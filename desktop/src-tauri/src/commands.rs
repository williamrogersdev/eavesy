use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::hotkeys::{self, Action};
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
pub async fn paste_to_frontmost(app: AppHandle, text: String) -> Result<(), String> {
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

    paste_text(&app, &text)
}

pub fn paste_text(app: &AppHandle, text: &str) -> Result<(), String> {
    paste_text_quietly(app, text).map_err(|error| match error {
        PasteError::Clipboard(message) => message,
        PasteError::Keystroke(error) => {
            eprintln!("paste: {error}");
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
            message
        }
    })
}

/// Why a paste did not happen.
#[derive(Debug)]
pub enum PasteError {
    /// The text never reached the clipboard.
    Clipboard(String),
    /// The text is on the clipboard (left there on purpose, so ⌘V still
    /// works), but the ⌘V key press could not be sent.
    Keystroke(String),
}

/// `paste_text` without the notification: the caller says what happened.
pub fn paste_text_quietly(app: &AppHandle, text: &str) -> Result<(), PasteError> {
    let previous = app.clipboard().read_text().ok();

    app.clipboard()
        .write_text(text.to_string())
        .map_err(|e| PasteError::Clipboard(format!("failed to copy to clipboard: {e}")))?;

    #[cfg(target_os = "macos")]
    {
        crate::dictation::press_paste().map_err(PasteError::Keystroke)?;
    }

    if let Some(prev) = previous {
        // The key press is posted, not awaited: give the app time to read the
        // pasteboard before the user's own clipboard comes back.
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = app.clipboard().write_text(prev);
    }

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

#[tauri::command]
pub fn set_hotkey(app: AppHandle, action: String, accelerator: String) -> Result<(), String> {
    let action = Action::parse(&action)?;
    hotkeys::set_hotkey(&app, action, &accelerator)?;
    crate::tray::refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn show_launcher(app: AppHandle) {
    let _ = app.emit("launcher:recordings", ());
    hotkeys::show_launcher(&app);
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


/// The HUD grows to show its running transcript, and shrinks back after.
#[tauri::command]
pub fn set_hud_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || crate::hud::set_expanded_on_main(&handle, expanded))
        .map_err(|error| format!("could not resize the capture control: {error}"))
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

// Async so reading the registry never runs on the main (UI) thread.
#[tauri::command(async)]
pub fn list_recordings(app: AppHandle) -> Result<Vec<RecordingDto>, String> {
    let out = store::load_all(&app)
        .into_iter()
        .map(|r| RecordingDto {
            id: r.id,
            title: r.title,
            started_at_ms: r.started_at_ms,
            duration_sec: r.duration_sec,
            source: r.source,
            status: r.status,
            summary: r.summary,
            transcript: r.transcript,
            has_audio: r.has_audio,
            has_video: r.has_video,
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub async fn hotkey_conflict(accelerator: String) -> Option<crate::shortcut_conflicts::Conflict> {
    crate::shortcut_conflicts::check(&accelerator)
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
pub fn open_web_app(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(format!("{}/app", crate::sync::api_base()), None).map_err(|e| e.to_string())
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
pub fn get_hud_state() -> crate::hud::HudState { crate::hud::current() }

#[tauri::command]
pub fn show_settings(app: AppHandle) -> Result<(), String> {
    hotkeys::show_launcher_and_emit(&app, Some("launcher:settings"));
    Ok(())
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
pub fn suspend_hotkeys(app: AppHandle, suspended: bool) -> Result<(), String> {
    hotkeys::suspend(&app, suspended)
}
