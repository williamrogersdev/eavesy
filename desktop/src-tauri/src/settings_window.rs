//! Preferences use a normal, resizable window, independent of the capture panel.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn show(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Eavesy Settings")
        .inner_size(880.0, 680.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center();
    // Like System Settings: no title bar strip, the traffic lights sit over the
    // sidebar, and the page draws (and drags) the window's top edge.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}
