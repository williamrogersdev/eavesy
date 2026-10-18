use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::panel;
use crate::settings::{self, Settings, DEFAULT_DICTATION_HOTKEY, DEFAULT_TOGGLE_HOTKEY};

pub const EVENT_LAUNCHER_OPENED: &str = "launcher:opened";
/// A lone fn tap while shortcuts are suspended for recording one in Settings.
pub const EVENT_FN_TAP: &str = "hotkeys:fn-tap";

/// The accelerator that means "the fn / Globe key on its own".
pub const FN: &str = "Fn";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Toggle,
    Dictation,
}

impl Action {
    pub fn parse(s: &str) -> Result<Self, HotkeyError> {
        match s {
            "toggle" => Ok(Action::Toggle),
            "dictation" => Ok(Action::Dictation),
            other => Err(HotkeyError::invalid(format!("unknown shortcut action '{other}'"))),
        }
    }

    fn other(self) -> Self {
        match self { Action::Toggle => Action::Dictation, Action::Dictation => Action::Toggle }
    }

    /// The name people see in Settings.
    pub fn label(self) -> &'static str {
        match self { Action::Toggle => "Open Eavesy", Action::Dictation => "Talk" }
    }

    pub fn default_accelerator(self) -> &'static str {
        match self { Action::Toggle => DEFAULT_TOGGLE_HOTKEY, Action::Dictation => DEFAULT_DICTATION_HOTKEY }
    }
}

/// Who already holds a shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TakenBy {
    Toggle,
    Dictation,
    /// Another app or macOS registered it first.
    Other,
}

impl From<Action> for TakenBy {
    fn from(action: Action) -> Self {
        match action { Action::Toggle => TakenBy::Toggle, Action::Dictation => TakenBy::Dictation }
    }
}

/// Why a shortcut can't be used. Serialized as `{ kind, … }` for the Settings UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HotkeyError {
    /// Needs ⌘, ⌃ or ⌥ (fn and F1–F12 work alone).
    NeedsModifier,
    Taken { by: TakenBy },
    /// fn needs Input Monitoring, which macOS applies after a relaunch.
    InputMonitoring,
    Invalid { message: String },
}

impl HotkeyError {
    pub fn invalid(message: impl Into<String>) -> Self { HotkeyError::Invalid { message: message.into() } }

    /// One line for a notification or log, naming the shortcut that failed.
    pub fn describe(&self, action: Action, accelerator: &str) -> String {
        let keys = crate::tray::glyphs(accelerator);
        let name = action.label();
        match self {
            HotkeyError::NeedsModifier => format!("Your {name} shortcut ({keys}) needs ⌘, ⌃ or ⌥."),
            HotkeyError::Taken { by: TakenBy::Other } => format!("Your {name} shortcut ({keys}) is in use by another app."),
            HotkeyError::Taken { by } => {
                let other = if *by == TakenBy::Toggle { Action::Toggle } else { Action::Dictation };
                format!("Your {name} shortcut ({keys}) is also set for {}.", other.label())
            }
            HotkeyError::InputMonitoring => format!("Your {name} shortcut (fn) needs Input Monitoring for Eavesy."),
            HotkeyError::Invalid { message } => format!("Your {name} shortcut ({keys}) couldn't be set: {message}"),
        }
    }
}

impl std::fmt::Display for HotkeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HotkeyError::NeedsModifier => f.write_str("Use ⌘, ⌃ or ⌥ with a key, or fn on its own."),
            HotkeyError::Taken { by: TakenBy::Other } => f.write_str("Another app is using that shortcut."),
            HotkeyError::Taken { by: TakenBy::Toggle } => f.write_str("Already used for Open Eavesy."),
            HotkeyError::Taken { by: TakenBy::Dictation } => f.write_str("Already used for Talk."),
            HotkeyError::InputMonitoring => f.write_str("fn needs Input Monitoring. Allow Eavesy in Privacy & Security, then relaunch."),
            HotkeyError::Invalid { message } => f.write_str(message),
        }
    }
}

