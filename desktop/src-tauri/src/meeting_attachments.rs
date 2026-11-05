//! Pictures attached to a meeting recording: Snapshots of the shared screen
//! (written by the capture engine, see `SnapshotSampler.swift`) and
//! screenshots taken while the meeting records (the screenshot button and
//! ⌘⇧3/4/5). They live in the recording's own folder:
//!
//! ```text
//! 2026-11-05 Weekly sync/
//!   audio.m4a
//!   snapshots/snapshot-000123456.jpg    123.456 s into the recording
//!   screenshots/screenshot-000200000.png
//! ```
//!
//! The name carries the offset, so the folder alone is the record: nothing is
//! lost if the app quits mid-meeting. Sync uploads each one once (see
//! `upload_next`) to `PUT /api/sessions/{id}/attachments/{name}`.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection};
use tauri::{AppHandle, Runtime};

pub const SNAPSHOTS_DIR: &str = "snapshots";
pub const SCREENSHOTS_DIR: &str = "screenshots";
/// The server takes pictures up to this size.
const MAX_BYTES: u64 = 20 * 1024 * 1024;

pub const DDL: &str = "
CREATE TABLE IF NOT EXISTS recording_attachments (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  gave_up INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, name)
);
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Snapshot,
    Screenshot,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Snapshot => "snapshot",
            Kind::Screenshot => "screenshot",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    /// The file name without its extension (`snapshot-000123456`): unique in
    /// its meeting, and the id the server files it under.
    pub name: String,
    pub kind: Kind,
    pub offset_ms: i64,
    pub path: PathBuf,
    pub content_type: &'static str,
}

/// `snapshot-000123456.jpg` or `screenshot-000123456[-2].png`, else None.
fn parse(file_name: &str) -> Option<(String, Kind, i64, &'static str)> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    let content_type = match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        _ => return None,
    };
    let (kind, rest) = match stem.strip_prefix("snapshot-") {
        Some(rest) => (Kind::Snapshot, rest),
        None => (Kind::Screenshot, stem.strip_prefix("screenshot-")?),
    };
    let (digits, suffix) = rest.split_once('-').unwrap_or((rest, ""));
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || !suffix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((stem.to_string(), kind, digits.parse().ok()?, content_type))
}

/// The meeting's pictures, in the order they were taken.
pub fn list(folder: &Path) -> Vec<Attachment> {
    let mut found = Vec::new();
    for dir in [SNAPSHOTS_DIR, SCREENSHOTS_DIR] {
        let Ok(entries) = std::fs::read_dir(folder.join(dir)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else { continue };
            if file_name.starts_with('.') || !path.is_file() {
                continue;
            }
            if let Some((name, kind, offset_ms, content_type)) = parse(file_name) {
                found.push(Attachment { name, kind, offset_ms, path, content_type });
            }
        }
    }
    found.sort_by(|a, b| (a.offset_ms, &a.name).cmp(&(b.offset_ms, &b.name)));
    found
}

/// A hidden file in the meeting's screenshots folder to write a screenshot
/// into before `commit_screenshot` names it.
pub fn partial_screenshot(folder: &Path, ext: &str) -> Result<PathBuf, String> {
    let dir = folder.join(SCREENSHOTS_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| format!("Couldn't create {}: {error}", dir.display()))?;
    Ok(dir.join(format!(".{}.partial.{ext}", uuid::Uuid::new_v4())))
}

/// Gives a finished screenshot its name, `offset_ms` into the recording.
/// The name is claimed with a hard link, which fails rather than replace a
/// file, so two screenshots in the same millisecond both keep theirs. The
/// partial file is gone afterwards, whether or not this worked.
pub fn commit_screenshot(partial: &Path, folder: &Path, offset_ms: i64, ext: &str) -> Result<PathBuf, String> {
    let dir = folder.join(SCREENSHOTS_DIR);
    let base = format!("screenshot-{:09}", offset_ms.max(0));
    let mut result = Err("Couldn't name the screenshot.".to_string());
    for n in 1..1000 {
        let path = dir.join(if n == 1 { format!("{base}.{ext}") } else { format!("{base}-{n}.{ext}") });
        match std::fs::hard_link(partial, &path) {
            Ok(()) => {
                result = Ok(path);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                result = Err(format!("Couldn't save the screenshot: {error}"));
                break;
            }
        }
    }
    let _ = std::fs::remove_file(partial);
    result
}

