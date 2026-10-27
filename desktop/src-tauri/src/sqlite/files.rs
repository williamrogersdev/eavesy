use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use super::open;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFileEdit {
    pub operation_id: String,
    pub local_session_id: String,
    pub role: String,
    pub content_md: String,
    pub content_hash: String,
}

/// An edit that keeps failing is retried this many times, five seconds after
/// the first failure and twice as long after each one (at most an hour).
pub const FILE_EDIT_MAX_ATTEMPTS: i64 = 20;

/// Queues an edit for the cloud, if the recording has a copy there (or will):
/// one this Mac uploads, or one brought in from the cloud. An edit to anything
/// else, such as a screen recording, would never be taken.
pub fn enqueue_file_edit<R: Runtime>(
    app: &AppHandle<R>,
    local_session_id: &str,
    role: &str,
    content_md: &str,
    content_hash: &str,
) -> Result<(), String> {
    let pulled = crate::cloud_pull::is_pulled(app, local_session_id);
    let conn = open(app)?;
    if !pulled && !has_session_in(&conn, local_session_id)? {
        return Ok(());
    }
    enqueue_file_edit_in(&conn, local_session_id, role, content_md, content_hash)
}

/// Whether this Mac has an upload session for the recording.
pub(crate) fn has_session_in(conn: &Connection, local_session_id: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM recording_sessions WHERE id=?1", params![local_session_id], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
        .map_err(|error| format!("look up recording session: {error}"))
}

pub(crate) fn enqueue_file_edit_in(
    conn: &Connection, local_session_id: &str, role: &str, content_md: &str, content_hash: &str,
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
    conn.execute(
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
               status='pending',
               next_attempt_at=0,
               abandoned=0",
            params![operation_id, payload, now],
        )
        .map_err(|error| format!("queue external file edit: {error}"))?;
    Ok(())
}

/// The oldest edit that is due. One waiting or given up on never holds up the rest.
pub fn next_file_edit<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<PendingFileEdit>, String> {
    next_file_edit_on(&*open(app)?, chrono::Utc::now().timestamp_millis())
}

pub(crate) fn next_file_edit_on(conn: &Connection, now: i64) -> Result<Option<PendingFileEdit>, String> {
    let raw = conn
        .query_row(
            "SELECT payload_json FROM pending_operations
             WHERE operation_type='file-edit' AND status IN ('pending','failed')
               AND abandoned=0 AND next_attempt_at <= ?1
             ORDER BY created_at LIMIT 1",
            params![now],
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

/// The cloud meeting of a recording this Mac uploads, if it has one yet, and
/// its upload status; `None` when this Mac never had an upload session for it.
pub fn session_cloud_home<R: Runtime>(
    app: &AppHandle<R>,
    local_session_id: &str,
) -> Result<Option<(Option<String>, String)>, String> {
    open(app)?
        .query_row(
            "SELECT remote_meeting_id, status FROM recording_sessions WHERE id=?1",
            params![local_session_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("resolve cloud meeting for external edit: {error}"))
}

pub fn remote_meeting_id<R: Runtime>(app: &AppHandle<R>, local_session_id: &str) -> Result<Option<String>, String> {
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

/// Cloud meetings this Mac recorded itself.
pub fn remote_meeting_ids<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    let conn = open(app)?;
    let mut statement = conn
        .prepare("SELECT remote_meeting_id FROM recording_sessions WHERE remote_meeting_id IS NOT NULL")
        .map_err(|error| format!("list cloud meetings recorded here: {error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(Iterator::collect)
        .map_err(|error| format!("list cloud meetings recorded here: {error}"));
    ids
}

/// The finished local recording behind a cloud meeting this Mac recorded, if any.
pub fn completed_session_for_remote<R: Runtime>(app: &AppHandle<R>, remote_meeting_id: &str) -> Result<Option<String>, String> {
    open(app)?
        .query_row(
            "SELECT id FROM recording_sessions WHERE remote_meeting_id=?1 AND status='complete'",
            params![remote_meeting_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("resolve local recording for cloud meeting: {error}"))
}

/// Once an edit reached the cloud, the file as edited is what the cloud holds:
/// take it as the baseline so later changes made elsewhere can replace it.
/// Leaves the file alone if it changed again after the edit was queued.
pub fn adopt_uploaded_edit<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, role: &str, hash: &str) -> Result<(), String> {
    let adopted = open(app)?
        .execute(
            "UPDATE filesystem_state SET last_written_hash=?3, last_written_at=?4
             WHERE meeting_id=?1 AND file_role=?2 AND last_observed_hash=?3",
            params![meeting_id, role, hash, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|error| format!("adopt uploaded edit: {error}"))?;
    // None when the file changed again since: that newer edit is queued and adopted in turn.
    if adopted == 0 {
        tracing::info!(%meeting_id, %role, "desktop ingest: the file changed again after its edit was sent; keeping it as a local edit");
    }
    Ok(())
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

/// A failed attempt: tried again after a backoff, and given up on after
/// `FILE_EDIT_MAX_ATTEMPTS`.
pub fn mark_operation_failed<R: Runtime>(app: &AppHandle<R>,
    operation_id: &str,
    error: &str,
) -> Result<(), String> {
    mark_operation_failed_on(&*open(app)?, operation_id, error, chrono::Utc::now().timestamp_millis())
}

pub(crate) fn mark_operation_failed_on(conn: &Connection, operation_id: &str, error: &str, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE pending_operations SET status='failed', attempts=attempts+1,
         next_attempt_at=?2 + min(3600000, 5000 * (1 << min(attempts, 10))),
         abandoned=(attempts + 1 >= ?4),
         last_attempt_at=?2, last_error=?3 WHERE id=?1",
        params![operation_id, now, error, FILE_EDIT_MAX_ATTEMPTS],
    )
    .map_err(|db_error| format!("fail external file edit: {db_error}"))?;
    Ok(())
}

/// An edit the cloud will never take (its meeting is gone, or it was refused
/// outright): kept with the reason, for diagnostics, and never sent again.
pub fn abandon_operation<R: Runtime>(app: &AppHandle<R>, operation_id: &str, error: &str) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE pending_operations SET status='failed', abandoned=1,
             last_attempt_at=?2, last_error=?3 WHERE id=?1",
            params![operation_id, chrono::Utc::now().timestamp_millis(), error],
        )
        .map_err(|db_error| format!("give up on external file edit: {db_error}"))?;
    Ok(())
}

/// Leaves an edit for later without counting an attempt: its recording's
/// cloud meeting does not exist yet.
pub fn defer_operation<R: Runtime>(app: &AppHandle<R>, operation_id: &str, delay_ms: i64) -> Result<(), String> {
    open(app)?
        .execute(
            "UPDATE pending_operations SET next_attempt_at=?2 WHERE id=?1",
            params![operation_id, chrono::Utc::now().timestamp_millis() + delay_ms],
        )
        .map_err(|db_error| format!("defer external file edit: {db_error}"))?;
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

pub(super) fn classify_observation(
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
    record_file_observation_in(&*open(app)?, path, meeting_id, role, hash)
}

pub(crate) fn record_file_observation_in(
    conn: &Connection, path: &Path, meeting_id: &str, role: &str, hash: &str,
) -> Result<(), String> {
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

pub(super) fn relocate_recording_folder_in(
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
