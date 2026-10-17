// tauri-nspanel re-exports the legacy `cocoa`/`objc` crates: their APIs are deprecated and
// their `msg_send!` macros trip `unexpected_cfgs`. Moving to objc2 is a separate migration.
#![allow(deprecated, unexpected_cfgs)]

//! Putting files into Eavesy and taking captures out: drag-drop and file-picker
//! imports, ⌘V in the panel, and Delete (to the Trash).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{audio, fs_writer, store};

/// Notes larger than this are refused rather than loaded into the registry.
const MAX_NOTE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Note,
    Audio,
    Video,
}

pub fn classify(path: &Path) -> Option<Kind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "heic" | "heif" | "webp" | "tif" | "tiff" | "bmp" => Kind::Image,
        "txt" | "md" | "markdown" => Kind::Note,
        "m4a" | "mp3" | "wav" | "aac" | "aif" | "aiff" | "caf" | "flac" => Kind::Audio,
        "mp4" | "mov" | "m4v" => Kind::Video,
        _ => return None,
    })
}

/// Media files Eavesy plays or previews; used to find an imported file in its folder.
pub fn is_media(path: &Path) -> bool {
    matches!(classify(path), Some(Kind::Image | Kind::Audio | Kind::Video))
}

fn title_from(path: &Path, fallback: &str) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|stem| !stem.is_empty())
        .map(|stem| stem.chars().take(80).collect())
        .unwrap_or_else(|| fallback.to_string())
}

/// Copies one file into a new capture folder and adds it to the registry.
/// `screenshot` marks images that came from the macOS screenshot folder.
pub fn import_path(app: &AppHandle, path: &Path, screenshot: bool) -> Result<String, String> {
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("file").to_string();
    let kind = classify(path).ok_or_else(|| format!("Eavesy can't keep {name} yet."))?;
    let meta = std::fs::metadata(path).map_err(|_| format!("Couldn't read {name}."))?;
    if !meta.is_file() {
        return Err(format!("{name} is a folder. Drop the files inside it instead."));
    }

    let now = chrono::Utc::now();
    let (title, source) = match kind {
        Kind::Image if screenshot => ("Screenshot".to_string(), "screenshot"),
        Kind::Image => (title_from(path, "Image"), "image"),
        Kind::Note => (title_from(path, "Note"), "note"),
        Kind::Audio | Kind::Video => (title_from(path, "Upload"), "upload"),
    };
    let transcript = if kind == Kind::Note {
        if meta.len() > MAX_NOTE_BYTES {
            return Err(format!("{name} is too long for a note (over 1 MB)."));
        }
        let text = std::fs::read_to_string(path).map_err(|_| format!("{name} isn't plain text."))?;
        if text.trim().is_empty() {
            return Err(format!("{name} is empty."));
        }
        Some(text)
    } else {
        None
    };

    let folder = fs_writer::allocate_recording_folder(&fs_writer::recordings_root(app)?, &title, now)?;
    let result = (|| {
        match kind {
            Kind::Note => std::fs::write(folder.join("note.md"), transcript.as_deref().unwrap_or_default()),
            _ => std::fs::copy(path, folder.join(stored_name(kind, path, screenshot))).map(|_| ()),
        }
        .map_err(|error| format!("Couldn't copy {name}: {error}"))?;
        let recording = store::StoredRecording {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            started_at_ms: now.timestamp_millis(),
            duration_sec: 0,
            source: source.into(),
            status: "complete".into(),
            summary: None,
            transcript,
            notes: None,
            has_audio: kind == Kind::Audio,
            has_video: kind == Kind::Video,
            folder_path: Some(folder.to_string_lossy().into_owned()),
        };
        let json = serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?;
        std::fs::write(folder.join("capture.json"), json).map_err(|error| error.to_string())?;
        let id = recording.id.clone();
        store::append(app, recording)?;
        Ok(id)
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&folder);
    }
    result
}

/// Images keep their format; the name tells the preview which file to load.
fn stored_name(kind: Kind, original: &Path, screenshot: bool) -> String {
    let ext = original
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let stem = match kind {
        Kind::Image if screenshot => "screenshot",
        Kind::Image => "image",
        Kind::Audio => "audio",
        Kind::Video => "video",
        Kind::Note => "note",
    };
    format!("{stem}.{ext}")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub ids: Vec<String>,
    /// One sentence per file that could not be kept.
    pub skipped: Vec<String>,
}

