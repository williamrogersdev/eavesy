use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

use std::sync::atomic::{AtomicBool, Ordering};

use crate::hotkeys;

const TRAY_ID: &str = "eavesy-tray";

/// Whether a capture is recording, i.e. which glyph the tray should show.
static WANT_RECORDING: AtomicBool = AtomicBool::new(false);
/// Whether the tray actually shows the recording glyph (red porch light).
static SHOWING_RECORDING: AtomicBool = AtomicBool::new(false);

/// No accelerator for fn or an unbound ("") shortcut.
fn menu_accel(accelerator: &str) -> Option<String> {
    (accelerator != crate::hotkeys::FN && crate::hotkeys::parse_accelerator(accelerator).is_ok()).then(|| accelerator.to_string())
}

pub(crate) fn glyphs(accelerator: &str) -> String {
    if accelerator == crate::hotkeys::FN { return "fn".into(); }
    // fn with a key: "fn Space", "fn ⇧K".
    let tokens: Vec<&str> = accelerator.split('+').collect();
    if tokens.len() > 1 && tokens.iter().any(|t| t.trim().eq_ignore_ascii_case(crate::hotkeys::FN)) {
        let rest: Vec<&str> = tokens.into_iter().filter(|t| !t.trim().eq_ignore_ascii_case(crate::hotkeys::FN)).collect();
        return format!("fn {}", glyphs(&rest.join("+")));
    }
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
    if settings.dictation_hotkey.is_empty() { return "Eavesy".into(); }
    format!("Eavesy · {} to record", glyphs(&settings.dictation_hotkey))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = crate::settings::load(app);
    let record_item = MenuItem::with_id(app, "record", "Start or Stop Recording", true, menu_accel(&settings.dictation_hotkey))?;
    let open_item = MenuItem::with_id(app, "open", "Open Eavesy", true, menu_accel(&settings.toggle_hotkey))?;
    let control_item = MenuItem::with_id(app, "show_control", "Show Capture Control", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let dictionary_item = MenuItem::with_id(app, "dictionary", "Add to Dictionary…", true, None::<&str>)?;
    let machine_item = MenuItem::with_id(app, "this_mac", "Clean Up This Mac…", true, None::<&str>)?;
    let setup_item = MenuItem::with_id(app, "setup", "Run Setup Again…", true, None::<&str>)?;
    let updates_item = MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
    let about_item = MenuItem::with_id(app, "about", "About Eavesy", true, None::<&str>)?;
    let diagnostics_item = MenuItem::with_id(app, "copy_diagnostics", "Copy Diagnostics", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Eavesy", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    Menu::with_items(
        app,
        &[
            &record_item,
            &open_item,
            &control_item,
            &separator()?,
            &dictionary_item,
            &machine_item,
            &settings_item,
            &setup_item,
            &updates_item,
            &about_item,
            &separator()?,
            &diagnostics_item,
            &quit_item,
        ],
    )
}

pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let _ = tray.set_tooltip(Some(tooltip(&crate::settings::load(app))));
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Swaps the menu bar glyph while a capture records. The idle glyph is a
/// template image (tinted by macOS); the recording one keeps its red dot.
/// Callable from any thread: the swap itself runs on the main thread.
pub fn set_recording(app: &AppHandle, recording: bool) {
    WANT_RECORDING.store(recording, Ordering::SeqCst);
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || apply_recording_glyph(&handle)) {
        eprintln!("tray: couldn't schedule the recording glyph: {error}");
    }
}

/// Brings the glyph in line with `WANT_RECORDING`. Main thread only. The
/// shown state is recorded only once the swap worked, so a missing tray or a
/// failed swap is retried by the next call (and by `install`).
fn apply_recording_glyph(app: &AppHandle) {
    let want = WANT_RECORDING.load(Ordering::SeqCst);
    if SHOWING_RECORDING.load(Ordering::SeqCst) == want {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let icon = if want {
        tauri::include_image!("icons/tray-recording.png")
    } else {
        tauri::include_image!("icons/tray.png")
    };
    match tray.set_icon(Some(icon)).and_then(|()| tray.set_icon_as_template(!want)) {
        Ok(()) => SHOWING_RECORDING.store(want, Ordering::SeqCst),
        Err(error) => eprintln!("tray: couldn't swap the recording glyph: {error}"),
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
            "dictionary" => { let _ = crate::settings_window::show_section(app, "dictionary"); },
            "this_mac" => { let _ = crate::settings_window::show_section(app, "machine"); },
            "setup" => crate::commands::show_setup(app.clone()),
            "check_updates" => crate::updates::check_interactively(app),
            "about" => crate::app_menu::show_about(app),
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
    // A capture may have started before the tray existed.
    SHOWING_RECORDING.store(false, Ordering::SeqCst);
    apply_recording_glyph(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcuts_render_as_glyphs_and_fn_is_not_a_menu_accelerator() {
        assert_eq!(glyphs("Cmd+Shift+D"), "⌘⇧D");
        assert_eq!(glyphs("Cmd+Shift+Space"), "⌘⇧Space");
        assert_eq!(glyphs("Fn"), "fn");
        assert!(menu_accel("Cmd+Shift+D").is_some());
        assert!(menu_accel("Fn").is_none());
        assert!(menu_accel("").is_none());
        assert_eq!(glyphs("Fn+Space"), "fn Space");
        assert_eq!(glyphs("Fn+Shift+K"), "fn ⇧K");
        assert!(menu_accel("Fn+Space").is_none());
    }
}