/// The meeting being recorded right now, if one is.
#[derive(Debug, Clone)]
pub struct Recording {
    pub session_id: String,
    pub folder: PathBuf,
    /// When its first audio arrived; offsets count from here.
    pub live_at_ms: i64,
}

impl Recording {
    pub fn offset_of(&self, at_ms: i64) -> i64 {
        (at_ms - self.live_at_ms).max(0)
    }
}

/// Copies a screenshot file into the meeting being recorded and returns where it went.
pub fn attach_copy(recording: &Recording, source: &Path, taken_at_ms: i64) -> Result<PathBuf, String> {
    let ext = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|ext| matches!(ext.as_str(), "png" | "jpg" | "jpeg"))
        .ok_or("Only PNG and JPEG screenshots can be added to a meeting.")?;
    let partial = partial_screenshot(&recording.folder, &ext)?;
    if let Err(error) = std::fs::copy(source, &partial) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("Couldn't copy the screenshot: {error}"));
    }
    commit_screenshot(&partial, &recording.folder, recording.offset_of(taken_at_ms), &ext)
}

fn uploaded(conn: &Connection, session_id: &str) -> rusqlite::Result<std::collections::HashSet<String>> {
    let mut statement = conn.prepare("SELECT name FROM recording_attachments WHERE session_id=?1")?;
    let rows = statement.query_map(params![session_id], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn record_done(conn: &Connection, session_id: &str, name: &str, gave_up: bool) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO recording_attachments (session_id, name, uploaded_at, gave_up) VALUES (?1, ?2, ?3, ?4)",
        params![session_id, name, chrono::Utc::now().timestamp_millis(), gave_up as i64],
    )
    .map(drop)
}

/// The first picture of this recording the server doesn't have yet.
pub fn next_pending<R: Runtime>(app: &AppHandle<R>, session_id: &str, folder: &Path) -> Result<Option<Attachment>, String> {
    let all = list(folder);
    if all.is_empty() {
        return Ok(None);
    }
    let done = crate::sqlite::with_open(app, |conn| uploaded(conn, session_id))?
        .map_err(|error| format!("read uploaded attachments: {error}"))?;
    Ok(all.into_iter().find(|attachment| !done.contains(&attachment.name)))
}

