use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{fs_writer, sqlite, store};

const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SCANNED_FOLDERS: usize = 10_000;
const SETTLE_TIME: Duration = Duration::from_millis(180);

enum WatchMessage {
    Path(PathBuf),
    RescanFolders,
    StartupBarrier,
}

struct WatcherHandle {
    stopped: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    _watcher: Mutex<RecommendedWatcher>,
    _worker: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

#[derive(Default)]
pub struct WatcherManager {
    handle: Mutex<Option<WatcherHandle>>,
}

impl WatcherManager {
    fn is_ready(&self) -> Result<bool, String> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| "File recovery state is unavailable".to_string())?;
        match handle.as_ref() {
            Some(h) if h.failed.load(Ordering::Acquire) => Err(
                "Local file recovery failed; choose the recordings folder again or restart Eavesy"
                    .into(),
            ),
            Some(h) => Ok(h.ready.load(Ordering::Acquire)),
            None => Ok(true),
        }
    }

    pub fn replace<R: Runtime>(&self, app: AppHandle<R>, root: PathBuf) -> Result<()> {
        // Folder names under the root are meeting titles; reports must not carry them.
        crate::telemetry::set_recordings_root(&root);
        let replacement = start(app, root)?;
        let mut handle = self
            .handle
            .lock()
            .map_err(|_| anyhow::anyhow!("recordings watcher state is poisoned"))?;
        *handle = Some(replacement);
        Ok(())
    }
}

fn start<R: Runtime>(app: AppHandle<R>, root: PathBuf) -> Result<WatcherHandle> {
    std::fs::create_dir_all(&root).context("create recordings root")?;

    let (sender, receiver) = mpsc::channel::<WatchMessage>();
    let startup_sender = sender.clone();
    let callback_app = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
            Ok(event) if is_content_event(&event.kind) => {
                if is_folder_structure_event(&event.kind)
                    && event.paths.iter().any(|path| {
                        path.is_dir()
                            || path.file_name().and_then(|name| name.to_str())
                                == Some("meeting.json")
                    })
                {
                    let _ = sender.send(WatchMessage::RescanFolders);
                }
                for path in event.paths {
                    if file_role(&path).is_some() {
                        let _ = sender.send(WatchMessage::Path(path));
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                crate::telemetry::capture("filesystem.watch", &error.to_string());
                let _ = callback_app.emit("recordings:watch-error", ());
            }
        })
        .context("create recordings watcher")?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .context("watch recordings root")?;

    let stopped = Arc::new(AtomicBool::new(false));
    let ready = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let worker = spawn_reconciler(
        app,
        root,
        receiver,
        stopped.clone(),
        ready.clone(),
        startup_sender,
        failed.clone(),
    );
    Ok(WatcherHandle {
        stopped,
        ready,
        failed,
        _watcher: Mutex::new(watcher),
        _worker: Mutex::new(Some(worker)),
    })
}

fn spawn_reconciler<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    receiver: mpsc::Receiver<WatchMessage>,
    stopped: Arc<AtomicBool>,
    ready: Arc<AtomicBool>,
    startup_sender: mpsc::Sender<WatchMessage>,
    failed: Arc<AtomicBool>,
) -> JoinHandle<()> {
    // The watcher is registered before this worker starts: edits during offline
    // recovery queue up and are replayed afterwards. Setup need not wait for IO.
    std::thread::spawn(move || {
        if stopped.load(Ordering::Acquire) {
            return;
        }
        if !finish_startup(&ready, &failed, || {
            if let Err(error) = reconcile_folder_locations(&app, &root) {
                crate::telemetry::capture("filesystem.startup-folder-scan", &error.to_string());
            }
            seed_existing_files_until(&app, &stopped);
            // A folder may move after the initial scan while other records recover.
            // Replay those queued events before cloud writes can recreate old paths.
            let _ = startup_sender.send(WatchMessage::StartupBarrier);
            drop(startup_sender);
            reconcile_queued_startup(&app, &root, &receiver, &stopped);
        }) {
            return;
        }
        if stopped.load(Ordering::Acquire) {
            return;
        }
        let index_app = app.clone();
        let index_stop = stopped.clone();
        let index_worker = std::thread::spawn(move || loop {
            if index_stop.load(Ordering::Acquire) {
                break;
            }
            match store::prepare_search(&index_app) {
                Ok(true) => break,
                Ok(false) => std::thread::park_timeout(Duration::from_millis(250)),
                Err(error) => {
                    crate::telemetry::capture("history.search-index", &error);
                    break;
                }
            }
        });
        reconcile_loop(app, root, receiver, &stopped);
        let _ = index_worker.join();
    })
}

