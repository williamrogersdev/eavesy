use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime, State};

use crate::{fs_watcher::WatcherManager, settings, sqlite, store::StoredRecording};

const SUMMARY_FILE: &str = "summary.md";
const TRANSCRIPT_FILE: &str = "transcript.md";
const NOTES_FILE: &str = "notes.md";
const MANIFEST_FILE: &str = "meeting.json";
const SUMMARY_PLACEHOLDER: &str =
    "# Brief\n\nEavesy is processing this recording. Your brief will appear here automatically.\n";
const TRANSCRIPT_PLACEHOLDER: &str = "# Transcript\n\nEavesy is processing this recording. The transcript will appear here automatically.\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingFolderPayload {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    #[serde(default)]
    pub duration_sec: i64,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub summary_md: String,
    #[serde(default)]
    pub transcript_md: String,
    #[serde(default)]
    pub notes_md: String,
}

fn default_source() -> String {
    "unknown".to_string()
}

fn default_status() -> String {
    "complete".to_string()
}

#[tauri::command]
pub async fn set_root_folder(
    app: AppHandle,
    watcher: State<'_, WatcherManager>,
    path: String,
) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("recordings folder cannot be empty".to_string());
    }
    let root = PathBuf::from(trimmed);
    if !root.is_absolute() {
        return Err("choose an absolute recordings folder".to_string());
    }
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("could not create recordings folder: {error}"))?;

    let mut config = settings::load(&app);
    config.recordings_root = Some(root.to_string_lossy().into_owned());
    settings::save(&app, &config)?;
    watcher
        .replace(app, root.clone())
        .map_err(|error| format!("could not monitor the recordings folder: {error}"))?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn write_meeting_folder(
    app: AppHandle,
    payload: MeetingFolderPayload,
) -> Result<String, String> {
    let started = started_at(payload.started_at_ms);
    let folder = allocate_recording_folder(&recordings_root(&app)?, &payload.title, started)?;

    let recording = StoredRecording {
        id: payload.id,
        title: payload.title,
        started_at_ms: payload.started_at_ms,
        duration_sec: payload.duration_sec.max(0),
        source: payload.source,
        status: payload.status,
        summary: non_empty(payload.summary_md),
        transcript: non_empty(payload.transcript_md),
        notes: non_empty(payload.notes_md.clone()),
        has_audio: folder.join("audio.m4a").exists(),
        has_video: folder.join("screen.mp4").exists(),
        folder_path: Some(folder.to_string_lossy().into_owned()),
    };

    persist_recording_artifacts(
        Some(&app),
        &folder,
        &recording,
        None,
        Some(payload.notes_md.as_str()),
    )?;
    Ok(folder.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, meeting_id: String) -> Result<(), String> {
    let target = crate::store::get(&app, &meeting_id)?
        .and_then(|recording| recording.folder_path)
        .unwrap_or(meeting_id);

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(&target)
            .status()
            .map_err(|error| format!("could not open Finder: {error}"))?;
        if !status.success() {
            return Err("Finder could not reveal that recording folder".to_string());
        }
    }
    Ok(())
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

pub fn recordings_root(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = settings::load(app)
        .recordings_root
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from);
    let root = configured
        .or_else(default_recordings_root)
        .ok_or_else(|| "could not resolve the recordings folder".to_string())?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("could not create recordings folder: {error}"))?;
    Ok(root)
}

