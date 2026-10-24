//! The action core (docs/plans/assistant.md C): every action Eavesy takes for you or
//! for an agent goes through `submit`, which asks `policy::decide` whether it runs,
//! waits for a card, or is refused, and writes the Activity log either way.
//!
//! Three things never come from a request: its tier and reversibility (the tool's
//! code), who asked (the channel it arrived on), and the mode (the signed policy file,
//! changed only from Eavesy's own windows, with a native confirm for Bypass and for
//! trusting agents).

pub mod activity;
pub mod cards;
pub mod policy;
pub mod store;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use cards::{CardView, Cards, Row, TakeError};
use policy::{Breaker, Check, Decision, Facts, Mode, Requester};
use store::Policy;

/// A tool the core can run. Everything here is fixed in the tool's code.
pub trait Action: Send + Sync + 'static {
    /// Stable name for the log, e.g. `machine.clean`.
    fn tool(&self) -> &'static str;
    fn facts(&self) -> Facts;
    /// The card's title: what will happen, in plain words.
    fn title(&self) -> String;
    /// Each thing it touches; a card can untick any of them.
    fn rows(&self) -> Vec<Row>;
    /// Runs the given rows, checking each again right before touching it.
    fn run(&self, rows: &[String]) -> Ran;
}

#[derive(Debug, Serialize)]
pub struct Ran {
    /// One line for the log and the thread.
    pub summary: String,
    /// The tool's own result, for the window that asked.
    pub detail: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Submitted {
    Ran { ran: Ran },
    Card { card: CardView },
    Refused { reason: String },
}

pub struct Core {
    policy: Mutex<Policy>,
    /// The policy file failed its check at launch; cleared when you set the mode again.
    tampered: AtomicBool,
    cards: Mutex<Cards<Box<dyn Action>>>,
    breaker: Mutex<Breaker>,
}

/// Loads the signed policy. Called once from setup.
pub fn init(app: &AppHandle) {
    let loaded = match store::path() {
        Some(path) => store::load(&path, &keys()),
        None => store::Loaded::Missing,
    };
    if loaded == store::Loaded::Tampered {
        tracing::warn!("assistant: the policy file changed outside Eavesy; using Ask");
    }
    app.manage(Core {
        policy: Mutex::new(loaded.policy()),
        tampered: AtomicBool::new(loaded == store::Loaded::Tampered),
        cards: Mutex::default(),
        breaker: Mutex::default(),
    });
}

#[cfg(target_os = "macos")]
fn keys() -> store::Keychain { store::Keychain }

#[cfg(not(target_os = "macos"))]
fn keys() -> NoKeys { NoKeys }

/// Off macOS there's no Keychain, so nothing loads as anything but Ask.
#[cfg(not(target_os = "macos"))]
struct NoKeys;

#[cfg(not(target_os = "macos"))]
impl store::KeyStore for NoKeys {
    fn key(&self) -> Result<Option<Vec<u8>>, String> { Ok(None) }
    fn create_key(&self) -> Result<Vec<u8>, String> { Err("no Keychain on this platform".into()) }
}

fn now_ms() -> u64 { chrono::Utc::now().timestamp_millis().max(0) as u64 }

fn log(requester: &str, tool: &str, summary: &str, decision: &str, outcome: Option<String>) {
    let Some(dir) = activity::dir() else { return };
    let entry = activity::Entry { at_ms: now_ms(), requester: requester.into(), tool: tool.into(), summary: summary.into(), decision: decision.into(), outcome };
    if let Err(error) = activity::append(&dir, &entry) {
        tracing::warn!(%error, "assistant: couldn't write the Activity log");
    }
}

fn emit_cards(app: &AppHandle, core: &Core) {
    let (live, expired) = core.cards.lock().unwrap().list(now_ms());
    for card in expired {
        log(&card.requester, &card.tool, &card.title, "expired", None);
    }
    let _ = app.emit("assistant:cards", &live);
}

/// Runs `action` if the policy allows it now, or puts up a card. Blocking: call it off
/// the main thread. Its first callers are the conversation and the middleman tools
/// (assistant.md build steps 5 and 10).
#[allow(dead_code)]
pub fn submit(app: &AppHandle, action: Box<dyn Action>, requester: &Requester, check: &Check) -> Submitted {
    let core = app.state::<Core>();
    let facts = action.facts();
    let effective = core.policy.lock().unwrap().effective(now_ms());
    let decision = policy::decide(&facts, requester, &effective, check, &core.breaker.lock().unwrap());
    let who = requester.label();
    let title = action.title();
    match decision {
        Decision::Refuse(reason) => {
            log(&who, action.tool(), &title, "refused", Some(reason.into()));
            Submitted::Refused { reason: reason.into() }
        }
        // Undo arrives with the first tier 1 tool; until then nothing returns RunWithUndo
        // without also being safe to run plainly.
        Decision::Run | Decision::RunWithUndo { .. } => {
            if matches!(facts.tier, policy::Tier::Say | policy::Tier::Click) {
                core.breaker.lock().unwrap().record();
            }
            let rows: Vec<String> = action.rows().into_iter().map(|row| row.id).collect();
            let ran = action.run(&rows);
            log(&who, action.tool(), &title, "ran", Some(ran.summary.clone()));
            Submitted::Ran { ran }
        }
        // Read-back is a card until the voice step lets "yes" answer it.
        Decision::ReadBack | Decision::Card { .. } => {
            let warning = match decision {
                Decision::Card { warning } => warning,
                _ => None,
            };
            let view = CardView { id: String::new(), requester: who.clone(), tool: action.tool().into(), title: title.clone(), rows: action.rows(), warning, expires_ms: 0 };
            let (card, dropped) = core.cards.lock().unwrap().add(now_ms(), view, action);
            log(&who, &card.tool, &title, "card", None);
            if let Some(dropped) = dropped {
                log(&dropped.requester, &dropped.tool, &dropped.title, "expired", Some("too many cards waiting".into()));
            }
            emit_cards(app, &core);
            Submitted::Card { card }
        }
    }
}

/// For a confirm card Eavesy's own UI already showed (machine cleanup in Settings): the
/// click there is the acceptance, so this runs the rows and logs it.
pub fn run_clicked(action: &dyn Action, rows: &[String]) -> Ran {
    let ran = action.run(rows);
    log("You", action.tool(), &action.title(), "accepted", Some(ran.summary.clone()));
    ran
}

/// Mode changes, card decisions and the log only answer Eavesy's panel and Settings.
fn from_ui(window: &WebviewWindow) -> Result<(), String> {
    match window.label() {
        "main" | "settings" => Ok(()),
        _ => Err("This only works from Eavesy's panel or Settings.".into()),
    }
}

fn confirm(app: &AppHandle, title: &str, message: &str, ok: &str) -> bool {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), "Cancel".into()))
        .blocking_show()
}

