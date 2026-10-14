use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const RECHECK: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

pub fn check_in_background(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                crate::telemetry::capture("updater.initialize", &e.to_string());
                return;
            }
        };
        let mut announced: Option<String> = None;
        loop {
            match updater.check().await {
                Ok(Some(update)) if announced.as_deref() != Some(update.version.as_str()) => {
                    let _ = app
                        .notification()
                        .builder()
                        .title(format!("Eavesy {} is available", update.version))
                        .body("Open Eavesy and choose Install update to get it.")
                        .show();
                    announced = Some(update.version);
                }
                Ok(_) => {}
                Err(e) => {
                    crate::telemetry::capture("updater.check", &e.to_string());
                }
            }
            tokio::time::sleep(RECHECK).await;
        }
    });
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if app.state::<crate::audio::Captures>().is_busy() {
        return Err("Stop the current recording before updating.".into());
    }
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

    if app.state::<crate::audio::Captures>().is_busy() {
        return Err("Update installed. It takes effect after this recording, when Eavesy restarts.".into());
    }
    app.restart();
}
