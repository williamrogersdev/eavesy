//! Adds Eavesy's hooks to Claude Code's user settings (`~/.claude/settings.json`)
//! when you turn on talking with your sessions, and takes them out when you
//! turn it off. Your other settings and hooks are left as they are. The hook
//! command points at this app, so it's rewritten when the app moves.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Every hook command Eavesy writes has this in it, which is how it finds its own.
const MARK: &str = "--agent-hook";
const EVENTS: [(&str, &str); 3] = [("Stop", "stop"), ("Notification", "notification"), ("UserPromptSubmit", "prompt")];
/// Seconds Claude Code waits for a hook that doesn't hold.
const QUICK_TIMEOUT: u64 = 5;

pub fn settings_file() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("settings.json"))
}

/// Writes the hooks for `exe`, with the Stop hook allowed to wait `hold_secs`.
pub fn install(file: &Path, exe: &Path, hold_secs: u32) -> Result<(), String> {
    let current = read(file)?;
    let next = with_hooks(current.clone(), &exe.to_string_lossy(), hold_secs);
    if next != current {
        write(file, &next)?;
    }
    Ok(())
}

pub fn uninstall(file: &Path) -> Result<(), String> {
    if !file.exists() {
        return Ok(());
    }
    let current = read(file)?;
    let next = without_hooks(current.clone());
    if next != current {
        write(file, &next)?;
    }
    Ok(())
}

/// Whether the file already has Eavesy's hooks for exactly this app and hold.
#[cfg(test)]
fn installed(file: &Path, exe: &Path, hold_secs: u32) -> bool {
    read(file).map(|current| with_hooks(current.clone(), &exe.to_string_lossy(), hold_secs) == current).unwrap_or(false)
}

fn command(exe: &str, event: &str) -> String {
    format!("'{}' {MARK} {event}", exe.replace('\'', r"'\''"))
}

pub fn with_hooks(settings: Value, exe: &str, hold_secs: u32) -> Value {
    let mut settings = without_hooks(settings);
    let root = settings.as_object_mut().expect("without_hooks returns an object");
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().expect("just made an object");
    for (name, event) in EVENTS {
        let timeout = if event == "stop" { u64::from(hold_secs) + 30 } else { QUICK_TIMEOUT };
        let entry = json!({ "hooks": [{ "type": "command", "command": command(exe, event), "timeout": timeout }] });
        match hooks.entry(name).or_insert_with(|| json!([])) {
            Value::Array(list) => list.push(entry),
            other => *other = json!([entry]),
        }
    }
    settings
}

pub fn without_hooks(settings: Value) -> Value {
    let mut root = match settings {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Some(Value::Object(hooks)) = root.get_mut("hooks") {
        for (name, _) in EVENTS {
            let Some(Value::Array(list)) = hooks.get_mut(name) else { continue };
            for entry in list.iter_mut() {
                if let Some(Value::Array(inner)) = entry.get_mut("hooks") {
                    inner.retain(|hook| !is_ours(hook));
                }
            }
            list.retain(|entry| entry.get("hooks").and_then(Value::as_array).is_none_or(|inner| !inner.is_empty()));
            if list.is_empty() {
                hooks.remove(name);
            }
        }
        if hooks.is_empty() {
            root.remove("hooks");
        }
    }
    Value::Object(root)
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command").and_then(Value::as_str).is_some_and(|command| command.contains(MARK))
}

fn read(file: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(file) {
        Ok(raw) if raw.trim().is_empty() => Ok(json!({})),
        // Never rewrite a file we can't read: it would lose your settings.
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| format!("{} isn't valid JSON, so Eavesy left it alone.", file.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("Couldn't read {}: {error}", file.display())),
    }
}

/// Written aside and renamed over, so Claude Code never reads half a file.
fn write(file: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let mut raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    raw.push('\n');
    let partial = file.with_extension(format!("json.eavesy-{}", uuid::Uuid::new_v4().simple()));
    let result = std::fs::write(&partial, raw).and_then(|()| std::fs::rename(&partial, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result.map_err(|error| format!("Couldn't update {}: {error}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/Applications/Eavesy.app/Contents/MacOS/eavesy";

    #[test]
    fn installing_keeps_your_own_hooks_and_settings() {
        let mine = json!({
            "model": "opus",
            "hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "afplay done.aiff" }] }] }
        });
        let out = with_hooks(mine, EXE, 300);
        assert_eq!(out["model"], "opus");
        let stop = out["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "afplay done.aiff");
        assert_eq!(stop[1]["hooks"][0]["command"], format!("'{EXE}' --agent-hook stop"));
        assert_eq!(stop[1]["hooks"][0]["timeout"], 330);
        assert_eq!(out["hooks"]["UserPromptSubmit"][0]["hooks"][0]["timeout"], 5);
    }

    #[test]
    fn installing_twice_or_from_a_moved_app_leaves_one_copy() {
        let once = with_hooks(json!({}), "/old/eavesy", 300);
        let twice = with_hooks(once, EXE, 120);
        let stop = twice["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], format!("'{EXE}' --agent-hook stop"));
        assert_eq!(stop[0]["hooks"][0]["timeout"], 150);
    }

    #[test]
    fn uninstalling_takes_out_only_eavesy() {
        let mine = json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "afplay done.aiff" }] }] }, "env": {} });
        let back = without_hooks(with_hooks(mine.clone(), EXE, 300));
        assert_eq!(back, mine);
        assert_eq!(without_hooks(with_hooks(json!({}), EXE, 300)), json!({}));
    }

    #[test]
    fn a_path_with_a_quote_stays_one_argument() {
        assert_eq!(command("/Users/o'neil/Eavesy", "stop"), r"'/Users/o'\''neil/Eavesy' --agent-hook stop");
    }

    #[test]
    fn the_file_round_trips_and_bad_json_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("eavesy-install-{}", uuid::Uuid::new_v4().simple()));
        let file = dir.join("settings.json");
        install(&file, Path::new(EXE), 300).unwrap();
        assert!(installed(&file, Path::new(EXE), 300));
        assert!(!installed(&file, Path::new(EXE), 60));
        uninstall(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), "{}");
        std::fs::write(&file, "{ not json").unwrap();
        assert!(install(&file, Path::new(EXE), 300).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(dir);
    }
}
