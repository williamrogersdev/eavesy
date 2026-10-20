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

/// Save a deliberate correction under the same lock used by cloud-result updates.
/// The file remains a local edit, so later generated transcripts cannot replace it.
pub fn save_preview_transcript<R: Runtime>(
    app: &AppHandle<R>, id: &str, content: &str,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if content.len() > 5 * 1024 * 1024 { return Err("Transcript is too large".into()); }
    let _guard = registry_guard();
    let registry = registry_path(app)?;
    let previous = read_registry(&registry)?;
    let mut list = previous.clone();
    let recording = list.iter_mut().find(|rec| rec.id == id)
        .ok_or_else(|| "Recording is still being saved. Please retry.".to_string())?;
    let folder = recording.folder_path.as_deref()
        .ok_or_else(|| "Recording folder is still being saved. Please retry.".to_string())?;
    let path = Path::new(folder).join("transcript.md");
    let old_file = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not read saved transcript: {error}")),
    };
    let hash = hex::encode(Sha256::digest(content.as_bytes()));
    recording.transcript = Some(content.to_string());
    let saved = crate::sqlite::with_open_mut(app, |conn| -> Result<(), String> {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        crate::sqlite::enqueue_file_edit_in(&tx, id, "transcript", content, &hash)?;
        crate::sqlite::record_file_observation_in(&tx, &path, id, "transcript", &hash)?;
        // An explicit correction stays authoritative even if it matches the
        // old generated text (for example, the user undoes their first edit).
        tx.execute("UPDATE filesystem_state SET last_written_hash=NULL WHERE file_path=?1",
            rusqlite::params![path.to_string_lossy()]).map_err(|error| error.to_string())?;
        crate::fs_writer::atomic_write(&path, content.as_bytes())?;
        write_registry(&registry, &list)?;
        tx.commit().map_err(|error| error.to_string())
    }).and_then(|result| result);
    if let Err(error) = saved {
        // No outbox/observation becomes visible before both durable files land.
        // Restore the file and registry if writing either or committing fails.
        let restore = if let Some(bytes) = old_file {
            crate::fs_writer::atomic_write(&path, &bytes)
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|error| error.to_string())
        } else { Ok(()) };
        let restore_registry = write_registry(&registry, &previous);
        restore.and(restore_registry).map_err(|rollback| format!("{error}; restore failed: {rollback}"))?;
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
    fn preview_corrections_persist_and_survive_later_transcription() {
        let root = std::env::temp_dir().join(format!("eavesy-preview-save-{}", uuid::Uuid::new_v4()));
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        let app = app.handle();
        crate::sqlite::initialize(app).unwrap();
        let folder = root.join("recording");
        let mut recording = sample("edited", 1);
        recording.folder_path = Some(folder.to_string_lossy().into_owned());
        recording.transcript = Some("Original transcript".into());
        append(app, recording.clone()).unwrap();
        crate::fs_writer::persist_recording_artifacts(Some(app), &folder, &recording, None, None).unwrap();
        for correction in ["Original transcript", "Corrected opening.\nCorrected ending.", "", "Final saved correction."] {
            save_preview_transcript(app, "edited", correction).unwrap();
            // Read the physical registry as well as its in-memory cache.
            assert_eq!(read_registry_file(&registry_path(app).unwrap()).unwrap()[0].transcript.as_deref(), Some(correction));
            assert_eq!(std::fs::read_to_string(folder.join("transcript.md")).unwrap(), correction);
            let queued = crate::sqlite::next_file_edit(app).unwrap().unwrap();
            assert_eq!(queued.content_md, correction);
            assert!(crate::fs_writer::has_local_edit(app, &folder.join("transcript.md")).unwrap());
            set_transcript(app, "edited", Some("Late device transcript".into()), "processing").unwrap();
            let (updated, _) = set_result(app, "edited", "Cloud title", "Late cloud transcript".into(), None, None, "complete", true).unwrap().unwrap();
            crate::fs_writer::persist_recording_artifacts(Some(app), &folder, &updated, None, None).unwrap();
            assert_eq!(load_all(app)[0].transcript.as_deref(), Some(correction));
            assert_eq!(std::fs::read_to_string(folder.join("transcript.md")).unwrap(), correction);
        }
        // A failure after enqueueing must roll back the outbox and preserve both files.
        crate::sqlite::with_open(app, |conn| conn.execute_batch(
            "CREATE TRIGGER fail_preview_observation BEFORE UPDATE ON filesystem_state BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END;"
        )).unwrap().unwrap();
        assert!(save_preview_transcript(app, "edited", "Must not partially land").is_err());
        assert_eq!(read_registry_file(&registry_path(app).unwrap()).unwrap()[0].transcript.as_deref(), Some("Final saved correction."));
        assert_eq!(std::fs::read_to_string(folder.join("transcript.md")).unwrap(), "Final saved correction.");
        assert_eq!(crate::sqlite::next_file_edit(app).unwrap().unwrap().content_md, "Final saved correction.");
        crate::sqlite::with_open(app, |conn| conn.execute_batch("DROP TRIGGER fail_preview_observation")).unwrap().unwrap();
        assert!(save_preview_transcript(app, "missing", "must not disappear").is_err());
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
