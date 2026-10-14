use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

pub const MIGRATIONS_SQL: &str = include_str!("./schema.sql");

const RECORDING_SEGMENTS_DDL: &str = "
CREATE TABLE IF NOT EXISTS recording_segments (
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  track TEXT NOT NULL DEFAULT 'mixed',
  file_path TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  peak_rms REAL,
  active_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','uploading','uploaded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  gave_up INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, idx, track),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_recording_segments_queue
  ON recording_segments(status, next_attempt_at, created_at);
";

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
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFileEdit {
    pub operation_id: String,
    pub local_session_id: String,
    pub role: String,
    pub content_md: String,
    pub content_hash: String,
}

fn db_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join("eavesy.sqlite3"))
}

fn open<R: Runtime>(app: &AppHandle<R>) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| format!("open local database: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure local database: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("enable local WAL: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("enable local foreign keys: {e}"))?;
    Ok(conn)
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let conn = open(app)?;
    migrate(&conn)?;
    retry_context_rejections(&conn)?;
    drop(conn);
    recover_interrupted(app)
}

fn retry_context_rejections(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE recording_sessions SET status='uploading', last_error=NULL, next_attempt_at=0
         WHERE status='failed' AND remote_meeting_id IS NULL AND context_blurb IS NULL
         AND last_error LIKE 'create cloud recording session: HTTP 400%'
         AND last_error LIKE '%\"path\":[\"contextBlurb\"]%'",
        [],
    ).map_err(|error| format!("retry rejected voice notes: {error}"))?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MIGRATIONS_SQL)
        .map_err(|e| format!("initialize local database: {e}"))?;
    add_column_if_missing(conn, "recording_sessions", "segment_dir", "TEXT")?;
    add_column_if_missing(conn, "recording_sessions", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0")?;
    migrate_segments(conn)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut statement| {
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(columns.iter().any(|name| name == column))
        })
        .map_err(|e| format!("inspect local {table} schema: {e}"))
}

fn migrate_segments(conn: &Connection) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='recording_segments'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .map_err(|e| format!("inspect local segments table: {e}"))?;
    if exists && !has_column(conn, "recording_segments", "track")? {
        conn.execute_batch(&format!(
            "BEGIN;
             ALTER TABLE recording_segments RENAME TO recording_segments_pre_track;
             DROP INDEX IF EXISTS idx_recording_segments_queue;
             {RECORDING_SEGMENTS_DDL}
             INSERT INTO recording_segments
               (session_id, idx, track, file_path, start_ms, duration_ms, bytes, status,
                attempts, next_attempt_at, last_error, created_at, updated_at)
             SELECT session_id, idx, 'mixed', file_path, start_ms, duration_ms, bytes, status,
                    attempts, next_attempt_at, last_error, created_at, updated_at
             FROM recording_segments_pre_track;
             DROP TABLE recording_segments_pre_track;
             COMMIT;"
        ))
        .map_err(|e| format!("rebuild local segments table: {e}"))?;
        return Ok(());
    }
    conn.execute_batch(RECORDING_SEGMENTS_DDL)
        .map_err(|e| format!("create local segments table: {e}"))
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