fn save(core: &Core, policy: Policy) -> Result<(), String> {
    let path = store::path().ok_or("no home folder")?;
    store::save(&path, &keys(), &policy)?;
    *core.policy.lock().unwrap() = policy;
    core.tampered.store(false, Ordering::SeqCst);
    Ok(())
}

#[derive(Serialize)]
pub struct State {
    pub mode: Mode,
    /// The mode in force: Ask once `until_ms` has passed.
    pub effective: Mode,
    pub until_ms: Option<u64>,
    pub trusted_folders: Vec<PathBuf>,
    /// The policy file changed outside Eavesy; it's on Ask until you set it again.
    pub tampered: bool,
    pub cards: Vec<CardView>,
}

#[tauri::command]
pub fn assistant_state(app: AppHandle, window: WebviewWindow) -> Result<State, String> {
    from_ui(&window)?;
    let core = app.state::<Core>();
    let policy = core.policy.lock().unwrap().clone();
    let (cards, _) = core.cards.lock().unwrap().list(now_ms());
    Ok(State {
        effective: policy.effective(now_ms()).mode,
        mode: policy.mode,
        until_ms: policy.until_ms,
        trusted_folders: policy.trusted_folders,
        tampered: core.tampered.load(Ordering::SeqCst),
        cards,
    })
}

