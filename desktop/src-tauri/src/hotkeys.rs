use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::panel;
use crate::settings::{self, Settings, DEFAULT_ASSISTANT_HOTKEY, DEFAULT_DICTATION_HOTKEY, DEFAULT_TOGGLE_HOTKEY, OLD_ASSISTANT_HOTKEY};

pub const EVENT_LAUNCHER_OPENED: &str = "launcher:opened";
/// A lone fn tap while shortcuts are suspended for recording one in Settings.
pub const EVENT_FN_TAP: &str = "hotkeys:fn-tap";
/// fn held with a key ("Fn+Space") while recording: WebKit never reports fn,
/// so the Mac app sends the accelerator itself.
pub const EVENT_FN_CHORD: &str = "hotkeys:fn-chord";

/// The accelerator that means "the fn / Globe key on its own".
pub const FN: &str = "Fn";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Toggle,
    Dictation,
    /// Talk to Eavesy: records like dictation, and the words go to Eavesy.
    Assistant,
}

impl Action {
    pub const ALL: [Action; 3] = [Action::Toggle, Action::Dictation, Action::Assistant];

    pub fn parse(s: &str) -> Result<Self, HotkeyError> {
        match s {
            "toggle" => Ok(Action::Toggle),
            "dictation" => Ok(Action::Dictation),
            "assistant" => Ok(Action::Assistant),
            other => Err(HotkeyError::invalid(format!("unknown shortcut action '{other}'"))),
        }
    }

    /// The name people see in Settings.
    pub fn label(self) -> &'static str {
        match self { Action::Toggle => "Open Eavesy", Action::Dictation => "Talk", Action::Assistant => "Talk to Eavesy" }
    }

    pub fn default_accelerator(self) -> &'static str {
        match self {
            Action::Toggle => DEFAULT_TOGGLE_HOTKEY,
            Action::Dictation => DEFAULT_DICTATION_HOTKEY,
            Action::Assistant => DEFAULT_ASSISTANT_HOTKEY,
        }
    }
}

/// Who already holds a shortcut.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TakenBy {
    Toggle,
    Dictation,
    Assistant,
    /// Another app or macOS registered it first.
    Other,
}

impl From<Action> for TakenBy {
    fn from(action: Action) -> Self {
        match action { Action::Toggle => TakenBy::Toggle, Action::Dictation => TakenBy::Dictation, Action::Assistant => TakenBy::Assistant }
    }
}

impl TakenBy {
    /// The shortcut's own action, unless another app holds it.
    fn action(self) -> Option<Action> {
        match self { TakenBy::Toggle => Some(Action::Toggle), TakenBy::Dictation => Some(Action::Dictation), TakenBy::Assistant => Some(Action::Assistant), TakenBy::Other => None }
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
    /// fn with a key needs Accessibility, so Eavesy can keep the key from
    /// reaching the app in front.
    Accessibility,
    Invalid { message: String },
}

impl HotkeyError {
    pub fn invalid(message: impl Into<String>) -> Self { HotkeyError::Invalid { message: message.into() } }

    /// Saved anyway: the shortcut starts working once macOS allows it.
    pub fn waits_for_permission(&self) -> bool {
        matches!(self, HotkeyError::InputMonitoring | HotkeyError::Accessibility)
    }

