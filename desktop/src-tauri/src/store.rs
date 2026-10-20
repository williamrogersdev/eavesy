use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

/// The last registry read or written, so polls and list refreshes do not re-read
/// and re-parse recordings.json (transcripts included). Only touched under
/// `REGISTRY_LOCK`; every write goes through `write_registry`.
static CACHE: Mutex<Option<(PathBuf, Vec<StoredRecording>)>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredRecording {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    pub duration_sec: i64,
    pub source: String,
    pub status: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub transcript: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub has_video: bool,
    #[serde(default)]
    pub folder_path: Option<String>,
}

fn registry_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(dir.join("recordings.json"))
}

pub fn load_all<R: Runtime>(app: &AppHandle<R>) -> Vec<StoredRecording> {
    let _guard = registry_guard();
    let path = match registry_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    read_registry(&path).unwrap_or_else(|error| {
        eprintln!("{error}");
        Vec::new()
    })
}

pub fn append<R: Runtime>(app: &AppHandle<R>, rec: StoredRecording) -> Result<(), String> {
    mutate(app, move |list| {
        if let Some(existing) = list.iter_mut().find(|existing| existing.id == rec.id) {
            *existing = rec;
        } else {
            list.push(rec);
        }
        Ok(true)
    })
}

/// Removes a capture from the history. Its files are handled by the caller.
pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    mutate(app, |list| {
        let before = list.len();
        list.retain(|recording| recording.id != id);
        Ok(list.len() != before)
    })
}

pub fn set_transcript<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    transcript: Option<String>,
    status: &str,
) -> Result<(), String> {
    mutate(app, |list| {
        if let Some(rec) = list.iter_mut().find(|rec| rec.id == id) {
            let transcript_is_local = rec
                .folder_path
                .as_deref()
                .map(Path::new)
                .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join("transcript.md")))
                .transpose()?
                .unwrap_or(false);
            if !transcript_is_local {
                rec.transcript = transcript;
            }
            rec.status = status.to_string();
            return Ok(true);
        }
        Ok(false)
    })
}

/// Applies a cloud result. Returns the recording (None if it is not in the
/// registry) and whether anything changed, so an unchanged poll does not rewrite
/// recordings.json or notify the UI. `transcript_final` says the cloud has
/// transcribed every part, even if the summary is still being written.
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
    let mut updated = None;
    mutate(app, |list| {
        let Some(recording) = list.iter_mut().find(|recording| recording.id == id) else {
            return Ok(false);
        };
        let folder = recording.folder_path.as_deref().map(Path::new);
        let transcript_is_local = folder
            .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join("transcript.md")))
            .transpose()?
            .unwrap_or(false);
        let summary_is_local = folder
            .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join("summary.md")))
            .transpose()?
            .unwrap_or(false);
        let notes_are_local = folder
            .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join("notes.md")))
            .transpose()?
            .unwrap_or(false);

        let before = recording.clone();
        recording.title = title.to_string();
        if !transcript_is_local && takes_cloud_transcript(recording.transcript.as_deref(), &transcript, status, transcript_final) {
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
        updated = Some((recording.clone(), changed));
        Ok(changed)
    })?;
    Ok(updated)
}

/// Whether a cloud transcript should replace the one a recording has.
///
/// The text stored at stop is what the Mac heard on device: a first pass the
/// cloud refines, never one it may erase. So a cloud transcript with no words
/// never replaces one that has words, whatever its status: Whisper can drop a
/// quiet or short clip, or a segment may never have reached the cloud, and
/// "No speech detected" over words the user watched appear is worse than the
/// rougher on-device text. Otherwise a final cloud transcript (complete, or
/// every segment transcribed, with none abandoned) replaces it. Until then the cloud has only part
/// of the recording, so it takes over once it says at least as much. A failed
/// one never wipes text the recording already has.
fn takes_cloud_transcript(current: Option<&str>, cloud: &str, status: &str, transcript_final: bool) -> bool {
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

pub fn apply_external_edit<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    role: &str,
    content: String,
) -> Result<(), String> {
    mutate(app, |list| {
        let Some(recording) = list.iter_mut().find(|recording| recording.id == id) else {
            return Ok(false);
        };
        match role {
            "summary" => recording.summary = Some(content),
            "transcript" => recording.transcript = Some(content),
            "notes" => recording.notes = Some(content),
            _ => return Err(format!("unsupported recording file role: {role}")),
        }
        Ok(true)
    })
}

pub fn set_folder_path<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    folder: &Path,
) -> Result<(), String> {
    let folder = folder.to_string_lossy().into_owned();
    mutate(app, |list| {
        let Some(recording) = list.iter_mut().find(|recording| recording.id == id) else {
            return Ok(false);
        };
        if recording.folder_path.as_deref() == Some(folder.as_str()) {
            return Ok(false);
        }
        recording.folder_path = Some(folder);
        Ok(true)
    })
}

fn mutate<R: Runtime>(
    app: &AppHandle<R>,
    update: impl FnOnce(&mut Vec<StoredRecording>) -> Result<bool, String>,
) -> Result<(), String> {
    let _guard = registry_guard();
    let path = registry_path(app)?;
    mutate_path(&path, update)
}

