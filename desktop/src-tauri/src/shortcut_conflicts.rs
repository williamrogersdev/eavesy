use serde::Serialize;

use crate::hotkeys::{keys, plan, Action, Bindings, HotkeyError, Keys};
use tauri_plugin_global_shortcut::{Code, Modifiers};

/// A shortcut Eavesy can register but that something else probably uses too.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Conflict {
    /// An enabled macOS keyboard shortcut (System Settings → Keyboard Shortcuts).
    System { name: String },
    /// Another installed app's global shortcut, like Raycast's ⌥Space.
    App { name: String },
    /// One of macOS's own 🌐 shortcuts, like fn+E for Emoji & Symbols.
    Globe { name: String },
    /// A ⌘ combination most apps use, like ⌘C for Copy.
    Common { name: String },
}

pub(crate) fn keycode(key: Code) -> Option<u64> {
    use Code::*;
    Some(match key {
        KeyA=>0, KeyS=>1, KeyD=>2, KeyF=>3, KeyH=>4, KeyG=>5, KeyZ=>6, KeyX=>7,
        KeyC=>8, KeyV=>9, KeyB=>11, KeyQ=>12, KeyW=>13, KeyE=>14, KeyR=>15,
        KeyY=>16, KeyT=>17, Digit1=>18, Digit2=>19, Digit3=>20, Digit4=>21,
        Digit6=>22, Digit5=>23, Equal=>24, Digit9=>25, Digit7=>26, Minus=>27,
        Digit8=>28, Digit0=>29, BracketRight=>30, KeyO=>31, KeyU=>32,
        BracketLeft=>33, KeyI=>34, KeyP=>35, Enter=>36, KeyL=>37, KeyJ=>38,
        Quote=>39, KeyK=>40, Semicolon=>41, Backslash=>42, Comma=>43, Slash=>44,
        KeyN=>45, KeyM=>46, Period=>47, Tab=>48, Space=>49, Backquote=>50,
        Backspace=>51, Escape=>53, F1=>122, F2=>120, F3=>99, F4=>118, F5=>96,
        F6=>97, F7=>98, F8=>100, F9=>101, F10=>109, F11=>103, F12=>111,
        ArrowLeft=>123, ArrowRight=>124, ArrowDown=>125, ArrowUp=>126,
        _=>return None,
    })
}

/// Quartz event flags for ⇧ ⌃ ⌥ ⌘ (no fn).
pub(crate) fn flags(mods: Modifiers) -> u64 {
    let mut value=0;
    for (modifier, flag) in [(Modifiers::SHIFT,1<<17), (Modifiers::CONTROL,1<<18),
        (Modifiers::ALT,1<<19), (Modifiers::SUPER,1<<20)] {
        if mods.contains(modifier) { value |= flag; }
    }
    value
}
fn symbolic_match(value: &serde_json::Value, code: u64, mods: u64) -> Option<String> {
    value.get("AppleSymbolicHotKeys")?.as_object()?.iter().find_map(|(id, entry)| {
        if entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            let params = entry.pointer("/value/parameters")?.as_array()?;
            if params.get(1)?.as_u64()? == code && params.get(2)?.as_u64()? == mods { return Some(id.clone()); }
        }
        None
    })
}

/// What the Settings UI needs before saving a shortcut: whether it breaks the
/// rule, belongs to another action, or clashes with macOS or other apps.
pub fn check(current: &Bindings, action: Action, accelerator: &str) -> Result<Option<Conflict>, HotkeyError> {
    plan(current, action, accelerator, false)?;
    Ok(lookup(accelerator, true))
}

/// What else uses `accelerator`: macOS, an installed app, a 🌐 shortcut, or
/// (with `common`) a ⌘ combination most apps use.
pub fn lookup(accelerator: &str, common: bool) -> Option<Conflict> {
    match keys(accelerator).ok()?? {
        Keys::Fn => None,
        Keys::FnChord { mods, key } => globe_name(mods, key).map(|name| Conflict::Globe { name: name.into() }),
        Keys::Plain { mods, key } => {
            if let Some(name) = system_match(mods, key) { return Some(Conflict::System { name }); }
            if let Some(name) = app_holding(accelerator) { return Some(Conflict::App { name }); }
            if !common { return None; }
            common_name(mods, key).map(|name| Conflict::Common { name: name.into() })
        }
    }
}

