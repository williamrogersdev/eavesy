//! What Eavesy knows (assistant.md H1, H3, H4), one note per line in two files under
//! `~/Eavesy/assistant/`: `about-you.md` for you, kept short so you can read it all, and
//! `memory.md` for your setup, which merges its notes when full. Both go with every
//! turn, so they're capped and cleaned, and the server wraps them as data, never as
//! instructions: any process on the Mac can write these files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

/// Notes kept in memory.md at most; past this, Eavesy merges them.
pub const MAX_NOTES: usize = 50;
/// Notes kept in about-you.md at most, so it stays short enough to read.
pub const MAX_ABOUT: usize = 20;
/// Characters per note.
pub const NOTE_CHARS: usize = 300;
/// A merge must leave at least this much room, or it isn't worth keeping.
const MERGE_ROOM: usize = 10;

/// Held across a read-change-write, so two writes never undo each other.
static WRITING: Mutex<()> = Mutex::new(());

/// Which file a note lives in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Book {
    /// memory.md: your setup and how you work.
    #[default]
    Setup,
    /// about-you.md: you.
    You,
}

impl Book {
    pub fn max(self) -> usize {
        match self {
            Book::Setup => MAX_NOTES,
            Book::You => MAX_ABOUT,
        }
    }

    pub fn path(self) -> Option<PathBuf> {
        let name = match self {
            Book::Setup => "memory.md",
            Book::You => "about-you.md",
        };
        dirs::home_dir().map(|home| home.join("Eavesy").join("assistant").join(name))
    }

    fn header(self) -> &'static str {
        match self {
            Book::Setup => "# What Eavesy remembers\n\nOne note per line. Eavesy reads these with every message. Delete a line to make it forget.\n\n",
            Book::You => "# About you\n\nWhat Eavesy knows about you, one line each, kept short. Eavesy reads these with every message. Delete a line to make it forget.\n\n",
        }
    }

    fn full(self) -> String {
        match self {
            Book::Setup => format!("I'm already keeping {MAX_NOTES} notes and couldn't merge them. Clear some out in Settings → Assistant → Memory first."),
            Book::You => format!("I already know {MAX_ABOUT} things about you, which is all I keep. Clear some out in Settings → Assistant → Memory first."),
        }
    }
}

pub fn path() -> Option<PathBuf> {
    Book::Setup.path()
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
pub fn parse(text: &str, max: usize) -> Vec<String> {
    text.lines().filter_map(note_on).take(max).collect()
}

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
            return Err(format!("{name} is too big for me to edit safely. Trim it in your editor first."));
        }
        Ok(_) => {}
    }
    std::fs::read_to_string(file).map_err(|error| format!("Couldn't read {name}: {error}"))
}

