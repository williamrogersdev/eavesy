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
/// recordings.json or notify the UI.
pub fn set_result<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    title: &str,
    transcript: String,
    summary: Option<String>,
    notes: Option<String>,
    status: &str,
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
        if !transcript_is_local && takes_cloud_transcript(recording.transcript.as_deref(), &transcript, status) {
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

/// Whether a cloud transcript should replace the one a recording has. A
/// finished one always does. Until then the cloud has only part of the
/// recording, so it must not swap the fuller on-device text that was stored at
/// stop for a shorter partial; it takes over once it says at least as much.
/// A failed one never wipes text the recording already has.
fn takes_cloud_transcript(current: Option<&str>, cloud: &str, status: &str) -> bool {
    let words = |text: &str| text.split_whitespace().filter(|w| w.chars().any(char::is_alphabetic)).count();
    match status {
        "complete" => true,
        "transcript_failed" => current.is_none_or(|text| text.trim().is_empty()),
        _ => words(cloud) >= current.map_or(0, words),
    }
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
        assert!(!takes_cloud_transcript(on_device, partial, "processing"));
        let caught_up = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there, this is the whole recording now.";
        assert!(takes_cloud_transcript(on_device, caught_up, "processing"));
        assert!(takes_cloud_transcript(None, partial, "processing"));
    }

    #[test]
    fn a_finished_cloud_transcript_always_replaces_the_on_device_one() {
        assert!(takes_cloud_transcript(Some("much longer on device text than the cloud"), "# R\n\nshort", "complete"));
    }

    #[test]
    fn a_failed_cloud_transcript_keeps_the_on_device_text() {
        let empty = "# Recording\n\n## Transcript\n\n";
        assert!(!takes_cloud_transcript(Some("What the Mac heard."), empty, "transcript_failed"));
        assert!(takes_cloud_transcript(None, empty, "transcript_failed"));
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
        let poll = || set_result(app, "meeting", "Sync", "transcript".into(), None, None, "processing").unwrap();

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