fn finish_startup(ready: &AtomicBool, failed: &AtomicBool, recover: impl FnOnce()) -> bool {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(recover)) {
        Ok(()) => {
            failed.store(false, Ordering::Release);
            ready.store(true, Ordering::Release);
            true
        }
        Err(_) => {
            ready.store(false, Ordering::Release);
            failed.store(true, Ordering::Release);
            crate::telemetry::capture(
                "filesystem.recovery.failed",
                "Local file recovery panicked; background writes remain paused",
            );
            false
        }
    }
}

fn reconcile_queued_startup<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    receiver: &mpsc::Receiver<WatchMessage>,
    stopped: &AtomicBool,
) {
    let mut paths = HashSet::new();
    let mut rescan = false;
    // A marker after the scan defines a finite queue prefix even if new events
    // keep arriving. Every already-queued move is recovered before sync resumes.
    while let Ok(message) = receiver.recv() {
        if matches!(message, WatchMessage::StartupBarrier) {
            break;
        }
        collect_message(message, &mut paths, &mut rescan);
        if stopped.load(Ordering::Acquire) {
            break;
        }
    }
    if stopped.load(Ordering::Acquire) {
        return;
    }
    if rescan {
        if let Err(error) = reconcile_folder_locations(app, root) {
            crate::telemetry::capture("filesystem.startup-folder-replay", &error.to_string());
        }
    }
    for path in paths {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        if let Err(error) = reconcile_path(app, &path) {
            crate::telemetry::capture("filesystem.startup-file-replay", &error.to_string());
        }
    }
}

/// Cloud writes must wait for offline edits to enter the outbox. This waits on
/// the sync task, never the main thread, and is checked again after root changes.
pub async fn wait_until_ready<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    wait_until_ready_for(app, Duration::from_secs(30)).await
}

