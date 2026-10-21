use crate::history::History;
pub use crate::history::{HistoryPage, StoredRecording};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Manager, Runtime};

// Readers use independent WAL connections. Mutations share one connection;
// activity also interrupts a background index build before a mutation waits.
struct SharedHistory {
    directory: PathBuf,
    history: Mutex<History>,
    activity: std::sync::atomic::AtomicU64,
    pending: std::sync::atomic::AtomicUsize,
}
fn shared_history<R: Runtime>(app: &AppHandle<R>) -> Result<&'static SharedHistory, String> {
    static HISTORIES: Mutex<Vec<(PathBuf, &'static SharedHistory)>> = Mutex::new(Vec::new());
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut histories = HISTORIES.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((_, shared)) = histories.iter().find(|(path, _)| path == &dir) {
        return Ok(*shared);
    }
    let shared = Box::leak(Box::new(SharedHistory {
        directory: dir.clone(),
        history: Mutex::new(History::open(
            &dir.join("history.sqlite3"),
            &dir.join("recordings.json"),
        )?),
        activity: std::sync::atomic::AtomicU64::new(0),
        pending: std::sync::atomic::AtomicUsize::new(0),
    }));
    histories.push((dir, shared));
    Ok(shared)
}
fn history<R: Runtime>(app: &AppHandle<R>) -> Result<MutexGuard<'static, History>, String> {
    let shared = shared_history(app)?;
    shared
        .pending
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    shared
        .activity
        .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
    let locked = shared.history.lock();
    shared
        .pending
        .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    let guard = match locked {
        Ok(guard) => guard,
        Err(error) => recover_shared_history(shared, error.into_inner())?,
    };
    Ok(guard)
}

fn recover_shared_history(
    shared: &'static SharedHistory,
    mut guard: MutexGuard<'static, History>,
) -> Result<MutexGuard<'static, History>, String> {
    // A panic must not leave an open writer transaction or a half-built index.
    // Reopen with normal migration/durability checks before clearing poison.
    guard.rollback_uncommitted()?;
    *guard = History::open(
        &shared.directory.join("history.sqlite3"),
        &shared.directory.join("recordings.json"),
    )?;
    shared.history.clear_poison();
    crate::telemetry::capture(
        "history.lock.recovered",
        "Reopened local history after a worker panic",
    );
    Ok(guard)
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    drop(history(app)?);
    Ok(())
}
pub fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Option<StoredRecording>, String> {
    history(app)?.get(id)
}
pub fn pending_walkthroughs(app: &AppHandle) -> Result<Vec<String>, String> {
    history(app)?.pending_walkthroughs()
}
pub fn locations<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<(String, Option<String>)>, String> {
    history(app)?.locations()
}
pub fn folders<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<(String, String)>, String> {
    history(app)?.folders()
}
pub fn ids<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    history(app)?.ids()
}
pub fn by_folder<R: Runtime>(
    app: &AppHandle<R>,
    folder: &Path,
) -> Result<Option<StoredRecording>, String> {
    history(app)?.by_folder(folder)
}
pub fn prepare_search<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let shared = shared_history(app)?;
    let mut history = match shared.history.try_lock() {
        Ok(history) => history,
        Err(std::sync::TryLockError::Poisoned(error)) => {
            recover_shared_history(shared, error.into_inner())?
        }
        Err(std::sync::TryLockError::WouldBlock) => return Ok(false),
    };
    if shared.pending.load(std::sync::atomic::Ordering::Acquire) > 0 {
        return Ok(false);
    }
    let epoch = shared.activity.load(std::sync::atomic::Ordering::Acquire);
    history.prepare_search_while(move || {
        shared.pending.load(std::sync::atomic::Ordering::Acquire) > 0
            || shared.activity.load(std::sync::atomic::Ordering::Acquire) != epoch
    })
}

pub fn page<R: Runtime>(
    app: &AppHandle<R>,
    offset: usize,
    limit: usize,
    query: &str,
    category: &str,
    request: Option<&crate::history_search::Token>,
) -> Result<HistoryPage, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = dir.join("history.sqlite3");
    if request.is_some_and(|token| token.cancelled()) {
        return Err("History search superseded".into());
    }
    let reader = match History::read_only(&path) {
        Ok(reader) if reader.import_complete()? => reader,
        _ => {
            // An interrupted/failed import can leave an existing SQLite file.
            // Only the initialized writer may complete (or report) that import.
            initialize(app)?;
            let reader = History::read_only(&path)?;
            if !reader.import_complete()? {
                return Err("Recording history migration is incomplete; restart to retry".into());
            }
            reader
        }
    };
    match request {
        Some(token) => reader.page_while(offset, limit, query, category, token.callback()),
        None => reader.page(offset, limit, query, category),
    }
}