/// `minutes`: how long until it falls back to Ask; none is "until I turn it off".
#[tauri::command]
pub async fn set_assistant_mode(app: AppHandle, window: WebviewWindow, mode: Mode, minutes: Option<u64>) -> Result<(), String> {
    from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        if mode == Mode::Bypass {
            let how_long = match minutes {
                Some(m) => format!("for {m} minutes"),
                None => "until you turn it off".into(),
            };
            let message = format!(
                "Eavesy will send and change things you ask for without a card, {how_long}. It still never types passwords, shows secrets or pays, and agents still need a card unless you trust their folder."
            );
            if !confirm(&app, "Turn on Bypass?", &message, "Turn on Bypass") {
                return Err("cancelled".to_string());
            }
        }
        let core = app.state::<Core>();
        let mut policy = core.policy.lock().unwrap().clone();
        policy.mode = mode;
        policy.until_ms = match mode {
            Mode::Ask => None,
            _ => minutes.map(|m| now_ms() + m.min(24 * 60) * 60_000),
        };
        save(&core, policy)?;
        log("You", "assistant.mode", &format!("{mode:?}"), "ran", minutes.map(|m| format!("for {m} min")));
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Agents working inside these folders act as you outside Ask (C8). Adding one asks first.
#[tauri::command]
pub async fn set_trusted_agent_folders(app: AppHandle, window: WebviewWindow, folders: Vec<String>) -> Result<Vec<PathBuf>, String> {
    from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut clean = Vec::new();
        for folder in folders {
            let path = std::fs::canonicalize(&folder).map_err(|_| format!("{folder} isn't a folder on this Mac"))?;
            if path.parent().is_none() || Some(path.as_path()) == dirs::home_dir().as_deref() {
                return Err("Trust a project folder, not your whole disk or home folder.".to_string());
            }
            if !clean.contains(&path) {
                clean.push(path);
            }
        }
        let core = app.state::<Core>();
        let mut policy = core.policy.lock().unwrap().clone();
        let added: Vec<String> = clean.iter().filter(|path| !policy.trusted_folders.contains(path)).map(|path| path.display().to_string()).collect();
        if !added.is_empty() {
            let message = format!(
                "Outside Ask, agents working in {} will act as you: in Bypass they send and change things without a card. Secrets, passwords and payments still always ask.",
                added.join(", ")
            );
            if !confirm(&app, "Trust local agents here?", &message, "Trust") {
                return Err("cancelled".to_string());
            }
        }
        policy.trusted_folders = clean.clone();
        save(&core, policy)?;
        log("You", "assistant.trust", &format!("{} folders", clean.len()), "ran", None);
        Ok(clean)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Runs the card's stored action on the accepted rows; none accepted declines it.
#[tauri::command]
pub async fn assistant_card_decide(app: AppHandle, window: WebviewWindow, card_id: String, accepted_row_ids: Vec<String>) -> Result<Option<Ran>, String> {
    from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let core = app.state::<Core>();
        let taken = core.cards.lock().unwrap().take(now_ms(), &card_id, &accepted_row_ids);
        let result = match taken {
            Err(TakeError::Unknown) => Err("That card isn't waiting any more.".to_string()),
            Err(TakeError::Expired) => Err("That card expired. Ask again.".to_string()),
            Ok((card, _, rows)) if rows.is_empty() => {
                log(&card.requester, &card.tool, &card.title, "declined", None);
                Ok(None)
            }
            Ok((card, action, rows)) => {
                let ran = action.run(&rows);
                log(&card.requester, &card.tool, &card.title, "accepted", Some(ran.summary.clone()));
                Ok(Some(ran))
            }
        };
        emit_cards(&app, &core);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn assistant_activity(window: WebviewWindow, limit: Option<usize>) -> Result<Vec<activity::Entry>, String> {
    from_ui(&window)?;
    Ok(activity::dir().map(|dir| activity::recent(&dir, limit.unwrap_or(100).min(1000))).unwrap_or_default())
}