impl From<String> for HotkeyError {
    fn from(message: String) -> Self { HotkeyError::Invalid { message } }
}

pub(crate) fn parse_accelerator(accelerator: &str) -> Result<Shortcut, String> {
    Shortcut::from_str(accelerator)
        .map_err(|e| format!("invalid accelerator '{accelerator}': {e}"))
}

/// The one rule for what a shortcut may be: empty (unbound), fn alone, F1–F12
/// alone, or anything else with ⌘, ⌃ or ⌥.
pub fn validate(accelerator: &str) -> Result<(), HotkeyError> {
    if accelerator.is_empty() || accelerator == FN { return Ok(()); }
    let shortcut = parse_accelerator(accelerator).map_err(HotkeyError::invalid)?;
    if shortcut.mods.intersects(Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT) { return Ok(()); }
    use Code::*;
    if matches!(shortcut.key, F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 | F12) { return Ok(()); }
    Err(HotkeyError::NeedsModifier)
}

/// Whether two accelerators name the same keys ("Cmd+Shift+D" = "Shift+Cmd+D").
/// Unbound never collides with anything.
fn same_keys(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() { return false; }
    if a == b { return true; }
    matches!((Shortcut::from_str(a), Shortcut::from_str(b)), (Ok(x), Ok(y)) if x.mods == y.mods && x.key == y.key)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bindings {
    pub toggle: String,
    pub dictation: String,
}

impl Bindings {
    pub fn defaults() -> Self {
        Bindings { toggle: DEFAULT_TOGGLE_HOTKEY.into(), dictation: DEFAULT_DICTATION_HOTKEY.into() }
    }

    fn of(settings: &Settings) -> Self {
        Bindings { toggle: settings.toggle_hotkey.clone(), dictation: settings.dictation_hotkey.clone() }
    }

    pub fn get(&self, action: Action) -> &str {
        match action { Action::Toggle => &self.toggle, Action::Dictation => &self.dictation }
    }

    fn set(&mut self, action: Action, accelerator: String) {
        match action { Action::Toggle => self.toggle = accelerator, Action::Dictation => self.dictation = accelerator }
    }
}

/// What the bindings become when `action` is given `accelerator`. If the other
/// action already has it, that's an error unless `swap`, in which case the two
/// trade places.
pub fn plan(current: &Bindings, action: Action, accelerator: &str, swap: bool) -> Result<Bindings, HotkeyError> {
    validate(accelerator)?;
    let mut next = current.clone();
    let other = action.other();
    if same_keys(current.get(other), accelerator) {
        if !swap { return Err(HotkeyError::Taken { by: other.into() }); }
        next.set(other, current.get(action).to_string());
    }
    next.set(action, accelerator.to_string());
    Ok(next)
}

/// Held for every change to what is registered, so suspending for recording,
/// resuming and saving a new shortcut happen one at a time, in order.
static REGISTRY: Mutex<bool> = Mutex::new(false);

fn registry() -> std::sync::MutexGuard<'static, bool> {
    REGISTRY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Registers both shortcuts. Returns each one that failed and why.
pub fn register_all(app: &AppHandle, settings: &Settings) -> Vec<(Action, String, HotkeyError)> {
    register_bindings(app, &Bindings::of(settings))
}

fn register_bindings(app: &AppHandle, bindings: &Bindings) -> Vec<(Action, String, HotkeyError)> {
    [Action::Toggle, Action::Dictation]
        .into_iter()
        .filter_map(|action| {
            let accelerator = bindings.get(action);
            register(app, action, accelerator).err().map(|e| (action, accelerator.to_string(), e))
        })
        .collect()
}

fn unregister_everything(app: &AppHandle) {
    crate::dictate::reset_key();
    let _ = app.global_shortcut().unregister_all();
    #[cfg(target_os = "macos")]
    crate::fn_key::unbind();
}

fn register(app: &AppHandle, action: Action, accelerator: &str) -> Result<(), HotkeyError> {
    if action == Action::Dictation { crate::dictate::reset_key(); }
    if accelerator.is_empty() { return Ok(()); }
    if accelerator == FN {
        #[cfg(target_os = "macos")]
        return crate::fn_key::bind(app, if action == Action::Toggle { 1 } else { 2 });
        #[cfg(not(target_os = "macos"))]
        return Err(HotkeyError::invalid("fn works on macOS only"));
    }
    let shortcut = parse_accelerator(accelerator).map_err(HotkeyError::invalid)?;
    if app.global_shortcut().is_registered(shortcut) {
        return Err(HotkeyError::Taken { by: TakenBy::Other });
    }
    let registered = match action {
        Action::Toggle => app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed { toggle_launcher(app); }
        }),
        Action::Dictation => app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| match event.state {
            ShortcutState::Pressed => crate::dictate::key_down(app),
            ShortcutState::Released => crate::dictate::key_up(app),
        }),
    };
    // macOS refuses a hotkey another app already registered.
    registered.map_err(|e| {
        crate::telemetry::capture("hotkeys.register_one", &format!("{accelerator}: {e}"));
        HotkeyError::Taken { by: TakenBy::Other }
    })
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

