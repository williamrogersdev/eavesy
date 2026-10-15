use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Runtime};

use super::open;


#[derive(Debug, Clone)]
pub struct PendingSession {
    pub id: String,
    pub remote_meeting_id: Option<String>,
    pub archive_path: PathBuf,
    pub title: String,
    pub context_blurb: Option<String>,
    pub status: String,
    pub next_part_number: i64,
    pub next_archive_offset: i64,
    pub ended_at: Option<i64>,
    /// Set when the continuous archive was lost; the meeting is finished from its
    /// uploaded segments instead.
    pub archive_missing: bool,
}

// Mirrors the recordings table columns one-to-one.
#[allow(clippy::too_many_arguments)]
pub fn begin_recording<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    archive_path: &Path,
    segment_dir: &Path,
    source: &str,
    title: &str,
    context_blurb: Option<&str>,
    started_at: i64,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "INSERT INTO recording_sessions
             (id, archive_path, segment_dir, source, title, context_blurb, started_at, status, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'recording', ?8)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                archive_path.to_string_lossy(),
                segment_dir.to_string_lossy(),
                source,
                title,
                context_blurb,
                started_at,
                now
            ],
        )
        .map_err(|e| format!("persist recording session: {e}"))?;
    Ok(())
}

pub fn finish_recording<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    archive_path: &Path,
    duration_ms: i64,
    archive_bytes: i64,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "UPDATE recording_sessions SET archive_path=?2, ended_at=?3, duration_ms=?4,
             archive_bytes=?5, archive_missing=0, status='uploading', next_attempt_at=0,
             last_error=NULL, updated_at=?3 WHERE id=?1",
            params![id, archive_path.to_string_lossy(), now, duration_ms, archive_bytes],
        )
        .map_err(|e| format!("finalize local recording: {e}"))?;
    Ok(())
}

pub fn next_session<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PendingSession>, String> {
    next_session_on(&*open(app)?, chrono::Utc::now().timestamp_millis())
}

pub fn defer_session<R: Runtime>(app: &AppHandle<R>, id: &str, delay_ms: i64, error: Option<&str>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "UPDATE recording_sessions SET next_attempt_at=?2,
             last_error=COALESCE(?3, last_error), updated_at=?4 WHERE id=?1",
            params![id, now + delay_ms, error, now],
        )
        .map_err(|e| format!("defer session: {e}"))?;
    Ok(())
}

pub fn mark_session_failed<R: Runtime>(app: &AppHandle<R>, id: &str, error: &str) -> Result<(), String> {
    let conn = open(app)?;
    conn.execute(
        "UPDATE recording_sessions SET status='failed', last_error=?2, updated_at=?3 WHERE id=?1",
        params![id, error, chrono::Utc::now().timestamp_millis()],
    )
    .map_err(|e| format!("mark session failed: {e}"))?;
    // A failed recording gets no cloud lines; its captions would linger forever.
    crate::live_transcript::forget(&conn, id)
}

pub fn attach_remote<R: Runtime>(app: &AppHandle<R>, id: &str, remote_id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET remote_meeting_id=?2, updated_at=?3 WHERE id=?1",
            params![id, remote_id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("persist remote meeting id: {e}"))?;
    Ok(())
}

pub fn advance_archive<R: Runtime>(app: &AppHandle<R>,
    id: &str,
    next_part_number: i64,
    next_offset: i64,
) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET next_part_number=?2,
             next_archive_offset=?3, status='uploading', updated_at=?4 WHERE id=?1",
            params![id, next_part_number, next_offset, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("advance archive upload: {e}"))?;
    Ok(())
}

pub fn mark_processing<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET status='processing', last_error=NULL, updated_at=?2
             WHERE id=?1",
            params![id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark session processing: {e}"))?;
    Ok(())
}

pub fn mark_complete<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET status='complete', last_error=NULL, updated_at=?2
             WHERE id=?1",
            params![id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark session complete: {e}"))?;
    let session: Option<(Option<String>, bool)> = open(app)?
        .query_row(
            "SELECT segment_dir, archive_missing FROM recording_sessions WHERE id=?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("find completed session's segments: {e}"))?;
    // Segments are the only local audio of a session finished without its archive:
    // keep them. Otherwise the archive (validated before upload) holds the same
    // audio, so the per-capture folder `<captures>/<id>/segments` is removed whole.
    let segment_dir = match session {
        Some((segment_dir, false)) => segment_dir,
        _ => None,
    };
    let capture_dir = segment_dir
        .as_deref()
        .map(Path::new)
        .filter(|dir| dir.file_name().is_some_and(|name| name == "segments"))
        .and_then(Path::parent)
        .filter(|dir| dir.file_name().is_some_and(|name| name == id));
    if let Some(capture_dir) = capture_dir {
        if let Err(error) = std::fs::remove_dir_all(capture_dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!("could not remove capture folder {}: {error}", capture_dir.display());
            }
        }
    }
    Ok(())
}

pub(super) fn next_session_on(conn: &Connection, now: i64) -> Result<Option<PendingSession>, String> {
    conn
        .query_row(
            "SELECT id, remote_meeting_id, archive_path, title, context_blurb,
                    status, next_part_number, next_archive_offset, ended_at, archive_missing
             FROM recording_sessions
             WHERE status IN ('recording','uploading','finalizing','processing')
               AND next_attempt_at <= ?1
             ORDER BY
               -- Segments first: they feed the live transcript and are small.
               EXISTS (SELECT 1 FROM recording_segments s
                       WHERE s.session_id = recording_sessions.id
                         AND s.status IN ('pending','failed') AND s.gave_up = 0
                         AND s.next_attempt_at <= ?1) DESC,
               status = 'recording' DESC,
               status = 'processing',
               -- Then the archive with the least left to send, so a short note that
               -- just stopped is not queued behind an old meeting's 8 MiB parts.
               max(COALESCE(archive_bytes, 0) - next_archive_offset, 0),
               started_at
             LIMIT 1",
            params![now],
            |row| {
                Ok(PendingSession {
                    id: row.get(0)?,
                    remote_meeting_id: row.get(1)?,
                    archive_path: PathBuf::from(row.get::<_, String>(2)?),
                    title: row.get(3)?,
                    context_blurb: row.get(4)?,
                    status: row.get(5)?,
                    next_part_number: row.get(6)?,
                    next_archive_offset: row.get(7)?,
                    ended_at: row.get(8)?,
                    archive_missing: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("read pending session: {e}"))
}

pub const PROCESSING_GIVE_UP_MS: i64 = 24 * 60 * 60 * 1_000;