pub fn details<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<(StoredRecording, i64)>, String> {
    let history = history(app)?;
    Ok(history.get(id)?.zip(history.revision(id)?))
}
pub fn append<R: Runtime>(app: &AppHandle<R>, rec: StoredRecording) -> Result<(), String> {
    history(app)?.put(&rec)
}
pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    history(app)?.remove(id)
}

fn mutate<R: Runtime, T>(
    app: &AppHandle<R>,
    id: &str,
    update: impl FnOnce(&mut StoredRecording) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let mut history = history(app)?;
    let Some(mut rec) = history.get(id)? else {
        return Ok(None);
    };
    let before = rec.clone();
    let result = update(&mut rec)?;
    if rec != before {
        history.put(&rec)?;
    }
    Ok(Some(result))
}

pub fn set_transcript<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    transcript: Option<String>,
    status: &str,
) -> Result<(), String> {
    mutate(app, id, |rec| {
        let local = rec
            .folder_path
            .as_deref()
            .map(Path::new)
            .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join("transcript.md")))
            .transpose()?
            .unwrap_or(false);
        if !local {
            rec.transcript = transcript;
        }
        rec.status = status.to_string();
        Ok(())
    })?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn set_result<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    title: &str,
    transcript: String,
    summary: Option<String>,
    notes: Option<String>,
    status: &str,
    transcript_final: bool,
) -> Result<Option<(StoredRecording, bool)>, String> {
    mutate(app, id, |recording| {
        let folder = recording.folder_path.as_deref().map(Path::new);
        let is_local = |name: &str| {
            folder
                .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join(name)))
                .transpose()
                .map(|local| local.unwrap_or(false))
        };
        let transcript_is_local = is_local("transcript.md")?;
        let summary_is_local = is_local("summary.md")?;
        let notes_are_local = is_local("notes.md")?;
        let before = recording.clone();
        recording.title = title.to_string();
        if !transcript_is_local
            && takes_cloud_transcript(
                recording.transcript.as_deref(),
                &transcript,
                status,
                transcript_final,
            )
        {
            recording.transcript = Some(transcript);
        }
        if !summary_is_local {
            recording.summary = summary;
        }
        if !notes_are_local {
            recording.notes = notes;
        }
        recording.status = status.to_string();
        let changed = *recording != before;
        Ok((recording.clone(), changed))
    })
}

fn takes_cloud_transcript(
    current: Option<&str>,
    cloud: &str,
    status: &str,
    transcript_final: bool,
) -> bool {
    let current_words = current.map_or(0, spoken_word_count);
    let cloud_words = spoken_word_count(cloud);
    if cloud_words == 0 && current_words > 0 {
        return false;
    }
    if transcript_final {
        return true;
    }
    match status {
        "transcript_failed" => current_words == 0,
        _ => cloud_words >= current_words,
    }
}

/// Words in a transcript, leaving out markdown headings: a cloud transcript
/// with no lines is still "# Title / ## Transcript", which says nothing.
fn spoken_word_count(text: &str) -> usize {
    text.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .flat_map(str::split_whitespace)
        .filter(|w| w.chars().any(char::is_alphabetic))
        .count()
}

/// Save a deliberate correction under the same lock as cloud results. The
/// transcript, one history row and the sync outbox are restored if either
/// durable store fails; unrelated recordings are never copied or rewritten.
pub fn save_preview_transcript<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    content: &str,
) -> Result<(), String> {
    save_transcript(app, id, content, None)
}