/// Uploads one picture of this recording, if any is waiting. Returns whether it did.
pub(crate) async fn upload_next<R: Runtime>(
    app: &AppHandle<R>,
    api: &crate::sync::Api,
    token: &str,
    remote_id: &str,
    session_id: &str,
    folder: &Path,
) -> Result<bool> {
    let Some(attachment) = next_pending(app, session_id, folder).map_err(|error| anyhow!(error))? else {
        return Ok(false);
    };
    let give_up = |reason: &str| -> Result<bool> {
        tracing::warn!(session = %session_id, name = %attachment.name, "meeting attachment not uploaded: {reason}");
        crate::sqlite::with_open(app, |conn| record_done(conn, session_id, &attachment.name, true))
            .map_err(|error| anyhow!(error))?
            .map_err(|error| anyhow!("record attachment: {error}"))?;
        Ok(true)
    };
    // Too large is known from the size, before the file is read.
    if tokio::fs::metadata(&attachment.path).await.is_ok_and(|meta| meta.len() > MAX_BYTES) {
        return give_up("the file is too large");
    }
    let bytes = match tokio::fs::read(&attachment.path).await {
        Ok(bytes) if bytes.is_empty() => return give_up("the file is empty"),
        Ok(bytes) if bytes.len() as u64 > MAX_BYTES => return give_up("the file is too large"),
        Ok(bytes) => bytes,
        // Deleted by the user: nothing to send.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return give_up("the file was removed"),
        Err(error) => return Err(error).with_context(|| format!("read {}", attachment.path.display())),
    };
    let response = api
        .client
        .put(api.url(&format!("/api/sessions/{remote_id}/attachments/{}", attachment.name)))
        .bearer_auth(token)
        .header("content-type", attachment.content_type)
        .header("x-attachment-kind", attachment.kind.as_str())
        .header("x-attachment-offset-ms", attachment.offset_ms)
        .body(bytes)
        .send()
        .await
        .with_context(|| format!("upload meeting attachment {}", attachment.name))?;
    if !response.status().is_success() {
        let error = crate::sync::http_error("upload meeting attachment", response).await;
        if crate::sync::is_permanent(&error) && !crate::sync::is_unauthorized(&error) {
            return give_up(&format!("{error:#}"));
        }
        return Err(error);
    }
    crate::sqlite::with_open(app, |conn| record_done(conn, session_id, &attachment.name, false))
        .map_err(|error| anyhow!(error))?
        .map_err(|error| anyhow!("record attachment: {error}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let dir = std::env::temp_dir().join(format!("eavesy-attachments-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn names_carry_kind_and_offset() {
        assert_eq!(parse("snapshot-000123456.jpg"), Some(("snapshot-000123456".into(), Kind::Snapshot, 123_456, "image/jpeg")));
        assert_eq!(parse("screenshot-000000010-2.PNG"), Some(("screenshot-000000010-2".into(), Kind::Screenshot, 10, "image/png")));
        assert_eq!(parse("snapshot-12.gif"), None);
        assert_eq!(parse("snapshot-.jpg"), None);
        assert_eq!(parse("snapshot-12x.jpg"), None);
        assert_eq!(parse("photo-12.jpg"), None);
        assert_eq!(parse("snapshot-12-a.jpg"), None);
    }

    #[test]
    fn a_folder_lists_its_pictures_in_order_and_skips_partial_files() {
        let folder = tempdir();
        let snaps = folder.path().join(SNAPSHOTS_DIR);
        let shots = folder.path().join(SCREENSHOTS_DIR);
        std::fs::create_dir_all(&snaps).unwrap();
        std::fs::create_dir_all(&shots).unwrap();
        std::fs::write(snaps.join("snapshot-000005000.jpg"), b"a").unwrap();
        std::fs::write(snaps.join(".snapshot-000009000.jpg.partial"), b"a").unwrap();
        std::fs::write(snaps.join("notes.txt"), b"a").unwrap();
        std::fs::write(shots.join("screenshot-000001000.png"), b"a").unwrap();
        let names: Vec<_> = list(folder.path()).into_iter().map(|a| (a.name, a.offset_ms)).collect();
        assert_eq!(names, vec![("screenshot-000001000".to_string(), 1_000), ("snapshot-000005000".to_string(), 5_000)]);
        assert!(list(&folder.path().join("missing")).is_empty());
    }

    #[test]
    fn a_screenshot_during_a_recording_lands_in_its_folder_at_its_offset() {
        let root = tempdir();
        let folder = root.path().join("2026-11-05 Weekly sync");
        std::fs::create_dir_all(&folder).unwrap();
        let source = root.path().join("Screenshot 2026-11-05 at 10.00.00.png");
        std::fs::write(&source, b"png").unwrap();
        let recording = Recording { session_id: "s".into(), folder: folder.clone(), live_at_ms: 1_000_000 };

        let first = attach_copy(&recording, &source, 1_065_432).unwrap();
        assert_eq!(first, folder.join("screenshots/screenshot-000065432.png"));
        assert_eq!(std::fs::read(&first).unwrap(), b"png");
        assert!(source.exists(), "the original stays where macOS saved it");
        // Two in the same millisecond keep both.
        let second = attach_copy(&recording, &source, 1_065_432).unwrap();
        assert_eq!(second, folder.join("screenshots/screenshot-000065432-2.png"));
        // Before the audio was live counts as the start.
        assert_eq!(recording.offset_of(10), 0);
        let listed = list(&folder);
        assert_eq!(listed.len(), 2);
        let files = std::fs::read_dir(folder.join("screenshots")).unwrap().count();
        assert_eq!(files, 2, "no partial file is left behind");
        assert!(listed.iter().all(|a| a.kind == Kind::Screenshot && a.offset_ms == 65_432));

        let text = root.path().join("notes.txt");
        std::fs::write(&text, b"x").unwrap();
        assert!(attach_copy(&recording, &text, 0).is_err());
    }

    #[test]
    fn uploads_are_remembered_per_recording() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(DDL).unwrap();
        record_done(&conn, "a", "snapshot-000000001", false).unwrap();
        record_done(&conn, "a", "snapshot-000000001", false).unwrap();
        record_done(&conn, "b", "snapshot-000000002", true).unwrap();
        assert_eq!(uploaded(&conn, "a").unwrap(), ["snapshot-000000001".to_string()].into());
        assert_eq!(uploaded(&conn, "b").unwrap().len(), 1);
        assert!(uploaded(&conn, "c").unwrap().is_empty());
    }
}
