// Frozen recordings.json implementation from f63092a; benchmark only.
#![allow(dead_code)]
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

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
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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

pub fn load(path: &Path) -> Vec<StoredRecording> {
    let _g = registry_guard();
    read_registry(path).unwrap()
}
pub fn update(path: &Path, id: &str) {
    let _g = registry_guard();
    mutate_path(path, |rows| {
        rows.iter_mut()
            .find(|r| r.id == id)
            .unwrap()
            .title
            .push('x');
        Ok(true)
    })
    .unwrap()
}
pub fn seed(path: &Path, rows: &[StoredRecording]) {
    write_registry(path, rows).unwrap()
}