/// What else uses each saved shortcut, for the notes Settings keeps under
/// them. ⌘ combinations most apps use are left out: choosing one meant
/// clicking "Use anyway".
pub fn check_saved(current: &Bindings) -> SavedConflicts {
    SavedConflicts {
        toggle: lookup(current.get(Action::Toggle), false),
        dictation: lookup(current.get(Action::Dictation), false),
        assistant: lookup(current.get(Action::Assistant), false),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedConflicts {
    pub toggle: Option<Conflict>,
    pub dictation: Option<Conflict>,
    pub assistant: Option<Conflict>,
}

/// Sentences for the startup notice about saved shortcuts another app also
/// uses, each said once: `noted` holds the ones already said, and gains the
/// new ones. `holder` names the app that uses an accelerator.
pub fn new_app_conflicts(current: &Bindings, noted: &mut Vec<String>, holder: impl Fn(&str) -> Option<String>) -> Vec<String> {
    let mut lines = Vec::new();
    for action in Action::ALL {
        let accelerator = current.get(action);
        if accelerator.is_empty() { continue; }
        let Some(app) = holder(accelerator) else { continue };
        let name = match action { Action::Toggle => "toggle", Action::Dictation => "dictation", Action::Assistant => "assistant" };
        let key = format!("{name}:{accelerator}:{app}");
        if noted.contains(&key) { continue; }
        noted.push(key);
        lines.push(format!(
            "Your {} shortcut ({}) is also {app}'s, so it may not reach Eavesy.",
            action.label(),
            crate::tray::glyphs(accelerator),
        ));
    }
    lines
}

#[cfg(target_os = "macos")]
fn system_match(mods: Modifiers, key: Code) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let code = keycode(key)?;
    let export = Command::new("/usr/bin/defaults").args(["export", "com.apple.symbolichotkeys", "-"]).output().ok()?;
    if !export.status.success() { return None; }
    let mut convert = Command::new("/usr/bin/plutil").args(["-convert", "json", "-o", "-", "--", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    if let Some(mut input) = convert.stdin.take() { let _ = input.write_all(&export.stdout); }
    let output = convert.wait_with_output().ok()?;
    let value = serde_json::from_slice(&output.stdout).ok()?;
    let id = symbolic_match(&value, code, flags(mods))?;
    Some(system_name(&id).into())
}

#[cfg(not(target_os = "macos"))]
fn system_match(_: Modifiers, _: Code) -> Option<String> { None }

fn system_name(id: &str) -> &'static str {
    match id {
        "64" => "Spotlight",
        "65" => "Finder search",
        "60" | "61" => "input source switching",
        "32" | "34" => "Mission Control",
        "33" | "35" => "App Exposé",
        "36" | "37" => "Show Desktop",
        "28" | "29" | "30" | "31" | "184" => "Screenshots",
        "162" => "Dictation",
        "163" => "Notification Center",
        "175" => "Do Not Disturb",
        _ => "a macOS shortcut",
    }
}

/// How an app stores its global shortcut, when it can be read.
#[derive(Debug, Clone, Copy)]
enum Pref {
    /// Unreadable: assume the app's default.
    None,
    /// Raycast: "Command-49", "Option-Shift-49" (modifier names, then a keycode).
    Raycast(&'static str),
    /// sindresorhus/KeyboardShortcuts: `{"carbonKeyCode":49,"carbonModifiers":2048}`.
    KeyboardShortcuts(&'static str),
}

struct KnownApp {
    name: &'static str,
    bundle_id: &'static str,
    /// What the app ships with, as (keycode, Quartz flags).
    default: (u64, u64),
    pref: Pref,
}

const OPTION: u64 = 1 << 19;
const COMMAND: u64 = 1 << 20;
const SPACE: u64 = 49;

/// Launchers and assistants that ship with a global shortcut people often
/// pick for Eavesy too.
const KNOWN_APPS: [KnownApp; 3] = [
    KnownApp { name: "Raycast", bundle_id: "com.raycast.macos", default: (SPACE, OPTION), pref: Pref::Raycast("raycastGlobalHotkey") },
    KnownApp { name: "ChatGPT", bundle_id: "com.openai.chat", default: (SPACE, OPTION), pref: Pref::KeyboardShortcuts("KeyboardShortcuts_toggleLauncher") },
    KnownApp { name: "Alfred", bundle_id: "com.runningwithcrayons.Alfred", default: (SPACE, OPTION), pref: Pref::None },
];

/// The shortcut an app's preference holds, as (keycode, Quartz flags), or
/// `None` when it can't be read (then the app's default is assumed).
fn parse_pref(pref: Pref, raw: &str) -> Option<(u64, u64)> {
    let raw = raw.trim();
    match pref {
        Pref::None => None,
        Pref::Raycast(_) => {
            let mut parts: Vec<&str> = raw.split('-').collect();
            let code = parts.pop()?.trim().parse().ok()?;
            let mut mods = 0;
            for part in parts {
                mods |= match part.trim() {
                    "Command" => COMMAND,
                    "Option" => OPTION,
                    "Control" => 1 << 18,
                    "Shift" => 1 << 17,
                    _ => return None,
                };
            }
            Some((code, mods))
        }
        Pref::KeyboardShortcuts(_) => {
            let value: serde_json::Value = serde_json::from_str(raw).ok()?;
            let code = value.get("carbonKeyCode")?.as_u64()?;
            let carbon = value.get("carbonModifiers")?.as_u64()?;
            let mut mods = 0;
            for (bit, flag) in [(256, COMMAND), (512, 1 << 17), (2048, OPTION), (4096, 1 << 18)] {
                if carbon & bit != 0 { mods |= flag; }
            }
            Some((code, mods))
        }
    }
}

/// The installed app (or apps) whose global shortcut is `accelerator`, e.g.
/// "Raycast" or "Raycast and ChatGPT".
pub fn app_holding(accelerator: &str) -> Option<String> {
    let Ok(Some(Keys::Plain { mods, key })) = keys(accelerator) else { return None };
    let wanted = (keycode(key)?, flags(mods));
    let names: Vec<&str> = KNOWN_APPS
        .iter()
        // Only apps whose default could be it are worth asking macOS about.
        .filter(|app| app.default == wanted || !matches!(app.pref, Pref::None))
        .filter(|app| installed(app.bundle_id))
        .filter(|app| current_shortcut(app) == wanted)
        .map(|app| app.name)
        .collect();
    (!names.is_empty()).then(|| names.join(" and "))
}

fn current_shortcut(app: &KnownApp) -> (u64, u64) {
    let key = match app.pref {
        Pref::None => return app.default,
        Pref::Raycast(key) | Pref::KeyboardShortcuts(key) => key,
    };
    read_pref(app.bundle_id, key).and_then(|raw| parse_pref(app.pref, &raw)).unwrap_or(app.default)
}

#[cfg(target_os = "macos")]
fn read_pref(bundle_id: &str, key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/defaults").args(["read", bundle_id, key]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn read_pref(_: &str, _: &str) -> Option<String> { None }

/// Whether Launch Services knows an app with this bundle id.
#[cfg(target_os = "macos")]
fn installed(bundle_id: &str) -> bool {
    use crate::cf::{cf_str, CFArrayGetCount, CFTypeRef, Owned};
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyApplicationURLsForBundleIdentifier(bundle_id: CFTypeRef, error: *mut CFTypeRef) -> CFTypeRef;
    }
    unsafe {
        let id = cf_str(bundle_id);
        if id.0.is_null() { return false; }
        let urls = Owned(LSCopyApplicationURLsForBundleIdentifier(id.0, std::ptr::null_mut()));
        !urls.0.is_null() && CFArrayGetCount(urls.0) > 0
    }
}

#[cfg(not(target_os = "macos"))]
fn installed(_: &str) -> bool { false }

/// macOS's own 🌐 (fn) shortcuts, which an fn chord would take over.
fn globe_name(mods: Modifiers, key: Code) -> Option<&'static str> {
    use Code::*;
    if !mods.is_empty() { return None; }
    Some(match key {
        KeyA => "Dock focus",
        KeyC => "Control Center",
        KeyE => "Emoji & Symbols",
        KeyF => "Full Screen",
        KeyH => "Show Desktop",
        KeyM => "menu bar focus",
        KeyN => "Notification Center",
        KeyQ => "Quick Note",
        _ => return None,
    })
}

/// The everyday meaning of a plain ⌘ combination in most apps.
fn common_name(mods: Modifiers, key: Code) -> Option<&'static str> {
    if mods != Modifiers::SUPER { return None; }
    use Code::*;
    Some(match key {
        KeyC => "Copy", KeyV => "Paste", KeyX => "Cut", KeyA => "Select All", KeyZ => "Undo",
        KeyS => "Save", KeyQ => "Quit", KeyW => "Close", KeyN => "New", KeyO => "Open",
        KeyP => "Print", KeyF => "Find", KeyT => "New Tab", KeyH => "Hide", KeyM => "Minimize",
        KeyR => "Reload", KeyD => "Duplicate", Comma => "Settings", Space => "Spotlight",
        Tab => "the app switcher", Backquote => "window switching",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::DEFAULT_ASSISTANT_HOTKEY;

    #[test]
    fn only_enabled_matching_system_binding_warns() {
        let prefs=serde_json::json!({"AppleSymbolicHotKeys":{
            "64":{"enabled":true,"value":{"parameters":[32,49,1048576]}},
            "65":{"enabled":false,"value":{"parameters":[32,49,1572864]}}
        }});
        assert_eq!(symbolic_match(&prefs,49,1048576),Some("64".into()));
        assert_eq!(symbolic_match(&prefs,49,1572864),None);
        assert_eq!(symbolic_match(&prefs,2,1048576),None);
    }

    #[test]
    fn the_default_avoids_the_stock_input_source_and_launcher_shortcuts() {
        // Stock macOS: 60 ⌃Space, 61 ⌃⌥Space (input sources), 64 ⌘Space, 65 ⌘⌥Space.
        let stock = serde_json::json!({"AppleSymbolicHotKeys":{
            "60":{"enabled":true,"value":{"parameters":[32,49,262144]}},
            "61":{"enabled":true,"value":{"parameters":[32,49,786432]}},
            "64":{"enabled":true,"value":{"parameters":[32,49,1048576]}},
            "65":{"enabled":true,"value":{"parameters":[32,49,1572864]}}
        }});
        let Ok(Some(Keys::Plain { mods, key })) = keys(DEFAULT_ASSISTANT_HOTKEY) else { panic!("default parses") };
        assert_eq!(symbolic_match(&stock, keycode(key).unwrap(), flags(mods)), None);
        assert!(KNOWN_APPS.iter().all(|app| app.default != (keycode(key).unwrap(), flags(mods))));
        assert_eq!(common_name(mods, key), None);
    }

    #[test]
    fn fn_is_never_a_conflict_and_common_combos_are_named() {
        let now = Bindings { toggle: "Cmd+Shift+Space".into(), dictation: "Cmd+Shift+D".into(), assistant: "Alt+Shift+Space".into() };
        assert_eq!(check(&now, Action::Dictation, "Fn"), Ok(None));
        assert_eq!(check(&now, Action::Dictation, ""), Ok(None));
        assert_eq!(common_name(Modifiers::SUPER, Code::KeyC), Some("Copy"));
        assert_eq!(common_name(Modifiers::SUPER | Modifiers::SHIFT, Code::KeyC), None);
        assert_eq!(check(&now, Action::Dictation, "Shift+K"), Err(HotkeyError::NeedsModifier));
        assert!(matches!(check(&now, Action::Dictation, "Cmd+Shift+Space"), Err(HotkeyError::Taken { .. })));
    }

    #[test]
    fn fn_chords_on_macos_globe_shortcuts_are_named() {
        let now = Bindings { toggle: "Cmd+Shift+Space".into(), dictation: "Fn".into(), assistant: "Alt+Shift+Space".into() };
        assert_eq!(check(&now, Action::Assistant, "Fn+E"), Ok(Some(Conflict::Globe { name: "Emoji & Symbols".into() })));
        assert_eq!(check(&now, Action::Assistant, "Fn+Space"), Ok(None));
        assert_eq!(check(&now, Action::Assistant, "Fn+Shift+E"), Ok(None));
        assert_eq!(serde_json::to_value(Conflict::App { name: "Raycast".into() }).unwrap(), serde_json::json!({"kind": "app", "name": "Raycast"}));
    }

    #[test]
    fn app_shortcut_prefs_parse_or_fall_back_to_the_default() {
        let raycast = Pref::Raycast("k");
        assert_eq!(parse_pref(raycast, "Command-49\n"), Some((SPACE, COMMAND)));
        assert_eq!(parse_pref(raycast, "Option-Shift-49"), Some((SPACE, OPTION | (1 << 17))));
        assert_eq!(parse_pref(raycast, "Hyper-49"), None);
        assert_eq!(parse_pref(raycast, "49"), Some((SPACE, 0)));
        let chatgpt = Pref::KeyboardShortcuts("k");
        assert_eq!(parse_pref(chatgpt, r#"{"carbonKeyCode":49,"carbonModifiers":2048}"#), Some((SPACE, OPTION)));
        assert_eq!(parse_pref(chatgpt, r#"{"carbonModifiers":2560,"carbonKeyCode":18}"#), Some((18, OPTION | (1 << 17))));
        assert_eq!(parse_pref(chatgpt, "false"), None);
        assert_eq!(parse_pref(Pref::None, "anything"), None);
    }

    #[test]
    fn startup_says_once_which_saved_shortcut_another_app_uses() {
        let now = Bindings { toggle: "Cmd+Shift+Space".into(), dictation: "".into(), assistant: "Alt+Space".into() };
        let raycast = |accelerator: &str| (accelerator == "Alt+Space").then(|| "Raycast".to_string());
        let mut noted = Vec::new();
        let first = new_app_conflicts(&now, &mut noted, raycast);
        assert_eq!(first, vec!["Your Talk to Eavesy shortcut (⌥Space) is also Raycast's, so it may not reach Eavesy.".to_string()]);
        assert_eq!(noted, vec!["assistant:Alt+Space:Raycast".to_string()]);
        assert!(new_app_conflicts(&now, &mut noted, raycast).is_empty(), "said once");
    }
}
