use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::install_location::MOVE_TO_APPLICATIONS;

enum InstallError {
    /// The Move to Applications prompt is on screen and already explains itself.
    MovePrompted,
    Failed(String),
}

impl From<String> for InstallError {
    fn from(message: String) -> Self {
        InstallError::Failed(message)
    }
}

impl From<&str> for InstallError {
    fn from(message: &str) -> Self {
        InstallError::Failed(message.into())
    }
}

impl From<InstallError> for String {
    fn from(error: InstallError) -> Self {
        match error {
            InstallError::MovePrompted => "Move Eavesy to Applications first, then update again.".into(),
            InstallError::Failed(message) => message,
        }
    }
}

const RECHECK: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);
/// Emitted with an [`UpdateStatus`] whenever a check finishes.
pub const EVENT_UPDATE_STATUS: &str = "launcher:update-status";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum UpdateState {
    /// No check has finished since Eavesy started.
    Unknown,
    UpToDate,
    Available { version: String, notes: Option<String> },
    /// Downloaded and installed; it takes effect the next time Eavesy starts.
    Installed { version: String },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current_version: String,
    #[serde(flatten)]
    pub state: UpdateState,
    pub checked_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub update: UpdateStatus,
}

static LAST: Mutex<Option<(UpdateState, i64)>> = Mutex::new(None);
/// Set while an install runs, so a second click doesn't download it twice.
static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The version installed this run, waiting for a restart to take effect.
static INSTALLED: Mutex<Option<String>> = Mutex::new(None);

fn status(app: &AppHandle) -> UpdateStatus {
    let last = LAST.lock().ok().and_then(|last| last.clone());
    UpdateStatus {
        current_version: crate::app_menu::version(app),
        checked_at_ms: last.as_ref().map(|(_, at)| *at),
        state: last.map(|(state, _)| state).unwrap_or(UpdateState::Unknown),
    }
}

fn record(app: &AppHandle, state: UpdateState) -> UpdateStatus {
    if let Ok(mut last) = LAST.lock() {
        let installed = INSTALLED.lock().ok().and_then(|v| v.clone());
        let state = keep_installed(installed.as_deref(), state);
        *last = Some((state, chrono::Utc::now().timestamp_millis()));
    }
    let status = status(app);
    let _ = app.emit(EVENT_UPDATE_STATUS, &status);
    status
}

/// Until Eavesy restarts, the running build still sees the installed version as
/// "available"; keep saying it's installed so the UI doesn't offer it again.
fn keep_installed(installed: Option<&str>, next: UpdateState) -> UpdateState {
    match (installed, &next) {
        (Some(done), UpdateState::Available { version, .. }) if done == version => {
            UpdateState::Installed { version: done.to_string() }
        }
        _ => next,
    }
}

async fn check(app: &AppHandle) -> UpdateState {
    let result = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match result {
        Ok(Some(update)) => UpdateState::Available { version: update.version, notes: update.body },
        Ok(None) => UpdateState::UpToDate,
        Err(message) => {
            crate::telemetry::capture("updater.check", &message);
            UpdateState::Error { message }
        }
    }
}

pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut announced: Option<String> = None;
        loop {
            let state = check(&app).await;
            if let UpdateState::Available { version, .. } = &state {
                if announced.as_deref() != Some(version.as_str()) {
                    crate::telemetry::track("update_available", serde_json::json!({ "version": version }));
                    let _ = app
                        .notification()
                        .builder()
                        .title(format!("Eavesy {version} is available"))
                        .body("Click Update at the top of the Eavesy panel to install it.")
                        .show();
                    announced = Some(version.clone());
                }
            }
            record(&app, state);
            tokio::time::sleep(RECHECK).await;
        }
    });
}

/// The app's name and version, and the result of the last update check.
#[tauri::command]
pub fn get_app_info(app: AppHandle) -> AppInfo {
    AppInfo { name: app.package_info().name.clone(), version: crate::app_menu::version(&app), update: status(&app) }
}