fn mutate_path(
    path: &Path,
    update: impl FnOnce(&mut Vec<StoredRecording>) -> Result<bool, String>,
) -> Result<(), String> {
    let mut list = read_registry(path)?;
    if !update(&mut list)? {
        return Ok(());
    }
    list.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
    write_registry(path, &list)
}

fn registry_guard() -> MutexGuard<'static, ()> {
    REGISTRY_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn read_registry(path: &Path) -> Result<Vec<StoredRecording>, String> {
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((cached_path, list)) = cache.as_ref() {
        if cached_path == path {
            return Ok(list.clone());
        }
    }
    let list = read_registry_file(path)?;
    *cache = Some((path.to_path_buf(), list.clone()));
    Ok(list)
}

fn read_registry_file(path: &Path) -> Result<Vec<StoredRecording>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("could not read recordings registry: {error}")),
    };
    let mut list: Vec<StoredRecording> = serde_json::from_str(&raw)
        .map_err(|error| format!("recordings registry is malformed and was preserved: {error}"))?;
    list.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
    Ok(list)
}

fn write_registry(path: &Path, list: &[StoredRecording]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create app data dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(list)
        .map_err(|e| format!("could not serialize recordings: {e}"))?;
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    // Drop the cache first: if the write fails, the next read goes back to disk.
    *cache = None;
    atomic_write(path, json.as_bytes())?;
    *cache = Some((path.to_path_buf(), list.to_vec()));
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    let temp = parent.join(format!(".recordings.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("could not create registry update: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("could not write registry update: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("could not flush registry update: {error}"))?;
        drop(file);
        std::fs::rename(&temp, path)
            .map_err(|error| format!("could not replace recordings registry: {error}"))?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_cloud_transcript_does_not_replace_fuller_on_device_text() {
        let on_device = Some("Hello there, this is the whole recording.");
        let partial = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there,";
        assert!(!takes_cloud_transcript(on_device, partial, "processing", false));
        let caught_up = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there, this is the whole recording now.";
        assert!(takes_cloud_transcript(on_device, caught_up, "processing", false));
        assert!(takes_cloud_transcript(None, partial, "processing", false));
    }

    #[test]
    fn a_finished_cloud_transcript_with_words_replaces_the_on_device_one() {
        let cloud = "# R\n\n## Transcript\n\n[00:00:00] short";
        assert!(takes_cloud_transcript(Some("much longer on device text than the cloud"), cloud, "complete", true));
        assert!(takes_cloud_transcript(Some("much longer on device text than the cloud"), cloud, "processing", true));
        // Complete but missing parts that never uploaded: it has to catch up first.
        assert!(!takes_cloud_transcript(Some("much longer on device text than the cloud"), cloud, "complete", false));
    }

    #[test]
    fn an_empty_cloud_transcript_never_wipes_on_device_words() {
        // What render_transcript writes for a result with no lines.
        let empty = "# Voice memo\n\n## Transcript\n\n";
        let heard = Some("Remind me to call the bank tomorrow.");
        for status in ["complete", "processing", "transcript_failed"] {
            assert!(!takes_cloud_transcript(heard, empty, status, true), "{status}");
            assert!(!takes_cloud_transcript(heard, "   \n", status, false), "{status}");
        }
        // With nothing heard on device there is nothing to protect.
        assert!(takes_cloud_transcript(None, empty, "complete", false));
        assert!(takes_cloud_transcript(Some("  "), empty, "complete", false));
    }

    #[test]
    fn a_failed_cloud_transcript_keeps_the_on_device_text() {
        let empty = "# Recording\n\n## Transcript\n\n";
        assert!(!takes_cloud_transcript(Some("What the Mac heard."), empty, "transcript_failed", false));
        assert!(takes_cloud_transcript(None, empty, "transcript_failed", false));
    }

    #[test]
    fn headings_are_not_spoken_words() {
        assert_eq!(spoken_word_count("# Voice memo\n\n## Transcript\n\n"), 0);
        assert_eq!(spoken_word_count("# T\n\n[00:00:01] hello there\n"), 2);
    }
    use std::sync::Arc;

    fn sample(id: &str, started_at_ms: i64) -> StoredRecording {
        StoredRecording {
            id: id.to_string(),
            title: id.to_string(),
            started_at_ms,
            duration_sec: 0,
            source: "mixed".to_string(),
            status: "processing".to_string(),
            summary: None,
            transcript: None,
            notes: None,
            has_audio: true,
            has_video: false,
            folder_path: None,
        }
    }

    fn temp_registry() -> PathBuf {
        std::env::temp_dir()
            .join(format!("eavesy-store-{}", uuid::Uuid::new_v4()))
            .join("recordings.json")
    }

    #[test]
    fn concurrent_mutations_do_not_lose_recordings() {
        let path = Arc::new(temp_registry());
        let mut workers = Vec::new();
        for index in 0..16 {
            let path = Arc::clone(&path);
            workers.push(std::thread::spawn(move || {
                let _guard = registry_guard();
                mutate_path(&path, |list| {
                    list.push(sample(&format!("meeting-{index}"), index));
                    Ok(true)
                })
                .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }

        let list = read_registry(&path).unwrap();
        assert_eq!(list.len(), 16);
        assert_eq!(list.first().unwrap().id, "meeting-15");
        assert!(!path.parent().unwrap().join(".recordings.tmp").exists());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_unchanged_result_poll_does_not_rewrite_the_registry() {
        let root = std::env::temp_dir().join(format!("eavesy-store-app-{}", uuid::Uuid::new_v4()));
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        let app = app.handle();
        append(app, sample("meeting", 1)).unwrap();
        let path = registry_path(app).unwrap();
        let poll = || set_result(app, "meeting", "Sync", "transcript".into(), None, None, "processing", false).unwrap();

        assert!(poll().unwrap().1, "the first result changes the recording");
        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let (recording, changed) = poll().unwrap();

        assert!(!changed);
        assert_eq!(recording.transcript.as_deref(), Some("transcript"));
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), written);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deliberate_correction_saves_original_and_rejects_stale_text() {
        let root = std::env::temp_dir().join(format!("eavesy-correction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        let mut rec = sample("correction", 1);
        rec.transcript = Some("Open a pool request.".into());
        rec.folder_path = Some(root.to_string_lossy().into_owned());
        append(app.handle(), rec).unwrap();
        correct_transcript(app.handle(), "correction", "stale", "wrong").unwrap_err();
        std::fs::write(root.join("transcript.md"), "Open a pool request.").unwrap();
        let registry = registry_path(app.handle()).unwrap();
        let backup = registry.with_extension("backup");
        std::fs::rename(&registry, &backup).unwrap();
        std::fs::create_dir(&registry).unwrap();
        assert!(correct_transcript(app.handle(), "correction", "Open a pool request.", "Must roll back.").is_err());
        assert_eq!(std::fs::read_to_string(root.join("transcript.md")).unwrap(), "Open a pool request.");
        assert!(!root.join("transcript.raw.md").exists(), "failed corrections leave no raw file");
        std::fs::remove_dir(&registry).unwrap();
        std::fs::rename(&backup, &registry).unwrap();
        correct_transcript(app.handle(), "correction", "Open a pool request.", "Open a pull request.").unwrap();
        assert_eq!(load_all(app.handle())[0].transcript.as_deref(), Some("Open a pull request."));
        assert_eq!(std::fs::read_to_string(root.join("transcript.raw.md")).unwrap(), "Open a pool request.");
        assert_eq!(std::fs::read_to_string(root.join("transcript.md")).unwrap(), "Open a pull request.");
        correct_transcript(app.handle(), "correction", "Open a pool request.", "stale again").unwrap_err();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_registry_is_never_overwritten_by_a_mutation() {
        let path = temp_registry();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not json").unwrap();

        let result = mutate_path(&path, |list| {
            list.push(sample("new", 1));
            Ok(true)
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"not json");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}

pub fn set_status<R: Runtime>(app: &AppHandle<R>, id: &str, status: &str) -> Result<(), String> {
    mutate(app, |list| {
        let Some(recording) = list.iter_mut().find(|recording| recording.id == id) else { return Ok(false); };
        recording.status = status.to_string();
        Ok(true)
    })
}

/// A deliberate human edit wins over later transcription and sync results.
pub fn correct_transcript<R: Runtime>(app: &AppHandle<R>, id: &str, original: &str, corrected: &str) -> Result<(), String> {
    let _guard = registry_guard();
    let registry = registry_path(app)?;
    let mut list = read_registry(&registry)?;
    let rec = list.iter_mut().find(|r| r.id == id).ok_or("Recording not found")?;
    if rec.transcript.as_deref() != Some(original) { return Err("Transcript changed; reopen it before correcting".into()); }
    let file = rec.folder_path.as_deref().map(|folder| Path::new(folder).join("transcript.md"));
    let before = if let Some(path) = &file {
        match std::fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        }
    } else { None };
    let raw_created = file.as_ref().map(|path| path.with_file_name("transcript.raw.md")).filter(|raw| !raw.exists());
    if let Some(raw) = &raw_created { atomic_write(raw, original.as_bytes())?; }
    if let Some(path) = &file {
        if let Err(error) = atomic_write(path, corrected.as_bytes()) {
            if let Some(raw) = &raw_created { std::fs::remove_file(raw).map_err(|e| format!("{error}; restoring raw transcript failed: {e}"))?; }
            return Err(error);
        }
    }
    rec.transcript = Some(corrected.to_string());
    if let Err(error) = write_registry(&registry, &list) {
        if let Some(path) = &file {
            let restored = match before {
                Some(bytes) => atomic_write(path, &bytes),
                None => std::fs::remove_file(path).map_err(|e| e.to_string()),
            };
            let raw_restored = raw_created.as_ref().map_or(Ok(()), |raw| std::fs::remove_file(raw).map_err(|e| e.to_string()));
            restored.and(raw_restored).map_err(|rollback| format!("{error}; restoring transcript failed: {rollback}"))?;
        }
        return Err(error);
    }
    Ok(())
}