pub fn read(file: &Path, max: usize) -> Vec<String> {
    parse(&read_text(file), max)
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

fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The file's note lines, every one of them, for an edit.
fn notes_in(text: &str) -> Vec<String> {
    text.lines().filter_map(note_on).collect()
}

/// Notes appended at the end, after a header when the file has nothing else yet.
fn with_notes(mut text: String, header: &str, notes: &[String]) -> String {
    if text.trim().is_empty() {
        text = header.to_string();
    } else if !text.ends_with('\n') {
        text.push('\n');
    }
    for note in notes {
        text.push_str(&format!("- {note}\n"));
    }
    text
}

/// True when the book holds as many notes as it keeps.
pub fn is_full(book: Book, file: &Path) -> bool {
    read_for_edit(file).map(|text| notes_in(&text).len() >= book.max()).unwrap_or(false)
}

/// Adds a note at the end of the file, leaving every other line alone, and returns
/// the note as kept. A note already kept (in any case) isn't added twice: the kept
/// one is returned, so Undo removes the right line.
pub fn add(book: Book, file: &Path, note: &str) -> Result<String, String> {
    let note = clean(note);
    if note.is_empty() {
        return Err("There's nothing in that to remember.".into());
    }
    let _guard = lock();
    let text = read_for_edit(file)?;
    let kept = notes_in(&text);
    if let Some(same) = kept.iter().find(|kept| kept.eq_ignore_ascii_case(&note)) {
        return Ok(same.clone());
    }
    if kept.len() >= book.max() {
        return Err(book.full());
    }
    write_text(file, &with_notes(text, book.header(), std::slice::from_ref(&note)))?;
    Ok(note)
}

/// Removes the first line holding this note; none matching is fine.
pub fn forget(file: &Path, note: &str) -> Result<(), String> {
    let note = clean(note);
    let _guard = lock();
    let text = read_for_edit(file)?;
    let mut found = false;
    let left = without(&text, |line| {
        let hit = !found && note_on(line).as_deref() == Some(note.as_str());
        found |= hit;
        hit
    });
    if found { write_text(file, &left) } else { Ok(()) }
}

/// Removes every note line; a heading or anything else you wrote stays. For memory.md,
/// a merge waiting to be undone goes too, so Undo can't bring the notes back.
pub fn forget_all(book: Book, file: &Path) -> Result<(), String> {
    let _guard = lock();
    let text = read_for_edit(file)?;
    if !text.is_empty() {
        write_text(file, &without(&text, |line| note_on(line).is_some()))?;
    }
    // Only once the notes are gone: until then Undo still has them.
    let backup = backup_path(file);
    if book == Book::Setup && backup.exists() {
        std::fs::remove_file(&backup).map_err(|e| format!("Couldn't remove the merge backup: {e}"))?;
    }
    Ok(())
}

/// What a merge replaced, kept beside memory.md until you undo or keep it.
#[derive(Serialize, Deserialize)]
struct Backup {
    at_ms: u64,
    /// The whole file before the merge, byte for byte.
    before: String,
    /// The notes the merge wrote, to tell them from notes added since.
    merged: Vec<String>,
}

fn backup_path(file: &Path) -> PathBuf {
    file.with_file_name("memory.before-merge.json")
}

/// The last merge, for Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MergeInfo {
    pub at_ms: u64,
    pub before: usize,
    pub after: usize,
}

pub fn last_merge(file: &Path) -> Option<MergeInfo> {
    let backup: Backup = serde_json::from_str(&std::fs::read_to_string(backup_path(file)).ok()?).ok()?;
    Some(MergeInfo { at_ms: backup.at_ms, before: notes_in(&backup.before).len(), after: backup.merged.len() })
}

/// Replaces the file's notes with `merged`, keeping your other lines and a backup to
/// undo it. Refused unless it's fewer notes than before and leaves room for more, and
/// when the notes changed after `from` was sent to be merged.
pub fn apply_merge(file: &Path, from: &[String], merged: &[String], at_ms: u64) -> Result<MergeInfo, String> {
    let mut kept: Vec<String> = Vec::new();
    for note in merged.iter().map(|note| clean(note)).filter(|note| !note.is_empty()) {
        if !kept.iter().any(|seen| seen.eq_ignore_ascii_case(&note)) {
            kept.push(note);
        }
    }
    let _guard = lock();
    let text = read_for_edit(file)?;
    let now = notes_in(&text);
    if now != from {
        return Err("My notes changed while I was merging them, so I kept them as they were.".into());
    }
    let before = now.len();
    if kept.is_empty() || kept.len() >= before || kept.len() > MAX_NOTES - MERGE_ROOM {
        return Err("The merge didn't leave enough room, so I kept your notes as they were.".into());
    }
    let backup = Backup { at_ms, before: text.clone(), merged: kept.clone() };
    let json = serde_json::to_string(&backup).map_err(|e| e.to_string())?;
    write_text(&backup_path(file), &json)?;
    let rest = without(&text, |line| note_on(line).is_some());
    if let Err(error) = write_text(file, &with_notes(rest, Book::Setup.header(), &kept)) {
        // No merge happened, so there's nothing for Settings to offer to undo.
        let _ = std::fs::remove_file(backup_path(file));
        return Err(error);
    }
    Ok(MergeInfo { at_ms, before, after: kept.len() })
}

/// Puts the notes back as they were before the last merge, keeping any added since.
pub fn undo_merge(file: &Path) -> Result<(), String> {
    let _guard = lock();
    let backup_file = backup_path(file);
    let backup: Backup = std::fs::read_to_string(&backup_file)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .ok_or("There's no merge to undo.")?;
    let now = notes_in(&read_for_edit(file)?);
    let earlier = notes_in(&backup.before);
    let seen = |note: &String, list: &[String]| list.iter().any(|kept| kept.eq_ignore_ascii_case(note));
    let added: Vec<String> = now.into_iter().filter(|note| !seen(note, &backup.merged) && !seen(note, &earlier)).collect();
    write_text(file, &with_notes(backup.before, Book::Setup.header(), &added))?;
    std::fs::remove_file(&backup_file).map_err(|e| format!("Couldn't remove the merge backup: {e}"))
}

