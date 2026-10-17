use std::str::FromStr;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::panel;
use crate::settings::{self, Settings};

pub const EVENT_LAUNCHER_OPENED: &str = "launcher:opened";

pub enum Action {
    Toggle,
    Dictation,
}

impl Action {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "toggle" => Ok(Action::Toggle),
            "dictation" => Ok(Action::Dictation),
            other => Err(format!("unknown hotkey action '{other}' (expected 'toggle' or 'dictation')")),
        }
    }
}

pub(crate) fn parse_accelerator(accelerator: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accelerator)
        .map_err(|e| format!("invalid accelerator '{accelerator}': {e}"))
}

pub fn register_all(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(e) = register_toggle(app, &settings.toggle_hotkey) {
        errors.push(e);
    }
    if let Err(e) = register_dictation(app, &settings.dictation_hotkey) {
        errors.push(e);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn register_toggle(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if accelerator == "Fn" { return crate::fn_key::bind(app, 1); }
    let shortcut = parse_accelerator(accelerator)?;
    if app.global_shortcut().is_registered(shortcut) {
        return Err(format!("accelerator '{accelerator}' is already registered"));
    }
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            toggle_launcher(app);
        })
        .map_err(|e| format!("failed to register toggle hotkey '{accelerator}': {e}"))
}

fn register_dictation(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if accelerator == "Fn" { return crate::fn_key::bind(app, 2); }
    let shortcut = parse_accelerator(accelerator)?;
    if app.global_shortcut().is_registered(shortcut) {
        return Err(format!("accelerator '{accelerator}' is already registered"));
    }
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| match event.state {
            ShortcutState::Pressed => crate::dictate::key_down(app),
            ShortcutState::Released => crate::dictate::key_up(app),
        })
        .map_err(|e| format!("failed to register dictation hotkey '{accelerator}': {e}"))
}

/// Starts or stops dictation without opening the launcher, so focus stays in
/// the app the words are going to.
pub fn trigger_dictation(app: &AppHandle) {
    crate::dictate::toggle(app);
}

pub fn toggle_launcher(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || toggle_launcher_on_main(&handle)) {
        let message = format!("failed to schedule launcher toggle: {error}");
        crate::telemetry::capture("launcher.toggle.dispatch", &message);
    }
}

fn toggle_launcher_on_main(app: &AppHandle) {
    if panel::is_visible(app) {
        let _ = panel::hide(app);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if panel::show(app, &window).is_ok() {
            let _ = app.emit(EVENT_LAUNCHER_OPENED, ());
        }
    }
}

pub fn show_launcher(app: &AppHandle) {
    show_launcher_and_emit(app, None);
}

pub fn show_launcher_and_emit(app: &AppHandle, event: Option<&'static str>) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        show_launcher_on_main(&handle);
        if let Some(event) = event {
            let _ = handle.emit(event, ());
        }
    }) {
        let message = format!("failed to schedule launcher open: {error}");
        crate::telemetry::capture("launcher.open.dispatch", &message);
    }
}

fn show_launcher_on_main(app: &AppHandle) {
    let was_visible = panel::is_visible(app);
    if let Some(window) = app.get_webview_window("main") {
        if panel::show(app, &window).is_ok() && !was_visible {
            let _ = app.emit(EVENT_LAUNCHER_OPENED, ());
        }
    }
}

pub fn suspend(app: &AppHandle, suspended: bool) -> Result<(), String> {
    let _ = app.global_shortcut().unregister_all();
    #[cfg(target_os = "macos")]
    crate::fn_key::unbind();
    if suspended {
        return Ok(());
    }
    register_all(app, &settings::load(app))
}

pub fn set_hotkey(app: &AppHandle, action: Action, accelerator: &str) -> Result<(), String> {
    let new_shortcut = if accelerator == "Fn" { None } else { Some(parse_accelerator(accelerator)?) };

    let mut settings = settings::load(app);
    let old_accelerator = match action {
        Action::Toggle => settings.toggle_hotkey.clone(),
        Action::Dictation => settings.dictation_hotkey.clone(),
    };

    if old_accelerator == accelerator {
        if accelerator == "Fn" || new_shortcut.is_some_and(|key| !app.global_shortcut().is_registered(key)) {
            return match action { Action::Toggle => register_toggle(app, accelerator), Action::Dictation => register_dictation(app, accelerator) };
        }
        return Ok(());
    }

    let other = match action { Action::Toggle => &settings.dictation_hotkey, Action::Dictation => &settings.toggle_hotkey };
    if other == accelerator || new_shortcut.is_some_and(|key| app.global_shortcut().is_registered(key)) {
        return Err(format!("accelerator '{accelerator}' is already taken"));
    }

    if let Ok(old_shortcut) = parse_accelerator(&old_accelerator) {
        let _ = app.global_shortcut().unregister(old_shortcut);
    }

    let register_result = match action {
        Action::Toggle => register_toggle(app, accelerator),
        Action::Dictation => register_dictation(app, accelerator),
    };

    if let Err(e) = register_result {
        let _ = match action {
            Action::Toggle => register_toggle(app, &old_accelerator),
            Action::Dictation => register_dictation(app, &old_accelerator),
        };
        return Err(e);
    }

    #[cfg(target_os = "macos")]
    if old_accelerator == "Fn" && accelerator != "Fn" { crate::fn_key::unbind(); }

    match action {
        Action::Toggle => settings.toggle_hotkey = accelerator.to_string(),
        Action::Dictation => settings.dictation_hotkey = accelerator.to_string(),
    }
    if let Err(error) = settings::save(app, &settings) {
        if let Some(key) = new_shortcut { let _ = app.global_shortcut().unregister(key); }
        #[cfg(target_os = "macos")]
        if accelerator == "Fn" { crate::fn_key::unbind(); }
        let _ = match action { Action::Toggle => register_toggle(app, &old_accelerator), Action::Dictation => register_dictation(app, &old_accelerator) };
        return Err(error);
    }
    Ok(())
}
