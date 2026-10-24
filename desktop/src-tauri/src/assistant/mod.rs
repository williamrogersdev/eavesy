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
mod check;
pub mod memory;
pub mod voice;
pub mod policy;
pub mod rules;
pub mod store;
pub mod style;
pub mod thread;
mod tools;

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
    /// What each row touches, in `rows` order, from the tool's own data, so a rule you
    /// accepted can cover it (C3). None by default: no rule reaches the tool.
    fn scopes(&self) -> Vec<rules::Scope> { Vec::new() }
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
    /// Held across a policy change and its save, so the policy lock itself stays short.
    updating: Mutex<()>,
}

/// Loads the signed policy. Called once from setup.
pub fn init(app: &AppHandle) {
    thread::init(app);
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
        updating: Mutex::default(),
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
    fn latest(&self) -> Result<Option<String>, String> { Ok(None) }
    fn set_latest(&self, _: &str) -> Result<(), String> { Err("no Keychain on this platform".into()) }
}

fn now_ms() -> u64 { chrono::Utc::now().timestamp_millis().max(0) as u64 }

fn log(requester: &str, tool: &str, summary: &str, decision: &str, outcome: Option<String>) {
    let Some(dir) = activity::dir() else { return };
    let entry = activity::Entry { at_ms: now_ms(), requester: requester.into(), tool: tool.into(), summary: summary.into(), decision: decision.into(), outcome };
    if let Err(error) = activity::append(&dir, &entry) {
        tracing::warn!(%error, "assistant: couldn't write the Activity log");
    }
}

/// Opens the panel on the Eavesy tab.
pub const EVENT_SHOW: &str = "assistant:show";

/// How many cards are waiting for a click.
pub fn waiting_cards(app: &AppHandle) -> usize {
    live_cards(&app.state::<Core>()).len()
}

fn emit_cards(app: &AppHandle, core: &Core) {
    let _ = app.emit("assistant:cards", &live_cards(core));
}

