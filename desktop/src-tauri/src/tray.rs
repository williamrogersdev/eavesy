use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use crate::hotkeys;

const TRAY_ID: &str = "eavesy-tray";

fn menu_accel(accelerator: &str) -> Option<String> {
    (accelerator != "Fn" && crate::hotkeys::parse_accelerator(accelerator).is_ok()).then(|| accelerator.to_string())
}

fn glyphs(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "cmd" | "command" | "super" | "meta" => "⌘".to_string(),
            "shift" => "⇧".to_string(),
            "alt" | "option" => "⌥".to_string(),
            "ctrl" | "control" => "⌃".to_string(),
            other if other.len() == 1 => other.to_ascii_uppercase(),
            _ => part.trim().to_string(),
        })
        .collect()
}

fn tooltip(settings: &crate::settings::Settings) -> String {
    format!("Eavesy · {} to record", glyphs(&settings.dictation_hotkey))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = crate::settings::load(app);
    let record_item = MenuItem::with_id(app, "record", "Start or Stop Recording", true, menu_accel(&settings.dictation_hotkey))?;
    let open_item = MenuItem::with_id(app, "open", "Open Eavesy", true, menu_accel(&settings.toggle_hotkey))?;
    let control_item = MenuItem::with_id(app, "show_control", "Show Capture Control", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let diagnostics_item = MenuItem::with_id(app, "copy_diagnostics", "Copy Diagnostics", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Eavesy", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[&record_item, &open_item, &control_item, &settings_item, &diagnostics_item, &quit_item],
    )
}

pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_tooltip(Some(tooltip(&crate::settings::load(app))));
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(&crate::settings::load(app)))
        .menu(&build_menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "record" => hotkeys::trigger_dictation(app),
            "open" => hotkeys::show_launcher(app),
            "show_control" => crate::hud::set_hidden_on_main(app, false),
            "settings" => { let _ = crate::commands::show_settings(app.clone()); },
            "copy_diagnostics" => crate::diagnostics::copy(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                hotkeys::toggle_launcher(tray.app_handle());
            }
        });

    builder = builder
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true);

    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_render_as_glyphs_and_fn_is_not_a_menu_accelerator() {
        assert_eq!(glyphs("Cmd+Shift+D"), "⌘⇧D");
        assert_eq!(glyphs("Cmd+Shift+Space"), "⌘⇧Space");
        assert_eq!(glyphs("Fn"), "Fn");
        assert!(menu_accel("Cmd+Shift+D").is_some());
        assert!(menu_accel("Fn").is_none());
    }
}
