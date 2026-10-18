use serde::Serialize;

use crate::hotkeys::{plan, Action, Bindings, HotkeyError};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use std::str::FromStr;

/// A shortcut Eavesy can register but that something else probably uses too.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Conflict {
    /// An enabled macOS keyboard shortcut (System Settings → Keyboard Shortcuts).
    System { name: String },
    /// A ⌘ combination most apps use, like ⌘C for Copy.
    Common { name: String },
}

fn keycode(key: Code) -> Option<u64> {
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
fn flags(shortcut: &Shortcut) -> u64 {
    let mut value=0;
    for (modifier, flag) in [(Modifiers::SHIFT,1<<17), (Modifiers::CONTROL,1<<18),
        (Modifiers::ALT,1<<19), (Modifiers::SUPER,1<<20)] {
        if shortcut.mods.contains(modifier) { value |= flag; }
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
/// rule, belongs to the other action, or clashes with macOS or common apps.
pub fn check(current: &Bindings, action: Action, accelerator: &str) -> Result<Option<Conflict>, HotkeyError> {
    plan(current, action, accelerator, false)?;
    if accelerator.is_empty() || accelerator == crate::hotkeys::FN { return Ok(None); }
    let Ok(shortcut) = Shortcut::from_str(accelerator) else { return Ok(None) };
    if let Some(name) = system_match(&shortcut) { return Ok(Some(Conflict::System { name })); }
    Ok(common_name(&shortcut).map(|name| Conflict::Common { name: name.into() }))
}

#[cfg(target_os = "macos")]
fn system_match(shortcut: &Shortcut) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let code = keycode(shortcut.key)?;
    let export = Command::new("/usr/bin/defaults").args(["export", "com.apple.symbolichotkeys", "-"]).output().ok()?;
    if !export.status.success() { return None; }
    let mut convert = Command::new("/usr/bin/plutil").args(["-convert", "json", "-o", "-", "--", "-"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    if let Some(mut input) = convert.stdin.take() { let _ = input.write_all(&export.stdout); }
    let output = convert.wait_with_output().ok()?;
    let value = serde_json::from_slice(&output.stdout).ok()?;
    let id = symbolic_match(&value, code, flags(shortcut))?;
    Some(system_name(&id).into())
}

#[cfg(not(target_os = "macos"))]
fn system_match(_: &Shortcut) -> Option<String> { None }

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

/// The everyday meaning of a plain ⌘ combination in most apps.
fn common_name(shortcut: &Shortcut) -> Option<&'static str> {
    if shortcut.mods != Modifiers::SUPER { return None; }
    use Code::*;
    Some(match shortcut.key {
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
    fn fn_is_never_a_conflict_and_common_combos_are_named() {
        let now = Bindings { toggle: "Cmd+Shift+Space".into(), dictation: "Cmd+Shift+D".into() };
        assert_eq!(check(&now, Action::Dictation, "Fn"), Ok(None));
        assert_eq!(check(&now, Action::Dictation, ""), Ok(None));
        assert_eq!(common_name(&Shortcut::from_str("Cmd+C").unwrap()), Some("Copy"));
        assert_eq!(common_name(&Shortcut::from_str("Cmd+Shift+C").unwrap()), None);
        assert_eq!(check(&now, Action::Dictation, "Shift+K"), Err(HotkeyError::NeedsModifier));
        assert!(matches!(check(&now, Action::Dictation, "Cmd+Shift+Space"), Err(HotkeyError::Taken { .. })));
    }
}
