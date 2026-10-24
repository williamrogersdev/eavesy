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

/// Most of the file read for a turn; a note past this is past the cap anyway.
const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Largest file Eavesy will edit. Edits rewrite the whole file, so a bigger one is
/// left for you to trim rather than risk cutting it.
const MAX_EDIT_BYTES: u64 = 1024 * 1024;

/// One note as it may be kept: a single line, no control or line-separator
/// characters, capped.
pub fn clean(note: &str) -> String {
    let flat: String = note.chars().map(|c| if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = flat.trim_start_matches(['-', '*', ' ']).trim();
    flat.chars().take(NOTE_CHARS).collect()
}

/// The note on one line of the file, if it's a `- ` or `* ` line.
fn note_on(line: &str) -> Option<String> {
    let rest = line.trim_start().strip_prefix("- ").or_else(|| line.trim_start().strip_prefix("* "))?;
    Some(clean(rest)).filter(|note| !note.is_empty())
}

/// The notes in a file's text, as many as go with a turn. Other lines (a heading you
/// added, blank lines) aren't notes, and every write leaves them as they are.
pub fn parse(text: &str) -> Vec<String> {
    text.lines().filter_map(note_on).take(MAX_NOTES).collect()
}

const HEADER: &str = "# What Eavesy remembers\n\nOne note per line. Eavesy reads these with every message. Delete a line to make it forget.\n\n";

/// The start of the file, for a turn: bounded, and lossy where the cut splits a
/// character. Never written back.
fn read_text(file: &Path) -> String {
    use std::io::Read;
    let mut bytes = Vec::new();
    if let Ok(handle) = std::fs::File::open(file) {
        let _ = handle.take(MAX_FILE_BYTES).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The whole file, for an edit. Missing is empty; anything else that stops a full,
/// exact read is an error, so an edit never writes back less than was there.
pub(super) fn read_for_edit(file: &Path) -> Result<String, String> {
    let name = file.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    match std::fs::metadata(file) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("Couldn't read {name}: {error}")),
        Ok(meta) if meta.len() > MAX_EDIT_BYTES => {
            return Err(format!("{name} is too big for me to edit safely. Trim it in your editor (Settings → Assistant → Open in Editor)."));
        }
        Ok(_) => {}
    }
    std::fs::read_to_string(file).map_err(|error| format!("Couldn't read {name}: {error}"))
}

pub fn read(file: &Path) -> Vec<String> {
    parse(&read_text(file))
}

pub(super) fn write_text(file: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    crate::fs_writer::atomic_write(file, text.as_bytes())
}

/// The file with the lines `drop` picks taken out; everything else stays byte for byte.
pub(super) fn without(text: &str, mut drop: impl FnMut(&str) -> bool) -> String {
    text.split_inclusive('\n').filter(|line| !drop(line.trim_end_matches(['\n', '\r']))).collect()
}

/// Adds a note at the end of the file, leaving every other line alone, and returns
/// the note as kept. A note already kept (in any case) isn't added twice: the kept
/// one is returned, so Undo removes the right line.
pub fn add(file: &Path, note: &str) -> Result<String, String> {
    let note = clean(note);
    if note.is_empty() {
        return Err("There's nothing in that to remember.".into());
    }
    let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut text = read_for_edit(file)?;
    let kept: Vec<String> = text.lines().filter_map(note_on).collect();
    if let Some(same) = kept.iter().find(|kept| kept.eq_ignore_ascii_case(&note)) {
        return Ok(same.clone());
    }
    if kept.len() >= MAX_NOTES {
        return Err(format!("I'm already keeping {MAX_NOTES} notes. Clear some out in Settings → Assistant → Memory first."));
    }
    if text.trim().is_empty() {
        text = HEADER.to_string();
    } else if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("- {note}\n"));
    write_text(file, &text)?;
    Ok(note)
}

/// Removes the first line holding this note; none matching is fine.
pub fn forget(file: &Path, note: &str) -> Result<(), String> {
    let note = clean(note);
    let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let text = read_for_edit(file)?;
    let mut found = false;
    let left = without(&text, |line| {
        let hit = !found && note_on(line).as_deref() == Some(note.as_str());
        found |= hit;
        hit
    });
    if found { write_text(file, &left) } else { Ok(()) }
}

/// Removes every note line; a heading or anything else you wrote stays.
pub fn forget_all(file: &Path) -> Result<(), String> {
    let _guard = WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let text = read_for_edit(file)?;
    if text.is_empty() {
        return Ok(());
    }
    write_text(file, &without(&text, |line| note_on(line).is_some()))
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
        write_text(&file, HEADER)?;
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
        assert_eq!(clean("a\u{2028}b\u{85}c"), "a b c");
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
    fn writes_leave_your_own_lines_alone() {
        let file = temp_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mine = "# Mine\n\nSome words I wrote.\n- First\n- Second\n";
        std::fs::write(&file, mine).unwrap();
        add(&file, "Third").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{mine}- Third\n"));
        forget(&file, "Second").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Mine\n\nSome words I wrote.\n- First\n- Third\n");
        forget_all(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Mine\n\nSome words I wrote.\n");
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn a_duplicate_returns_the_kept_spelling_so_undo_finds_it() {
        let file = temp_file();
        add(&file, "Prefers Bun").unwrap();
        let kept = add(&file, "prefers bun").unwrap();
        assert_eq!(kept, "Prefers Bun");
        forget(&file, &kept).unwrap();
        assert!(read(&file).is_empty());
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn an_edit_never_writes_back_less_than_was_there() {
        let file = temp_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // Not UTF-8: refused, file untouched.
        std::fs::write(&file, b"- ok\n\xff\xfe\n").unwrap();
        assert!(add(&file, "new").is_err());
        assert!(forget_all(&file).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"- ok\n\xff\xfe\n");
        // Too big to edit: refused, though the start still reads for a turn.
        let big = format!("- first\n{}", "x".repeat(MAX_EDIT_BYTES as usize));
        std::fs::write(&file, &big).unwrap();
        assert!(add(&file, "new").unwrap_err().contains("too big"));
        assert_eq!(std::fs::read_to_string(&file).unwrap().len(), big.len());
        assert_eq!(read(&file), ["first"]);
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