/// Keeps the merge: the backup goes.
pub fn keep_merge(file: &Path) -> Result<(), String> {
    let _guard = lock();
    match std::fs::remove_file(backup_path(file)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(format!("Couldn't remove the merge backup: {error}")),
        _ => Ok(()),
    }
}

#[derive(Serialize)]
struct MergeRequest<'a> {
    notes: &'a [String],
}

#[derive(Deserialize)]
struct MergeResponse {
    notes: Vec<String>,
}

/// Asks Eavesy's cloud to merge memory.md's notes into fewer, then applies the result
/// with a backup. Blocking: call it off the main thread.
pub fn consolidate(app: &AppHandle) -> Result<MergeInfo, String> {
    let file = path().ok_or("No home folder.")?;
    let notes = notes_in(&read_for_edit(&file)?);
    let merged = tauri::async_runtime::block_on(ask_merge(app, &notes))?;
    let info = apply_merge(&file, &notes, &merged, super::now_ms())?;
    super::log("Eavesy", "assistant.merge", &format!("{} notes into {}", info.before, info.after), "ran", None);
    Ok(info)
}

async fn ask_merge(app: &AppHandle, notes: &[String]) -> Result<Vec<String>, String> {
    let unavailable = || "I couldn't merge my notes just now.".to_string();
    let credential = crate::settings::device_credential(app).ok_or_else(unavailable)?;
    let client = crate::sync::http_client().map_err(|_| unavailable())?;
    let response = client
        .post(crate::base_url::join(&credential.base, "/api/assistant/consolidate"))
        .timeout(Duration::from_secs(60))
        .bearer_auth(credential.token)
        .json(&MergeRequest { notes })
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        tracing::warn!("assistant merge unavailable: {}", response.status());
        return Err(unavailable());
    }
    response.json::<MergeResponse>().await.map(|body| body.notes).map_err(|_| unavailable())
}

/// What goes with a turn: both books when memory is on, nothing when it's off.
#[derive(Default)]
pub struct ForTurn {
    pub memory: Vec<String>,
    pub about: Vec<String>,
}

pub fn for_turn(app: &AppHandle) -> ForTurn {
    if !crate::settings::load(app).assistant_memory() {
        return ForTurn::default();
    }
    let read_book = |book: Book| book.path().map(|file| read(&file, book.max())).unwrap_or_default();
    ForTurn { memory: read_book(Book::Setup), about: read_book(Book::You) }
}

#[derive(Serialize)]
pub struct MemoryView {
    pub on: bool,
    pub notes: Vec<String>,
    pub about: Vec<String>,
    pub path: Option<String>,
    pub about_path: Option<String>,
    /// The last merge, while it can still be undone.
    pub merged: Option<MergeInfo>,
}

#[tauri::command(async)]
pub fn assistant_memory(app: AppHandle, window: WebviewWindow) -> Result<MemoryView, String> {
    super::from_ui(&window)?;
    let (file, about) = (Book::Setup.path(), Book::You.path());
    Ok(MemoryView {
        on: crate::settings::load(&app).assistant_memory(),
        notes: file.as_deref().map(|file| read(file, MAX_NOTES)).unwrap_or_default(),
        about: about.as_deref().map(|file| read(file, MAX_ABOUT)).unwrap_or_default(),
        merged: file.as_deref().and_then(last_merge),
        path: file.map(|file| file.display().to_string()),
        about_path: about.map(|file| file.display().to_string()),
    })
}

fn book_path(book: Option<Book>) -> Result<PathBuf, String> {
    book.unwrap_or_default().path().ok_or_else(|| "No home folder.".into())
}

#[tauri::command(async)]
pub fn assistant_forget(window: WebviewWindow, note: String, book: Option<Book>) -> Result<(), String> {
    super::from_ui(&window)?;
    forget(&book_path(book)?, &note)?;
    super::log("You", "assistant.forget", &clean(&note), "ran", None);
    Ok(())
}