fn import_all(app: &AppHandle, paths: &[PathBuf]) -> ImportResult {
    let mut result = ImportResult { ids: Vec::new(), skipped: Vec::new() };
    for path in paths {
        match import_path(app, path, false) {
            Ok(id) => result.ids.push(id),
            Err(error) => result.skipped.push(error),
        }
    }
    if !result.ids.is_empty() {
        let _ = app.emit("recordings:updated", ());
    }
    result
}

/// Files dropped on the panel or picked with `+`. Images become image
/// captures, .txt/.md become notes, audio and video are kept as uploads.
#[tauri::command]
pub async fn import_files(app: AppHandle, paths: Vec<String>) -> Result<ImportResult, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    tokio::task::spawn_blocking(move || import_all(&app, &paths))
        .await
        .map_err(|error| error.to_string())
}

/// A note typed (or pasted as text) in the composer.
#[tauri::command]
pub async fn save_note(app: AppHandle, text: String) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("The note is empty.".into());
    }
    if text.len() as u64 > MAX_NOTE_BYTES {
        return Err("That note is too long (over 1 MB).".into());
    }
    tokio::task::spawn_blocking(move || {
        let now = chrono::Utc::now();
        let folder = fs_writer::allocate_recording_folder(&fs_writer::recordings_root(&app)?, "Note", now)?;
        let result = (|| {
            std::fs::write(folder.join("note.md"), &text).map_err(|error| error.to_string())?;
            let recording = store::StoredRecording {
                id: uuid::Uuid::new_v4().to_string(),
                title: "Note".into(),
                started_at_ms: now.timestamp_millis(),
                duration_sec: 0,
                source: "note".into(),
                status: "complete".into(),
                summary: None,
                transcript: Some(text),
                notes: None,
                has_audio: false,
                has_video: false,
                folder_path: Some(folder.to_string_lossy().into_owned()),
            };
            let json = serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?;
            std::fs::write(folder.join("capture.json"), json).map_err(|error| error.to_string())?;
            let id = recording.id.clone();
            store::append(&app, recording)?;
            Ok::<_, String>(id)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&folder);
        } else {
            let _ = app.emit("recordings:updated", ());
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PasteOutcome {
    /// Files or an image were saved as captures.
    Saved { count: usize, skipped: Vec<String> },
    /// Text for the composer draft. Nothing was saved yet.
    Text { text: String },
}

/// ⌘V in the panel. Files copied in Finder are imported, an image is saved,
/// and text comes back so the composer can show it as an editable draft.
#[tauri::command]
pub async fn paste_to_composer(app: AppHandle) -> Result<PasteOutcome, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = sender.send(clipboard_file_paths()); })
        .map_err(|error| error.to_string())?;
    let files = receiver.await.map_err(|error| error.to_string())?;
    if !files.is_empty() {
        let handle = app.clone();
        let result = tokio::task::spawn_blocking(move || import_all(&handle, &files))
            .await
            .map_err(|error| error.to_string())?;
        if result.ids.is_empty() {
            return Err(result.skipped.join(" "));
        }
        return Ok(PasteOutcome::Saved { count: result.ids.len(), skipped: result.skipped });
    }
    let clipboard = app.clipboard();
    if clipboard.read_image().ok().is_some_and(|image| image.width() > 0 && image.height() > 0) {
        crate::visual::paste_clip(app).await?;
        return Ok(PasteOutcome::Saved { count: 1, skipped: Vec::new() });
    }
    let text = clipboard.read_text().map_err(|_| "The clipboard is empty.".to_string())?;
    if text.trim().is_empty() {
        return Err("The clipboard is empty.".into());
    }
    Ok(PasteOutcome::Text { text })
}

/// File URLs on the general pasteboard (files copied in Finder). Main thread only.
#[cfg(target_os = "macos")]
fn clipboard_file_paths() -> Vec<PathBuf> {
    use tauri_nspanel::cocoa::base::{id, nil, BOOL, YES};
    use tauri_nspanel::cocoa::foundation::NSString;
    use tauri_nspanel::objc::{class, msg_send, sel, sel_impl};
    let mut paths = Vec::new();
    unsafe {
        let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        let classes: id = msg_send![class!(NSArray), arrayWithObject: class!(NSURL)];
        let key = NSString::alloc(nil).init_str("NSPasteboardURLReadingFileURLsOnlyKey");
        let yes: id = msg_send![class!(NSNumber), numberWithBool: YES];
        let options: id = msg_send![class!(NSDictionary), dictionaryWithObject: yes forKey: key];
        let urls: id = msg_send![pasteboard, readObjectsForClasses: classes options: options];
        let _: () = msg_send![key, release];
        if urls == nil {
            return paths;
        }
        let count: usize = msg_send![urls, count];
        for index in 0..count {
            let url: id = msg_send![urls, objectAtIndex: index];
            let is_file: BOOL = msg_send![url, isFileURL];
            if is_file != YES {
                continue;
            }
            let path: id = msg_send![url, path];
            let utf8: *const std::os::raw::c_char = msg_send![path, UTF8String];
            if !utf8.is_null() {
                paths.push(PathBuf::from(std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()));
            }
        }
    }
    paths
}
#[cfg(not(target_os = "macos"))]
fn clipboard_file_paths() -> Vec<PathBuf> { Vec::new() }