async fn wait_until_ready_for<R: Runtime>(
    app: &AppHandle<R>,
    budget: Duration,
) -> Result<(), String> {
    let began = std::time::Instant::now();
    loop {
        let ready = match app.try_state::<WatcherManager>() {
            Some(manager) => manager.is_ready()?,
            None => true,
        };
        if ready {
            crate::sync::clear_recovery_pause();
            return Ok(());
        }
        if began.elapsed() >= budget {
            return Err("Local offline-edit recovery is still pending; cloud writes remain paused and will retry".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Only call from blocking processing workers, never the UI or an async worker.
pub fn wait_for_recovery_on_worker<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    // A processing job must finish its normal error/active-set cleanup on a
    // failed or excessively slow recovery, not occupy a worker indefinitely.
    let result = tauri::async_runtime::block_on(wait_until_ready(app));
    if let Err(error) = &result {
        crate::sync::report_recovery_wait(app, error);
    }
    result
}

fn is_content_event(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Any | EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn is_folder_structure_event(kind: &EventKind) -> bool {
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    matches!(
        kind,
        EventKind::Any
            | EventKind::Create(CreateKind::Any | CreateKind::Folder)
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Remove(RemoveKind::Any | RemoveKind::Folder)
    )
}

fn reconcile_loop<R: Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    receiver: mpsc::Receiver<WatchMessage>,
    stopped: &AtomicBool,
) {
    while let Ok(first) = receiver.recv() {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        let mut paths = HashSet::new();
        let mut rescan_folders = false;
        collect_message(first, &mut paths, &mut rescan_folders);
        let deadline = std::time::Instant::now() + SETTLE_TIME;
        while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
            let Ok(message) = receiver.recv_timeout(remaining) else {
                break;
            };
            collect_message(message, &mut paths, &mut rescan_folders);
        }
        if stopped.load(Ordering::Acquire) {
            break;
        }
        if rescan_folders {
            if let Err(error) = reconcile_folder_locations(&app, &root) {
                crate::telemetry::capture("filesystem.folder-scan", &error.to_string());
            }
        }
        for path in paths {
            if let Err(error) = reconcile_path(&app, &path) {
                crate::telemetry::capture("filesystem.reconcile", &error.to_string());
            }
        }
    }
}

fn collect_message(message: WatchMessage, paths: &mut HashSet<PathBuf>, rescan_folders: &mut bool) {
    match message {
        WatchMessage::Path(path) => {
            paths.insert(path);
        }
        WatchMessage::RescanFolders => *rescan_folders = true,
        WatchMessage::StartupBarrier => {}
    }
}

#[derive(serde::Deserialize)]
struct ManifestIdentity {
    id: String,
}

fn reconcile_folder_locations<R: Runtime>(app: &AppHandle<R>, root: &Path) -> Result<()> {
    let discovered = discover_manifest_folders(root)?;
    let recordings = store::locations(app).map_err(anyhow::Error::msg)?;
    let mut moved = Vec::new();

    for (id, folder) in recordings {
        let Some(candidates) = discovered.get(&id) else {
            continue;
        };
        let current = folder.as_deref().map(Path::new);
        let Some(target) = unique_relocation_target(current, candidates) else {
            continue;
        };
        sqlite::relocate_recording_folder(app, &id, target).map_err(anyhow::Error::msg)?;
        store::set_folder_path(app, &id, target).map_err(anyhow::Error::msg)?;
        moved.push(target.to_path_buf());
    }

    if !moved.is_empty() {
        let _ = app.emit("recordings:updated", ());
    }
    for folder in moved {
        for filename in ["summary.md", "transcript.md", "notes.md"] {
            reconcile_path(app, &folder.join(filename))?;
        }
    }
    Ok(())
}

fn unique_relocation_target<'a>(
    current: Option<&Path>,
    candidates: &'a [PathBuf],
) -> Option<&'a Path> {
    let [candidate] = candidates else {
        return None;
    };
    if current == Some(candidate.as_path()) || current.is_some_and(Path::is_dir) {
        return None;
    }
    Some(candidate)
}

fn discover_manifest_folders(root: &Path) -> Result<HashMap<String, Vec<PathBuf>>> {
    let mut discovered: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    let mut scanned = 0_usize;

    while let Some(folder) = stack.pop() {
        scanned += 1;
        if scanned > MAX_SCANNED_FOLDERS {
            anyhow::bail!("recordings root contains more than {MAX_SCANNED_FOLDERS} folders");
        }

        let manifest = folder.join("meeting.json");
        if let Ok(metadata) = std::fs::metadata(&manifest) {
            if metadata.is_file() && metadata.len() <= MAX_MANIFEST_BYTES {
                if let Ok(raw) = std::fs::read_to_string(&manifest) {
                    if let Ok(identity) = serde_json::from_str::<ManifestIdentity>(&raw) {
                        if !identity.id.trim().is_empty() {
                            discovered
                                .entry(identity.id)
                                .or_default()
                                .push(folder.clone());
                        }
                    }
                }
            }
        }

        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if folder != root => {
                tracing::warn!("could not inspect a recording subfolder: {}", error.kind());
                continue;
            }
            Err(error) => return Err(error).context("scan recordings root"),
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() && !file_type.is_symlink() {
                stack.push(entry.path());
            }
        }
    }

    for candidates in discovered.values_mut() {
        candidates.sort();
    }
    Ok(discovered)
}

#[cfg(test)]
fn seed_existing_files<R: Runtime>(app: &AppHandle<R>) {
    seed_existing_files_until(app, &AtomicBool::new(false));
}