fn save_transcript<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if content.len() > 5 * 1024 * 1024 {
        return Err("Transcript is too large".into());
    }
    let mut history = history(app)?;
    let previous = history
        .get(id)?
        .ok_or_else(|| "Recording is still being saved. Please retry.".to_string())?;
    if expected.is_some_and(|original| previous.transcript.as_deref() != Some(original)) {
        return Err("Transcript changed; reopen it before correcting".into());
    }
    let folder = previous
        .folder_path
        .as_deref()
        .ok_or_else(|| "Recording folder is still being saved. Please retry.".to_string())?;
    let path = Path::new(folder).join("transcript.md");
    let old_file = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not read saved transcript: {error}")),
    };
    let raw_path = Path::new(folder).join("transcript.raw.md");
    let raw_created = !raw_path.exists() && previous.transcript.is_some();
    let hash = hex::encode(Sha256::digest(content.as_bytes()));
    let mut recording = previous.clone();
    recording.transcript = Some(content.to_string());
    let saved = crate::sqlite::with_open_mut(app, |conn| -> Result<(), String> {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        crate::sqlite::enqueue_file_edit_in(&tx, id, "transcript", content, &hash)?;
        crate::sqlite::record_file_observation_in(&tx, &path, id, "transcript", &hash)?;
        tx.execute(
            "UPDATE filesystem_state SET last_written_hash=NULL WHERE file_path=?1",
            rusqlite::params![path.to_string_lossy()],
        )
        .map_err(|error| error.to_string())?;
        if raw_created {
            crate::fs_writer::atomic_write(
                &raw_path,
                previous
                    .transcript
                    .as_deref()
                    .unwrap_or_default()
                    .as_bytes(),
            )?;
        }
        crate::fs_writer::atomic_write(&path, content.as_bytes())?;
        history.put(&recording)?;
        tx.commit().map_err(|error| error.to_string())
    })
    .and_then(|result| result);
    if let Err(error) = saved {
        let restore = if let Some(bytes) = old_file {
            crate::fs_writer::atomic_write(&path, &bytes)
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|error| error.to_string())
        } else {
            Ok(())
        };
        let restore_raw = if raw_created && raw_path.exists() {
            std::fs::remove_file(&raw_path).map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        let restore_history = history.put(&previous);
        restore
            .and(restore_raw)
            .and(restore_history)
            .map_err(|rollback| format!("{error}; restore failed: {rollback}"))?;
        return Err(error);
    }
    Ok(())
}

