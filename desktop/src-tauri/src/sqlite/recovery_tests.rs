use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use super::schema::MIGRATIONS_SQL;
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

    std::fs::write(&archive, crate::recovery::playable_m4a()).unwrap();
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
    assert!(!session.archive_missing);
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

struct Fixture {
    root: PathBuf,
    app: tauri::App<tauri::test::MockRuntime>,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("eavesy-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let app = isolated_mock_app(&root);
        initialize(app.handle()).unwrap();
        Self { root, app }
    }

    fn handle(&self) -> &AppHandle<tauri::test::MockRuntime> {
        self.app.handle()
    }

    /// Starts a capture with `segments` sealed segments on disk (manifests only;
    /// the sync loop is not involved).
    fn capture(&self, id: &str, segments: i64) -> PathBuf {
        let folder = self.root.join(id);
        let segment_dir = self.root.join("capture").join(id).join("segments");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&segment_dir).unwrap();
        let archive = folder.join("audio.m4a");
        begin_recording(self.handle(), id, &archive, &segment_dir, "mic", "Memo", None, 1_000).unwrap();
        for index in 0..segments {
            let segment = segment_dir.join(format!("segment-{index:06}-mixed.m4a"));
            std::fs::write(&segment, b"segment").unwrap();
            let manifest = serde_json::json!({
                "path": segment, "index": index, "startMs": index * 240_000,
                "durationMs": 240_000, "bytes": 7,
            });
            std::fs::write(
                format!("{}.json", segment.to_string_lossy()),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
        }
        archive
    }