    /// One line for a notification or log, naming the shortcut that failed.
    pub fn describe(&self, action: Action, accelerator: &str) -> String {
        let keys = crate::tray::glyphs(accelerator);
        let name = action.label();
        match self {
            HotkeyError::NeedsModifier => format!("Your {name} shortcut ({keys}) needs ⌘, ⌃, ⌥ or fn."),
            HotkeyError::Taken { by } => match by.action() {
                Some(other) => format!("Your {name} shortcut ({keys}) is also set for {}.", other.label()),
                None => format!("Your {name} shortcut ({keys}) is in use by another app."),
            },
            HotkeyError::InputMonitoring => format!("Your {name} shortcut (fn) needs Input Monitoring for Eavesy."),
            HotkeyError::Accessibility => format!("Your {name} shortcut ({keys}) needs Accessibility for Eavesy."),
            HotkeyError::Invalid { message } => format!("Your {name} shortcut ({keys}) couldn't be set: {message}"),
        }
    }
}

impl std::fmt::Display for HotkeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HotkeyError::NeedsModifier => f.write_str(MODIFIER_RULE),
            HotkeyError::Taken { by } => match by.action() {
                Some(other) => write!(f, "Already used for {}.", other.label()),
                None => f.write_str("Another app is using that shortcut."),
            },
            HotkeyError::InputMonitoring => f.write_str("fn needs Input Monitoring. Allow Eavesy in Privacy & Security, then relaunch."),
            HotkeyError::Accessibility => f.write_str("fn with a key needs Accessibility. Allow Eavesy in Privacy & Security."),
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

/// The rule, in the words Settings shows.
pub const MODIFIER_RULE: &str = "Use ⌘, ⌃, ⌥ or fn with a key, or fn on its own.";

/// An accelerator taken apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keys {
    /// The fn / 🌐 key on its own.
    Fn,
    /// fn held with a key, maybe with other modifiers too: "Fn+Space", "Fn+Shift+K".
    FnChord { mods: Modifiers, key: Code },
    /// Anything the global-shortcut plugin registers.
    Plain { mods: Modifiers, key: Code },
}

/// What `accelerator` names; `None` for unbound ("").
pub fn keys(accelerator: &str) -> Result<Option<Keys>, String> {
    if accelerator.trim().is_empty() { return Ok(None); }
    let tokens: Vec<&str> = accelerator.split('+').map(str::trim).collect();
    let (fns, rest): (Vec<&str>, Vec<&str>) = tokens.into_iter().partition(|t| t.eq_ignore_ascii_case(FN));
    if fns.len() > 1 { return Err(format!("invalid accelerator '{accelerator}': fn is named twice")); }
    if rest.is_empty() { return Ok(Some(Keys::Fn)); }
    let shortcut = parse_accelerator(&rest.join("+"))?;
    Ok(Some(if fns.is_empty() {
        Keys::Plain { mods: shortcut.mods, key: shortcut.key }
    } else {
        Keys::FnChord { mods: shortcut.mods, key: shortcut.key }
    }))
}

/// Whether `accelerator` is fn held with a key.
pub fn is_fn_chord(accelerator: &str) -> bool {
    matches!(keys(accelerator), Ok(Some(Keys::FnChord { .. })))
}

/// The keys fn may be held with, as accelerators spell them. Only keys whose
/// keycode never changes under fn: arrows, F-keys, Home/End and Page Up/Down
/// carry the fn flag on their own, and fn turns Delete and Return into other
/// keys on a laptop keyboard.
const CHORD_KEYS: [(Code, &str); 37] = {
    use Code::*;
    [
        (KeyA, "A"), (KeyB, "B"), (KeyC, "C"), (KeyD, "D"), (KeyE, "E"), (KeyF, "F"), (KeyG, "G"),
        (KeyH, "H"), (KeyI, "I"), (KeyJ, "J"), (KeyK, "K"), (KeyL, "L"), (KeyM, "M"), (KeyN, "N"),
        (KeyO, "O"), (KeyP, "P"), (KeyQ, "Q"), (KeyR, "R"), (KeyS, "S"), (KeyT, "T"), (KeyU, "U"),
        (KeyV, "V"), (KeyW, "W"), (KeyX, "X"), (KeyY, "Y"), (KeyZ, "Z"),
        (Digit0, "0"), (Digit1, "1"), (Digit2, "2"), (Digit3, "3"), (Digit4, "4"),
        (Digit5, "5"), (Digit6, "6"), (Digit7, "7"), (Digit8, "8"), (Digit9, "9"),
        (Space, "Space"),
    ]
};