fn recover_interrupted<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let conn = open(app)?;
    let mut statement = conn
        .prepare(
            "SELECT id, archive_path, segment_dir, title, source, started_at
             FROM recording_sessions WHERE status='recording'",
        )
        .map_err(|e| format!("prepare interrupted recording recovery: {e}"))?;
    let sessions = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                PathBuf::from(row.get::<_, String>(1)?),
                row.get::<_, Option<String>>(2)?.map(PathBuf::from),
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|e| format!("read interrupted recordings: {e}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    drop(statement);
    drop(conn);

    for (id, archive_path, segment_dir, title, source, started_at_ms) in sessions {
        if let Some(segment_dir) = segment_dir {
            if let Ok(entries) = std::fs::read_dir(segment_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                        continue;
                    }
                    let Some(manifest) = std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|raw| serde_json::from_str::<SegmentManifest>(&raw).ok())
                    else {
                        continue;
                    };
                    record_segment(app, &id, &manifest)?;
                }
            }
        }

        if let Ok(metadata) = std::fs::metadata(&archive_path) {
            let duration_ms: i64 = open(app)?
                .query_row(
                    "SELECT COALESCE(max(start_ms + duration_ms), 0) FROM recording_segments WHERE session_id=?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let mut recording = crate::store::load_all(app)
                .into_iter()
                .find(|recording| recording.id == id);
            if recording.is_none() {
                let recovered = crate::store::StoredRecording {
                    id: id.clone(),
                    title,
                    started_at_ms,
                    duration_sec: duration_ms / 1_000,
                    source,
                    status: "processing".to_string(),
                    summary: None,
                    transcript: None,
                    notes: None,
                    has_audio: true,
                    has_video: false,
                    folder_path: archive_path
                        .parent()
                        .and_then(|path| path.to_str())
                        .map(str::to_string),
                };
                crate::store::append(app, recovered.clone())?;
                recording = Some(recovered);
            }

            if let (Some(recording), Some(folder)) = (recording.as_ref(), archive_path.parent()) {
                crate::fs_writer::persist_recording_artifacts(
                    Some(app),
                    folder,
                    recording,
                    None,
                    recording.notes.as_deref(),
                )?;
            }
            finish_recording(app, &id, &archive_path, duration_ms, metadata.len() as i64)?;
        }
    }
    Ok(())
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

pub fn record_segment<R: Runtime>(app: &AppHandle<R>, session_id: &str, segment: &SegmentManifest) -> Result<(), String> {
    record_segment_on(&open(app)?, session_id, segment, chrono::Utc::now().timestamp_millis())
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
             archive_bytes=?5, status='uploading', updated_at=?3 WHERE id=?1",
            params![id, archive_path.to_string_lossy(), now, duration_ms, archive_bytes],
        )
        .map_err(|e| format!("finalize local recording: {e}"))?;
    Ok(())
}

pub fn next_session<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PendingSession>, String> {
    next_session_on(&open(app)?, chrono::Utc::now().timestamp_millis())
}

