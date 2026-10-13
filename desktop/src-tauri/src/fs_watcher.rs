use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Context, Result};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{fs_writer, sqlite, store};

const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SCANNED_FOLDERS: usize = 10_000;
const SETTLE_TIME: Duration = Duration::from_millis(180);

enum WatchMessage {
    Path(PathBuf),
    RescanFolders,
}

struct WatcherHandle {
    _watcher: Mutex<RecommendedWatcher>,
    _worker: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
pub struct WatcherManager {
    handle: Mutex<Option<WatcherHandle>>,
}

impl WatcherManager {
    pub fn replace(&self, app: AppHandle, root: PathBuf) -> Result<()> {
        let replacement = start(app, root)?;
        let mut handle = self
            .handle
            .lock()
            .map_err(|_| anyhow::anyhow!("recordings watcher state is poisoned"))?;
        *handle = Some(replacement);
        Ok(())
    }
}

fn start(app: AppHandle, root: PathBuf) -> Result<WatcherHandle> {
    std::fs::create_dir_all(&root)
        .with_context(|| format!("create recordings root {}", root.display()))?;

    let (sender, receiver) = mpsc::channel::<WatchMessage>();
    let callback_app = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        match event {
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
                eprintln!("recordings watcher: {error}");
                crate::telemetry::capture("filesystem.watch", &error.to_string());
                let _ = callback_app.emit("recordings:watch-error", ());
            }
        }
    })
    .context("create recordings watcher")?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .with_context(|| format!("watch recordings root {}", root.display()))?;

    if let Err(error) = reconcile_folder_locations(&app, &root) {
        eprintln!("could not locate moved recording folders during startup: {error:#}");
        crate::telemetry::capture("filesystem.startup-folder-scan", &error.to_string());
    }
    seed_existing_files(&app);
    let worker = std::thread::spawn(move || reconcile_loop(app, root, receiver));
    Ok(WatcherHandle {
        _watcher: Mutex::new(watcher),
        _worker: Mutex::new(Some(worker)),
    })
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

fn reconcile_loop(
    app: AppHandle,
    root: PathBuf,
    receiver: mpsc::Receiver<WatchMessage>,
) {
    while let Ok(first) = receiver.recv() {
        let mut paths = HashSet::new();
        let mut rescan_folders = false;
        collect_message(first, &mut paths, &mut rescan_folders);
        while let Ok(message) = receiver.recv_timeout(SETTLE_TIME) {
            collect_message(message, &mut paths, &mut rescan_folders);
        }
        if rescan_folders {
            if let Err(error) = reconcile_folder_locations(&app, &root) {
                eprintln!("could not reconcile moved recording folders: {error:#}");
                crate::telemetry::capture("filesystem.folder-scan", &error.to_string());
            }
        }
        for path in paths {
            if let Err(error) = reconcile_path(&app, &path) {
                eprintln!("could not reconcile {}: {error:#}", path.display());
                crate::telemetry::capture("filesystem.reconcile", &error.to_string());
            }
        }
    }
}

fn collect_message(
    message: WatchMessage,
    paths: &mut HashSet<PathBuf>,
    rescan_folders: &mut bool,
) {
    match message {
        WatchMessage::Path(path) => {
            paths.insert(path);
        }
        WatchMessage::RescanFolders => *rescan_folders = true,
    }
}

#[derive(serde::Deserialize)]
struct ManifestIdentity {
    id: String,
}

fn reconcile_folder_locations<R: Runtime>(app: &AppHandle<R>, root: &Path) -> Result<()> {
    let discovered = discover_manifest_folders(root)?;
    let recordings = store::load_all(app);
    let mut moved = Vec::new();

    for recording in recordings {
        let Some(candidates) = discovered.get(&recording.id) else {
            continue;
        };
        let current = recording.folder_path.as_deref().map(Path::new);
        let Some(target) = unique_relocation_target(current, candidates) else {
            continue;
        };
        sqlite::relocate_recording_folder(app, &recording.id, target)
            .map_err(anyhow::Error::msg)?;
        store::set_folder_path(app, &recording.id, target).map_err(anyhow::Error::msg)?;
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
                            discovered.entry(identity.id).or_default().push(folder.clone());
                        }
                    }
                }
            }
        }

        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if folder != root => {
                eprintln!("could not inspect recording subfolder {}: {error}", folder.display());
                continue;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("scan recordings root {}", root.display()))
            }
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