/// The macOS keycode for a key fn may be held with.
pub fn chord_keycode(key: Code) -> Option<u16> {
    if !CHORD_KEYS.iter().any(|(code, _)| *code == key) { return None; }
    crate::shortcut_conflicts::keycode(key).map(|code| code as u16)
}

/// The accelerator for fn held with `keycode` and the modifiers in `flags`
/// (Quartz event flags), or `None` for a key fn can't be held with.
pub fn chord_accelerator(keycode: u16, flags: u64) -> Option<String> {
    let name = CHORD_KEYS.iter().find(|(code, _)| crate::shortcut_conflicts::keycode(*code) == Some(u64::from(keycode)))?.1;
    let mut parts = vec![FN];
    for (flag, label) in [(1u64 << 20, "Cmd"), (1 << 18, "Ctrl"), (1 << 19, "Alt"), (1 << 17, "Shift")] {
        if flags & flag != 0 { parts.push(label); }
    }
    parts.push(name);
    Some(parts.join("+"))
}

/// The one rule for what a shortcut may be: empty (unbound), fn alone, fn with
/// a letter, digit or Space, F1–F12 alone, or anything else with ⌘, ⌃ or ⌥.
pub fn validate(accelerator: &str) -> Result<(), HotkeyError> {
    match keys(accelerator).map_err(HotkeyError::invalid)? {
        None | Some(Keys::Fn) => Ok(()),
        Some(Keys::FnChord { key, .. }) => match chord_keycode(key) {
            Some(_) => Ok(()),
            None => Err(HotkeyError::invalid(CHORD_RULE)),
        },
        Some(Keys::Plain { mods, key }) => {
            if mods.intersects(Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT) { return Ok(()); }
            use Code::*;
            if matches!(key, F1 | F2 | F3 | F4 | F5 | F6 | F7 | F8 | F9 | F10 | F11 | F12) { return Ok(()); }
            Err(HotkeyError::NeedsModifier)
        }
    }
}

const CHORD_RULE: &str = "fn works with a letter, a number or Space.";

