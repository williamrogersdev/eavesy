use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::hotkeys::{self, Action, HotkeyError};
use crate::panel;
use crate::settings::{self, Settings};
use crate::store;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingDto {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    pub duration_sec: i64,
    pub source: String,
    pub status: String,
    pub summary: Option<String>,
    pub transcript: Option<String>,
    pub has_audio: bool,
    pub has_video: bool,
}

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("failed to copy to clipboard: {e}"))
}

#[tauri::command]
pub async fn paste_to_frontmost(app: AppHandle, text: String, learn: Option<bool>) -> Result<(), String> {
    hide_panel_on_main_thread(&app).await?;

    // Hiding the launcher hands focus back to the app it opened over; wait for that app to be in
    // front before pasting into it.
    std::thread::sleep(std::time::Duration::from_millis(120));
    for _ in 0..8 {
        if !crate::app_menu::is_active() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    paste_text_with_learning(&app, &text, learn.unwrap_or(true))
}

/// A paste's pending restore of the user's own clipboard: its generation, and
/// while one is pending, what to put back (nothing, when the clipboard held
/// no text). A newer paste takes the restore over, so Eavesy's own words on
/// the clipboard are never mistaken for the user's.
struct Restore {
    generation: u64,
    pending: Option<Option<String>>,
}

static RESTORE: std::sync::Mutex<Restore> = std::sync::Mutex::new(Restore { generation: 0, pending: None });

fn restore() -> std::sync::MutexGuard<'static, Restore> {
    RESTORE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn paste_text(app: &AppHandle, text: &str) -> Result<(), String> {
    paste_text_with_learning(app, text, true)
}
fn paste_text_with_learning(app: &AppHandle, text: &str, learn: bool) -> Result<(), String> {
    let on_clipboard = app.clipboard().read_text().ok();
    let (generation, previous) = {
        let mut restore = restore();
        let previous = restore.pending.take().unwrap_or(on_clipboard);
        restore.generation += 1;
        restore.pending = Some(previous.clone());
        (restore.generation, previous)
    };

    app.clipboard()
        .write_text(text.to_string())
        .map_err(|e| format!("failed to copy to clipboard: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        let learning_target = if learn { crate::paste_learning::capture() } else { None };
        if let Err(error) = crate::dictation::press_paste() {
            eprintln!("paste: {error}");
            // The words stay on the clipboard for ⌘V: nothing is put back.
            restore().pending = None;
            let message = "Couldn't paste automatically. Grant Accessibility to Eavesy in System \
                 Settings → Privacy & Security → Accessibility. The text is on your \
                 clipboard — press ⌘V to paste it now."
                .to_string();
            let _ = app
                .notification()
                .builder()
                .title("Eavesy couldn't paste")
                .body(&message)
                .show();
            return Err(message);
        }
        crate::paste_learning::observe(app.clone(), learning_target, text.to_string());
    }

    // The key press is posted, not awaited: give the app time to read the
    // pasteboard before the user's own clipboard comes back. Off this
    // thread, so whoever pasted can say so at once.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let mut restore = restore();
        if restore.generation == generation {
            restore.pending = None;
            if let Some(previous) = previous {
                let _ = app.clipboard().write_text(previous);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn hide_panel(app: AppHandle) -> Result<(), String> {
    hide_panel_on_main_thread(&app).await
}

async fn hide_panel_on_main_thread(app: &AppHandle) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(panel::hide(&handle));
    })
    .map_err(|error| format!("failed to schedule launcher hide: {error}"))?;

    receiver
        .await
        .map_err(|_| "launcher hide task ended before returning a result".to_string())?
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    settings::load(&app)
}

#[tauri::command]
pub fn set_launcher_position(app: AppHandle, position: settings::LauncherPosition) -> Result<(), String> {
    let mut config = settings::load(&app);
    config.launcher_position = position;
    settings::save(&app, &config)?;
    crate::hud::reset_frame(&app);
    let handle = app.clone();
    app.run_on_main_thread(move || crate::placement::place(&handle))
        .map_err(|error| format!("could not reposition Eavesy: {error}"))
}

/// Turns live captions on or off. Speech Recognition permission is asked for
/// by the launcher when they are turned on, never by a recording.
#[tauri::command]
pub fn set_live_captions(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut config = settings::load(&app);
    config.live_captions = Some(enabled);
    settings::save(&app, &config)
}

/// Setup's practice box is open in the panel and wants the next dictation.
#[tauri::command]
pub fn set_dictation_in_panel(wants: bool) {
    crate::dictation::set_panel_wants_dictation(wants);
}

/// The panel put a dictation's words in its box.
#[tauri::command]
pub fn ack_dictation_text(session_id: String) {
    crate::dictation::ack_panel_dictation(&session_id);
}

/// Turns the start and stop sounds on or off.
#[tauri::command]
pub fn set_capture_sounds(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut config = settings::load(&app);
    config.capture_sounds = Some(enabled);
    settings::save(&app, &config)
}

/// How many lines of live words the control shows while recording, whether
/// it is see-through, and (when given) whether faster live words are on.
#[tauri::command]
pub fn set_hud_look(app: AppHandle, lines: u8, translucent: bool, fast_live_words: Option<bool>) -> Result<(), String> {
    if !matches!(lines, 0 | 1 | 2 | 4) {
        return Err(format!("the preview shows 0, 1, 2 or 4 lines, not {lines}"));
    }
    crate::hud::set_look(&app, lines, translucent, fast_live_words);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupStatus {
    pub paired: bool,
    pub completed: bool,
}

#[tauri::command]
pub fn get_setup_status(app: AppHandle) -> SetupStatus {
    let config = settings::load(&app);
    SetupStatus {
        paired: settings::device_token(&app).is_some(),
        completed: config.setup_completed,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub email: Option<String>,
    pub name: Option<String>,
}

#[tauri::command]
pub async fn account_info(app: AppHandle) -> Option<AccountInfo> {
    let credential = settings::device_credential(&app)?;
    let unknown = AccountInfo { email: None, name: None };
    let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build() else {
        return Some(unknown);
    };
    match client
        .get(format!("{}/api/devices/me", credential.base))
        .bearer_auth(credential.token)
        .send()
        .await
    {
        Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => None,
        Ok(response) if response.status().is_success() => Some(response.json().await.unwrap_or(unknown)),
        _ => Some(unknown),
    }
}

#[tauri::command]
pub async fn disconnect_account(app: AppHandle) -> Result<(), String> {
    if let Some(credential) = settings::device_credential(&app) {
        if let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build() {
            let _ = client
                .delete(format!("{}/api/devices/me", credential.base))
                .bearer_auth(credential.token)
                .send()
                .await;
        }
    }
    settings::delete_device_token(&app)
}

#[tauri::command]
pub fn complete_setup(app: AppHandle) -> Result<(), String> {
    let mut config = settings::load(&app);
    config.setup_completed = true;
    settings::save(&app, &config)
}

/// Gives `action` ("toggle" or "dictation") a shortcut; "" leaves it unbound.
/// With `swap`, takes the other action's shortcut and gives it this one's.
#[tauri::command]
pub fn set_hotkey(app: AppHandle, action: String, accelerator: String, swap: Option<bool>) -> Result<(), HotkeyError> {
    let action = Action::parse(&action)?;
    let result = hotkeys::set_hotkey(&app, action, &accelerator, swap.unwrap_or(false));
    crate::tray::refresh(&app);
    result
}

#[tauri::command]
pub fn get_hotkey_defaults() -> hotkeys::Bindings {
    hotkeys::Bindings::defaults()
}

#[tauri::command]
pub fn reset_hotkey(app: AppHandle, action: String, swap: Option<bool>) -> Result<(), HotkeyError> {
    let action = Action::parse(&action)?;
    let result = hotkeys::set_hotkey(&app, action, action.default_accelerator(), swap.unwrap_or(false));
    crate::tray::refresh(&app);
    result
}

#[tauri::command]
pub fn reset_all_hotkeys(app: AppHandle) -> Result<(), HotkeyError> {
    let result = hotkeys::reset_all(&app);
    crate::tray::refresh(&app);
    result
}

#[derive(Serialize)]
pub struct FnStatus {
    input_monitoring: bool,
    globe_action: &'static str,
}

/// What still stands between the fn key and an Eavesy shortcut.
#[tauri::command(async)]
pub fn fn_status() -> FnStatus {
    #[cfg(target_os = "macos")]
    {
        let globe = match crate::fn_key::GlobeAction::read() {
            crate::fn_key::GlobeAction::DoNothing => "do_nothing",
            crate::fn_key::GlobeAction::InputSource => "input_source",
            crate::fn_key::GlobeAction::Emoji => "emoji",
            crate::fn_key::GlobeAction::Dictation => "dictation",
            crate::fn_key::GlobeAction::Unknown => "unknown",
        };
        FnStatus { input_monitoring: crate::fn_key::input_monitoring_granted(), globe_action: globe }
    }
    #[cfg(not(target_os = "macos"))]
    FnStatus { input_monitoring: false, globe_action: "unknown" }
}

#[tauri::command]
pub fn show_launcher(app: AppHandle) {
    let _ = app.emit("launcher:recordings", ());
    hotkeys::show_launcher(&app);
}

#[tauri::command]
pub fn focus_preview_editor(app: AppHandle, session_id: String) -> Result<u64, String> {
    validate_live_preview_session(&crate::hud::current(), &session_id)?;
    let revision = crate::live_edit::revision(&session_id);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = crate::hud::current();
        if matches!(state.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing | crate::hud::Phase::Done) && state.session_id.as_deref() == Some(session_id.as_str()) {
            crate::hud::focus_editor_on_main(&handle);
        }
    }).map_err(|error| format!("Could not focus transcript editor: {error}"))?;
    Ok(revision)
}

fn validate_live_preview_session(state: &crate::hud::HudState, session_id: &str) -> Result<(), String> {
    // Done allows an edit already in flight when Stop completed. Other captures
    // and idle/failed previews may only use the explicit saved-transcript editor.
    if state.session_id.as_deref() == Some(session_id)
        && matches!(state.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing | crate::hud::Phase::Done) {
        Ok(())
    } else { Err("This capture is no longer accepting live corrections".into()) }
}

#[tauri::command]
pub async fn update_live_preview_edit(app: AppHandle, session_id: String, source: String, text: String, revision: u64) -> Result<(), String> {
    validate_live_preview_session(&crate::hud::current(), &session_id)?;
    crate::live_edit::update(&session_id, source, text, revision)?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_live_preview_session(&crate::hud::current(), &session_id)?;
        if let Some(recording) = store::get(&app, &session_id)? {
            if recording.folder_path.is_some() {
                if let Some(text) = crate::live_edit::corrected(&session_id, recording.transcript.as_deref().unwrap_or("")) {
                    if !store::save_live_preview_transcript(&app, &session_id, &text)? {
                        return Err("Transcript was edited in its folder; reopen it before correcting".into());
                    }
                }
            }
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn dismiss_hud(app: AppHandle, session_id: Option<String>) {
    let state = crate::hud::current();
    if session_id.is_some() && state.session_id != session_id { return; }
    if !matches!(state.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing) {
        let mut idle = crate::hud::HudState::idle();
        idle.session_id = state.session_id;
        crate::hud::set_state(&app, idle);
    }
}


/// Hovering a finished dictation opens its transcript drawer; returns once
/// the control has the drawer's size.
#[tauri::command]
pub async fn peek_hud(app: AppHandle, session_id: String, open: bool) {
    let _ = tauri::async_runtime::spawn_blocking(move || crate::hud::set_peek(&app, session_id, open)).await;
}

/// The capture control painted a new phase: its native shadow can follow now.
#[tauri::command]
pub fn hud_painted(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::hud::repainted_on_main(&handle));
}

#[tauri::command]
pub fn close_hud(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || crate::hud::set_hidden_on_main(&handle, true))
        .map_err(|error| format!("could not close the capture control: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStart {
    code: String,
    verification_url: String,
    expires_in_sec: Option<u64>,
}

#[derive(Deserialize)]
struct PairStatus {
    status: String,
    token: Option<String>,
}

#[tauri::command]
pub async fn pair_device(app: AppHandle) -> Result<(), String> {
    if PAIRING.swap(true, Ordering::SeqCst) {
        return Err("Sign-in is already in progress. Finish it in your browser or cancel it.".to_string());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) { PAIRING.store(false, Ordering::SeqCst); }
    }
    let _done = Done;
    let generation = PAIR_GENERATION.load(Ordering::SeqCst);

    let result = pair_device_inner(&app, generation).await;
    let cancelled = matches!(&result, Err(e) if e == PAIR_CANCELLED);
    if !cancelled {
        let (title, body) = match &result {
            Ok(()) => ("Signed in", "Eavesy for Mac is connected to your account.".to_string()),
            Err(e) => ("Couldn't connect this Mac", e.clone()),
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
    if result.is_ok() {
        if settings::load(&app).setup_completed {
            let _ = show_settings(app.clone());
        } else {
            show_setup(app.clone());
        }
    }
    if let Err(error) = &result {
        if !cancelled {
            crate::telemetry::capture("device.pair", error);
        }
    }
    result
}

static PAIRING: AtomicBool = AtomicBool::new(false);
static PAIR_GENERATION: AtomicU64 = AtomicU64::new(0);
const PAIR_CANCELLED: &str = "Sign-in cancelled.";

#[tauri::command]
pub fn cancel_pairing() {
    PAIR_GENERATION.fetch_add(1, Ordering::SeqCst);
}

async fn pair_device_inner(app: &AppHandle, generation: u64) -> Result<(), String> {
    let cancelled = || PAIR_GENERATION.load(Ordering::SeqCst) != generation;
    let config = settings::load(app);
    let recordings_root = crate::fs_writer::recordings_root(app)?;
    let base = crate::base_url::api_base();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("could not start pairing: {e}"))?;
    let response = client
        .post(format!("{}/api/devices/pair/start", base.trim_end_matches('/')))
        .json(&serde_json::json!({
            "deviceId": &config.device_id,
            "name": "Eavesy for Mac",
            "rootFolderPath": recordings_root.to_string_lossy(),
        }))
        .send()
        .await
        .map_err(|e| format!("could not contact Eavesy: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("could not start pairing (HTTP {})", response.status()));
    }
    if cancelled() {
        return Err(PAIR_CANCELLED.to_string());
    }
    let pairing: PairStart = response
        .json()
        .await
        .map_err(|e| format!("invalid pairing response: {e}"))?;

    if !crate::base_url::same_origin(&pairing.verification_url, &base) {
        return Err("The server returned a sign-in link on a different site, so it was not opened.".to_string());
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&pairing.verification_url)
        .status()
        .map_err(|e| format!("could not open your browser: {e}"))?;

    const POLL_INTERVAL_SEC: u64 = 2;
    let window_sec = pairing.expires_in_sec.unwrap_or(600);
    let minutes = window_sec / 60;

    for _ in 0..(window_sec / POLL_INTERVAL_SEC) {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SEC)).await;
        if cancelled() {
            return Err(PAIR_CANCELLED.to_string());
        }
        let response = match client
            .post(format!("{}/api/devices/pair/status", base.trim_end_matches('/')))
            .json(&serde_json::json!({
                "code": &pairing.code,
                "deviceId": &config.device_id,
            }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("The pairing code expired. Run Connect account again.".to_string());
        }
        if !response.status().is_success() {
            continue;
        }
        let status: PairStatus = response
            .json()
            .await
            .map_err(|e| format!("invalid pairing status: {e}"))?;
        if status.status == "paired" {
            let token = status.token.ok_or("pairing completed without a credential")?;
            settings::save_device_token(app, &base, &token)?;
            crate::sync::wake();
            return Ok(());
        }
    }
    Err(format!(
        "Pairing timed out. Run Connect account and approve it within {minutes} minutes."
    ))
}

// SQLite, filesystem migration, and serialization run off the UI thread.
#[tauri::command(async)]
pub fn list_recordings(app: AppHandle, offset: Option<usize>, limit: Option<usize>, query: Option<String>, filter: Option<String>, search: Option<crate::history_search::Request>) -> Result<store::HistoryPage, String> {
    let token=search.as_ref().map(crate::history_search::register).transpose()?;
    let mut page = store::page(&app, offset.unwrap_or(0), limit.unwrap_or(50), query.as_deref().unwrap_or(""), filter.as_deref().unwrap_or("all"), token.as_ref())?;
    let mut origins = crate::cloud_pull::origins(&app);
    origins.extend(crate::capture_sync::origins(&app));
    for item in &mut page.items {
        item.device = origins.get(&item.id).cloned();
    }
    Ok(page)
}

#[tauri::command(async)]
pub fn cancel_history_search(search: crate::history_search::Request) -> Result<(),String> {
    crate::history_search::cancel(search)
}

#[derive(Serialize)]
pub struct RecordingDetails {
    #[serde(flatten)]
    recording: RecordingDto,
    revision: i64,
}

#[tauri::command(async)]
pub fn get_recording(app: AppHandle, id: String) -> Result<Option<RecordingDetails>, String> {
    Ok(store::details(&app, &id)?.map(|(r,revision)| RecordingDetails { revision, recording: RecordingDto {
        id:r.id,title:r.title,started_at_ms:r.started_at_ms,duration_sec:r.duration_sec,source:r.source,status:r.status,
        summary:r.summary,transcript:r.transcript,has_audio:r.has_audio,has_video:r.has_video,
    }}))
}

/// Checks a shortcut before saving it: the modifier rule, the other action,
/// then macOS and common app shortcuts.
/// Runs off the main thread: it shells out to `defaults` and `plutil`.
#[tauri::command(async)]
pub fn check_hotkey(app: AppHandle, action: String, accelerator: String) -> Result<Option<crate::shortcut_conflicts::Conflict>, HotkeyError> {
    let action = Action::parse(&action)?;
    let settings = settings::load(&app);
    let current = hotkeys::Bindings { toggle: settings.toggle_hotkey, dictation: settings.dictation_hotkey };
    crate::shortcut_conflicts::check(&current, action, &accelerator)
}

#[tauri::command]
// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
#[allow(deprecated)]
pub fn open_keyboard_settings(app: AppHandle, input_monitoring: bool) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let url = if input_monitoring {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
    } else { "x-apple.systempreferences:com.apple.Keyboard-Settings.extension" };
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
#[allow(deprecated)]
pub fn open_web_app(app: AppHandle, path: Option<String>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let url = format!("{}/app{}", crate::sync::api_base(), web_app_path(path.as_deref()));
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// A page under /app, such as `/settings#projects`; anything else opens /app.
fn web_app_path(path: Option<&str>) -> &str {
    match path {
        Some(path)
            if path.starts_with('/')
                && !path.starts_with("//")
                && path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_#".contains(c)) =>
        {
            path
        }
        _ => "",
    }
}

#[tauri::command]
pub fn set_panel_pinned(pinned: bool) { panel::set_pinned(pinned); }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    signed_out: bool,
}

/// Whether uploads are paused because the server rejected this Mac's credential.
#[tauri::command]
pub fn sync_status() -> SyncStatus {
    SyncStatus { signed_out: crate::sync::signed_out() }
}

#[tauri::command]
pub async fn get_hud_state(app: AppHandle) -> crate::hud::HudState {
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = crate::hud::current();
        if state.phase == crate::hud::Phase::Done {
            if let Some(recording) = state.session_id.as_deref().and_then(|id| store::get(&app, id).ok().flatten()) {
                if let Some(transcript) = recording.transcript { state.message = Some(transcript); }
            }
        }
        state
    }).await.unwrap_or_else(|_| crate::hud::current())
}

#[tauri::command]
pub async fn save_preview_transcript(app: AppHandle, session_id: String, text: String, live: Option<bool>) -> Result<(), String> {
    // The readiness wait and durable writes use blocking filesystem/SQLite APIs.
    tauri::async_runtime::spawn_blocking(move || {
        // Fast paste can finish just before the recording's folder is registered.
        for _ in 0..50 {
            let ready = store::get(&app, &session_id)?.is_some_and(|rec| rec.folder_path.is_some());
            if ready {
                let original = store::get(&app, &session_id)?.and_then(|rec| rec.transcript);
                if live.unwrap_or(false) {
                    if !store::save_live_preview_transcript(&app, &session_id, &text)? {
                        return Err("Transcript was edited in its folder; reopen it before correcting".into());
                    }
                } else { store::save_preview_transcript(&app, &session_id, &text)?; }
                crate::live_edit::forget(&session_id);
                if let Some(original) = original.filter(|original| original != &text) {
                    let learning_app = app.clone();
                    let corrected = text.clone();
                    // Durable local edits work offline; dictionary feedback follows separately.
                    std::thread::spawn(move || {
                        if crate::settings::device_credential(&learning_app).is_none() { return; }
                        match crate::learning::feedback(&learning_app, &original, &corrected) {
                            Ok(value) => crate::learning::notify(&learning_app, serde_json::json!({ "status": "saved", "learned": value["learned"], "words": value["words"] })),
                            Err(_) => crate::learning::notify(&learning_app, serde_json::json!({ "status": "failed", "message": "Transcript saved. Dictionary could not connect; use Edit transcript to retry learning." })),
                        }
                    });
                }
                let _ = app.emit("recordings:updated", ());
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err("Recording is still being saved. Please retry.".into())
    }).await.map_err(|error| format!("Could not save transcript: {error}"))?
}

#[tauri::command(async)]
pub fn show_settings(app: AppHandle) -> Result<(), String> {
    crate::settings_window::show(&app)
}

#[tauri::command]
pub fn show_setup(app: AppHandle) {
    hotkeys::show_launcher_and_emit(&app, Some("launcher:setup"));
}

#[tauri::command]
// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
#[allow(deprecated)]
pub fn open_privacy_settings(app: AppHandle, pane: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let url = match pane.as_str() {
        "notifications" => crate::permissions::NOTIFICATIONS_SETTINGS_URL.to_string(),
        other => {
            let anchor = crate::permissions::privacy_anchor(other).ok_or_else(|| format!("unknown privacy pane '{other}'"))?;
            format!("x-apple.systempreferences:com.apple.preference.security?{anchor}")
        }
    };
    app.shell().open(url, None).map_err(|e| e.to_string())?;
    crate::make_room::after_opening_settings(&app);
    Ok(())
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if app.state::<crate::audio::Captures>().is_busy() {
        return Err("Stop the current recording before reopening Eavesy.".into());
    }
    app.restart()
}

#[tauri::command]
pub fn show_notice(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
/// Returns whether a lone fn tap will be reported while suspended.
pub fn suspend_hotkeys(app: AppHandle, suspended: bool) -> Result<bool, HotkeyError> {
    hotkeys::suspend(&app, suspended)
}

#[cfg(test)]
mod tests {
    #[test]
    fn live_corrections_only_target_the_current_capture() {
        use crate::hud::{HudState, Phase};
        for phase in [Phase::Recording, Phase::Transcribing, Phase::Done] {
            let state = HudState { phase, session_id: Some("current".into()), ..HudState::idle() };
            assert!(super::validate_live_preview_session(&state, "current").is_ok());
            assert!(super::validate_live_preview_session(&state, "another").is_err());
        }
        for phase in [Phase::Idle, Phase::Failed, Phase::Saved] {
            let state = HudState { phase, session_id: Some("current".into()), ..HudState::idle() };
            assert!(super::validate_live_preview_session(&state, "current").is_err());
        }
    }
    #[test]
    fn only_plain_app_pages_open_in_the_browser() {
        assert_eq!(super::web_app_path(Some("/settings#projects")), "/settings#projects");
        assert_eq!(super::web_app_path(Some("//evil.example")), "");
        assert_eq!(super::web_app_path(Some("/a?b=c")), "");
        assert_eq!(super::web_app_path(None), "");
    }
}