pub fn defer_session(app: &AppHandle, id: &str, delay_ms: i64, error: Option<&str>) -> Result<(), String> {
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

pub fn mark_session_failed(app: &AppHandle, id: &str, error: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET status='failed', last_error=?2, updated_at=?3 WHERE id=?1",
            params![id, error, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark session failed: {e}"))?;
    Ok(())
}

pub fn attach_remote(app: &AppHandle, id: &str, remote_id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET remote_meeting_id=?2, updated_at=?3 WHERE id=?1",
            params![id, remote_id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("persist remote meeting id: {e}"))?;
    Ok(())
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
             ORDER BY idx, track LIMIT 1",
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

pub fn mark_segment_failed(app: &AppHandle, segment: &PendingSegment, error: &str) -> Result<(), String> {
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

pub fn advance_archive(
    app: &AppHandle,
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

pub fn mark_processing(app: &AppHandle, id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET status='processing', last_error=NULL, updated_at=?2
             WHERE id=?1",
            params![id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark session processing: {e}"))?;
    Ok(())
}

pub fn mark_complete(app: &AppHandle, id: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE recording_sessions SET status='complete', last_error=NULL, updated_at=?2
             WHERE id=?1",
            params![id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| format!("mark session complete: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn session(conn: &Connection, id: &str, status: &str, started_at: i64, next_attempt_at: i64) {
        conn.execute(
            "INSERT INTO recording_sessions (id, archive_path, source, title, started_at, status, next_attempt_at, updated_at)
             VALUES (?1, '/tmp/a.m4a', 'mixed', 't', ?2, ?3, ?4, 0)",
            params![id, started_at, status, next_attempt_at],
        )
        .unwrap();
    }

    #[test]
    fn retry_context_failure_leaves_other_failures_alone() {
        let conn = db();
        session(&conn, "context", "failed", 1, 100);
        session(&conn, "unrelated", "failed", 2, 100);
        let error = r#"create cloud recording session: HTTP 400 Bad Request: {"issues":[{"path":["contextBlurb"]}]}"#;
        conn.execute("UPDATE recording_sessions SET last_error=?1 WHERE id='context'", [error]).unwrap();
        conn.execute("UPDATE recording_sessions SET last_error='archive file missing' WHERE id='unrelated'", []).unwrap();
        retry_context_rejections(&conn).unwrap();
        assert_eq!(next_session_on(&conn, 0).unwrap().unwrap().id, "context");
        let status: String = conn.query_row("SELECT status FROM recording_sessions WHERE id='unrelated'", [], |row| row.get(0)).unwrap();
        assert_eq!(status, "failed");
        retry_context_rejections(&conn).unwrap();
    }

    #[test]
    fn processing_session_does_not_block_newer_uploads() {
        let conn = db();
        session(&conn, "old", "processing", 1, 0);
        session(&conn, "new", "uploading", 2, 0);
        assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "new");
    }

    #[test]
    fn deferred_session_steps_aside_until_due() {
        let conn = db();
        session(&conn, "stuck", "uploading", 1, 500);
        session(&conn, "next", "uploading", 2, 0);
        assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "next");
        assert_eq!(next_session_on(&conn, 600).unwrap().unwrap().id, "stuck");
    }

    #[test]
    fn pre_track_segments_table_is_rebuilt_keeping_its_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS_SQL).unwrap();
        conn.execute_batch(
            "CREATE TABLE recording_segments (
               session_id TEXT NOT NULL, idx INTEGER NOT NULL, file_path TEXT NOT NULL,
               start_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, bytes INTEGER NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
               next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
               PRIMARY KEY(session_id, idx));",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recording_sessions (id, archive_path, source, title, started_at, updated_at)
             VALUES ('s', '/a.m4a', 'mixed', 't', 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO recording_segments (session_id, idx, file_path, start_ms, duration_ms, bytes, created_at, updated_at)
             VALUES ('s', 0, '/a.m4a', 0, 1000, 10, 0, 0)",
            [],
        )
        .unwrap();

        migrate(&conn).unwrap();

        let track: String = conn
            .query_row("SELECT track FROM recording_segments WHERE session_id='s' AND idx=0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(track, "mixed");
        for track in ["mic", "system"] {
            let manifest: SegmentManifest = serde_json::from_value(serde_json::json!({
                "path": format!("/b-{track}.m4a"), "index": 1, "track": track,
                "startMs": 1000, "durationMs": 1000, "bytes": 10, "peakRms": 0.2, "activeMs": 500
            }))
            .unwrap();
            record_segment_on(&conn, "s", &manifest, 0).unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT count(*) FROM recording_segments WHERE idx=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn old_manifests_without_a_track_read_as_mixed() {
        let manifest: SegmentManifest = serde_json::from_str(
            r#"{"path":"/a.m4a","index":0,"startMs":0,"durationMs":1,"bytes":1}"#,
        )
        .unwrap();
        assert_eq!(manifest.track, "mixed");
        assert_eq!(manifest.active_ms, None);
    }

    #[test]
    fn failed_and_complete_sessions_are_never_picked() {
        let conn = db();
        session(&conn, "a", "failed", 1, 0);
        session(&conn, "b", "complete", 2, 0);
        assert!(next_session_on(&conn, 100).unwrap().is_none());
    }
}

pub fn enqueue_file_edit<R: Runtime>(
    app: &AppHandle<R>,
    local_session_id: &str,
    role: &str,
    content_md: &str,
    content_hash: &str,
) -> Result<(), String> {
    let operation_id = format!("file-edit:{local_session_id}:{role}");
    let payload = serde_json::to_string(&PendingFileEdit {
        operation_id: operation_id.clone(),
        local_session_id: local_session_id.to_string(),
        role: role.to_string(),
        content_md: content_md.to_string(),
        content_hash: content_hash.to_string(),
    })
    .map_err(|error| format!("serialize external file edit: {error}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "INSERT INTO pending_operations
             (id, operation_type, payload_json, attempts, last_attempt_at,
              last_error, created_at, status)
             VALUES (?1, 'file-edit', ?2, 0, NULL, NULL, ?3, 'pending')
             ON CONFLICT(id) DO UPDATE SET
               payload_json=excluded.payload_json,
               attempts=0,
               last_attempt_at=NULL,
               last_error=NULL,
               created_at=excluded.created_at,
               status='pending'",
            params![operation_id, payload, now],
        )
        .map_err(|error| format!("queue external file edit: {error}"))?;
    Ok(())
}

pub fn next_file_edit<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<PendingFileEdit>, String> {
    let raw = open(app)?
        .query_row(
            "SELECT payload_json FROM pending_operations
             WHERE operation_type='file-edit' AND status IN ('pending','failed')
             ORDER BY created_at LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read external file edit queue: {error}"))?;
    raw.map(|payload| {
        serde_json::from_str(&payload)
            .map_err(|error| format!("decode external file edit queue: {error}"))
    })
    .transpose()
}

pub fn remote_meeting_id(app: &AppHandle, local_session_id: &str) -> Result<Option<String>, String> {
    open(app)?
        .query_row(
            "SELECT remote_meeting_id FROM recording_sessions WHERE id=?1",
            params![local_session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(|error| format!("resolve cloud meeting for external edit: {error}"))
}

pub fn mark_operation_done<R: Runtime>(
    app: &AppHandle<R>,
    operation_id: &str,
) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE pending_operations SET status='done', last_error=NULL,
             last_attempt_at=?2 WHERE id=?1",
            params![operation_id, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|error| format!("complete external file edit: {error}"))?;
    Ok(())
}

pub fn mark_operation_failed(
    app: &AppHandle,
    operation_id: &str,
    error: &str,
) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE pending_operations SET status='failed', attempts=attempts+1,
             last_attempt_at=?2, last_error=?3 WHERE id=?1",
            params![operation_id, chrono::Utc::now().timestamp_millis(), error],
        )
        .map_err(|db_error| format!("fail external file edit: {db_error}"))?;
    Ok(())
}

pub fn record_file_write<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    meeting_id: &str,
    role: &str,
    hash: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    open(app)?
        .execute(
            "INSERT INTO filesystem_state
             (file_path, meeting_id, file_role, last_written_at, last_written_hash,
              last_observed_at, last_observed_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?5)
             ON CONFLICT(file_path) DO UPDATE SET
               meeting_id=excluded.meeting_id,
               file_role=excluded.file_role,
               last_written_at=excluded.last_written_at,
               last_written_hash=excluded.last_written_hash,
               last_observed_at=excluded.last_observed_at,
               last_observed_hash=excluded.last_observed_hash",
            params![path.to_string_lossy(), meeting_id, role, now, hash],
        )
        .map_err(|error| format!("track generated file: {error}"))?;
    Ok(())
}

pub fn file_was_edited<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    current_hash: &str,
) -> Result<bool, String> {
    let state = open(app)?
        .query_row(
            "SELECT last_written_hash FROM filesystem_state WHERE file_path=?1",
            params![path.to_string_lossy()],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("inspect generated file state: {error}"))?;
    Ok(match state {
        Some(Some(written_hash)) => written_hash != current_hash,
        Some(None) => true,
        None => path.exists(),
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum FileObservation {
    Baseline,
    Current,
    External,
}

pub fn classify_file_observation<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    hash: &str,
    expected_hash: Option<&str>,
) -> Result<FileObservation, String> {
    let previous = open(app)?
        .query_row(
            "SELECT last_written_hash, last_observed_hash
             FROM filesystem_state WHERE file_path=?1",
            params![path.to_string_lossy()],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("read observed file state: {error}"))?;
    Ok(classify_observation(previous.as_ref(), hash, expected_hash))
}

fn classify_observation(
    previous: Option<&(Option<String>, Option<String>)>,
    hash: &str,
    expected_hash: Option<&str>,
) -> FileObservation {
    match previous {
        Some((written, observed))
            if written.as_deref() == Some(hash) || observed.as_deref() == Some(hash) =>
        {
            FileObservation::Current
        }
        Some(_) => FileObservation::External,
        None if expected_hash == Some(hash) => FileObservation::Baseline,
        None => FileObservation::External,
    }
}

pub fn record_file_observation<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    meeting_id: &str,
    role: &str,
    hash: &str,
) -> Result<(), String> {
    let conn = open(app)?;
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO filesystem_state
         (file_path, meeting_id, file_role, last_observed_at, last_observed_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(file_path) DO UPDATE SET
           meeting_id=excluded.meeting_id,
           file_role=excluded.file_role,
           last_observed_at=excluded.last_observed_at,
           last_observed_hash=excluded.last_observed_hash",
        params![path.to_string_lossy(), meeting_id, role, now, hash],
    )
    .map_err(|error| format!("record observed file state: {error}"))?;
    Ok(())
}

pub fn relocate_recording_folder<R: Runtime>(
    app: &AppHandle<R>,
    local_session_id: &str,
    folder: &Path,
) -> Result<(), String> {
    let mut conn = open(app)?;
    relocate_recording_folder_in(&mut conn, local_session_id, folder)
}

fn relocate_recording_folder_in(
    conn: &mut Connection,
    local_session_id: &str,
    folder: &Path,
) -> Result<(), String> {
    let transaction = conn
        .transaction()
        .map_err(|error| format!("begin recording-folder relocation: {error}"))?;
    transaction
        .execute(
            "UPDATE recording_sessions SET archive_path=?2, updated_at=?3 WHERE id=?1",
            params![
                local_session_id,
                folder.join("audio.m4a").to_string_lossy(),
                chrono::Utc::now().timestamp_millis()
            ],
        )
        .map_err(|error| format!("relocate recording archive: {error}"))?;
    transaction
        .execute(
            "DELETE FROM filesystem_state WHERE meeting_id=?1",
            params![local_session_id],
        )
        .map_err(|error| format!("reset relocated filesystem state: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit recording-folder relocation: {error}"))
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn isolated_mock_app(root: &Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        tauri::test::mock_builder().build(context).unwrap()
    }

    #[test]
    fn restart_recovers_sealed_segments_and_a_complete_offline_folder() {
        let root = std::env::temp_dir().join(format!(
            "eavesy-interrupted-recovery-{}",
            uuid::Uuid::new_v4()
        ));
        let folder = root.join("recording");
        let archive = folder.join("audio.m4a");
        let segment_dir = root.join("capture").join("segments");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&segment_dir).unwrap();

        let app = isolated_mock_app(&root);
        initialize(app.handle()).unwrap();
        begin_recording(
            app.handle(),
            "meeting-1",
            &archive,
            &segment_dir,
            "mixed",
            "Recovered meeting",
            Some("Recovery acceptance"),
            1_751_808_600_000,
        )
        .unwrap();

        std::fs::write(&archive, b"finalized continuous audio").unwrap();
        for (index, start_ms) in [(0, 0), (1, 240_000)] {
          for track in ["mic", "system"] {
            let segment = segment_dir.join(format!("segment-{index:06}-{track}.m4a"));
            std::fs::write(&segment, format!("segment {index}")).unwrap();
            let manifest = serde_json::json!({
                "path": segment,
                "index": index,
                "startMs": start_ms,
                "durationMs": 240_000,
                "track": track,
                "activeMs": 60_000,
                "bytes": 9,
            });
            std::fs::write(
                format!("{}.json", segment.to_string_lossy()),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        }
          }
        drop(app);

        let restarted = isolated_mock_app(&root);
        initialize(restarted.handle()).unwrap();

        let session = next_session(restarted.handle())
            .unwrap()
            .expect("recovered capture should remain queued");
        assert_eq!(session.status, "uploading");
        assert_eq!(session.archive_path, archive);
        assert_eq!(
            next_segment(restarted.handle(), "meeting-1")
                .unwrap()
                .unwrap()
                .idx,
            0
        );
        mark_segment_uploaded(restarted.handle(), &next_segment(restarted.handle(), "meeting-1").unwrap().unwrap()).unwrap();
        assert_eq!(next_segment(restarted.handle(), "meeting-1").unwrap().unwrap().idx, 0);
        mark_segment_uploaded(restarted.handle(), &next_segment(restarted.handle(), "meeting-1").unwrap().unwrap()).unwrap();
        assert_eq!(
            next_segment(restarted.handle(), "meeting-1")
                .unwrap()
                .unwrap()
                .idx,
            1
        );

        let recovered = crate::store::load_all(restarted.handle());
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].id, "meeting-1");
        assert_eq!(recovered[0].duration_sec, 480);
        for filename in [
            "audio.m4a",
            "transcript.md",
            "summary.md",
            "notes.md",
            "meeting.json",
        ] {
            assert!(folder.join(filename).is_file(), "missing {filename}");
        }

        drop(restarted);
        let second_restart = isolated_mock_app(&root);
        initialize(second_restart.handle()).unwrap();
        assert_eq!(crate::store::load_all(second_restart.handle()).len(), 1);
        assert_eq!(
            next_segment(second_restart.handle(), "meeting-1")
                .unwrap()
                .unwrap()
                .idx,
            1
        );

        drop(second_restart);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unknown_existing_file_is_compared_with_legacy_baseline() {
        assert_eq!(
            classify_observation(None, "generated", Some("generated")),
            FileObservation::Baseline
        );
        assert_eq!(
            classify_observation(None, "edited", Some("generated")),
            FileObservation::External
        );
    }

    #[test]
    fn generated_and_duplicate_observations_are_ignored() {
        let generated = (Some("same".to_string()), Some("same".to_string()));
        assert_eq!(
            classify_observation(Some(&generated), "same", None),
            FileObservation::Current
        );

        let edited = (Some("generated".to_string()), Some("edited".to_string()));
        assert_eq!(
            classify_observation(Some(&edited), "edited", None),
            FileObservation::Current
        );
        assert_eq!(
            classify_observation(Some(&edited), "new edit", None),
            FileObservation::External
        );
    }

    #[test]
    fn folder_relocation_moves_archive_queue_and_resets_old_hash_paths() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATIONS_SQL).unwrap();
        conn.execute(
            "INSERT INTO recording_sessions
             (id, archive_path, source, title, started_at, status, updated_at)
             VALUES ('meeting-1', '/old/audio.m4a', 'mixed', 'Meeting', 1, 'uploading', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO filesystem_state
             (file_path, meeting_id, file_role, last_written_hash)
             VALUES ('/old/summary.md', 'meeting-1', 'summary', 'old-hash')",
            [],
        )
        .unwrap();

        relocate_recording_folder_in(&mut conn, "meeting-1", Path::new("/new")).unwrap();

        let archive: String = conn
            .query_row(
                "SELECT archive_path FROM recording_sessions WHERE id='meeting-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let old_states: i64 = conn
            .query_row(
                "SELECT count(*) FROM filesystem_state WHERE meeting_id='meeting-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archive, "/new/audio.m4a");
        assert_eq!(old_states, 0);
    }
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<(), String> {
    if !has_column(conn, table, column)? {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"), [])
            .map_err(|e| format!("migrate local {table}.{column}: {e}"))?;
    }
    Ok(())
}

fn record_segment_on(conn: &Connection, session_id: &str, segment: &SegmentManifest, now: i64) -> Result<(), String> {
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
    Ok(())
}

fn next_session_on(conn: &Connection, now: i64) -> Result<Option<PendingSession>, String> {
    conn
        .query_row(
            "SELECT id, remote_meeting_id, archive_path, title, context_blurb,
                    status, next_part_number, next_archive_offset, ended_at
             FROM recording_sessions
             WHERE status IN ('recording','uploading','finalizing','processing')
               AND next_attempt_at <= ?1
             ORDER BY status = 'processing', started_at LIMIT 1",
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
                })
            },
        )
        .optional()
        .map_err(|e| format!("read pending session: {e}"))
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

pub const PROCESSING_GIVE_UP_MS: i64 = 24 * 60 * 60 * 1_000;
const SEGMENT_MAX_ATTEMPTS: i64 = 200;