/// Whether two accelerators name the same keys ("Cmd+Shift+D" = "Shift+Cmd+D",
/// "Fn+Space" = "fn+space"). Unbound never collides with anything.
fn same_keys(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() { return false; }
    if a == b { return true; }
    matches!((keys(a), keys(b)), (Ok(Some(x)), Ok(Some(y))) if x == y)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Bindings {
    pub toggle: String,
    pub dictation: String,
    pub assistant: String,
}

impl Bindings {
    pub fn defaults() -> Self {
        Bindings { toggle: DEFAULT_TOGGLE_HOTKEY.into(), dictation: DEFAULT_DICTATION_HOTKEY.into(), assistant: DEFAULT_ASSISTANT_HOTKEY.into() }
    }

    pub fn of(settings: &Settings) -> Self {
        Bindings { toggle: settings.toggle_hotkey.clone(), dictation: settings.dictation_hotkey.clone(), assistant: settings.assistant_hotkey.clone() }
    }

    pub fn get(&self, action: Action) -> &str {
        match action { Action::Toggle => &self.toggle, Action::Dictation => &self.dictation, Action::Assistant => &self.assistant }
    }

    fn set(&mut self, action: Action, accelerator: String) {
        match action {
            Action::Toggle => self.toggle = accelerator,
            Action::Dictation => self.dictation = accelerator,
            Action::Assistant => self.assistant = accelerator,
        }
    }
}

/// What the bindings become when `action` is given `accelerator`. If another
/// action already has it, that's an error unless `swap`, in which case the two
/// trade places.
pub fn plan(current: &Bindings, action: Action, accelerator: &str, swap: bool) -> Result<Bindings, HotkeyError> {
    validate(accelerator)?;
    let mut next = current.clone();
    let holder = Action::ALL.into_iter().find(|other| *other != action && same_keys(current.get(*other), accelerator));
    if let Some(other) = holder {
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

/// Registers every shortcut. Returns each one that failed and why.
pub fn register_all(app: &AppHandle, settings: &Settings) -> Vec<(Action, String, HotkeyError)> {
    register_bindings(app, &Bindings::of(settings))
}

fn register_bindings(app: &AppHandle, bindings: &Bindings) -> Vec<(Action, String, HotkeyError)> {
    Action::ALL
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
    if action != Action::Toggle { crate::dictate::reset_key(); }
    let shortcut = match keys(accelerator).map_err(HotkeyError::invalid)? {
        None => return Ok(()),
        Some(Keys::Fn) => {
            #[cfg(target_os = "macos")]
            return crate::fn_key::bind(app, match action { Action::Toggle => 1, Action::Dictation => 2, Action::Assistant => crate::fn_key::TALK });
            #[cfg(not(target_os = "macos"))]
            return Err(HotkeyError::invalid("fn works on macOS only"));
        }
        Some(Keys::FnChord { mods, key }) => {
            let keycode = chord_keycode(key).ok_or_else(|| HotkeyError::invalid(CHORD_RULE))?;
            #[cfg(target_os = "macos")]
            return crate::fn_key::bind_chord(app, action, keycode, crate::shortcut_conflicts::flags(mods));
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (mods, keycode);
                return Err(HotkeyError::invalid("fn works on macOS only"));
            }
        }
        Some(Keys::Plain { .. }) => parse_accelerator(accelerator).map_err(HotkeyError::invalid)?,
    };
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
        Action::Assistant => app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| match event.state {
            ShortcutState::Pressed => crate::dictate::talk_key_down(app),
            ShortcutState::Released => crate::dictate::talk_key_up(app),
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
pub fn suspend(app: &AppHandle, suspended: bool) -> Result<bool, HotkeyError> {
    let mut is_suspended = registry();
    unregister_everything(app);
    *is_suspended = suspended;
    if suspended {
        // Whether a lone fn tap can be heard while recording, so Settings
        // only says "or tap fn" when it's true.
        #[cfg(target_os = "macos")]
        return Ok(match crate::fn_key::capture(app) {
            Ok(()) => true,
            Err(error) => {
                if error != HotkeyError::InputMonitoring { crate::telemetry::capture("hotkeys.fn_capture", &error.to_string()); }
                false
            }
        });
        #[cfg(not(target_os = "macos"))]
        return Ok(false);
    }
    // The startup notice lists every failure; on resume the first is enough
    // for the caller, and each row re-reads its own state.
    let failures = register_all(app, &settings::load(app));
    failures.into_iter().next().map_or(Ok(false), |(_, _, e)| Err(e))
}

/// Gives `action` a new shortcut ("" unbinds it), trading with the other
/// action when `swap` is set. Either both shortcuts end up registered and
/// saved, or nothing changes. Also ends a suspension.
pub fn set_hotkey(app: &AppHandle, action: Action, accelerator: &str, swap: bool) -> Result<(), HotkeyError> {
    {
        let mut suspended = registry();
        let mut settings = settings::load(app);
        let current = Bindings::of(&settings);
        let next = plan(&current, action, accelerator, swap)?;
        apply(app, &mut settings, &current, &next)?;
        *suspended = false;
    }
    // Choosing fn is when to ask for Input Monitoring (fn alone) or
    // Accessibility (fn with a key): only for that choice, only once it's
    // saved, and outside the registry lock.
    #[cfg(target_os = "macos")]
    if accelerator == FN && !crate::fn_key::input_monitoring_granted() {
        crate::permissions::request_input_monitoring_inner(app);
    } else if is_fn_chord(accelerator) && !crate::permissions::accessibility_granted() {
        crate::permissions::request_accessibility(app.clone());
    }
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
    // fn without Input Monitoring (or fn with a key without Accessibility) is
    // still saved: it starts working once the permission is there, and
    // Settings shows how to get there.
    let blocking = failures.into_iter().find(|(_, _, e)| !e.waits_for_permission());
    if let Some((_, _, error)) = blocking {
        unregister_everything(app);
        let _ = register_bindings(app, current);
        return Err(error);
    }
    // Only the shortcuts are written, onto the file as it is now, so a
    // setting saved elsewhere since `settings` was read is kept.
    let saved = settings::update(app, |config| {
        config.toggle_hotkey = next.toggle.clone();
        config.dictation_hotkey = next.dictation.clone();
        config.assistant_hotkey = next.assistant.clone();
        // Someone who chose their Talk to Eavesy shortcut keeps it.
        if next.assistant != current.assistant { config.assistant_hotkey_settled = Some(true); }
    });
    match saved {
        Ok(config) => {
            *settings = config;
            Ok(())
        }
        Err(error) => {
            unregister_everything(app);
            let _ = register_bindings(app, current);
            Err(HotkeyError::invalid(error))
        }
    }
}

/// The startup notification body: shortcuts that failed to register, then
/// anything else worth saying about them (`notes`: a moved default, a
/// shortcut another app also uses).
pub fn startup_notice(failures: &[(Action, String, HotkeyError)], notes: &[String]) -> Option<String> {
    let mut lines: Vec<String> = failures.iter().map(|(action, accelerator, error)| error.describe(*action, accelerator)).collect();
    lines.extend(notes.iter().cloned());
    if lines.is_empty() { return None; }
    Some(format!("{} Open Settings from the Eavesy menu bar icon to change it.", lines.join(" ")))
}

/// Talk to Eavesy used to default to ⌥Space, which Raycast, ChatGPT and Alfred
/// also default to. Someone who never chose it and has one of those apps on
/// that shortcut gets the new default instead, once. Returns the sentence
/// that says so. `holder` names the app that uses an accelerator, if any.
pub fn migrate_assistant_default(settings: &mut Settings, holder: impl FnOnce(&str) -> Option<String>) -> Option<String> {
    if settings.assistant_hotkey != OLD_ASSISTANT_HOTKEY || settings.assistant_hotkey_settled == Some(true) { return None; }
    let app = holder(OLD_ASSISTANT_HOTKEY)?;
    let next = plan(&Bindings::of(settings), Action::Assistant, DEFAULT_ASSISTANT_HOTKEY, false).ok()?;
    settings.assistant_hotkey = next.assistant;
    settings.assistant_hotkey_settled = Some(true);
    Some(format!(
        "Talk to Eavesy is now {}, because {app} also uses {}.",
        crate::tray::glyphs(DEFAULT_ASSISTANT_HOTKEY),
        crate::tray::glyphs(OLD_ASSISTANT_HOTKEY),
    ))
}

/// Moves an old ⌥Space default (see `migrate_assistant_default`) before the
/// shortcuts are registered. Returns the settings to register and what to say.
pub fn migrate_defaults(app: &AppHandle, settings: Settings) -> (Settings, Option<String>) {
    let mut moved = settings.clone();
    let Some(note) = migrate_assistant_default(&mut moved, crate::shortcut_conflicts::app_holding) else { return (settings, None) };
    let saved = settings::update(app, |config| {
        config.assistant_hotkey = moved.assistant_hotkey.clone();
        config.assistant_hotkey_settled = Some(true);
    });
    match saved {
        Ok(saved) => (saved, Some(note)),
        Err(error) => {
            crate::telemetry::capture("hotkeys.migrate_default", &error);
            (settings, None)
        }
    }
}

/// Off the main thread (it asks Launch Services and reads other apps'
/// preferences): says once, in a notification, when a saved shortcut is also
/// another installed app's, like Raycast's ⌥Space.
pub fn notice_app_conflicts(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let settings = settings::load(&app);
        let mut noted = settings.shortcut_conflicts_noted.clone().unwrap_or_default();
        let lines = crate::shortcut_conflicts::new_app_conflicts(&Bindings::of(&settings), &mut noted, crate::shortcut_conflicts::app_holding);
        if lines.is_empty() { return; }
        if let Err(error) = settings::update(&app, |config| config.shortcut_conflicts_noted = Some(noted)) {
            // Better quiet than the same notice every launch.
            crate::telemetry::capture("hotkeys.conflicts_noted", &error);
            return;
        }
        let Some(body) = startup_notice(&[], &lines) else { return };
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title("A shortcut may not reach Eavesy").body(body).show();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bindings(toggle: &str, dictation: &str) -> Bindings {
        Bindings { toggle: toggle.into(), dictation: dictation.into(), assistant: DEFAULT_ASSISTANT_HOTKEY.into() }
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
    fn talk_to_eavesy_is_a_third_shortcut_that_trades_with_either() {
        let now = bindings("Cmd+Shift+Space", "Cmd+Shift+D");
        assert_eq!(plan(&now, Action::Assistant, "Cmd+Shift+D", false), Err(HotkeyError::Taken { by: TakenBy::Dictation }));
        let swapped = plan(&now, Action::Assistant, "Cmd+Shift+D", true).unwrap();
        assert_eq!((swapped.dictation.as_str(), swapped.assistant.as_str()), (DEFAULT_ASSISTANT_HOTKEY, "Cmd+Shift+D"));
        assert_eq!(plan(&now, Action::Toggle, DEFAULT_ASSISTANT_HOTKEY, false), Err(HotkeyError::Taken { by: TakenBy::Assistant }));
        assert_eq!(HotkeyError::Taken { by: TakenBy::Assistant }.to_string(), "Already used for Talk to Eavesy.");
        assert_eq!(validate(DEFAULT_ASSISTANT_HOTKEY), Ok(()));
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
        assert_eq!(startup_notice(&[], &[]), None);
        let notice = startup_notice(&[
            (Action::Dictation, "Fn".into(), HotkeyError::InputMonitoring),
            (Action::Toggle, "Cmd+Shift+Space".into(), HotkeyError::Taken { by: TakenBy::Other }),
            (Action::Assistant, "Fn+Space".into(), HotkeyError::Accessibility),
        ], &[]).unwrap();
        assert!(notice.contains("Talk shortcut (fn) needs Input Monitoring"), "{notice}");
        assert!(notice.contains("Open Eavesy shortcut (⌘⇧Space) is in use by another app"), "{notice}");
        assert!(notice.contains("Talk to Eavesy shortcut (fn Space) needs Accessibility"), "{notice}");
        let moved = startup_notice(&[], &["Talk to Eavesy is now ⌥⇧Space.".into()]).unwrap();
        assert!(moved.starts_with("Talk to Eavesy is now ⌥⇧Space."), "{moved}");
    }

    #[test]
    fn fn_chords_parse_validate_and_collide_like_any_shortcut() {
        assert_eq!(keys(""), Ok(None));
        assert_eq!(keys("Fn"), Ok(Some(Keys::Fn)));
        assert_eq!(keys("Fn+Space"), Ok(Some(Keys::FnChord { mods: Modifiers::empty(), key: Code::Space })));
        assert_eq!(keys("fn+Shift+K"), Ok(Some(Keys::FnChord { mods: Modifiers::SHIFT, key: Code::KeyK })));
        assert_eq!(keys("Alt+Space"), Ok(Some(Keys::Plain { mods: Modifiers::ALT, key: Code::Space })));
        assert!(keys("Fn+Fn+Space").is_err());
        for ok in ["Fn+Space", "Fn+K", "Fn+7", "Fn+Ctrl+Space", "Fn+Cmd+Shift+A"] {
            assert_eq!(validate(ok), Ok(()), "{ok}");
        }
        // Keys that carry the fn flag on their own, or change under fn.
        for refused in ["Fn+Left", "Fn+ArrowUp", "Fn+F5", "Fn+Enter", "Fn+Backspace", "Fn+Home", "Fn+Tab"] {
            assert!(matches!(validate(refused), Err(HotkeyError::Invalid { .. })), "{refused}");
        }
        assert!(same_keys("Fn+Space", "fn+space"));
        assert!(same_keys("Fn+Shift+Ctrl+K", "fn+ctrl+shift+k"));
        assert!(!same_keys("Fn+Space", "Space"));
        assert!(!same_keys("Fn", "Fn+Space"));
        let now = Bindings { toggle: "Cmd+Shift+Space".into(), dictation: "Fn".into(), assistant: "Fn+Space".into() };
        assert_eq!(plan(&now, Action::Toggle, "fn+space", false), Err(HotkeyError::Taken { by: TakenBy::Assistant }));
        assert_eq!(plan(&now, Action::Toggle, "Fn+K", false).map(|b| b.toggle), Ok("Fn+K".to_string()));
        assert!(is_fn_chord("Fn+Space") && !is_fn_chord("Fn") && !is_fn_chord("Alt+Space"));
    }

    #[test]
    fn a_recorded_fn_chord_spells_its_accelerator() {
        const SHIFT: u64 = 1 << 17;
        const CTRL: u64 = 1 << 18;
        const FN_FLAG: u64 = 1 << 23;
        assert_eq!(chord_accelerator(49, FN_FLAG).as_deref(), Some("Fn+Space"));
        assert_eq!(chord_accelerator(40, FN_FLAG | CTRL | SHIFT).as_deref(), Some("Fn+Ctrl+Shift+K"));
        assert_eq!(chord_accelerator(126, FN_FLAG), None, "arrows carry fn on their own");
        assert_eq!(chord_accelerator(36, FN_FLAG), None, "Return is not a chord key");
        assert_eq!(chord_keycode(Code::Space), Some(49));
        assert_eq!(chord_keycode(Code::ArrowUp), None);
        for spelled in ["Fn+Space", "Fn+Ctrl+Shift+K"] {
            assert_eq!(validate(spelled), Ok(()));
        }
    }

    #[test]
    fn errors_that_wait_for_a_permission_do_not_block_saving() {
        assert!(HotkeyError::InputMonitoring.waits_for_permission());
        assert!(HotkeyError::Accessibility.waits_for_permission());
        assert!(!HotkeyError::Taken { by: TakenBy::Other }.waits_for_permission());
        assert_eq!(serde_json::to_value(HotkeyError::Accessibility).unwrap(), serde_json::json!({"kind": "accessibility"}));
    }

    #[test]
    fn the_old_option_space_default_moves_once_and_only_when_an_app_holds_it() {
        let raycast = |_: &str| Some("Raycast".to_string());
        let nobody = |_: &str| None;
        let mut old = Settings { assistant_hotkey: OLD_ASSISTANT_HOTKEY.into(), ..Settings::default() };
        assert_eq!(migrate_assistant_default(&mut old.clone(), nobody), None, "no app on ⌥Space: leave it");
        let note = migrate_assistant_default(&mut old, raycast).unwrap();
        assert_eq!(old.assistant_hotkey, DEFAULT_ASSISTANT_HOTKEY);
        assert_eq!(old.assistant_hotkey_settled, Some(true));
        assert!(note.contains("Raycast also uses ⌥Space"), "{note}");
        // Picking ⌥Space again afterwards sticks.
        old.assistant_hotkey = OLD_ASSISTANT_HOTKEY.into();
        assert_eq!(migrate_assistant_default(&mut old, raycast), None);
        // A shortcut the person chose is never moved.
        let mut chosen = Settings { assistant_hotkey: "Cmd+Alt+K".into(), ..Settings::default() };
        assert_eq!(migrate_assistant_default(&mut chosen, raycast), None);
        // Nor is it moved onto a shortcut another action already has.
        let mut clash = Settings { assistant_hotkey: OLD_ASSISTANT_HOTKEY.into(), toggle_hotkey: DEFAULT_ASSISTANT_HOTKEY.into(), ..Settings::default() };
        assert_eq!(migrate_assistant_default(&mut clash, raycast), None);
        assert_eq!(clash.assistant_hotkey, OLD_ASSISTANT_HOTKEY);
    }
}