pub fn persist_recording_artifacts<R: Runtime>(
    app: Option<&AppHandle<R>>,
    folder: &Path,
    recording: &StoredRecording,
    remote_meeting_id: Option<&str>,
    notes_override: Option<&str>,
) -> Result<(), String> {
    std::fs::create_dir_all(folder)
        .map_err(|error| format!("could not create recording folder: {error}"))?;

    let started = started_at(recording.started_at_ms);
    let summary = recording.summary.as_deref().unwrap_or(SUMMARY_PLACEHOLDER);
    let transcript = recording
        .transcript
        .as_deref()
        .unwrap_or(TRANSCRIPT_PLACEHOLDER);

    write_generated(
        app,
        &folder.join(SUMMARY_FILE),
        summary.as_bytes(),
        &recording.id,
        "summary",
    )?;
    write_generated(
        app,
        &folder.join(TRANSCRIPT_FILE),
        transcript.as_bytes(),
        &recording.id,
        "transcript",
    )?;

    let notes_path = folder.join(NOTES_FILE);
    if let Some(notes) = notes_override {
        write_generated(
            app,
            &notes_path,
            notes_file_content(recording, notes).as_bytes(),
            &recording.id,
            "notes",
        )?;
    } else if !notes_path.exists() {
        write_generated(
            app,
            &notes_path,
            render_notes(recording, "").as_bytes(),
            &recording.id,
            "notes",
        )?;
    }

    let audio_filename = if recording.has_audio {
        Some("audio.m4a")
    } else {
        None
    };
    let video_filename = recording.has_video.then_some("screen.mp4");
    let manifest = json!({
        "schemaVersion": 1,
        "id": recording.id,
        "remoteMeetingId": remote_meeting_id,
        "title": recording.title,
        "date": started.to_rfc3339(),
        "startedAt": recording.started_at_ms,
        "durationSeconds": recording.duration_sec,
        "source": recording.source,
        "status": recording.status,
        "files": {
            "audio": audio_filename,
            "video": video_filename,
            "summary": SUMMARY_FILE,
            "transcript": TRANSCRIPT_FILE,
            "notes": NOTES_FILE
        }
    });
    let manifest = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("could not serialize meeting metadata: {error}"))?;
    write_generated(
        app,
        &folder.join(MANIFEST_FILE),
        &manifest,
        &recording.id,
        "manifest",
    )?;
    Ok(())
}

fn write_generated<R: Runtime>(
    app: Option<&AppHandle<R>>,
    path: &Path,
    bytes: &[u8],
    meeting_id: &str,
    role: &str,
) -> Result<(), String> {
    let hash = sha256_hex(bytes);
    if let Some(app) = app {
        if let Ok(current) = std::fs::read(path) {
            let current_hash = sha256_hex(&current);
            if sqlite::file_was_edited(app, path, &current_hash)? {
                return Ok(());
            }
            // Ours and already up to date: no write, no watcher event.
            if current_hash == hash {
                return Ok(());
            }
        }
    }
    // Register the new content as observed before it lands, so the watcher never
    // sees our own write as an external edit if it fires before record_file_write.
    if let Some(app) = app {
        sqlite::record_file_observation(app, path, meeting_id, role, &hash)?;
    }
    atomic_write(path, bytes)?;
    if let Some(app) = app {
        sqlite::record_file_write(app, path, meeting_id, role, &hash)?;
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn render_notes(recording: &StoredRecording, notes: &str) -> String {
    format!(
        "---\nid: {}\ntitle: {}\nstarted_at: {}\n---\n\n# Notes\n\n{}",
        yaml_string(&recording.id),
        yaml_string(&recording.title),
        started_at(recording.started_at_ms).to_rfc3339(),
        notes.trim()
    )
}

fn notes_file_content(recording: &StoredRecording, notes: &str) -> String {
    let trimmed = notes.trim_start();
    if trimmed.starts_with("---\n") || trimmed.starts_with("---\r\n") {
        notes.to_string()
    } else {
        render_notes(recording, notes)
    }
}

pub(crate) fn expected_editable_content(
    recording: &StoredRecording,
    role: &str,
) -> Option<String> {
    match role {
        "summary" => Some(
            recording
                .summary
                .clone()
                .unwrap_or_else(|| SUMMARY_PLACEHOLDER.to_string()),
        ),
        "transcript" => Some(
            recording
                .transcript
                .clone()
                .unwrap_or_else(|| TRANSCRIPT_PLACEHOLDER.to_string()),
        ),
        "notes" => Some(notes_file_content(
            recording,
            recording.notes.as_deref().unwrap_or(""),
        )),
        _ => None,
    }
}

pub(crate) fn restore_missing_editable_file<R: Runtime>(
    app: Option<&AppHandle<R>>,
    path: &Path,
    recording: &StoredRecording,
    role: &str,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let content = expected_editable_content(recording, role)
        .ok_or_else(|| format!("unsupported recording file role: {role}"))?;
    write_generated(app, path, content.as_bytes(), &recording.id, role)
}

pub(crate) fn has_local_edit<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
) -> Result<bool, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("could not inspect {}: {error}", path.display())),
    };
    sqlite::file_was_edited(app, path, &sha256_hex(&bytes))
}

