use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

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
        if let Err(message) = install_update(app.clone()).await {
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
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    if app.state::<crate::audio::Captures>().is_busy() {
        return Err("Stop the current recording before updating.".into());
    }
    if let Some(version) = INSTALLED.lock().ok().and_then(|v| v.clone()) {
        return Err(format!("Eavesy {version} is already installed. It takes effect the next time Eavesy starts."));
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("The update is already installing.".into());
    }
    let result = download_and_install(&app).await;
    // Record the install before releasing the lock, so no second call slips in between.
    if let Ok(version) = &result {
        *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.clone());
    }
    INSTALLING.store(false, Ordering::SeqCst);
    let version = result?;

    if app.state::<crate::audio::Captures>().is_busy() {
        record(&app, UpdateState::Installed { version });
        return Ok(());
    }
    app.restart();
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
        .map_err(|e| e.to_string())?;
    Ok(update.version)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn status_serializes_flat_with_a_state_tag() {
        let json = serde_json::to_value(status(UpdateState::Available { version: "0.3.0".into(), notes: None })).unwrap();
        assert_eq!(json["state"], "available");
        assert_eq!(json["version"], "0.3.0");
        assert_eq!(json["currentVersion"], "0.2.0");
        let json = serde_json::to_value(status(UpdateState::UpToDate)).unwrap();
        assert_eq!(json["state"], "upToDate");
    }
}