#[tauri::command(async)]
pub fn assistant_forget_all(window: WebviewWindow, book: Option<Book>) -> Result<(), String> {
    super::from_ui(&window)?;
    forget_all(book.unwrap_or_default(), &book_path(book)?)?;
    let what = match book.unwrap_or_default() {
        Book::Setup => "every note",
        Book::You => "everything about you",
    };
    super::log("You", "assistant.forget", what, "ran", None);
    Ok(())
}

#[tauri::command(async)]
pub fn assistant_undo_merge(window: WebviewWindow) -> Result<(), String> {
    super::from_ui(&window)?;
    undo_merge(&book_path(None)?)?;
    super::log("You", "assistant.merge", "undone", "ran", None);
    Ok(())
}

#[tauri::command(async)]
pub fn assistant_keep_merge(window: WebviewWindow) -> Result<(), String> {
    super::from_ui(&window)?;
    keep_merge(&book_path(None)?)
}

/// Memory off: no notes are sent with your messages and Eavesy can't add any. The files stay.
#[tauri::command(async)]
pub fn set_assistant_memory(app: AppHandle, window: WebviewWindow, on: bool) -> Result<(), String> {
    super::from_ui(&window)?;
    crate::settings::update(&app, |config| config.assistant_memory = Some(on)).map(drop)
}