/// Runs `action` if the policy allows it now, or puts up a card. Blocking: call it off
/// the main thread.
pub fn submit(app: &AppHandle, action: Box<dyn Action>, requester: &Requester, check: &Check) -> Submitted {
    let core = app.state::<Core>();
    let mut facts = action.facts();
    let policy = core.policy.lock().unwrap().clone();
    let effective = policy.effective(now_ms());
    // Set here from the signed rules, whatever the tool said.
    let covering = rules::covering(&policy.rules, &action.scopes(), action.rows().len());
    facts.always_allowed = covering.is_some();
    let decision = gate(&facts, requester, &effective, check, &mut core.breaker.lock().unwrap());
    let who = requester.label();
    let title = action.title();
    match decision {
        Decision::Refuse(reason) => {
            log(&who, action.tool(), &title, "refused", Some(reason.into()));
            Submitted::Refused { reason: reason.into() }
        }
        // Undo arrives with the first tool that can undo. Until then RunWithUndo comes
        // only from tier 1 (none registered yet) and from undoable tools in Auto and
        // Bypass, which run without the Undo button rather than not at all.
        Decision::Run | Decision::RunWithUndo { .. } => {
            let rows: Vec<String> = action.rows().into_iter().map(|row| row.id).collect();
            let mut ran = action.run(&rows);
            // Say which rule let it run, so the log and the thread show why no card came (C5).
            if let Some(used) = covering.filter(|_| policy::by_rule(&facts, requester, effective.mode)) {
                let named: Vec<String> = used.iter().map(rules::Rule::text).collect();
                ran.summary = format!("{} (your rule: {})", ran.summary, named.join("; "));
            }
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

/// Decides, and counts an unattended tier 2 or 3 run, under one breaker guard so
/// requests arriving together can't all slip under it before any of them counts.
fn gate(facts: &Facts, requester: &Requester, effective: &policy::Effective, check: &Check, breaker: &mut Breaker) -> Decision {
    let decision = policy::decide(facts, requester, effective, check, breaker);
    let unattended = matches!(decision, Decision::Run | Decision::RunWithUndo { .. }) && matches!(facts.tier, policy::Tier::Say | policy::Tier::Click);
    if unattended {
        breaker.record();
    }
    decision
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

/// A native alert, brought to the front the way updates.rs does it (Eavesy is an
/// accessory app, so an alert shown from a background thread can open behind other
/// windows). Blocks this thread until it's answered; never call it on the main thread.
fn confirm(app: &AppHandle, title: &str, message: &str, ok: &str) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let (handle, title, message, ok) = (app.clone(), title.to_string(), message.to_string(), ok.to_string());
    let shown = app.run_on_main_thread(move || {
        crate::app_menu::present(&handle);
        handle
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(ok, "Cancel".into()))
            .show(move |answer| {
                let _ = tx.send(answer);
            });
    });
    // An alert nobody answers in ten minutes counts as Cancel, so the command can't hang.
    shown.is_ok() && rx.recv_timeout(std::time::Duration::from_secs(600)).unwrap_or(false)
}

/// Waiting cards; any that expired go to the log as they're cleared.
fn live_cards(core: &Core) -> Vec<CardView> {
    let (live, expired) = core.cards.lock().unwrap().list(now_ms());
    for card in expired {
        log(&card.requester, &card.tool, &card.title, "expired", None);
    }
    live
}

/// Changes the policy and saves it, one change at a time so two can't overwrite each
/// other. The Keychain call runs outside the policy lock, so a slow Keychain never
/// stalls `submit` or the panel. Never call it while a dialog is up.
fn update(core: &Core, change: impl FnOnce(&mut Policy)) -> Result<Policy, String> {
    let path = store::path().ok_or("no home folder")?;
    let _updating = core.updating.lock().unwrap();
    let mut policy = core.policy.lock().unwrap().clone();
    change(&mut policy);
    store::save(&path, &keys(), &policy)?;
    *core.policy.lock().unwrap() = policy.clone();
    core.tampered.store(false, Ordering::SeqCst);
    Ok(policy)
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
    let cards = live_cards(&core);
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
    // A timed mode lasts a day at most.
    let minutes = minutes.map(|m| m.clamp(1, 24 * 60));
    tauri::async_runtime::spawn_blocking(move || {
        if mode == Mode::Bypass {
            let how_long = match minutes {
                Some(60) => "for an hour".into(),
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
        update(&core, |policy| {
            policy.mode = mode;
            policy.until_ms = match mode {
                Mode::Ask => None,
                _ => minutes.map(|m| now_ms() + m * 60_000),
            };
        })?;
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
        let before = core.policy.lock().unwrap().trusted_folders.clone();
        let added: Vec<String> = clean.iter().filter(|path| !before.contains(path)).map(|path| path.display().to_string()).collect();
        if !added.is_empty() {
            let message = format!(
                "Outside Ask, agents working in {} will act as you: in Bypass they send and change things without a card. Secrets, passwords and payments still always ask.",
                added.join(", ")
            );
            if !confirm(&app, "Trust local agents here?", &message, "Trust") {
                return Err("cancelled".to_string());
            }
        }
        // Only the folders change, so a mode change made while the dialog was up stays.
        update(&core, |policy| policy.trusted_folders = clean.clone())?;
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
                thread::note(&app, format!("the user declined the card \"{}\"", card.title));
                Ok(None)
            }
            Ok((card, action, rows)) => {
                let ran = action.run(&rows);
                log(&card.requester, &card.tool, &card.title, "accepted", Some(ran.summary.clone()));
                thread::note(&app, format!("the user accepted {} of {} rows on the card \"{}\": {}", rows.len(), card.rows.len(), card.title, ran.summary));
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

#[cfg(test)]
mod tests {
    use super::*;
    use policy::{Effective, Tier};

    #[test]
    fn unattended_runs_trip_the_breaker_for_the_next_one() {
        let facts = Facts { tier: Tier::Click, undoable: true, safe_listed: true, irreversible: false, grants_power: false, remote_allowed: false, items: 1, always_allowed: false };
        let you = Requester::You { spoken: false };
        let bypass = Effective { mode: Mode::Bypass, trusted_folders: vec![] };
        let mut breaker = Breaker::new(std::time::Duration::from_secs(60), 3);
        for _ in 0..3 {
            assert!(matches!(gate(&facts, &you, &bypass, &Check::Pass, &mut breaker), Decision::RunWithUndo { .. }));
        }
        assert!(matches!(gate(&facts, &you, &bypass, &Check::Pass, &mut breaker), Decision::Card { warning: Some(_) }));
        // Cards don't count: looking doesn't trip it either.
        let look = Facts { tier: Tier::Look, ..facts };
        assert_eq!(gate(&look, &you, &bypass, &Check::NotRun, &mut breaker), Decision::Run);
    }
}
