use rusqlite::{params, Connection};

use super::schema::MIGRATIONS_SQL;
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

fn segment(conn: &Connection, session_id: &str, idx: i64) {
    let manifest: SegmentManifest = serde_json::from_value(serde_json::json!({
        "path": format!("/{session_id}-{idx}.m4a"), "index": idx,
        "startMs": idx * 240_000, "durationMs": 240_000, "bytes": 10,
    }))
    .unwrap();
    record_segment_on(conn, session_id, &manifest, 0).unwrap();
}

fn archive(conn: &Connection, id: &str, bytes: i64, offset: i64) {
    conn.execute(
        "UPDATE recording_sessions SET archive_bytes=?2, next_archive_offset=?3 WHERE id=?1",
        params![id, bytes, offset],
    )
    .unwrap();
}

#[test]
fn a_live_segment_goes_before_an_older_sessions_archive_parts() {
    let conn = db();
    session(&conn, "old-meeting", "uploading", 1, 0);
    archive(&conn, "old-meeting", 900 * 1024 * 1024, 8 * 1024 * 1024);
    session(&conn, "live", "recording", 2, 0);
    segment(&conn, "live", 0);
    assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "live");

    conn.execute("UPDATE recording_segments SET status='uploaded'", []).unwrap();
    // With nothing to upload, the live session's result poll still goes first.
    assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "live");
}

#[test]
fn a_cancelled_recording_drops_its_segments_and_goes_first_to_be_deleted() {
    let conn = db();
    session(&conn, "old-meeting", "uploading", 1, 0);
    session(&conn, "cancelled", "recording", 2, 0);
    segment(&conn, "cancelled", 0);
    conn.execute("UPDATE recording_sessions SET next_attempt_at=500 WHERE id='cancelled'", []).unwrap();
    discard_recording_on(&conn, "cancelled", 100).unwrap();

    let next = next_session_on(&conn, 100).unwrap().unwrap();
    assert_eq!(next.id, "cancelled");
    assert!(next.discarded);
    let segments: i64 = conn
        .query_row("SELECT count(*) FROM recording_segments WHERE session_id='cancelled'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(segments, 0);
    // Whatever state an in-flight upload leaves it in, it is still deleted.
    conn.execute("UPDATE recording_sessions SET status='failed' WHERE id='cancelled'", []).unwrap();
    assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "cancelled");
}

#[test]
fn a_just_stopped_note_is_not_queued_behind_a_long_archive() {
    let conn = db();
    session(&conn, "old-meeting", "uploading", 1, 0);
    archive(&conn, "old-meeting", 900 * 1024 * 1024, 16 * 1024 * 1024);
    session(&conn, "dictation", "uploading", 2, 0);
    archive(&conn, "dictation", 40 * 1024, 0);
    assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "dictation");
}

#[test]
fn a_new_segment_wakes_a_parked_live_session() {
    let conn = db();
    session(&conn, "live", "recording", 1, 10_000);
    assert!(next_session_on(&conn, 100).unwrap().is_none());
    segment(&conn, "live", 0);
    assert_eq!(next_session_on(&conn, 100).unwrap().unwrap().id, "live");
}

#[test]
fn a_new_segment_does_not_reopen_a_finished_session() {
    let conn = db();
    session(&conn, "done", "uploading", 1, 10_000);
    segment(&conn, "done", 0);
    assert!(next_session_on(&conn, 100).unwrap().is_none());
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

fn edit_state(conn: &Connection, id: &str) -> (i64, i64, i64) {
    conn.query_row(
        "SELECT attempts, next_attempt_at, abandoned FROM pending_operations WHERE id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .unwrap()
}

#[test]
fn a_failing_file_edit_backs_off_and_steps_aside_for_later_edits() {
    let conn = db();
    enqueue_file_edit_in(&conn, "a", "notes", "first", "h1").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    enqueue_file_edit_in(&conn, "b", "notes", "second", "h2").unwrap();
    let first = next_file_edit_on(&conn, i64::MAX / 2).unwrap().unwrap();
    assert_eq!(first.local_session_id, "a");

    mark_operation_failed_on(&conn, &first.operation_id, "HTTP 503", 1_000).unwrap();
    assert_eq!(edit_state(&conn, &first.operation_id), (1, 6_000, 0));
    // Waiting out its backoff, it does not hold up the next edit.
    assert_eq!(next_file_edit_on(&conn, 2_000).unwrap().unwrap().local_session_id, "b");
    mark_operation_failed_on(&conn, &first.operation_id, "HTTP 503", 6_000).unwrap();
    assert_eq!(edit_state(&conn, &first.operation_id), (2, 16_000, 0), "twice as long each time");

    for attempt in 2..FILE_EDIT_MAX_ATTEMPTS {
        mark_operation_failed_on(&conn, &first.operation_id, "HTTP 503", attempt * 1_000_000).unwrap();
    }
    let (attempts, next_attempt_at, abandoned) = edit_state(&conn, &first.operation_id);
    assert_eq!((attempts, abandoned), (FILE_EDIT_MAX_ATTEMPTS, 1), "given up on after the cap");
    assert!(next_attempt_at - (FILE_EDIT_MAX_ATTEMPTS - 1) * 1_000_000 <= 3_600_000, "at most an hour apart");
    assert_eq!(next_file_edit_on(&conn, i64::MAX / 2).unwrap().unwrap().local_session_id, "b");

    // A newer edit to the same file starts afresh.
    enqueue_file_edit_in(&conn, "a", "notes", "third", "h3").unwrap();
    assert_eq!(edit_state(&conn, &first.operation_id), (0, 0, 0));
}

#[test]
fn file_edit_columns_are_added_to_an_older_queue() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(MIGRATIONS_SQL).unwrap();
    conn.execute(
        "INSERT INTO pending_operations (id, operation_type, payload_json, created_at, status)
         VALUES ('file-edit:x:notes', 'file-edit', '{\"operationId\":\"file-edit:x:notes\",\"localSessionId\":\"x\",\"role\":\"notes\",\"contentMd\":\"\",\"contentHash\":\"h\"}', 1, 'failed')",
        [],
    )
    .unwrap();
    migrate(&conn).unwrap();
    assert_eq!(edit_state(&conn, "file-edit:x:notes"), (0, 0, 0));
    assert!(next_file_edit_on(&conn, 0).unwrap().is_some(), "an older failed edit is tried again");
}