/// Opens the book in your default editor, creating it first so there's something to open.
#[tauri::command(async)]
#[allow(deprecated)]
pub fn open_assistant_memory(app: AppHandle, window: WebviewWindow, book: Option<Book>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    super::from_ui(&window)?;
    let file = book_path(book)?;
    if !file.exists() {
        let _guard = lock();
        write_text(&file, book.unwrap_or_default().header())?;
    }
    app.shell().open(file.display().to_string(), None).map_err(|e| format!("Couldn't open it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file() -> PathBuf {
        std::env::temp_dir().join(format!("eavesy-memory-{}", uuid::Uuid::new_v4())).join("memory.md")
    }

    fn cleanup(file: &Path) {
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }

    #[test]
    fn notes_are_one_clean_capped_line() {
        assert_eq!(clean("  - uses bun,\nnot npm\u{7} "), "uses bun, not npm");
        assert_eq!(clean("a\u{2028}b\u{85}c"), "a b c");
        assert_eq!(clean(&"a".repeat(NOTE_CHARS + 10)).chars().count(), NOTE_CHARS);
        assert_eq!(parse("# Heading\n\n- one\n* two\nnot a note\n-   \n- three", MAX_NOTES), ["one", "two", "three"]);
        let many: String = (0..MAX_NOTES + 5).map(|i| format!("- n{i}\n")).collect();
        assert_eq!(parse(&many, MAX_NOTES).len(), MAX_NOTES);
    }

    #[test]
    fn add_forget_and_round_trip() {
        let file = temp_file();
        assert_eq!(add(Book::Setup, &file, "Prefers bun over npm").unwrap(), "Prefers bun over npm");
        add(Book::Setup, &file, "prefers BUN over npm").unwrap();
        add(Book::Setup, &file, "Ships behind flags").unwrap();
        assert_eq!(read(&file, MAX_NOTES), ["Prefers bun over npm", "Ships behind flags"]);
        assert!(add(Book::Setup, &file, " \n ").is_err());
        forget(&file, "Prefers bun over npm").unwrap();
        forget(&file, "never kept").unwrap();
        assert_eq!(read(&file, MAX_NOTES), ["Ships behind flags"]);
        forget_all(Book::Setup, &file).unwrap();
        assert!(read(&file, MAX_NOTES).is_empty());
        cleanup(&file);
    }

    #[test]
    fn writes_leave_your_own_lines_alone() {
        let file = temp_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mine = "# Mine\n\nSome words I wrote.\n- First\n- Second\n";
        std::fs::write(&file, mine).unwrap();
        add(Book::Setup, &file, "Third").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{mine}- Third\n"));
        forget(&file, "Second").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Mine\n\nSome words I wrote.\n- First\n- Third\n");
        forget_all(Book::Setup, &file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Mine\n\nSome words I wrote.\n");
        cleanup(&file);
    }

    #[test]
    fn a_duplicate_returns_the_kept_spelling_so_undo_finds_it() {
        let file = temp_file();
        add(Book::Setup, &file, "Prefers Bun").unwrap();
        let kept = add(Book::Setup, &file, "prefers bun").unwrap();
        assert_eq!(kept, "Prefers Bun");
        forget(&file, &kept).unwrap();
        assert!(read(&file, MAX_NOTES).is_empty());
        cleanup(&file);
    }

    #[test]
    fn an_edit_never_writes_back_less_than_was_there() {
        let file = temp_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // Not UTF-8: refused, file untouched.
        std::fs::write(&file, b"- ok\n\xff\xfe\n").unwrap();
        assert!(add(Book::Setup, &file, "new").is_err());
        assert!(forget_all(Book::Setup, &file).is_err());
        assert!(apply_merge(&file, &["ok".into()], &["x".into()], 1).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"- ok\n\xff\xfe\n");
        // Too big to edit: refused, though the start still reads for a turn.
        let big = format!("- first\n{}", "x".repeat(MAX_EDIT_BYTES as usize));
        std::fs::write(&file, &big).unwrap();
        assert!(add(Book::Setup, &file, "new").unwrap_err().contains("too big"));
        assert_eq!(std::fs::read_to_string(&file).unwrap().len(), big.len());
        assert_eq!(read(&file, MAX_NOTES), ["first"]);
        cleanup(&file);
    }

    #[test]
    fn each_book_has_its_own_cap() {
        let file = temp_file();
        for i in 0..MAX_ABOUT {
            add(Book::You, &file, &format!("fact {i}")).unwrap();
        }
        assert!(is_full(Book::You, &file));
        assert!(!is_full(Book::Setup, &file));
        assert!(add(Book::You, &file, "one more").unwrap_err().contains("all I keep"));
        assert!(std::fs::read_to_string(&file).unwrap().starts_with("# About you"));
        cleanup(&file);
    }

    /// Merges what the file holds now.
    fn merge(file: &Path, merged: &[String], at_ms: u64) -> Result<MergeInfo, String> {
        apply_merge(file, &notes_in(&read_for_edit(file)?), merged, at_ms)
    }

    fn full_memory() -> PathBuf {
        let file = temp_file();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let notes: String = (0..MAX_NOTES).map(|i| format!("- note {i}\n")).collect();
        std::fs::write(&file, format!("# Mine\n\nKeep this line.\n{notes}")).unwrap();
        file
    }

    #[test]
    fn a_merge_keeps_your_lines_and_can_be_undone_keeping_notes_added_since() {
        let file = full_memory();
        let before = std::fs::read_to_string(&file).unwrap();
        assert!(is_full(Book::Setup, &file));
        let info = merge(&file, &["Merged A".into(), "merged a".into(), "Merged B".into(), " ".into()], 7).unwrap();
        assert_eq!(info, MergeInfo { at_ms: 7, before: MAX_NOTES, after: 2 });
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Mine\n\nKeep this line.\n- Merged A\n- Merged B\n");
        assert_eq!(last_merge(&file), Some(info));
        add(Book::Setup, &file, "Added after").unwrap();
        undo_merge(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{before}- Added after\n"));
        assert_eq!(last_merge(&file), None);
        assert!(undo_merge(&file).is_err());
        cleanup(&file);
    }

    #[test]
    fn a_merge_that_leaves_no_room_is_refused() {
        let file = full_memory();
        let before = std::fs::read_to_string(&file).unwrap();
        let too_many: Vec<String> = (0..MAX_NOTES - MERGE_ROOM + 1).map(|i| format!("m{i}")).collect();
        assert!(merge(&file, &too_many, 1).is_err());
        assert!(merge(&file, &[], 1).is_err());
        // Notes changed after they were sent: the merge would lose the new one.
        assert!(apply_merge(&file, &["note 0".into()], &["m".into()], 1).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
        assert_eq!(last_merge(&file), None);
        cleanup(&file);
    }

    #[test]
    fn forgetting_everything_drops_the_merge_backup() {
        let file = full_memory();
        merge(&file, &["Merged".into()], 1).unwrap();
        forget_all(Book::Setup, &file).unwrap();
        assert_eq!(last_merge(&file), None);
        // Keeping a merge drops its backup too, and keeping when there's none is fine.
        keep_merge(&file).unwrap();
        cleanup(&file);
    }
}