fn yaml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("eavesy"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("could not create {}: {error}", temp.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("could not write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("could not flush {}: {error}", temp.display()))?;
        drop(file);
        std::fs::rename(&temp, path)
            .map_err(|error| format!("could not replace {}: {error}", path.display()))?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn started_at(started_at_ms: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(started_at_ms).unwrap_or_else(Utc::now)
}

fn slug_with_date(title: &str, date_part: &str) -> String {
    let mut safe = String::with_capacity(title.len());
    let mut last_was_space = false;
    for ch in title.chars() {
        let is_safe = ch.is_ascii()
            && !matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        if !is_safe {
            continue;
        }
        if ch.is_whitespace() {
            if last_was_space {
                continue;
            }
            last_was_space = true;
            safe.push(' ');
        } else {
            last_was_space = false;
            safe.push(ch);
        }
    }
    let trimmed: String = safe.trim().chars().take(80).collect();
    if trimmed.is_empty() {
        format!("{} Recording", date_part)
    } else {
        format!("{} {}", date_part, trimmed)
    }
}

pub fn allocate_recording_folder(
    root: &Path,
    title: &str,
    started_at: DateTime<Utc>,
) -> Result<PathBuf, String> {
    allocate_named(root, title, &started_at.with_timezone(&chrono::Local).fixed_offset())
}

fn allocate_named(
    root: &Path,
    title: &str,
    started_at: &DateTime<chrono::FixedOffset>,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("could not create recordings root: {error}"))?;
    let base = slug_with_date(title, &started_at.format("%Y-%m-%d").to_string());
    let time = started_at.format("%H-%M");

    for attempt in 0_u32.. {
        let name = match attempt {
            0 => base.clone(),
            1 => format!("{base} ({time})"),
            _ => format!("{base} ({time}-{attempt})"),
        };
        let candidate = root.join(name);
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "could not reserve recording folder {}: {error}",
                    candidate.display()
                ))
            }
        }
    }
    unreachable!("the folder collision counter cannot be exhausted")
}

