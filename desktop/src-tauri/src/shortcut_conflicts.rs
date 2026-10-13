use serde::Serialize;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use std::str::FromStr;

#[derive(Serialize)]
pub struct Conflict { pub title: String, pub detail: String }

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

pub fn check(accelerator: &str) -> Option<Conflict> {
    if accelerator == "Fn" {
        return Some(Conflict { title: "Fn / Globe may also trigger macOS".into(), detail:
            "In System Settings → Keyboard, set ‘Press Fn/Globe key to’ to ‘Do Nothing’. Check Apple's Dictation shortcut too. Eavesy uses a single tap to start or stop; Fn combinations and holds keep their normal behavior. Fn requires Input Monitoring access.".into() });
    }
    let shortcut=Shortcut::from_str(accelerator).ok()?;
    #[cfg(target_os = "macos")]
    if let Some(code)=keycode(shortcut.key) {
        use std::io::Write;
        use std::process::{Command, Stdio};
        if let Ok(export)=Command::new("/usr/bin/defaults").args(["export", "com.apple.symbolichotkeys", "-"]).output() {
            if export.status.success() {
                if let Ok(mut convert)=Command::new("/usr/bin/plutil").args(["-convert","json","-o","-","--","-"])
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
                    if let Some(mut input)=convert.stdin.take() { let _=input.write_all(&export.stdout); }
                    if let Ok(output)=convert.wait_with_output() {
                        if let Ok(value)=serde_json::from_slice(&output.stdout) {
                            if let Some(id)=symbolic_match(&value,code,flags(&shortcut)) {
                                let name=match id.as_str() { "64"=>"Spotlight", "65"=>"Finder search", "60"|"61"=>"Input source switching", "32"=>"Mission Control", "36"=>"Desktop", _=>"an enabled macOS shortcut" };
                                return Some(Conflict { title:format!("Already assigned to {name}"), detail: "Open System Settings → Keyboard → Keyboard Shortcuts to disable or change the macOS binding, then return here and save. You can also choose another Eavesy shortcut.".into() });
                            }
                        }
                    }
                }
            }
        }
    }
    let command=shortcut.mods.contains(Modifiers::SUPER);
    let common=command && matches!(shortcut.key, Code::KeyC|Code::KeyV|Code::KeyX|Code::KeyA|Code::KeyQ|Code::KeyW|Code::KeyD|Code::KeyS|Code::KeyZ|Code::Space);
    common.then(|| Conflict { title:"Possible macOS or application conflict".into(), detail: "This combination is commonly used by macOS or other apps. Eavesy's global binding can take precedence. Check Keyboard Shortcuts in System Settings or choose another combination. App-specific bindings cannot all be detected automatically.".into() })
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
}