/// Checks for an update now and returns the result; the UI decides what to show.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> UpdateStatus {
    let state = check(&app).await;
    record(&app, state)
}

pub fn dialog_text(status: &UpdateStatus) -> (String, String) {
    let current = &status.current_version;
    match &status.state {
        UpdateState::UpToDate | UpdateState::Unknown => {
            ("You're up to date".into(), format!("Eavesy {current} is the newest version."))
        }
        UpdateState::Installed { version } => (
            format!("Eavesy {version} is installed"),
            format!("It takes effect the next time Eavesy starts. You're running {current} until then."),
        ),
        UpdateState::Available { version, .. } => (
            format!("Eavesy {version} is available"),
            format!("You have {current}. Install it now? Eavesy relaunches when it's done."),
        ),
        UpdateState::Error { message } => {
            ("Couldn't check for updates".into(), format!("Eavesy {current} couldn't reach the update server: {message}"))
        }
    }
}

/// Check for Updates… from the app or tray menu: checks, then answers with a native dialog,
/// offering Install & Relaunch when there is an update.
pub fn check_interactively(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = check_for_updates(app.clone()).await;
        let (title, message) = dialog_text(&status);
        let available = matches!(status.state, UpdateState::Available { .. });
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::app_menu::present(&handle);
            let dialog = handle.dialog().message(message).title(title);
            if available {
                let installer = handle.clone();
                dialog
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom("Install & Relaunch".into(), "Later".into()))
                    .show(move |install| {
                        if install {
                            install_and_report(installer);
                        }
                    });
            } else {
                let kind =
                    if matches!(status.state, UpdateState::Error { .. }) { MessageDialogKind::Warning } else { MessageDialogKind::Info };
                dialog.kind(kind).buttons(MessageDialogButtons::Ok).show(|_| {});
            }
        });
    });
}

fn install_and_report(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(InstallError::Failed(message)) = install(app.clone()).await {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::app_menu::present(&handle);
                handle
                    .dialog()
                    .message(message)
                    .title("Eavesy couldn't install the update")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::Ok)
                    .show(|_| {});
            });
        }
    });
}

/// Downloads and installs the update, then relaunches. If a recording started
/// meanwhile, it keeps the install, reports `Installed` and skips the relaunch.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    install(app).await.map_err(String::from)
}

async fn install(app: AppHandle) -> Result<(), InstallError> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    if app.state::<crate::audio::Captures>().is_busy() {
        return Err("Stop the current recording before updating.".into());
    }
    if let Some(version) = INSTALLED.lock().ok().and_then(|v| v.clone()) {
        return Err(format!("Eavesy {version} is already installed. It takes effect the next time Eavesy starts.").into());
    }
    if let Some(misplaced) = crate::install_location::misplaced() {
        crate::install_location::offer_move(
            &app,
            misplaced,
            "Eavesy can't update itself while it runs from the disk image. Move it to Applications? Then click Update again.",
        );
        return Err(InstallError::MovePrompted);
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("The update is already installing.".into());
    }
    let result = download_and_install(&app).await;
    INSTALLING.store(false, Ordering::SeqCst);
    let version = result?;
    // The app relaunches next, so give the event a moment to leave.
    let event = serde_json::json!({ "version": version });
    let _ = tauri::async_runtime::spawn_blocking(move || {
        crate::telemetry::track_before_exit("update_installed", event, std::time::Duration::from_secs(3));
    })
    .await;

    if let Ok(mut installed) = INSTALLED.lock() {
        *installed = Some(version.clone());
    }
    if app.state::<crate::audio::Captures>().is_busy() {
        record(&app, UpdateState::Installed { version });
        return Ok(());
    }
    app.restart();
}

