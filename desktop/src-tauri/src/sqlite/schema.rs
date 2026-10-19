use rusqlite::{params, Connection};

pub const MIGRATIONS_SQL: &str = include_str!("../schema.sql");

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

/// Older builds counted 401s as ordinary failures and gave up on segments after
/// the attempt limit; put those back in the queue now that a 401 pauses sync.
pub(super) fn retry_unauthorized_segments(conn: &Connection) -> Result<(), String> {
    conn.execute(
        &format!(
            "UPDATE recording_segments SET status='pending', gave_up=0, attempts=0, next_attempt_at=0
             WHERE gave_up=1 AND last_error LIKE '%{UNAUTHORIZED_MARKER}%'"
        ),
        [],
    )
    .map_err(|error| format!("requeue segments refused while signed out: {error}"))?;
    Ok(())
}

/// Synced external edits are only kept for a week, for diagnostics.
const DONE_OPERATION_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

pub(super) fn prune_done_operations(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM pending_operations WHERE status='done' AND COALESCE(last_attempt_at, created_at) < ?1",
        params![now - DONE_OPERATION_RETENTION_MS],
    )
    .map_err(|error| format!("prune synced edits: {error}"))?;
    Ok(())
}

/// Part of the message the sync loop records for a 401 response.
pub const UNAUTHORIZED_MARKER: &str = "device is not paired or its credential was revoked";

pub(super) fn retry_context_rejections(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE recording_sessions SET status='uploading', last_error=NULL, next_attempt_at=0
         WHERE status='failed' AND remote_meeting_id IS NULL AND context_blurb IS NULL
         AND last_error LIKE 'create cloud recording session: HTTP 400%'
         AND last_error LIKE '%\"path\":[\"contextBlurb\"]%'",
        [],
    ).map_err(|error| format!("retry rejected voice notes: {error}"))?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MIGRATIONS_SQL)
        .map_err(|e| format!("initialize local database: {e}"))?;
    add_column_if_missing(conn, "recording_sessions", "segment_dir", "TEXT")?;
    add_column_if_missing(conn, "recording_sessions", "next_attempt_at", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "recording_sessions", "archive_missing", "INTEGER NOT NULL DEFAULT 0")?;
    add_column_if_missing(conn, "recording_sessions", "project_id", "TEXT")?;
    conn.execute_batch(crate::live_transcript::SCHEMA)
        .map_err(|e| format!("initialize live transcript: {e}"))?;
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

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, ddl: &str) -> Result<(), String> {
    if !has_column(conn, table, column)? {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"), [])
            .map_err(|e| format!("migrate local {table}.{column}: {e}"))?;
    }
    Ok(())
}