/// While Settings records a shortcut, every shortcut is off so pressing the
/// current one doesn't fire it, and a lone fn tap is reported as
/// `EVENT_FN_TAP` instead. Resuming registers the saved shortcuts again.
pub fn suspend(app: &AppHandle, suspended: bool) -> Result<(), HotkeyError> {
    let mut is_suspended = registry();
    unregister_everything(app);
    *is_suspended = suspended;
    if suspended {
        #[cfg(target_os = "macos")]
        crate::fn_key::capture(app);
        return Ok(());
    }
    let failures = register_all(app, &settings::load(app));
    failures.into_iter().next().map_or(Ok(()), |(_, _, e)| Err(e))
}

/// Gives `action` a new shortcut ("" unbinds it), trading with the other
/// action when `swap` is set. Either both shortcuts end up registered and
/// saved, or nothing changes. Also ends a suspension.
pub fn set_hotkey(app: &AppHandle, action: Action, accelerator: &str, swap: bool) -> Result<(), HotkeyError> {
    let mut suspended = registry();
    let mut settings = settings::load(app);
    let current = Bindings::of(&settings);
    let next = plan(&current, action, accelerator, swap)?;
    apply(app, &mut settings, &current, &next)?;
    *suspended = false;
    Ok(())
}

/// Puts both shortcuts back to their defaults.
pub fn reset_all(app: &AppHandle) -> Result<(), HotkeyError> {
    let mut suspended = registry();
    let mut settings = settings::load(app);
    let current = Bindings::of(&settings);
    apply(app, &mut settings, &current, &Bindings::defaults())?;
    *suspended = false;
    Ok(())
}

fn apply(app: &AppHandle, settings: &mut Settings, current: &Bindings, next: &Bindings) -> Result<(), HotkeyError> {
    unregister_everything(app);
    let failures = register_bindings(app, next);
    // fn without Input Monitoring is still saved: it starts working once
    // Eavesy relaunches with the permission, and Settings shows how to get there.
    let blocking = failures.into_iter().find(|(_, _, e)| *e != HotkeyError::InputMonitoring);
    if let Some((_, _, error)) = blocking {
        unregister_everything(app);
        let _ = register_bindings(app, current);
        return Err(error);
    }
    settings.toggle_hotkey = next.toggle.clone();
    settings.dictation_hotkey = next.dictation.clone();
    if let Err(error) = settings::save(app, settings) {
        unregister_everything(app);
        let _ = register_bindings(app, current);
        return Err(HotkeyError::invalid(error));
    }
    Ok(())
}