pub fn apply_external_edit<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    role: &str,
    content: String,
) -> Result<(), String> {
    mutate(app, id, |rec| {
        match role {
            "summary" => rec.summary = Some(content),
            "transcript" => rec.transcript = Some(content),
            "notes" => rec.notes = Some(content),
            _ => return Err(format!("unsupported recording file role: {role}")),
        };
        Ok(())
    })?;
    Ok(())
}
pub fn set_folder_path<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    folder: &Path,
) -> Result<(), String> {
    mutate(app, id, |rec| {
        rec.folder_path = Some(folder.to_string_lossy().into_owned());
        Ok(())
    })?;
    Ok(())
}
pub fn set_status<R: Runtime>(app: &AppHandle<R>, id: &str, status: &str) -> Result<(), String> {
    mutate(app, id, |rec| {
        rec.status = status.to_string();
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
pub fn load_all<R: Runtime>(app: &AppHandle<R>) -> Vec<StoredRecording> {
    let history = history(app).unwrap();
    {
        let mut rows: Vec<_> = history
            .ids()
            .unwrap()
            .into_iter()
            .filter_map(|id| history.get(&id).unwrap())
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        rows
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_partial_cloud_transcript_does_not_replace_fuller_on_device_text() {
        let on_device = Some("Hello there, this is the whole recording.");
        let partial = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there,";
        assert!(!takes_cloud_transcript(
            on_device,
            partial,
            "processing",
            false
        ));
        let caught_up = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there, this is the whole recording now.";
        assert!(takes_cloud_transcript(
            on_device,
            caught_up,
            "processing",
            false
        ));
        assert!(takes_cloud_transcript(None, partial, "processing", false));
    }

    #[test]
    fn a_finished_cloud_transcript_with_words_replaces_the_on_device_one() {
        let cloud = "# R\n\n## Transcript\n\n[00:00:00] short";
        assert!(takes_cloud_transcript(
            Some("much longer on device text than the cloud"),
            cloud,
            "complete",
            true
        ));
        assert!(takes_cloud_transcript(
            Some("much longer on device text than the cloud"),
            cloud,
            "processing",
            true
        ));
        // Complete but missing parts that never uploaded: it has to catch up first.
        assert!(!takes_cloud_transcript(
            Some("much longer on device text than the cloud"),
            cloud,
            "complete",
            false
        ));
    }

    #[test]
    fn an_empty_cloud_transcript_never_wipes_on_device_words() {
        // What render_transcript writes for a result with no lines.
        let empty = "# Voice memo\n\n## Transcript\n\n";
        let heard = Some("Remind me to call the bank tomorrow.");
        for status in ["complete", "processing", "transcript_failed"] {
            assert!(
                !takes_cloud_transcript(heard, empty, status, true),
                "{status}"
            );
            assert!(
                !takes_cloud_transcript(heard, "   \n", status, false),
                "{status}"
            );
        }
        // With nothing heard on device there is nothing to protect.
        assert!(takes_cloud_transcript(None, empty, "complete", false));
        assert!(takes_cloud_transcript(Some("  "), empty, "complete", false));
    }

    #[test]
    fn a_failed_cloud_transcript_keeps_the_on_device_text() {
        let empty = "# Recording\n\n## Transcript\n\n";
        assert!(!takes_cloud_transcript(
            Some("What the Mac heard."),
            empty,
            "transcript_failed",
            false
        ));
        assert!(takes_cloud_transcript(
            None,
            empty,
            "transcript_failed",
            false
        ));
    }

    #[test]
    fn headings_are_not_spoken_words() {
        assert_eq!(spoken_word_count("# Voice memo\n\n## Transcript\n\n"), 0);
        assert_eq!(spoken_word_count("# T\n\n[00:00:01] hello there\n"), 2);
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    fn app(root: &Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        tauri::test::mock_builder().build(context).unwrap()
    }
    fn recording(id: String) -> StoredRecording {
        StoredRecording {
            id,
            title: "Initial".into(),
            started_at_ms: 1,
            duration_sec: 0,
            source: "mixed".into(),
            status: "processing".into(),
            summary: None,
            transcript: None,
            notes: None,
            has_audio: true,
            has_video: false,
            folder_path: None,
        }
    }

    #[test]
    fn poisoned_history_reopens_for_both_indexing_and_normal_mutations() {
        let root = std::env::temp_dir().join(format!("eavesy-poisoned-{}", uuid::Uuid::new_v4()));
        let fixture = app(&root);
        append(fixture.handle(), recording("safe".into())).unwrap();
        let shared = shared_history(fixture.handle()).unwrap();
        let poison = || {
            let _guard = shared.history.lock().unwrap();
            panic!("test worker panic");
        };
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(poison)).is_err());
        assert!(prepare_search(fixture.handle()).unwrap());
        assert!(!shared.history.is_poisoned());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(poison)).is_err());
        set_status(fixture.handle(), "safe", "complete").unwrap();
        assert!(!shared.history.is_poisoned());
        assert_eq!(
            page(fixture.handle(), 0, 50, "initial", "all", None)
                .unwrap()
                .items
                .len(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn an_existing_database_never_hides_a_failed_legacy_import() {
        let root =
            std::env::temp_dir().join(format!("eavesy-import-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let fixture = app(&root);
        std::fs::write(root.join("history.sqlite3"), []).unwrap();
        std::fs::write(root.join("recordings.json"), b"invalid JSON").unwrap();
        assert!(page(fixture.handle(), 0, 50, "", "all", None)
            .unwrap_err()
            .contains("malformed"));
        let r = recording("legacy".into());
        std::fs::write(
            root.join("recordings.json"),
            serde_json::to_vec(&[r]).unwrap(),
        )
        .unwrap();
        let result = page(fixture.handle(), 0, 50, "", "all", None).unwrap();
        assert_eq!(result.items[0].id, "legacy");
        assert_eq!(result.counts.all, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_waiting_mutation_interrupts_index_construction_and_preserves_the_write() {
        let root =
            std::env::temp_dir().join(format!("eavesy-index-priority-{}", uuid::Uuid::new_v4()));
        let fixture = app(&root);
        for i in 0..100 {
            append(fixture.handle(), recording(i.to_string())).unwrap();
        }
        let shared = shared_history(fixture.handle()).unwrap();
        let (start, wait) = std::sync::mpsc::channel();
        let handle = fixture.handle().clone();
        std::thread::scope(|scope| {
            let mut guard = shared.history.lock().unwrap();
            let writer = scope.spawn(move || {
                wait.recv().unwrap();
                set_status(&handle, "0", "complete").unwrap();
            });
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let built = guard
                .prepare_search_while(move || {
                    let call = calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if call == 0 {
                        return false;
                    } // initial check; enter actual SQL
                    if call == 1 {
                        start.send(()).unwrap();
                    }
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                    while shared.pending.load(std::sync::atomic::Ordering::Acquire) == 0
                        && std::time::Instant::now() < deadline
                    {
                        std::thread::yield_now();
                    }
                    true
                })
                .unwrap();
            assert!(!built);
            drop(guard);
            writer.join().unwrap();
        });
        assert_eq!(
            get(fixture.handle(), "0").unwrap().unwrap().status,
            "complete"
        );
        assert!(prepare_search(fixture.handle()).unwrap());
        assert_eq!(
            page(fixture.handle(), 0, 50, "", "all", None)
                .unwrap()
                .counts
                .all,
            100
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_updates_and_appends_never_lose_other_fields_or_recordings() {
        let root =
            std::env::temp_dir().join(format!("eavesy-store-parallel-{}", uuid::Uuid::new_v4()));
        let fixture = app(&root);
        append(fixture.handle(), recording("shared".into())).unwrap();
        std::thread::scope(|scope| {
            for i in 0..16 {
                let handle = fixture.handle();
                scope.spawn(move || {
                    append(handle, recording(i.to_string())).unwrap();
                    apply_external_edit(
                        handle,
                        "shared",
                        if i % 2 == 0 { "notes" } else { "summary" },
                        "kept".into(),
                    )
                    .unwrap();
                });
            }
        });
        assert_eq!(ids(fixture.handle()).unwrap().len(), 17);
        let shared = get(fixture.handle(), "shared").unwrap().unwrap();
        assert_eq!(shared.notes.as_deref(), Some("kept"));
        assert_eq!(shared.summary.as_deref(), Some("kept"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unchanged_result_does_not_write_or_increment_revision() {
        let root = std::env::temp_dir().join(format!("eavesy-store-poll-{}", uuid::Uuid::new_v4()));
        let fixture = app(&root);
        let handle = fixture.handle();
        append(handle, recording("a".into())).unwrap();
        let poll = || {
            set_result(
                handle,
                "a",
                "Sync",
                "transcript".into(),
                None,
                None,
                "processing",
                false,
            )
            .unwrap()
            .unwrap()
        };
        assert!(poll().1);
        let revision = details(handle, "a").unwrap().unwrap().1;
        assert!(!poll().1);
        assert_eq!(details(handle, "a").unwrap().unwrap().1, revision);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn deliberate_correction_saves_original_and_rejects_stale_text() {
        let root = std::env::temp_dir().join(format!("eavesy-correction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        crate::sqlite::initialize(app.handle()).unwrap();
        let mut rec = recording("correction".into());
        rec.transcript = Some("Open a pool request.".into());
        rec.folder_path = Some(root.to_string_lossy().into_owned());
        append(app.handle(), rec).unwrap();
        correct_transcript(app.handle(), "correction", "stale", "wrong").unwrap_err();
        std::fs::write(root.join("transcript.md"), "Open a pool request.").unwrap();
        crate::sqlite::with_open(app.handle(), |conn| conn.execute_batch(
            "CREATE TRIGGER fail_correction BEFORE INSERT ON pending_operations BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
        )).unwrap().unwrap();
        assert!(correct_transcript(
            app.handle(),
            "correction",
            "Open a pool request.",
            "Must roll back."
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("transcript.md")).unwrap(),
            "Open a pool request."
        );
        assert!(!root.join("transcript.raw.md").exists());
        crate::sqlite::with_open(app.handle(), |conn| {
            conn.execute_batch("DROP TRIGGER fail_correction")
        })
        .unwrap()
        .unwrap();
        correct_transcript(
            app.handle(),
            "correction",
            "Open a pool request.",
            "Open a pull request.",
        )
        .unwrap();
        assert_eq!(
            load_all(app.handle())[0].transcript.as_deref(),
            Some("Open a pull request.")
        );
        assert_eq!(
            std::fs::read_to_string(root.join("transcript.raw.md")).unwrap(),
            "Open a pool request."
        );
        assert_eq!(
            std::fs::read_to_string(root.join("transcript.md")).unwrap(),
            "Open a pull request."
        );
        correct_transcript(
            app.handle(),
            "correction",
            "Open a pool request.",
            "stale again",
        )
        .unwrap_err();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_corrections_persist_and_survive_later_transcription() {
        let root =
            std::env::temp_dir().join(format!("eavesy-preview-save-{}", uuid::Uuid::new_v4()));
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        let app = app.handle();
        crate::sqlite::initialize(app).unwrap();
        let folder = root.join("recording");
        let mut recording = recording("edited".into());
        recording.folder_path = Some(folder.to_string_lossy().into_owned());
        recording.transcript = Some("Original transcript".into());
        append(app, recording.clone()).unwrap();
        crate::fs_writer::persist_recording_artifacts(Some(app), &folder, &recording, None, None)
            .unwrap();
        let data = app.path().app_data_dir().unwrap();
        let durable = || {
            History::open(&data.join("history.sqlite3"), &data.join("recordings.json"))
                .unwrap()
                .get("edited")
                .unwrap()
                .unwrap()
        };
        for correction in [
            "Original transcript",
            "Corrected opening.\nCorrected ending.",
            "",
            "Final saved correction.",
        ] {
            save_preview_transcript(app, "edited", correction).unwrap();
            // Open a second database connection to verify durable state.
            assert_eq!(durable().transcript.as_deref(), Some(correction));
            assert_eq!(
                std::fs::read_to_string(folder.join("transcript.md")).unwrap(),
                correction
            );
            let queued = crate::sqlite::next_file_edit(app).unwrap().unwrap();
            assert_eq!(queued.content_md, correction);
            assert!(crate::fs_writer::has_local_edit(app, &folder.join("transcript.md")).unwrap());
            set_transcript(
                app,
                "edited",
                Some("Late device transcript".into()),
                "processing",
            )
            .unwrap();
            let (updated, _) = set_result(
                app,
                "edited",
                "Cloud title",
                "Late cloud transcript".into(),
                None,
                None,
                "complete",
                true,
            )
            .unwrap()
            .unwrap();
            crate::fs_writer::persist_recording_artifacts(Some(app), &folder, &updated, None, None)
                .unwrap();
            assert_eq!(load_all(app)[0].transcript.as_deref(), Some(correction));
            assert_eq!(
                std::fs::read_to_string(folder.join("transcript.md")).unwrap(),
                correction
            );
        }
        // A failure after enqueueing must roll back the outbox and preserve both files.
        crate::sqlite::with_open(app, |conn| conn.execute_batch(
            "CREATE TRIGGER fail_preview_observation BEFORE UPDATE ON filesystem_state BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END;"
        )).unwrap().unwrap();
        assert!(save_preview_transcript(app, "edited", "Must not partially land").is_err());
        assert_eq!(
            durable().transcript.as_deref(),
            Some("Final saved correction.")
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("transcript.md")).unwrap(),
            "Final saved correction."
        );
        assert_eq!(
            crate::sqlite::next_file_edit(app)
                .unwrap()
                .unwrap()
                .content_md,
            "Final saved correction."
        );
        crate::sqlite::with_open(app, |conn| {
            conn.execute_batch("DROP TRIGGER fail_preview_observation")
        })
        .unwrap()
        .unwrap();
        // Deferred foreign keys let every write succeed and fail only at COMMIT.
        crate::sqlite::with_open(app, |conn| conn.execute_batch(
            "CREATE TABLE preview_parent(id INTEGER PRIMARY KEY);
             CREATE TABLE preview_commit_guard(parent_id INTEGER REFERENCES preview_parent(id) DEFERRABLE INITIALLY DEFERRED);
             CREATE TRIGGER fail_preview_commit AFTER UPDATE ON pending_operations BEGIN INSERT INTO preview_commit_guard VALUES(99); END;"
        )).unwrap().unwrap();
        assert!(
            save_preview_transcript(app, "edited", "Must roll back after both file writes")
                .is_err()
        );
        assert_eq!(
            durable().transcript.as_deref(),
            Some("Final saved correction.")
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("transcript.md")).unwrap(),
            "Final saved correction."
        );
        assert_eq!(
            crate::sqlite::next_file_edit(app)
                .unwrap()
                .unwrap()
                .content_md,
            "Final saved correction."
        );
        crate::sqlite::with_open(app, |conn| conn.execute_batch("DROP TRIGGER fail_preview_commit; DROP TABLE preview_commit_guard; DROP TABLE preview_parent;")).unwrap().unwrap();
        assert!(save_preview_transcript(app, "missing", "must not disappear").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// A deliberate human edit wins over later transcription and sync results.
pub fn correct_transcript<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    original: &str,
    corrected: &str,
) -> Result<(), String> {
    save_transcript(app, id, corrected, Some(original))
}
