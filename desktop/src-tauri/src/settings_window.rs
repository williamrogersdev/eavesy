//! Preferences use a normal, resizable window, independent of the capture panel.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn show(app: &AppHandle) -> Result<(), String> {
    open(app, None)
}

/// The sections Settings knows (`SETTINGS_SECTIONS` in web/src/lib/desktop/bridge.ts).
const SECTIONS: &[&str] = &[
    "capture", "dictation", "transcription", "dictionary", "shortcuts", "prompts", "projects", "assistant", "machine",
    "permissions", "account",
];

/// Opens Settings on one section, the same way the panel does: through the
/// `eavesy.settings.section` key that Settings reads when it starts or gets focus.
pub fn show_section(app: &AppHandle, section: &str) -> Result<(), String> {
    open(app, Some(section_script(section)?))
}

/// Sets the key once per window: the script also runs on every reload, and a
/// reload shouldn't send you back to this section.
fn section_script(section: &str) -> Result<String, String> {
    if !SECTIONS.contains(&section) {
        return Err(format!("unknown settings section '{section}'"));
    }
    Ok(format!(
        "try {{ if (!sessionStorage.getItem('eavesy.settings.asked')) {{ sessionStorage.setItem('eavesy.settings.asked', '1'); localStorage.setItem('eavesy.settings.section', JSON.stringify({{ section: '{section}', at: Date.now() }})); }} }} catch {{}}"
    ))
}

fn open(app: &AppHandle, section: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        if let Some(script) = &section {
            // The window has already used its one-shot flag, so clear it first. Settings looks for
            // the key again on focus; this focus event covers a window that already has it.
            let _ = window.eval(format!("try {{ sessionStorage.removeItem('eavesy.settings.asked'); }} catch {{}} {script} window.dispatchEvent(new Event('focus'));"));
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
    fn section_script_takes_only_known_sections_and_runs_once() {
        let script = section_script("machine").unwrap();
        assert!(script.contains("section: 'machine'"));
        assert!(script.contains("sessionStorage.getItem('eavesy.settings.asked')"));
        assert!(section_script("a'); alert(1); ('").is_err());
        assert!(section_script("").is_err());
    }
}
