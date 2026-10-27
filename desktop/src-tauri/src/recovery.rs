//! Salvaging an audio capture whose stop did not finish cleanly: a failed stop in
//! this run, or a capture still marked `recording` when the app launches.

use std::io::Read;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Runtime};

use crate::sqlite;
use crate::store::{self, StoredRecording};

#[derive(Debug, PartialEq, Eq)]
pub enum Salvage {
    /// The continuous archive is playable and will be uploaded as usual.
    Archive,
    /// The archive is unusable; the meeting will be finished from this many segments.
    Segments(i64),
    /// Nothing usable was captured; the session is marked failed.
    Nothing,
}

/// True when `path` is an MP4/M4A whose top-level boxes are intact and include the
/// `moov` index. A capture killed mid-write has `ftyp` and `mdat` but no `moov`, so
/// it cannot be played or transcribed even though it is not empty.
pub fn archive_is_playable(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let Ok(len) = file.metadata().map(|metadata| metadata.len()) else { return false };
    let mut offset = 0_u64;
    let (mut has_ftyp, mut has_moov) = (false, false);
    while offset + 8 <= len {
        let mut header = [0_u8; 16];
        if file.read_exact(&mut header[..8]).is_err() {
            return false;
        }
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = header[4..8].try_into().unwrap();
        let mut header_len = 8;
        if size == 1 {
            if file.read_exact(&mut header[8..16]).is_err() {
                return false;
            }
            size = u64::from_be_bytes(header[8..16].try_into().unwrap());
            header_len = 16;
        } else if size == 0 {
            size = len - offset;
        }
        if size < header_len || offset.checked_add(size).is_none_or(|end| end > len) {
            return false;
        }
        has_ftyp |= &kind == b"ftyp";
        has_moov |= &kind == b"moov";
        offset += size;
        if std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(offset)).is_err() {
            return false;
        }
    }
    has_ftyp && has_moov && offset == len
}

/// Queues every sealed segment whose manifest is on disk. The capture engine writes
/// a manifest next to each finished segment, so this also catches segments whose
/// event never reached the app.
pub fn ingest_segment_manifests<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    segment_dir: &Path,
) -> Result<usize, String> {
    let Ok(entries) = std::fs::read_dir(segment_dir) else { return Ok(0) };
    let mut count = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(manifest) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<sqlite::SegmentManifest>(&raw).ok())
        else {
            continue;
        };
        sqlite::record_segment(app, session_id, &manifest)?;
        count += 1;
    }
    Ok(count)
}

/// Prefix of `last_error` on a capture whose recovery is waiting to be retried.
pub const DEFERRED_NOTE: &str = "recovery deferred: ";

/// Salvages a capture, or leaves it queued with a note when that is not possible
/// yet. It is never failed here: its segments keep uploading meanwhile and
/// `retry_deferred` tries again.
pub fn recover_or_defer<R: Runtime>(app: &AppHandle<R>, session_id: &str, reason: &str) -> Option<Salvage> {
    match salvage(app, session_id, reason) {
        Ok(outcome) => {
            tracing::info!(%session_id, "recovered interrupted recording: {outcome:?}");
            Some(outcome)
        }
        Err(error) => {
            tracing::warn!(%session_id, "could not recover recording yet: {error}");
            crate::telemetry::capture("recording recovery deferred", &error);
            if let Err(error) = sqlite::defer_session(app, session_id, 0, Some(&format!("{DEFERRED_NOTE}{error}"))) {
                tracing::warn!(%session_id, "could not note deferred recovery: {error}");
            }
            None
        }
    }
}

/// Retries every capture whose recovery was deferred.
pub fn retry_deferred<R: Runtime>(app: &AppHandle<R>) {
    match sqlite::deferred_recoveries(app) {
        Ok(ids) => {
            for id in ids {
                recover_or_defer(app, &id, "it could not be finished when the recording ended");
            }
        }
        Err(error) => tracing::warn!("deferred recovery: {error}"),
    }
}

