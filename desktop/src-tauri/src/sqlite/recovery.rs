use std::path::PathBuf;

use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Runtime};

use super::open;


/// What launch or stop recovery needs to know about a capture that did not finish.
#[derive(Debug, Clone)]
pub struct InterruptedSession {
    pub id: String,
    pub archive_path: PathBuf,
    pub segment_dir: Option<PathBuf>,
    pub title: String,
    pub source: String,
    pub started_at: i64,
}

pub(super) fn recover_interrupted<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let ids = open(app)?
        .prepare("SELECT id FROM recording_sessions WHERE status='recording' AND discarded=0")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| format!("read interrupted recordings: {e}"))?;
    for id in ids {
        // One damaged capture must not stop the app from launching or block the rest.
        crate::recovery::recover_or_defer(app, &id, "the app quit while recording");
    }
    Ok(())
}

/// Captures whose recovery could not finish (for example, their folder is on a
/// disk that is not mounted); `recovery::retry_deferred` tries them again.
pub fn deferred_recoveries<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    open(app)?
        .prepare("SELECT id FROM recording_sessions WHERE status='recording' AND discarded=0 AND last_error LIKE ?1")
        .and_then(|mut statement| {
            statement
                .query_map(params![format!("{}%", crate::recovery::DEFERRED_NOTE)], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| format!("read deferred recoveries: {e}"))
}

pub fn interrupted_session<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Option<InterruptedSession>, String> {
    open(app)?
        .query_row(
            "SELECT id, archive_path, segment_dir, title, source, started_at
             FROM recording_sessions WHERE id=?1",
            params![id],
            |row| {
                Ok(InterruptedSession {
                    id: row.get(0)?,
                    archive_path: PathBuf::from(row.get::<_, String>(1)?),
                    segment_dir: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
                    title: row.get(3)?,
                    source: row.get(4)?,
                    started_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("read interrupted recording: {e}"))
}

pub fn recorded_duration_ms<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<i64, String> {
    open(app)?
        .query_row(
            "SELECT COALESCE(max(start_ms + duration_ms), 0) FROM recording_segments WHERE session_id=?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("measure recorded segments: {e}"))
}

/// Segments that are uploaded or still worth uploading.
pub fn usable_segment_count<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<i64, String> {
    open(app)?
        .query_row(
            "SELECT count(*) FROM recording_segments WHERE session_id=?1 AND gave_up=0",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("count recorded segments: {e}"))
}

pub fn uploaded_segment_count<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<i64, String> {
    open(app)?
        .query_row(
            "SELECT count(*) FROM recording_segments WHERE session_id=?1 AND status='uploaded'",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("count uploaded segments: {e}"))
}

/// Ends a capture whose archive is unusable: it keeps syncing its segments and is
/// then finalized without an archive.
pub fn finish_from_segments<R: Runtime>(app: &AppHandle<R>, id: &str, duration_ms: i64, note: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "UPDATE recording_sessions SET ended_at=COALESCE(ended_at, ?2), duration_ms=?3, archive_bytes=0,
             archive_missing=1, status='uploading', next_attempt_at=0, last_error=?4, updated_at=?2
             WHERE id=?1",
            params![id, now, duration_ms, note],
        )
        .map_err(|e| format!("finish recording from segments: {e}"))?;
    Ok(())
}

pub fn mark_archive_missing<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET archive_missing=1, updated_at=?2 WHERE id=?1",
            params![id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark archive missing: {e}"))?;
    Ok(())
}
