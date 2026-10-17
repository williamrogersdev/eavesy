use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::open;


#[derive(Debug, Clone, Serialize)]
pub struct PendingSegment {
    pub session_id: String,
    pub idx: i64,
    pub track: String,
    pub active_ms: Option<i64>,
    pub file_path: PathBuf,
    pub start_ms: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentManifest {
    pub path: String,
    pub index: i64,
    #[serde(default = "mixed_track")]
    pub track: String,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub bytes: i64,
    #[serde(default)]
    pub peak_rms: Option<f64>,
    #[serde(default)]
    pub active_ms: Option<i64>,
}

fn mixed_track() -> String {
    "mixed".to_string()
}

pub fn record_segment<R: Runtime>(app: &AppHandle<R>, session_id: &str, segment: &SegmentManifest) -> Result<(), String> {
    record_segment_on(&*open(app)?, session_id, segment, chrono::Utc::now().timestamp_millis())
}

pub fn next_segment<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<Option<PendingSegment>, String> {
    open(app)?
        .query_row(
            "SELECT session_id, idx, track, active_ms, file_path, start_ms, duration_ms FROM recording_segments
             WHERE session_id=?1 AND status IN ('pending','failed') AND gave_up=0
               AND next_attempt_at <= ?2
             -- The computer-audio track of a part goes before its mic track:
             -- the server treats a mic part as a mic-only note until it has
             -- seen a system part of the same meeting.
             ORDER BY idx, CASE track WHEN 'system' THEN 0 ELSE 1 END, track LIMIT 1",
            params![session_id, chrono::Utc::now().timestamp_millis()],
            |row| {
                Ok(PendingSegment {
                    session_id: row.get(0)?,
                    idx: row.get(1)?,
                    track: row.get(2)?,
                    active_ms: row.get(3)?,
                    file_path: PathBuf::from(row.get::<_, String>(4)?),
                    start_ms: row.get(5)?,
                    duration_ms: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("read pending segment: {e}"))
}

pub fn mark_segment_uploaded<R: Runtime>(app: &AppHandle<R>, segment: &PendingSegment) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_segments SET status='uploaded', last_error=NULL, updated_at=?4
             WHERE session_id=?1 AND idx=?2 AND track=?3",
            params![segment.session_id, segment.idx, segment.track, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark segment uploaded: {e}"))?;
    Ok(())
}

pub fn mark_segment_failed<R: Runtime>(app: &AppHandle<R>, segment: &PendingSegment, error: &str) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "UPDATE recording_segments SET status='failed', attempts=attempts+1,
             next_attempt_at=?3 + min(300000, 2000 * (1 << min(attempts, 7))),
             gave_up=(attempts + 1 >= ?5),
             last_error=?4, updated_at=?3 WHERE session_id=?1 AND idx=?2 AND track=?6",
            params![segment.session_id, segment.idx, now, error, SEGMENT_MAX_ATTEMPTS, segment.track],
        )
        .map_err(|e| format!("mark segment failed: {e}"))?;
    Ok(())
}

pub fn all_segments_uploaded<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<bool, String> {
    let remaining: i64 = open(app)?
        .query_row(
            "SELECT count(*) FROM recording_segments
             WHERE session_id=?1 AND status != 'uploaded' AND gave_up=0",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("count pending segments: {e}"))?;
    Ok(remaining == 0)
}

/// Whether any part of this recording was given up on and never reached the cloud.
pub fn has_abandoned_segments<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<bool, String> {
    let abandoned: i64 = open(app)?
        .query_row(
            "SELECT count(*) FROM recording_segments WHERE session_id=?1 AND gave_up=1",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("count abandoned segments: {e}"))?;
    Ok(abandoned > 0)
}

pub(super) fn record_segment_on(conn: &Connection, session_id: &str, segment: &SegmentManifest, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO recording_segments
         (session_id, idx, track, file_path, start_ms, duration_ms, bytes, peak_rms, active_ms,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(session_id, idx, track) DO UPDATE SET
           file_path=excluded.file_path,
           start_ms=excluded.start_ms,
           duration_ms=excluded.duration_ms,
           bytes=excluded.bytes,
           peak_rms=excluded.peak_rms,
           active_ms=excluded.active_ms,
           updated_at=excluded.updated_at",
        params![
            session_id,
            segment.index,
            segment.track,
            segment.path,
            segment.start_ms,
            segment.duration_ms,
            segment.bytes,
            segment.peak_rms,
            segment.active_ms,
            now
        ],
    )
    .map_err(|e| format!("persist recording segment: {e}"))?;
    // A live session parked between result polls has new work now.
    conn.execute(
        "UPDATE recording_sessions SET next_attempt_at=0 WHERE id=?1 AND status='recording'",
        params![session_id],
    )
    .map_err(|e| format!("wake recording session: {e}"))?;
    Ok(())
}

pub fn give_up_segment<R: Runtime>(app: &AppHandle<R>, segment: &PendingSegment, error: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_segments SET status='failed', gave_up=1, attempts=attempts+1,
             last_error=?3, updated_at=?4 WHERE session_id=?1 AND idx=?2 AND track=?5",
            params![segment.session_id, segment.idx, error, chrono::Utc::now().timestamp_millis(), segment.track],
        )
        .map_err(|e| format!("give up on segment: {e}"))?;
    Ok(())
}

const SEGMENT_MAX_ATTEMPTS: i64 = 200;