pub fn default_recordings_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Eavesy").join("Recordings"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_recording(folder: &Path) -> StoredRecording {
        StoredRecording {
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
    fn materializes_all_canonical_text_artifacts_and_preserves_notes() {
        let folder = std::env::temp_dir().join(format!("eavesy-writer-{}", uuid::Uuid::new_v4()));
        let mut recording = sample_recording(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("audio.m4a"), b"audio").unwrap();
        persist_recording_artifacts::<tauri::Wry>(None, &folder, &recording, None, None).unwrap();

        for filename in [SUMMARY_FILE, TRANSCRIPT_FILE, NOTES_FILE, MANIFEST_FILE] {
            assert!(folder.join(filename).is_file(), "missing {filename}");
        }
        std::fs::write(folder.join(NOTES_FILE), "my external note").unwrap();

        recording.status = "complete".to_string();
        recording.summary = Some("# Brief\n\nFinished".to_string());
        recording.transcript = Some("# Transcript\n\n[00:00] Hello".to_string());
        persist_recording_artifacts::<tauri::Wry>(
            None,
            &folder,
            &recording,
            Some("remote-1"),
            None,
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(folder.join(NOTES_FILE)).unwrap(), "my external note");
        assert!(std::fs::read_to_string(folder.join(SUMMARY_FILE)).unwrap().contains("Finished"));
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(folder.join(MANIFEST_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["schemaVersion"], 1);
        assert_eq!(manifest["remoteMeetingId"], "remote-1");
        assert_eq!(manifest["files"]["audio"], "audio.m4a");

        recording.has_video = true;
        std::fs::write(folder.join("screen.mp4"), b"video").unwrap();
        persist_recording_artifacts::<tauri::Wry>(
            None,
            &folder,
            &recording,
            Some("remote-1"),
            None,
        )
        .unwrap();
        let screen_manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(folder.join(MANIFEST_FILE)).unwrap(),
        )
        .unwrap();
        assert_eq!(screen_manifest["files"]["audio"], "audio.m4a");
        assert_eq!(screen_manifest["files"]["video"], "screen.mp4");

        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn atomically_allocates_unique_folders_for_same_title_and_day() {
        let root = std::env::temp_dir().join(format!("eavesy-allocate-{}", uuid::Uuid::new_v4()));
        let started = DateTime::<Utc>::from_timestamp_millis(1_751_808_600_000).unwrap();

        let started = started.fixed_offset();
        let first = allocate_named(&root, "Design review", &started).unwrap();
        let second = allocate_named(&root, "Design review", &started).unwrap();
        let third = allocate_named(&root, "Design review", &started).unwrap();

        assert_eq!(first.file_name().unwrap(), "2025-07-06 Design review");
        assert_eq!(second.file_name().unwrap(), "2025-07-06 Design review (13-30)");
        assert_eq!(third.file_name().unwrap(), "2025-07-06 Design review (13-30-2)");
        assert!(first.is_dir() && second.is_dir() && third.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_name_uses_the_local_date_and_time() {
        let root = std::env::temp_dir().join(format!("eavesy-local-{}", uuid::Uuid::new_v4()));
        let utc = DateTime::<Utc>::from_timestamp_millis(1_751_851_800_000).unwrap();
        let mountain = utc.with_timezone(&chrono::FixedOffset::west_opt(6 * 3600).unwrap());
        let first = allocate_named(&root, "Standup", &mountain).unwrap();
        let second = allocate_named(&root, "Standup", &mountain).unwrap();
        assert_eq!(first.file_name().unwrap(), "2025-07-06 Standup");
        assert_eq!(second.file_name().unwrap(), "2025-07-06 Standup (19-30)");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_a_missing_canonical_file_without_touching_renamed_copy() {
        let folder = std::env::temp_dir().join(format!("eavesy-restore-{}", uuid::Uuid::new_v4()));
        let mut recording = sample_recording(&folder);
        recording.summary = Some("# Brief\n\nKeep this".to_string());
        persist_recording_artifacts::<tauri::Wry>(None, &folder, &recording, None, None).unwrap();

        let summary = folder.join(SUMMARY_FILE);
        let renamed = folder.join("my-brief.md");
        std::fs::rename(&summary, &renamed).unwrap();
        restore_missing_editable_file::<tauri::Wry>(None, &summary, &recording, "summary").unwrap();

        assert_eq!(std::fs::read_to_string(summary).unwrap(), "# Brief\n\nKeep this");
        assert_eq!(std::fs::read_to_string(renamed).unwrap(), "# Brief\n\nKeep this");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn preserves_complete_notes_markdown_without_nesting_frontmatter() {
        let folder = std::env::temp_dir().join(format!("eavesy-notes-{}", uuid::Uuid::new_v4()));
        let recording = sample_recording(&folder);
        let complete = "---\nid: custom\n---\n\n# Notes\n\nEdited externally\n";

        persist_recording_artifacts::<tauri::Wry>(
            None,
            &folder,
            &recording,
            None,
            Some(complete),
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(folder.join(NOTES_FILE)).unwrap(), complete);
        std::fs::remove_dir_all(folder).unwrap();
    }
}