/// Decides what can be kept of an interrupted capture and moves its local session
/// out of `recording`, so the sync loop never polls it forever.
pub fn salvage<R: Runtime>(app: &AppHandle<R>, session_id: &str, reason: &str) -> Result<Salvage, String> {
    let Some(session) = sqlite::interrupted_session(app, session_id)? else {
        return Err(format!("no local recording session {session_id}"));
    };
    if let Some(segment_dir) = session.segment_dir.as_deref() {
        ingest_segment_manifests(app, session_id, segment_dir)?;
    }
    let duration_ms = sqlite::recorded_duration_ms(app, session_id)?;
    let folder = session.archive_path.parent().map(PathBuf::from);
    // A recordings root on a disk that is not mounted yet looks exactly like a lost
    // archive. Leave the session alone; it is salvaged once the folder is back.
    if folder.as_deref().is_some_and(|folder| !folder.is_dir()) {
        return Err(format!(
            "the recording folder {} is not available",
            folder.as_deref().unwrap_or(Path::new("")).display()
        ));
    }

    // The database decides what happens to the capture, so it is updated first.
    // The registry entry and the recording folder are conveniences that the
    // result poll rewrites later; failing to write them must not lose the upload.
    let (outcome, has_audio, status) = if archive_is_playable(&session.archive_path) {
        let archive_bytes = std::fs::metadata(&session.archive_path)
            .map(|metadata| metadata.len() as i64)
            .unwrap_or(0);
        sqlite::finish_recording(app, session_id, &session.archive_path, duration_ms, archive_bytes)?;
        (Salvage::Archive, true, "processing")
    } else {
        let segments = sqlite::usable_segment_count(app, session_id)?;
        if segments > 0 {
            sqlite::finish_from_segments(
                app,
                session_id,
                duration_ms,
                &format!("the audio file could not be saved ({reason}); finishing from recorded segments"),
            )?;
            (Salvage::Segments(segments), false, "processing")
        } else {
            sqlite::mark_session_failed(
                app,
                session_id,
                &format!("the recording could not be saved and no audio was captured ({reason})"),
            )?;
            (Salvage::Nothing, false, "failed")
        }
    };
    if let Err(error) = save_local_recording(app, &session, folder.as_deref(), duration_ms, has_audio, status) {
        tracing::warn!(%session_id, "recovered, but could not update its local files: {error}");
        crate::telemetry::capture("recording recovery files not written", &error);
    }
    Ok(outcome)
}

fn save_local_recording<R: Runtime>(
    app: &AppHandle<R>,
    session: &sqlite::InterruptedSession,
    folder: Option<&Path>,
    duration_ms: i64,
    has_audio: bool,
    status: &str,
) -> Result<(), String> {
    let existing = store::get(app, &session.id)?;
    let recording = match existing {
        Some(mut recording) => {
            if recording.status != status || recording.has_audio != has_audio {
                recording.status = status.to_string();
                recording.has_audio = has_audio;
                store::append(app, recording.clone())?;
            }
            recording
        }
        None => {
            let recording = StoredRecording {
                id: session.id.clone(),
                title: session.title.clone(),
                started_at_ms: session.started_at,
                duration_sec: duration_ms / 1_000,
                source: session.source.clone(),
                status: status.to_string(),
                summary: None,
                transcript: None,
                notes: None,
                has_audio,
                has_video: false,
                folder_path: folder.and_then(Path::to_str).map(str::to_string),
            };
            store::append(app, recording.clone())?;
            recording
        }
    };
    if let Some(folder) = folder {
        crate::fs_writer::persist_recording_artifacts(Some(app), folder, &recording, None, recording.notes.as_deref())?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

/// A minimal M4A with the boxes `archive_is_playable` requires.
#[cfg(test)]
pub(crate) fn playable_m4a() -> Vec<u8> {
    let mut bytes = mp4_box(b"ftyp", b"M4A ");
    bytes.extend(mp4_box(b"mdat", &[7; 64]));
    bytes.extend(mp4_box(b"moov", &[1; 16]));
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("eavesy-archive-{}.m4a", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_finished_m4a_is_playable() {
        let path = temp_file(&playable_m4a());
        assert!(archive_is_playable(&path));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn an_unfinished_or_truncated_m4a_is_not_playable() {
        let mut unfinished = mp4_box(b"ftyp", b"M4A ");
        unfinished.extend(mp4_box(b"mdat", &[7; 64]));
        let mut truncated = unfinished.clone();
        truncated.extend(mp4_box(b"moov", &[1; 16]));
        truncated.truncate(truncated.len() - 4);
        for bytes in [Vec::new(), b"not audio at all".to_vec(), unfinished, truncated] {
            let path = temp_file(&bytes);
            assert!(!archive_is_playable(&path), "{bytes:?}");
            std::fs::remove_file(path).unwrap();
        }
        assert!(!archive_is_playable(Path::new("/nonexistent/audio.m4a")));
    }
}
