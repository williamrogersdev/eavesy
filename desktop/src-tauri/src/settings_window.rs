//! Preferences use a normal, resizable window, independent of the capture panel.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn show(app: &AppHandle) -> Result<(), String> {
    open(app, None)
}

/// Opens Settings on one section, the same way the panel does: through the
/// `eavesy.settings.section` key that Settings reads when it starts or gets focus.
pub fn show_section(app: &AppHandle, section: &str) -> Result<(), String> {
    open(app, Some(section_script(section)))
}

fn section_script(section: &str) -> String {
    let value = serde_json::json!({ "section": section }).to_string();
    format!(
        "try {{ const ask = {value}; ask.at = Date.now(); localStorage.setItem('eavesy.settings.section', JSON.stringify(ask)); }} catch {{}}"
    )
}

fn open(app: &AppHandle, section: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        if let Some(script) = &section {
            // Settings looks for the key again on focus; this focus event covers a window that already has it.
            let _ = window.eval(format!("{script} window.dispatchEvent(new Event('focus'));"));
        }
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let mut builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()));
    if let Some(script) = &section {
        builder = builder.initialization_script(script);
    }
    builder
        .title("Eavesy Settings")
        .inner_size(840.0, 680.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_script_quotes_the_section() {
        let script = section_script("machine");
        assert!(script.contains(r#"{"section":"machine"}"#));
        assert!(section_script("a'b").contains(r#"{"section":"a'b"}"#));
    }
}