fn seed_existing_files_until<R: Runtime>(app: &AppHandle<R>, stopped: &AtomicBool) {
    let folders = match store::folders(app) {
        Ok(folders) => folders,
        Err(error) => {
            crate::telemetry::capture("filesystem.startup-reconcile", &error);
            return;
        }
    };
    // One indexed body read per recording, reused for its three editable files.
    for (id, folder) in folders {
        if stopped.load(Ordering::Acquire) {
            break;
        }
        let recording = match store::get(app, &id) {
            Ok(Some(recording)) => recording,
            Ok(None) => continue,
            Err(error) => {
                crate::telemetry::capture("filesystem.startup-reconcile", &error);
                continue;
            }
        };
        for filename in ["summary.md", "transcript.md", "notes.md"] {
            if let Err(error) =
                reconcile_recording(app, &Path::new(&folder).join(filename), &recording)
            {
                crate::telemetry::capture("filesystem.startup-reconcile", &error.to_string());
            }
        }
    }
}

fn reconcile_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<()> {
    if file_role(path).is_none() {
        return Ok(());
    }
    let parent = path.parent().context("edited file has no parent folder")?;
    let Some(recording) = store::by_folder(app, parent).map_err(anyhow::Error::msg)? else {
        return Ok(());
    };
    reconcile_recording(app, path, &recording)
}

fn reconcile_recording<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    recording: &store::StoredRecording,
) -> Result<()> {
    let Some(role) = file_role(path) else {
        return Ok(());
    };
    let parent = path.parent().context("edited file has no parent folder")?;
    let file_name = path.file_name().context("edited file has no name")?;
    let owned_path =
        Path::new(recording.folder_path.as_deref().unwrap_or_default()).join(file_name);
    let path = owned_path.as_path();

    if !path.is_file() {
        if parent.is_dir() {
            fs_writer::restore_missing_editable_file(Some(app), path, recording, role)
                .map_err(anyhow::Error::msg)?;
            let _ = app.emit("recordings:updated", ());
        }
        return Ok(());
    }

    let bytes = read_bounded(path)?;
    let hash = sha256_hex(&bytes);
    // Persisted observations identify our unchanged files without reconstructing
    // and hashing their expected content a second time.
    if matches!(
        sqlite::classify_file_observation(app, path, &hash, None).map_err(anyhow::Error::msg)?,
        sqlite::FileObservation::Current
    ) {
        return Ok(());
    }
    let expected_hash = fs_writer::expected_editable_content(recording, role)
        .map(|content| sha256_hex(content.as_bytes()));
    match sqlite::classify_file_observation(app, path, &hash, expected_hash.as_deref())
        .map_err(anyhow::Error::msg)?
    {
        sqlite::FileObservation::Current => return Ok(()),
        sqlite::FileObservation::Baseline => {
            sqlite::record_file_write(app, path, &recording.id, role, &hash)
                .map_err(anyhow::Error::msg)?;
            return Ok(());
        }
        sqlite::FileObservation::External => {}
    }
    let content = String::from_utf8(bytes).context("edited recording file is not UTF-8")?;
    store::apply_external_edit(app, &recording.id, role, content.clone())
        .map_err(anyhow::Error::msg)?;
    sqlite::enqueue_file_edit(app, &recording.id, role, &content, &hash)
        .map_err(anyhow::Error::msg)?;
    sqlite::record_file_observation(app, path, &recording.id, role, &hash)
        .map_err(anyhow::Error::msg)?;
    let _ = app.emit("recordings:updated", ());
    Ok(())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata =
        std::fs::metadata(path).with_context(|| format!("inspect edited {}", file_label(path)))?;
    if metadata.len() > MAX_EDIT_BYTES {
        anyhow::bail!("edited file exceeds the 5 MiB safety limit");
    }
    std::fs::read(path).with_context(|| format!("read edited {}", file_label(path)))
}

/// The canonical file name only: the folder above it is the meeting title.
fn file_label(path: &Path) -> &str {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
}