fn seed_existing_files<R: Runtime>(app: &AppHandle<R>) {
    for recording in store::load_all(app) {
        let Some(folder) = recording.folder_path.as_deref().map(Path::new) else {
            continue;
        };
        for filename in ["summary.md", "transcript.md", "notes.md"] {
            let path = folder.join(filename);
            if let Err(error) = reconcile_path(app, &path) {
                eprintln!("could not reconcile {} during startup: {error:#}", path.display());
                crate::telemetry::capture("filesystem.startup-reconcile", &error.to_string());
            }
        }
    }
}

fn reconcile_path<R: Runtime>(app: &AppHandle<R>, path: &Path) -> Result<()> {
    let Some(role) = file_role(path) else {
        return Ok(());
    };
    let parent = path.parent().context("edited file has no parent folder")?;
    let file_name = path.file_name().context("edited file has no name")?;
    let parent_key = canonical(parent);
    let Some(recording) = store::load_all(app).into_iter().find(|recording| {
        recording.folder_path.as_deref().is_some_and(|folder| {
            let folder = Path::new(folder);
            folder == parent || canonical(folder) == parent_key
        })
    }) else {
        return Ok(());
    };
    let owned_path = Path::new(recording.folder_path.as_deref().unwrap_or_default()).join(file_name);
    let path = owned_path.as_path();

    if !path.is_file() {
        if parent.is_dir() {
            fs_writer::restore_missing_editable_file(Some(app), path, &recording, role)
                .map_err(anyhow::Error::msg)?;
            let _ = app.emit("recordings:updated", ());
        }
        return Ok(());
    }

    let bytes = read_bounded(path)?;
    let hash = sha256_hex(&bytes);
    let expected_hash = fs_writer::expected_editable_content(&recording, role)
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

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("inspect edited file {}", path.display()))?;
    if metadata.len() > MAX_EDIT_BYTES {
        anyhow::bail!("edited file exceeds the 5 MiB safety limit");
    }
    std::fs::read(path).with_context(|| format!("read edited file {}", path.display()))
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
        fs_writer::persist_recording_artifacts(
            Some(app.handle()),
            &folder,
            &recording,
            None,
            None,
        )
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
        assert!(sqlite::next_file_edit(restarted.handle()).unwrap().is_none());

        store::set_result(
            restarted.handle(),
            "meeting-1",
            "Cloud title",
            "# Transcript\n\nCloud transcript".to_string(),
            Some("# Brief\n\nCloud summary".to_string()),
            Some("Cloud notes".to_string()),
            "complete",
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
        assert_eq!(std::fs::read_to_string(&summary_path).unwrap(), offline_summary);

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
        fs_writer::persist_recording_artifacts(Some(app.handle()), &registered, &recording, None, None)
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
        assert_eq!(store::load_all(app.handle())[0].summary.as_deref(), Some(edited));
        sqlite::mark_operation_done(app.handle(), &edit.operation_id).unwrap();
        reconcile_path(app.handle(), &registered.join("summary.md")).unwrap();
        reconcile_path(app.handle(), &on_disk.join("summary.md")).unwrap();
        assert!(sqlite::next_file_edit(app.handle()).unwrap().is_none());

        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_follows_a_moved_folder_in_the_registry_and_archive_queue() {
        let root =
            std::env::temp_dir().join(format!("eavesy-relocation-{}", uuid::Uuid::new_v4()));
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
        assert!(sqlite::next_file_edit(restarted.handle()).unwrap().is_none());

        reconcile_folder_locations(restarted.handle(), &root).unwrap();
        assert_eq!(store::load_all(restarted.handle())[0].folder_path.as_deref(), moved.to_str());
        assert_eq!(
            sqlite::next_session(restarted.handle()).unwrap().unwrap().archive_path,
            moved.join("audio.m4a")
        );

        drop(restarted);
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
}
