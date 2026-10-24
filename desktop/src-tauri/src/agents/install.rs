//! Adds Eavesy's hooks to Claude Code's user settings (`~/.claude/settings.json`)
//! when you turn on talking with your sessions, and takes them out when you
//! turn it off. Your other settings and hooks are left as they are. The hook
//! command points at this app, so it's rewritten when the app moves.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// Every hook command Eavesy writes has this in it, which is how it finds its own.
const MARK: &str = "--agent-hook";
const EVENTS: [(&str, &str); 4] = [
    ("Stop", "stop"),
    ("Notification", "notification"),
    ("UserPromptSubmit", "prompt"),
    // Only to take an approval off the card once you've given it in Claude.
    ("PostToolUse", "tool_done"),
];
/// Seconds Claude Code waits for a hook that doesn't hold.
const QUICK_TIMEOUT: u64 = 5;

pub fn settings_file() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("settings.json"))
}

/// Writes the hooks for `exe`, with the Stop hook allowed to wait `hold_secs`.
pub fn install(file: &Path, exe: &Path, hold_secs: u32) -> Result<(), String> {
    update(file, |current| with_hooks(current, &exe.to_string_lossy(), hold_secs))
}

pub fn uninstall(file: &Path) -> Result<(), String> {
    if !file.exists() {
        return Ok(());
    }
    update(file, without_hooks)
}

/// Reads, changes and writes the file. If Claude Code wrote it in the
/// meantime, the change is made again on top of its version instead.
fn update(file: &Path, change: impl Fn(Value) -> Value) -> Result<(), String> {
    for _ in 0..3 {
        let current = read(file)?;
        check_shape(file, &current)?;
        let next = change(current.clone());
        if next == current || write(file, &current, &next)? {
            return Ok(());
        }
    }
    Err(format!("{} kept changing while Eavesy updated it. Try again.", file.display()))
}

/// Whether the file already has Eavesy's hooks for exactly this app and hold.
#[cfg(test)]
fn installed(file: &Path, exe: &Path, hold_secs: u32) -> bool {
    read(file).map(|current| with_hooks(current.clone(), &exe.to_string_lossy(), hold_secs) == current).unwrap_or(false)
}

/// Settings that aren't an object, or whose `hooks` isn't one, are left alone
/// rather than replaced: Eavesy only rewrites a file it understands.
fn check_shape(file: &Path, settings: &Value) -> Result<(), String> {
    let hooks_ok = match settings.get("hooks") {
        None => true,
        Some(Value::Object(hooks)) => EVENTS.iter().all(|(name, _)| hooks.get(*name).is_none_or(Value::is_array)),
        Some(_) => false,
    };
    if settings.is_object() && hooks_ok {
        Ok(())
    } else {
        Err(format!("{} isn't laid out the way Claude Code expects, so Eavesy left it alone.", file.display()))
    }
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
        let mut touched = false;
        for (name, _) in EVENTS {
            let Some(Value::Array(list)) = hooks.get_mut(name) else { continue };
            let before = list.len();
            // Only entries that held one of Eavesy's hooks are pruned; yours stay as they are.
            list.retain_mut(|entry| {
                let Some(Value::Array(inner)) = entry.get_mut("hooks") else { return true };
                let had = inner.len();
                inner.retain(|hook| !is_ours(hook));
                inner.len() == had || !inner.is_empty()
            });
            if list.is_empty() && before > 0 {
                touched = true;
                hooks.remove(name);
            }
        }
        if hooks.is_empty() && touched {
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
/// Returns false, writing nothing, when the file no longer holds `was`.
fn write(file: &Path, was: &Value, value: &Value) -> Result<bool, String> {
    // A settings file linked in from a dotfiles repo stays a link: write its target.
    let resolved = std::fs::canonicalize(file).ok();
    let file = resolved.as_deref().unwrap_or(file);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let mut raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    raw.push('\n');
    let partial = file.with_extension(format!("json.eavesy-{}", uuid::Uuid::new_v4().simple()));
    if let Err(error) = std::fs::write(&partial, raw) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("Couldn't update {}: {error}", file.display()));
    }
    // Checked last, right before the rename, so the window for a lost write is tiny.
    if read(file).ok().as_ref() != Some(was) {
        let _ = std::fs::remove_file(&partial);
        return Ok(false);
    }
    std::fs::rename(&partial, file).map(|()| true).map_err(|error| {
        let _ = std::fs::remove_file(&partial);
        format!("Couldn't update {}: {error}", file.display())
    })
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
    fn your_empty_entries_are_left_alone() {
        let mine = json!({ "hooks": { "Stop": [{ "matcher": "x", "hooks": [] }], "PreToolUse": [] } });
        assert_eq!(without_hooks(with_hooks(mine.clone(), EXE, 300)), mine);
        assert_eq!(without_hooks(json!({ "hooks": {} })), json!({ "hooks": {} }));
    }

    #[test]
    fn a_file_laid_out_oddly_is_left_alone() {
        let dir = std::env::temp_dir().join(format!("eavesy-install-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        for odd in [r#"[1, 2]"#, r#"{"hooks": "none"}"#, r#"{"hooks": {"Stop": "afplay"}}"#] {
            let file = dir.join("settings.json");
            std::fs::write(&file, odd).unwrap();
            assert!(install(&file, Path::new(EXE), 300).is_err());
            assert!(uninstall(&file).is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), odd);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_linked_settings_file_stays_a_link() {
        let dir = std::env::temp_dir().join(format!("eavesy-install-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("dotfiles-settings.json");
        let link = dir.join("settings.json");
        std::fs::write(&target, "{}").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        install(&link, Path::new(EXE), 300).unwrap();
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert!(installed(&target, Path::new(EXE), 300));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_file_changed_underneath_is_not_overwritten() {
        let dir = std::env::temp_dir().join(format!("eavesy-install-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        std::fs::write(&file, r#"{"model":"opus"}"#).unwrap();
        assert!(!write(&file, &json!({}), &json!({ "hooks": {} })).unwrap());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"model":"opus"}"#);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "the partial file is cleaned up");
        let _ = std::fs::remove_dir_all(dir);
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