fn file_role(path: &Path) -> Option<&'static str> {
    match path.file_name()?.to_str()? {
        "summary.md" => Some("summary"),
        "transcript.md" => Some("transcript"),
        "notes.md" => Some("notes"),
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_mock_app(root: &Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        tauri::test::mock_builder().build(context).unwrap()
    }

    fn sample_recording(folder: &Path) -> store::StoredRecording {
        store::StoredRecording {
            id: "meeting-1".to_string(),
            title: "Design review".to_string(),
            started_at_ms: 1_751_808_600_000,
            duration_sec: 125,
            source: "mixed".to_string(),
            status: "processing".to_string(),
            summary: None,
            transcript: None,
            notes: None,
            has_audio: true,
            has_video: false,
            folder_path: Some(folder.to_string_lossy().into_owned()),
        }
    }

    #[test]
    fn restart_reconciles_an_offline_edit_once_and_restores_canonical_files() {
        let root = std::env::temp_dir().join(format!("eavesy-restart-{}", uuid::Uuid::new_v4()));
        let folder = root.join("recording");
        let summary_path = folder.join("summary.md");
        let notes_path = folder.join("notes.md");
        let renamed_notes_path = folder.join("notes from obsidian.md");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("audio.m4a"), b"audio").unwrap();

        let app = isolated_mock_app(&root);
        sqlite::initialize(app.handle()).unwrap();
        let recording = sample_recording(&folder);
        fs_writer::persist_recording_artifacts(Some(app.handle()), &folder, &recording, None, None)
            .unwrap();
        store::append(app.handle(), recording).unwrap();
        let generated_notes = std::fs::read(&notes_path).unwrap();
        drop(app);

        let offline_summary = "# Brief\n\nEdited in Obsidian while Eavesy was closed.\n";
        std::fs::write(&summary_path, offline_summary).unwrap();
        std::fs::rename(&notes_path, &renamed_notes_path).unwrap();

        let restarted = isolated_mock_app(&root);
        sqlite::initialize(restarted.handle()).unwrap();
        seed_existing_files(restarted.handle());

        let saved = store::load_all(restarted.handle());
        assert_eq!(saved[0].summary.as_deref(), Some(offline_summary));
        assert_eq!(std::fs::read(&renamed_notes_path).unwrap(), generated_notes);
        assert_eq!(std::fs::read(&notes_path).unwrap(), generated_notes);

        let edit = sqlite::next_file_edit(restarted.handle())
            .unwrap()
            .expect("offline edit should be queued");
        assert_eq!(edit.local_session_id, "meeting-1");
        assert_eq!(edit.role, "summary");
        assert_eq!(edit.content_md, offline_summary);

        sqlite::mark_operation_done(restarted.handle(), &edit.operation_id).unwrap();
        seed_existing_files(restarted.handle());
        assert!(sqlite::next_file_edit(restarted.handle())
            .unwrap()
            .is_none());

        store::set_result(
            restarted.handle(),
            "meeting-1",
            "Cloud title",
            "# Transcript\n\nCloud transcript".to_string(),
            Some("# Brief\n\nCloud summary".to_string()),
            Some("Cloud notes".to_string()),
            "complete",
            true,
        )
        .unwrap();
        let refreshed = store::load_all(restarted.handle())
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(refreshed.summary.as_deref(), Some(offline_summary));
        fs_writer::persist_recording_artifacts(
            Some(restarted.handle()),
            &folder,
            &refreshed,
            Some("remote-1"),
            refreshed.notes.as_deref(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&summary_path).unwrap(),
            offline_summary
        );

        drop(restarted);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_edit_matches_a_differently_cased_folder_path() {
        let root = std::env::temp_dir().join(format!("eavesy-case-{}", uuid::Uuid::new_v4()));
        let on_disk = root.join("recordings").join("meeting");
        std::fs::create_dir_all(&on_disk).unwrap();
        let registered = root.join("Recordings").join("meeting");
        let app = isolated_mock_app(&root);
        sqlite::initialize(app.handle()).unwrap();
        let recording = sample_recording(&registered);
        fs_writer::persist_recording_artifacts(
            Some(app.handle()),
            &registered,
            &recording,
            None,
            None,
        )
        .unwrap();
        store::append(app.handle(), recording).unwrap();

        let edited = "# Brief\n\nEdited while Eavesy was running.\n";
        std::fs::write(on_disk.join("summary.md"), edited).unwrap();
        reconcile_path(app.handle(), &on_disk.join("summary.md")).unwrap();

        let edit = sqlite::next_file_edit(app.handle())
            .unwrap()
            .expect("live edit should be queued");
        assert_eq!(edit.role, "summary");
        assert_eq!(edit.content_md, edited);
        assert_eq!(
            store::load_all(app.handle())[0].summary.as_deref(),
            Some(edited)
        );
        sqlite::mark_operation_done(app.handle(), &edit.operation_id).unwrap();
        reconcile_path(app.handle(), &registered.join("summary.md")).unwrap();
        reconcile_path(app.handle(), &on_disk.join("summary.md")).unwrap();
        assert!(sqlite::next_file_edit(app.handle()).unwrap().is_none());

        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_follows_a_moved_folder_in_the_registry_and_archive_queue() {
        let root = std::env::temp_dir().join(format!("eavesy-relocation-{}", uuid::Uuid::new_v4()));
        let original = root.join("recording");
        let moved = root.join("Projects").join("Renamed meeting");
        let segment_dir = root.join("segments");
        std::fs::create_dir_all(&original).unwrap();
        std::fs::create_dir_all(&segment_dir).unwrap();
        std::fs::write(original.join("audio.m4a"), b"audio").unwrap();

        let app = isolated_mock_app(&root);
        sqlite::initialize(app.handle()).unwrap();
        let recording = sample_recording(&original);
        fs_writer::persist_recording_artifacts(
            Some(app.handle()),
            &original,
            &recording,
            None,
            None,
        )
        .unwrap();
        store::append(app.handle(), recording).unwrap();
        sqlite::begin_recording(
            app.handle(),
            "meeting-1",
            &original.join("audio.m4a"),
            &segment_dir,
            "mixed",
            "Design review",
            None,
            1_751_808_600_000,
        )
        .unwrap();
        sqlite::finish_recording(
            app.handle(),
            "meeting-1",
            &original.join("audio.m4a"),
            125_000,
            5,
        )
        .unwrap();
        drop(app);

        std::fs::create_dir_all(moved.parent().unwrap()).unwrap();
        std::fs::rename(&original, &moved).unwrap();

        let restarted = isolated_mock_app(&root);
        sqlite::initialize(restarted.handle()).unwrap();
        reconcile_folder_locations(restarted.handle(), &root).unwrap();

        let saved = store::load_all(restarted.handle());
        assert_eq!(saved[0].folder_path.as_deref(), moved.to_str());
        let pending = sqlite::next_session(restarted.handle())
            .unwrap()
            .expect("uploading recording should remain queued");
        assert_eq!(pending.archive_path, moved.join("audio.m4a"));
        assert!(sqlite::next_file_edit(restarted.handle())
            .unwrap()
            .is_none());

        reconcile_folder_locations(restarted.handle(), &root).unwrap();
        assert_eq!(
            store::load_all(restarted.handle())[0]
                .folder_path
                .as_deref(),
            moved.to_str()
        );
        assert_eq!(
            sqlite::next_session(restarted.handle())
                .unwrap()
                .unwrap()
                .archive_path,
            moved.join("audio.m4a")
        );

        drop(restarted);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_reattaches_a_manifest_folder_when_the_history_has_no_path() {
        let root = std::env::temp_dir().join(format!("eavesy-unlinked-{}", uuid::Uuid::new_v4()));
        let folder = root.join("meeting");
        std::fs::create_dir_all(&folder).unwrap();
        let app = isolated_mock_app(&root);
        sqlite::initialize(app.handle()).unwrap();
        let mut recording = sample_recording(&folder);
        recording.folder_path = None;
        store::append(app.handle(), recording).unwrap();
        std::fs::write(folder.join("meeting.json"), r#"{"id":"meeting-1"}"#).unwrap();
        reconcile_folder_locations(app.handle(), &root).unwrap();
        assert_eq!(
            store::get(app.handle(), "meeting-1")
                .unwrap()
                .unwrap()
                .folder_path
                .as_deref(),
            folder.to_str()
        );
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_canonical_editable_files_are_watched() {
        assert_eq!(file_role(Path::new("summary.md")), Some("summary"));
        assert_eq!(file_role(Path::new("transcript.md")), Some("transcript"));
        assert_eq!(file_role(Path::new("notes.md")), Some("notes"));
        assert_eq!(file_role(Path::new("meeting.json")), None);
        assert_eq!(file_role(Path::new(".summary.md.tmp")), None);
    }

    #[test]
    fn editor_replace_events_are_accepted() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind};

        assert!(is_content_event(&EventKind::Create(CreateKind::File)));
        assert!(is_content_event(&EventKind::Modify(ModifyKind::Name(
            notify::event::RenameMode::Both,
        ))));
        assert!(is_content_event(&EventKind::Remove(RemoveKind::File)));
        assert!(!is_content_event(&EventKind::Access(
            notify::event::AccessKind::Any,
        )));
    }

    #[test]
    fn folder_rename_events_trigger_a_manifest_rescan() {
        use notify::event::{ModifyKind, RenameMode};

        assert!(is_folder_structure_event(&EventKind::Modify(
            ModifyKind::Name(RenameMode::Both),
        )));
        assert!(!is_folder_structure_event(&EventKind::Modify(
            ModifyKind::Data(notify::event::DataChange::Content),
        )));
    }

    #[test]
    fn discovers_only_unambiguous_known_folder_moves() {
        let root = std::env::temp_dir().join(format!("eavesy-move-{}", uuid::Uuid::new_v4()));
        let moved = root.join("Projects").join("Renamed meeting");
        let duplicate = root.join("Duplicate meeting");
        std::fs::create_dir_all(&moved).unwrap();
        std::fs::create_dir_all(&duplicate).unwrap();
        std::fs::write(moved.join("meeting.json"), r#"{"id":"meeting-1"}"#).unwrap();
        std::fs::write(duplicate.join("meeting.json"), r#"{"id":"meeting-2"}"#).unwrap();

        let discovered = discover_manifest_folders(&root).unwrap();
        let missing = root.join("Old meeting");
        assert_eq!(
            unique_relocation_target(Some(&missing), &discovered["meeting-1"]),
            Some(moved.as_path())
        );

        std::fs::create_dir_all(root.join("Second copy")).unwrap();
        std::fs::write(
            root.join("Second copy").join("meeting.json"),
            r#"{"id":"meeting-2"}"#,
        )
        .unwrap();
        let duplicated = discover_manifest_folders(&root).unwrap();
        assert_eq!(
            unique_relocation_target(Some(&missing), &duplicated["meeting-2"]),
            None
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn background_recovery_preserves_offline_edits_and_replays_queued_events() {
        let root = std::env::temp_dir().join(format!("eavesy-worker-{}", uuid::Uuid::new_v4()));
        let folder = root.join("recording");
        std::fs::create_dir_all(&folder).unwrap();
        let app = isolated_mock_app(&root);
        sqlite::initialize(app.handle()).unwrap();
        let r = sample_recording(&folder);
        fs_writer::persist_recording_artifacts(Some(app.handle()), &folder, &r, None, None)
            .unwrap();
        store::append(app.handle(), r).unwrap();
        // Legacy installs may have no observation rows yet; sync must not race
        // this classification and overwrite a genuine offline edit.
        sqlite::with_conn(app.handle(), |conn| {
            conn.execute("DELETE FROM filesystem_state", []).unwrap()
        });
        std::fs::write(folder.join("summary.md"), "Offline summary").unwrap();
        let (tx, rx) = mpsc::channel();
        tx.send(WatchMessage::Path(folder.join("summary.md")))
            .unwrap();
        let worker = spawn_reconciler(
            app.handle().clone(),
            root.clone(),
            rx,
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            tx.clone(),
            Arc::new(AtomicBool::new(false)),
        );
        drop(tx);
        worker.join().unwrap();
        assert_eq!(
            store::get(app.handle(), "meeting-1")
                .unwrap()
                .unwrap()
                .summary
                .as_deref(),
            Some("Offline summary")
        );
        let reader = store::page(app.handle(), 0, 50, "offline", "all", None).unwrap();
        assert_eq!(reader.items.len(), 1);
        sqlite::with_conn(app.handle(), |conn| {
            let count:i64=conn.query_row("SELECT count(*) FROM pending_operations WHERE id='file-edit:meeting-1:summary'",[],|r|r.get(0)).unwrap();
            assert_eq!(count, 1);
        });
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_replays_a_queued_folder_move_before_releasing_sync() {
        let root =
            std::env::temp_dir().join(format!("eavesy-startup-move-{}", uuid::Uuid::new_v4()));
        let old = root.join("old");
        let new = root.join("renamed");
        let app = isolated_mock_app(&root);
        sqlite::initialize(app.handle()).unwrap();
        let r = sample_recording(&old);
        fs_writer::persist_recording_artifacts(Some(app.handle()), &old, &r, None, None).unwrap();
        store::append(app.handle(), r).unwrap();
        seed_existing_files(app.handle());
        std::fs::rename(&old, &new).unwrap();
        std::fs::write(new.join("summary.md"), "Edited during startup").unwrap();
        let (tx, rx) = mpsc::channel();
        tx.send(WatchMessage::RescanFolders).unwrap();
        tx.send(WatchMessage::Path(new.join("summary.md"))).unwrap();
        tx.send(WatchMessage::StartupBarrier).unwrap();
        reconcile_queued_startup(app.handle(), &root, &rx, &AtomicBool::new(false));
        let r = store::get(app.handle(), "meeting-1").unwrap().unwrap();
        assert_eq!(r.folder_path.as_deref(), new.to_str());
        assert_eq!(r.summary.as_deref(), Some("Edited during startup"));
        assert!(!old.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_recovery_panic_is_an_explicit_failure_not_permanent_pending_readiness() {
        let root =
            std::env::temp_dir().join(format!("eavesy-recovery-panic-{}", uuid::Uuid::new_v4()));
        let app = isolated_mock_app(&root);
        let ready = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        app.manage(WatcherManager {
            handle: Mutex::new(Some(WatcherHandle {
                stopped: Arc::new(AtomicBool::new(false)),
                ready: ready.clone(),
                failed: failed.clone(),
                _watcher: Mutex::new(notify::recommended_watcher(|_| {}).unwrap()),
                _worker: Mutex::new(None),
            })),
        });
        assert!(!finish_startup(&ready, &failed, || panic!(
            "test recovery panic"
        )));
        let error = tokio::time::timeout(Duration::from_secs(2), wait_until_ready(app.handle()))
            .await
            .unwrap()
            .unwrap_err();
        assert!(error.contains("recovery failed"));
        assert!(!ready.load(Ordering::Acquire));
        let handle = app.handle().clone();
        let (done, result) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(wait_for_recovery_on_worker(&handle));
        });
        assert!(result
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err());

        assert!(finish_startup(&ready, &failed, || {}));
        assert!(wait_until_ready(app.handle()).await.is_ok());
    }

    #[tokio::test]
    async fn failed_watcher_registration_does_not_leave_a_readiness_wait() {
        let root =
            std::env::temp_dir().join(format!("eavesy-watcher-failure-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let invalid = root.join("not-a-folder");
        std::fs::write(&invalid, b"file").unwrap();
        let app = isolated_mock_app(&root);
        app.manage(WatcherManager::default());
        assert!(app
            .state::<WatcherManager>()
            .replace(app.handle().clone(), invalid)
            .is_err());
        assert!(
            tokio::time::timeout(Duration::from_secs(2), wait_until_ready(app.handle()))
                .await
                .unwrap()
                .is_ok()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn sync_waits_for_offline_recovery_without_blocking_setup() {
        let root = std::env::temp_dir().join(format!("eavesy-ready-{}", uuid::Uuid::new_v4()));
        let app = isolated_mock_app(&root);
        let ready = Arc::new(AtomicBool::new(false));
        let manager = WatcherManager {
            handle: Mutex::new(Some(WatcherHandle {
                stopped: Arc::new(AtomicBool::new(false)),
                ready: ready.clone(),
                failed: Arc::new(AtomicBool::new(false)),
                _watcher: Mutex::new(notify::recommended_watcher(|_| {}).unwrap()),
                _worker: Mutex::new(None),
            })),
        };
        app.manage(manager);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), wait_until_ready(app.handle()))
                .await
                .is_err()
        );
        assert!(wait_until_ready_for(app.handle(), Duration::ZERO)
            .await
            .is_err());
        ready.store(true, Ordering::Release);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), wait_until_ready(app.handle()))
                .await
                .unwrap()
                .is_ok()
        );
    }
}

#[cfg(test)]
#[path = "../../bench/next-reconcile.rs"]
mod benchmarks;
