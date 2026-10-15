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

pub fn mark_operation_failed<R: Runtime>(app: &AppHandle<R>,
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
