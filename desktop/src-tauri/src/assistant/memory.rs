//! Eavesy's notes about you and your setup (assistant.md H1, H3, H4), one per line in
//! `~/Eavesy/assistant/memory.md`. They go with every turn, so they're capped and
//! cleaned, and the server wraps them as data, never as instructions: any process on
//! the Mac can write this file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, WebviewWindow};

/// Notes kept at most; past this, `remember` asks you to clear some out.
pub const MAX_NOTES: usize = 50;
/// Characters per note.
pub const NOTE_CHARS: usize = 300;

/// Held across a read-change-write, so two writes never undo each other.
static WRITING: Mutex<()> = Mutex::new(());

pub fn path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Eavesy").join("assistant").join("memory.md"))
}

/// One note as it may be kept: a single line, no control characters, capped.
pub fn clean(note: &str) -> String {
    let flat: String = note.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = flat.trim_start_matches(['-', '*', ' ']).trim();
    flat.chars().take(NOTE_CHARS).collect()
}

/// The notes in a file's text: each `- ` line, cleaned. Other lines (a heading you
/// added, blank lines) are kept in the file but aren't notes.
pub fn parse(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.trim_start().strip_prefix("- ").or_else(|| line.trim_start().strip_prefix("* ")))
        .map(clean)
        .filter(|note| !note.is_empty())
        .take(MAX_NOTES)
        .collect()
}

fn render(notes: &[String]) -> String {
    let mut text = String::from("# What Eavesy remembers\n\nOne note per line. Eavesy reads these with every message. Delete a line to make it forget.\n\n");
    for note in notes {
        text.push_str("- ");
        text.push_str(note);
        text.push('\n');
    }
    text
}

pub fn read(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file).map(|text| parse(&text)).unwrap_or_default()
}

fn write(file: &Path, notes: &[String]) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    crate::fs_writer::atomic_write(file, render(notes).as_bytes())
}

/// Adds a note. A note already kept isn't added twice.
pub fn add(file: &Path, note: &str) -> Result<String, String> {
    let note = clean(note);
    if note.is_empty() {
        return Err("There's nothing in that to remember.".into());
    }
    let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut notes = read(file);
    if notes.iter().any(|kept| kept.eq_ignore_ascii_case(&note)) {
        return Ok(note);
    }
    if notes.len() >= MAX_NOTES {
        return Err(format!("I'm already keeping {MAX_NOTES} notes. Clear some out in Settings → Assistant → Memory first."));
    }
    notes.push(note.clone());
    write(file, &notes)?;
    Ok(note)
}

/// Removes a note (the first that matches); none matching is fine.
pub fn forget(file: &Path, note: &str) -> Result<(), String> {
    let note = clean(note);
    let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut notes = read(file);
    let Some(at) = notes.iter().position(|kept| *kept == note) else { return Ok(()) };
    notes.remove(at);
    write(file, &notes)
}

pub fn forget_all(file: &Path) -> Result<(), String> {
    let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    write(file, &[])
}

/// What goes with a turn: the notes when memory is on, none when it's off.
pub fn for_turn(app: &AppHandle) -> Vec<String> {
    if !crate::settings::load(app).assistant_memory() {
        return Vec::new();
    }
    path().map(|file| read(&file)).unwrap_or_default()
}

#[derive(serde::Serialize)]
pub struct MemoryView {
    pub on: bool,
    pub notes: Vec<String>,
    pub path: Option<String>,
}

#[tauri::command(async)]
pub fn assistant_memory(app: AppHandle, window: WebviewWindow) -> Result<MemoryView, String> {
    super::from_ui(&window)?;
    let file = path();
    Ok(MemoryView {
        on: crate::settings::load(&app).assistant_memory(),
        notes: file.as_deref().map(read).unwrap_or_default(),
        path: file.map(|file| file.display().to_string()),
    })
}

#[tauri::command(async)]
pub fn assistant_forget(window: WebviewWindow, note: String) -> Result<(), String> {
    super::from_ui(&window)?;
    forget(&path().ok_or("No home folder.")?, &note)?;
    super::log("You", "assistant.forget", &clean(&note), "ran", None);
    Ok(())
}

#[tauri::command(async)]
pub fn assistant_forget_all(window: WebviewWindow) -> Result<(), String> {
    super::from_ui(&window)?;
    forget_all(&path().ok_or("No home folder.")?)?;
    super::log("You", "assistant.forget", "every note", "ran", None);
    Ok(())
}

/// Memory off: no notes go with your messages and Eavesy can't add any. The file stays.
#[tauri::command(async)]
pub fn set_assistant_memory(app: AppHandle, window: WebviewWindow, on: bool) -> Result<(), String> {
    super::from_ui(&window)?;
    crate::settings::update(&app, |config| config.assistant_memory = Some(on)).map(drop)
}

/// Opens memory.md in your default editor, creating it first so there's something to open.
#[tauri::command(async)]
#[allow(deprecated)]
pub fn open_assistant_memory(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    super::from_ui(&window)?;
    let file = path().ok_or("No home folder.")?;
    if !file.exists() {
        let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write(&file, &[])?;
    }
    app.shell().open(file.display().to_string(), None).map_err(|e| format!("Couldn't open it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> PathBuf {
        std::env::temp_dir().join(format!("eavesy-memory-{}", uuid::Uuid::new_v4())).join("memory.md")
    }

    #[test]
    fn notes_are_one_clean_capped_line() {
        assert_eq!(clean("  - uses bun,\nnot npm\u{7} "), "uses bun, not npm");
        assert_eq!(clean(&"a".repeat(NOTE_CHARS + 10)).chars().count(), NOTE_CHARS);
        assert_eq!(parse("# Heading\n\n- one\n* two\nnot a note\n-   \n- three"), ["one", "two", "three"]);
        let many: String = (0..MAX_NOTES + 5).map(|i| format!("- n{i}\n")).collect();
        assert_eq!(parse(&many).len(), MAX_NOTES);
    }

    #[test]
    fn add_forget_and_round_trip() {
        let file = temp_file();
        assert_eq!(add(&file, "Prefers bun over npm").unwrap(), "Prefers bun over npm");
        add(&file, "prefers BUN over npm").unwrap();
        add(&file, "Ships behind flags").unwrap();
        assert_eq!(read(&file), ["Prefers bun over npm", "Ships behind flags"]);
        assert!(add(&file, " \n ").is_err());
        forget(&file, "Prefers bun over npm").unwrap();
        forget(&file, "never kept").unwrap();
        assert_eq!(read(&file), ["Ships behind flags"]);
        forget_all(&file).unwrap();
        assert!(read(&file).is_empty());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_full_memory_refuses_more() {
        let file = temp_file();
        for i in 0..MAX_NOTES {
            add(&file, &format!("note {i}")).unwrap();
        }
        assert!(add(&file, "one more").unwrap_err().contains("Clear some out"));
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