fn install_error(error: tauri_plugin_updater::Error) -> String {
    let detail = error.to_string();
    crate::telemetry::capture("updater.install", &detail);
    match &error {
        // EXDEV and EROFS: the bundle can't be moved out of a read-only mount.
        tauri_plugin_updater::Error::Io(io) if matches!(io.raw_os_error(), Some(18 | 30)) => {
            format!("{MOVE_TO_APPLICATIONS} ({detail})")
        }
        _ => detail,
    }
}

async fn download_and_install(app: &AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Eavesy is already up to date")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(install_error)?;
    Ok(update.version)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every installed copy trusts updates signed by this Minisign key (C0F27E06D477B704).
    /// Changing it orphans them all, so a change has to touch this test too and is
    /// visible in review (docs/RELEASING.md, docs/plans/device-security.md phase 0).
    const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEMwRjI3RTA2RDQ3N0I3MDQKUldRRXQzZlVCbjd5d0FUZC96djBqcVlSL25xbFozSXhBTWlPbStvamVod2tHR1V6Sk5mVDJWZWUK";

    #[test]
    fn the_updater_key_is_the_pinned_one() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["updater"]["pubkey"].as_str(), Some(UPDATER_PUBKEY));
    }

    fn status(state: UpdateState) -> UpdateStatus {
        UpdateStatus { current_version: "0.2.0".into(), state, checked_at_ms: Some(1) }
    }

    #[test]
    fn dialog_says_which_version_you_have() {
        assert_eq!(dialog_text(&status(UpdateState::UpToDate)).1, "Eavesy 0.2.0 is the newest version.");
        let (title, body) = dialog_text(&status(UpdateState::Available { version: "0.3.0".into(), notes: None }));
        assert_eq!(title, "Eavesy 0.3.0 is available");
        assert!(body.contains("0.2.0"));
        assert!(dialog_text(&status(UpdateState::Error { message: "offline".into() })).1.contains("offline"));
        let (title, body) = dialog_text(&status(UpdateState::Installed { version: "0.3.0".into() }));
        assert_eq!(title, "Eavesy 0.3.0 is installed");
        assert!(body.contains("next time Eavesy starts"));
    }

    #[test]
    fn an_installed_update_is_not_offered_again() {
        let installed = UpdateState::Installed { version: "0.3.0".into() };
        let same = UpdateState::Available { version: "0.3.0".into(), notes: None };
        assert_eq!(keep_installed(Some("0.3.0"), same.clone()), installed);
        assert_eq!(keep_installed(None, same.clone()), same);
        let newer = UpdateState::Available { version: "0.3.1".into(), notes: None };
        assert_eq!(keep_installed(Some("0.3.0"), newer.clone()), newer);
        let failed = UpdateState::Error { message: "offline".into() };
        assert_eq!(keep_installed(Some("0.3.0"), failed.clone()), failed);
    }

    #[test]
    fn a_read_only_install_error_asks_to_move_to_applications() {
        use std::io::Error as IoError;
        for code in [18, 30] {
            let message = install_error(tauri_plugin_updater::Error::Io(IoError::from_raw_os_error(code)));
            assert!(message.starts_with(MOVE_TO_APPLICATIONS));
            assert!(message.contains(&format!("os error {code}")));
        }
        let other = install_error(tauri_plugin_updater::Error::Io(IoError::from_raw_os_error(13)));
        assert!(!other.contains(MOVE_TO_APPLICATIONS));
    }

    #[test]
    fn status_serializes_flat_with_a_state_tag() {
        let json = serde_json::to_value(status(UpdateState::Available { version: "0.3.0".into(), notes: None })).unwrap();
        assert_eq!(json["state"], "available");
        assert_eq!(json["version"], "0.3.0");
        assert_eq!(json["currentVersion"], "0.2.0");
        let json = serde_json::to_value(status(UpdateState::UpToDate)).unwrap();
        assert_eq!(json["state"], "upToDate");
    }
}