/// The startup notification body for shortcuts that failed to register.
pub fn startup_notice(failures: &[(Action, String, HotkeyError)]) -> Option<String> {
    let lines: Vec<String> = failures.iter().map(|(action, accelerator, error)| error.describe(*action, accelerator)).collect();
    if lines.is_empty() { return None; }
    Some(format!("{} Open Settings from the Eavesy menu bar icon to fix it.", lines.join(" ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bindings(toggle: &str, dictation: &str) -> Bindings {
        Bindings { toggle: toggle.into(), dictation: dictation.into() }
    }

    #[test]
    fn validation_needs_a_real_modifier_except_fn_and_function_keys() {
        for ok in ["", "Fn", "F1", "F12", "Cmd+K", "Ctrl+Space", "Alt+D", "Cmd+Shift+Space", "Alt+Shift+F13"] {
            assert_eq!(validate(ok), Ok(()), "{ok}");
        }
        for needs in ["K", "Shift+K", "Space", "Shift+Space", "F13"] {
            assert_eq!(validate(needs), Err(HotkeyError::NeedsModifier), "{needs}");
        }
        assert!(matches!(validate("Cmd+Nope"), Err(HotkeyError::Invalid { .. })));
    }

    #[test]
    fn choosing_the_other_actions_shortcut_is_taken_unless_swapped() {
        let now = bindings("Cmd+Shift+Space", "Cmd+Shift+D");
        assert_eq!(plan(&now, Action::Toggle, "Cmd+Shift+D", false), Err(HotkeyError::Taken { by: TakenBy::Dictation }));
        assert_eq!(plan(&now, Action::Dictation, "Shift+Cmd+Space", false), Err(HotkeyError::Taken { by: TakenBy::Toggle }));
        assert_eq!(plan(&now, Action::Toggle, "Cmd+Shift+D", true), Ok(bindings("Cmd+Shift+D", "Cmd+Shift+Space")));
        assert_eq!(plan(&bindings("Fn", "Alt+D"), Action::Dictation, "Fn", true), Ok(bindings("Alt+D", "Fn")));
    }

    #[test]
    fn unbound_never_collides_and_is_allowed_for_both() {
        let now = bindings("", "Cmd+Shift+D");
        assert_eq!(plan(&now, Action::Dictation, "", false), Ok(bindings("", "")));
        assert_eq!(plan(&bindings("", ""), Action::Toggle, "Cmd+K", false), Ok(bindings("Cmd+K", "")));
    }

    #[test]
    fn reset_is_setting_the_default() {
        let now = bindings("Fn", "Alt+D");
        let action = Action::Toggle;
        assert_eq!(plan(&now, action, action.default_accelerator(), false), Ok(bindings(DEFAULT_TOGGLE_HOTKEY, "Alt+D")));
        let clash = bindings("Alt+D", DEFAULT_TOGGLE_HOTKEY);
        assert_eq!(plan(&clash, action, action.default_accelerator(), false), Err(HotkeyError::Taken { by: TakenBy::Dictation }));
        assert_eq!(validate(DEFAULT_TOGGLE_HOTKEY), Ok(()));
        assert_eq!(validate(DEFAULT_DICTATION_HOTKEY), Ok(()));
    }

    #[test]
    fn errors_serialize_with_a_kind_for_the_ui() {
        assert_eq!(serde_json::to_value(HotkeyError::NeedsModifier).unwrap(), serde_json::json!({"kind": "needsModifier"}));
        assert_eq!(serde_json::to_value(HotkeyError::Taken { by: TakenBy::Dictation }).unwrap(), serde_json::json!({"kind": "taken", "by": "dictation"}));
        assert_eq!(serde_json::to_value(HotkeyError::InputMonitoring).unwrap(), serde_json::json!({"kind": "inputMonitoring"}));
    }

    #[test]
    fn startup_notice_names_the_failing_shortcut_and_why() {
        assert_eq!(startup_notice(&[]), None);
        let notice = startup_notice(&[
            (Action::Dictation, "Fn".into(), HotkeyError::InputMonitoring),
            (Action::Toggle, "Cmd+Shift+Space".into(), HotkeyError::Taken { by: TakenBy::Other }),
        ]).unwrap();
        assert!(notice.contains("Talk shortcut (fn) needs Input Monitoring"), "{notice}");
        assert!(notice.contains("Open Eavesy shortcut (⌘⇧Space) is in use by another app"), "{notice}");
    }
}