    fn status(&self, id: &str) -> (String, bool, Option<String>) {
        with_conn(self.handle(), |conn| {
            conn.query_row(
                "SELECT status, archive_missing, last_error FROM recording_sessions WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap()
        })
    }

    fn restart(&mut self) {
        let app = isolated_mock_app(&self.root);
        initialize(app.handle()).unwrap();
        self.app = app;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_stopped_capture_is_due_at_once_even_if_it_was_deferred_while_recording() {
    let fixture = Fixture::new();
    let archive = fixture.capture("dictation", 0);
    std::fs::write(&archive, crate::recovery::playable_m4a()).unwrap();
    // While recording, the sync loop parks the session between result polls.
    defer_session(fixture.handle(), "dictation", 10_000, Some("waiting")).unwrap();
    assert!(next_session(fixture.handle()).unwrap().is_none());

    finish_recording(fixture.handle(), "dictation", &archive, 3_000, 10).unwrap();

    let due = next_session(fixture.handle()).unwrap().expect("stopped dictation should be due now");
    assert_eq!(due.id, "dictation");
    assert_eq!(fixture.status("dictation").2, None);
}

#[test]
fn launch_recovery_finishes_from_segments_when_the_archive_is_missing() {
    let mut fixture = Fixture::new();
    fixture.capture("lost-archive", 2);
    fixture.restart();

    assert_eq!(fixture.status("lost-archive").0, "uploading");
    assert!(fixture.status("lost-archive").1, "archive should be flagged missing");
    let session = next_session(fixture.handle()).unwrap().unwrap();
    assert!(session.archive_missing);
    assert_eq!(next_segment(fixture.handle(), "lost-archive").unwrap().unwrap().idx, 0);
    let recording = &crate::store::load_all(fixture.handle())[0];
    assert_eq!((recording.status.as_str(), recording.has_audio), ("processing", false));
    assert_eq!(recording.duration_sec, 480);
}

#[test]
fn launch_recovery_does_not_upload_an_unfinished_archive() {
    let mut fixture = Fixture::new();
    let archive = fixture.capture("killed", 1);
    // What a capture killed mid-write leaves: data without the moov index.
    std::fs::write(&archive, crate::recovery::mp4_box(b"ftyp", b"M4A ")).unwrap();
    fixture.restart();
    assert_eq!(fixture.status("killed").0, "uploading");
    assert!(fixture.status("killed").1);
}

#[test]
fn launch_recovery_fails_a_capture_with_nothing_saved_instead_of_polling_it() {
    let mut fixture = Fixture::new();
    fixture.capture("empty", 0);
    fixture.restart();

    let (status, _, error) = fixture.status("empty");
    assert_eq!(status, "failed");
    assert!(error.unwrap().contains("no audio was captured"));
    assert!(next_session(fixture.handle()).unwrap().is_none());
    assert_eq!(crate::store::load_all(fixture.handle())[0].status, "failed");
}

#[test]
fn launch_recovery_leaves_a_cancelled_capture_alone() {
    let mut fixture = Fixture::new();
    fixture.capture("cancelled", 1);
    discard_recording(fixture.handle(), "cancelled").unwrap();
    fixture.restart();

    let (status, _, error) = fixture.status("cancelled");
    assert_eq!((status.as_str(), error), ("recording", None), "must not be recovered");
    assert!(crate::store::load_all(fixture.handle()).is_empty());
    assert!(next_session(fixture.handle()).unwrap().unwrap().discarded);
    forget_discarded(fixture.handle(), "cancelled").unwrap();
    assert!(next_session(fixture.handle()).unwrap().is_none());
}

#[test]
fn launch_recovery_waits_for_an_unmounted_recording_folder() {
    let mut fixture = Fixture::new();
    let archive = fixture.capture("external-disk", 2);
    std::fs::write(&archive, crate::recovery::playable_m4a()).unwrap();
    let folder = archive.parent().unwrap().to_path_buf();
    let parked = fixture.root.join("unmounted");
    std::fs::rename(&folder, &parked).unwrap();

    fixture.restart();

    let (status, missing, note) = fixture.status("external-disk");
    assert_eq!((status.as_str(), missing), ("recording", false), "must not be failed or marked lost");
    assert!(note.unwrap().starts_with(crate::recovery::DEFERRED_NOTE));
    assert_eq!(next_segment(fixture.handle(), "external-disk").unwrap().unwrap().idx, 0);

    std::fs::rename(&parked, &folder).unwrap();
    crate::recovery::retry_deferred(fixture.handle());
    assert_eq!(fixture.status("external-disk"), ("uploading".to_string(), false, None));
}

#[test]
fn recovery_updates_the_queue_even_if_the_recording_folder_cannot_be_written() {
    let mut fixture = Fixture::new();
    let archive = fixture.capture("read-only", 1);
    let folder = archive.parent().unwrap().to_path_buf();
    let mut permissions = std::fs::metadata(&folder).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o500);
    std::fs::set_permissions(&folder, permissions.clone()).unwrap();

    fixture.restart();

    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o700);
    std::fs::set_permissions(&folder, permissions).unwrap();
    assert_eq!(fixture.status("read-only").0, "uploading");
    assert!(fixture.status("read-only").1);
}

#[test]
fn salvaging_a_failed_stop_leaves_other_captures_recording() {
    let fixture = Fixture::new();
    fixture.capture("failed-stop", 1);
    fixture.capture("still-going", 1);

    let outcome = crate::recovery::salvage(fixture.handle(), "failed-stop", "stop timed out").unwrap();

    assert_eq!(outcome, crate::recovery::Salvage::Segments(1));
    assert_eq!(fixture.status("failed-stop").0, "uploading");
    assert_eq!(fixture.status("still-going").0, "recording");
    assert!(fixture.status("failed-stop").2.unwrap().contains("stop timed out"));
}

#[test]
fn salvaging_a_failed_stop_keeps_a_playable_archive() {
    let fixture = Fixture::new();
    let archive = fixture.capture("late-error", 1);
    std::fs::write(&archive, crate::recovery::playable_m4a()).unwrap();
    let outcome = crate::recovery::salvage(fixture.handle(), "late-error", "registry write failed").unwrap();
    assert_eq!(outcome, crate::recovery::Salvage::Archive);
    assert_eq!(fixture.status("late-error"), ("uploading".to_string(), false, None));
}

#[test]
fn segments_dropped_while_signed_out_are_queued_again() {
    let mut fixture = Fixture::new();
    fixture.capture("signed-out", 1);
    fixture.restart();
    with_conn(fixture.handle(), |conn| {
        conn.execute(
            &format!(
                "UPDATE recording_segments SET status='failed', gave_up=1, attempts=200,
                 last_error='upload transcript segment: {UNAUTHORIZED_MARKER}'"
            ),
            [],
        )
        .unwrap();
    });
    assert!(next_segment(fixture.handle(), "signed-out").unwrap().is_none());

    fixture.restart();

    let segment = next_segment(fixture.handle(), "signed-out").unwrap();
    assert_eq!(segment.map(|segment| segment.idx), Some(0));
}

#[test]
fn segments_are_kept_until_a_session_completes_with_its_archive() {
    let mut fixture = Fixture::new();
    let archive = fixture.capture("meeting", 2);
    std::fs::write(&archive, crate::recovery::playable_m4a()).unwrap();
    fixture.restart();
    let capture_dir = fixture.root.join("capture").join("meeting");
    let first = next_segment(fixture.handle(), "meeting").unwrap().unwrap();

    mark_segment_uploaded(fixture.handle(), &first).unwrap();
    assert!(first.file_path.exists(), "uploaded segments stay until the session completes");

    mark_complete(fixture.handle(), "meeting").unwrap();
    assert!(!capture_dir.exists());
}

#[test]
fn segments_of_a_session_without_its_archive_are_never_removed() {
    let mut fixture = Fixture::new();
    fixture.capture("lost-archive", 2);
    fixture.restart();
    assert!(fixture.status("lost-archive").1);
    let capture_dir = fixture.root.join("capture").join("lost-archive");
    let first = next_segment(fixture.handle(), "lost-archive").unwrap().unwrap();

    mark_segment_uploaded(fixture.handle(), &first).unwrap();
    mark_complete(fixture.handle(), "lost-archive").unwrap();

    assert!(first.file_path.exists());
    assert!(capture_dir.join("segments").join("segment-000001-mixed.m4a").exists());
}

#[test]
fn synced_edits_are_pruned_after_a_week() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    let day = 24 * 60 * 60 * 1_000;
    for (id, status, at) in [("old", "done", 0), ("recent", "done", 6 * day), ("stuck", "failed", 0)] {
        conn.execute(
            "INSERT INTO pending_operations (id, operation_type, payload_json, attempts, last_attempt_at, created_at, status)
             VALUES (?1, 'file-edit', '{}', 0, ?2, ?2, ?3)",
            params![id, at, status],
        )
        .unwrap();
    }
    prune_done_operations(&conn, 8 * day).unwrap();
    let left: Vec<String> = conn
        .prepare("SELECT id FROM pending_operations ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(left, ["recent", "stuck"]);
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