/// Moves a capture's folder to the Trash and removes it from the history.
/// The folder must sit inside the recordings folder.
#[tauri::command]
pub async fn delete_capture(app: AppHandle, id: String) -> Result<(), String> {
    let recording = store::load_all(&app)
        .into_iter()
        .find(|recording| recording.id == id)
        .ok_or("That capture is already gone.")?;
    let live = app.state::<audio::Captures>().is_busy() && crate::hud::current().session_id.as_deref() == Some(id.as_str());
    if recording.status == "recording" || live {
        return Err("Stop the recording before deleting it.".into());
    }
    if let Some(folder) = recording.folder_path.as_deref().map(PathBuf::from).filter(|folder| folder.exists()) {
        let root = fs_writer::recordings_root(&app)?;
        let inside = folder
            .canonicalize()
            .ok()
            .zip(root.canonicalize().ok())
            .is_some_and(|(folder, root)| folder != root && folder.starts_with(&root));
        if !inside {
            return Err("That capture's folder is outside your Eavesy folder, so it was left alone.".into());
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || { let _ = sender.send(move_to_trash(&folder)); })
            .map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())??;
    }
    store::remove(&app, &id)?;
    let _ = app.emit("recordings:updated", ());
    Ok(())
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<(), String> {
    use tauri_nspanel::cocoa::base::{id, nil, BOOL, YES};
    use tauri_nspanel::cocoa::foundation::NSString;
    use tauri_nspanel::objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let string = NSString::alloc(nil).init_str(&path.to_string_lossy());
        let url: id = msg_send![class!(NSURL), fileURLWithPath: string];
        let manager: id = msg_send![class!(NSFileManager), defaultManager];
        let mut error: id = nil;
        let moved: BOOL = msg_send![manager, trashItemAtURL: url resultingItemURL: nil error: &mut error];
        let _: () = msg_send![string, release];
        if moved == YES { Ok(()) } else { Err("Couldn't move the capture to the Trash.".into()) }
    }
}
#[cfg(not(target_os = "macos"))]
fn move_to_trash(_path: &Path) -> Result<(), String> { Err("Delete is available on Mac.".into()) }

/// Opens the recordings folder (~/Eavesy/Recordings by default) in Finder.
#[tauri::command]
pub fn open_recordings_folder(app: AppHandle) -> Result<(), String> {
    let root = fs_writer::recordings_root(&app)?;
    std::process::Command::new("open")
        .arg(&root)
        .status()
        .map_err(|error| format!("Couldn't open Finder: {error}"))
        .and_then(|status| if status.success() { Ok(()) } else { Err("Finder couldn't open your Eavesy folder.".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_are_sorted_by_what_eavesy_keeps() {
        assert_eq!(classify(Path::new("/a/Shot.PNG")), Some(Kind::Image));
        assert_eq!(classify(Path::new("notes.md")), Some(Kind::Note));
        assert_eq!(classify(Path::new("memo.m4a")), Some(Kind::Audio));
        assert_eq!(classify(Path::new("call.mov")), Some(Kind::Video));
        assert_eq!(classify(Path::new("archive.zip")), None);
        assert_eq!(classify(Path::new("README")), None);
    }

    #[test]
    fn imported_media_keeps_its_format() {
        assert_eq!(stored_name(Kind::Image, Path::new("x/Photo.JPG"), false), "image.jpg");
        assert_eq!(stored_name(Kind::Image, Path::new("Screenshot 2026.png"), true), "screenshot.png");
        assert_eq!(stored_name(Kind::Audio, Path::new("memo.mp3"), false), "audio.mp3");
    }

    #[test]
    fn titles_come_from_the_file_name() {
        assert_eq!(title_from(Path::new("/x/Quarterly plan.md"), "Note"), "Quarterly plan");
        assert_eq!(title_from(Path::new("/x/.md"), "Note"), ".md");
    }
}
