use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::{fs_writer, settings, store};

pub fn spawn(
    app: AppHandle,
    id: String,
    media_path: PathBuf,
    folder: Option<PathBuf>,
    is_video: bool,
) {
    std::thread::spawn(move || {
        let result = settings::device_credential(&app)
            .ok_or_else(|| {
                "Pair this Mac with your Eavesy account before transcribing recordings."
                    .to_string()
            })
            .and_then(|credential| run(&media_path, is_video, false, &credential));
        match result {
            Ok(text) => {
                let _ = store::set_transcript(&app, &id, Some(text.clone()), "complete");
                crate::dictation::deliver(&app, &id, &text);
                if let Some(dir) = &folder {
                    if let Some(recording) = store::load_all(&app)
                        .into_iter()
                        .find(|recording| recording.id == id)
                    {
                        let _ = fs_writer::persist_recording_artifacts(
                            Some(&app),
                            dir,
                            &recording,
                            None,
                            None,
                        );
                    }
                }
                let current = crate::hud::current();
                if current.session_id.as_deref() == Some(id.as_str())
                    && current.phase != crate::hud::Phase::Recording
                    && !store::load_all(&app).iter().any(|rec| rec.id == id && rec.has_video) {
                    crate::hud::set_state(
                        &app,
                        crate::hud::HudState {
                            phase: crate::hud::Phase::Done,
                            session_id: Some(id.clone()),
                            mode: None,
                            started_at_ms: None,
                            message: Some(text),
                            notice: None,
                        },
                    );
                }
            }
            Err(e) => {
                crate::telemetry::capture("transcription.run", &e);
                let current = crate::hud::current();
                if current.session_id.as_deref() == Some(id.as_str())
                    && current.phase != crate::hud::Phase::Recording
                    && !store::load_all(&app).iter().any(|rec| rec.id == id && rec.has_video) {
                    crate::hud::set_state(
                        &app,
                        crate::hud::HudState {
                            phase: crate::hud::Phase::Failed,
                            session_id: Some(id.clone()),
                            mode: None,
                            started_at_ms: None,
                            message: Some(e.clone()),
                            notice: None,
                        },
                    );
                }
                // Keep any on-device transcript stored at stop: it beats none.
                let _ = store::set_status(&app, &id, "transcript_failed");
                let _ = app
                    .notification()
                    .builder()
                    .title("Couldn't transcribe your recording")
                    .body(format!(
                        "Your recording is saved in your Eavesy folder and is safe. \
                         Transcription failed: {e}"
                    ))
                    .show();
            }
        }
        let _ = app.emit("recordings:updated", ());
    });
}

/// Transcribes a dictation clip for its paste only. The recording uploads
/// separately and its cloud transcript is what gets stored; if this fails,
/// that transcript is pasted once it is ready instead.
pub fn paste_with_whisper(app: AppHandle, id: String, audio: PathBuf) {
    std::thread::spawn(move || {
        let Some(credential) = settings::device_credential(&app) else { return };
        match run(&audio, false, true, &credential) {
            Ok(text) => crate::dictation::deliver_dictation(&app, &id, &text),
            Err(error) => crate::telemetry::capture("dictation.whisper_paste", &error),
        }
    });
}

const CHUNK_SECS: usize = 4 * 60;
const RETRY_DELAYS: [u64; 3] = [5, 20, 60];
/// How many pieces of a long recording upload at once.
const PIECES_AT_ONCE: usize = 3;

/// `voice` marks the user's own mic alone (a dictation), which the server
/// filters more gently and retries when quiet speech is cut.
fn run(
    media_path: &Path,
    is_video: bool,
    voice: bool,
    credential: &settings::Credential,
) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let pieces = prepare(media_path, is_video)?;
    let texts = in_order_at_once(&pieces, PIECES_AT_ONCE, |(bytes, filename, mime)| {
        with_retry(|| transcribe_piece(&client, bytes, filename, mime, voice, credential))
    })?;
    let texts: Vec<&str> = texts.iter().map(|text| text.trim()).filter(|text| !text.is_empty()).collect();
    if texts.is_empty() {
        return Err("empty transcript".to_string());
    }
    Ok(texts.join("\n"))
}

/// Runs `work` on up to `width` items at a time and returns the results in
/// the items' order, or the first error.
fn in_order_at_once<T: Sync, R: Send>(
    items: &[T],
    width: usize,
    work: impl Fn(&T) -> Result<R, String> + Sync,
) -> Result<Vec<R>, String> {
    let mut results = Vec::with_capacity(items.len());
    for batch in items.chunks(width.max(1)) {
        let batch_results: Vec<Result<R, String>> = std::thread::scope(|scope| {
            let workers: Vec<_> = batch.iter().map(|item| scope.spawn(|| work(item))).collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap_or_else(|_| Err("transcription worker panicked".to_string())))
                .collect()
        });
        for result in batch_results {
            results.push(result?);
        }
    }
    Ok(results)
}

enum PieceError {
    Retry(String),
    Fatal(String),
}

fn with_retry(mut attempt: impl FnMut() -> Result<String, PieceError>) -> Result<String, String> {
    for delay in RETRY_DELAYS.iter().map(Some).chain(std::iter::once(None)) {
        match attempt() {
            Ok(text) => return Ok(text),
            Err(PieceError::Fatal(e)) => return Err(e),
            Err(PieceError::Retry(e)) => match delay {
                Some(secs) => std::thread::sleep(std::time::Duration::from_secs(*secs)),
                None => return Err(e),
            },
        }
    }
    unreachable!("the final attempt always returns")
}

fn transcribe_piece(
    client: &reqwest::blocking::Client,
    bytes: &[u8],
    filename: &str,
    mime: &str,
    voice: bool,
    credential: &settings::Credential,
) -> Result<String, PieceError> {
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str(mime)
        .map_err(|e| PieceError::Fatal(e.to_string()))?;
    let form = reqwest::blocking::multipart::Form::new().part("audio", part);
    let url = format!(
        "{}/api/transcribe{}",
        credential.base.trim_end_matches('/'),
        if voice { "?voice=1" } else { "" }
    );

    let resp = client
        .post(&url)
        .multipart(form)
        .bearer_auth(&credential.token)
        .send()
        .map_err(|e| PieceError::Retry(format!("request failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let message = format!("transcribe HTTP {status}");
        return Err(if status.is_server_error() || status.as_u16() == 429 || status.as_u16() == 408 {
            PieceError::Retry(message)
        } else {
            PieceError::Fatal(message)
        });
    }

    #[derive(serde::Deserialize)]
    struct Body {
        text: Option<String>,
    }
    let body: Body = resp
        .json()
        .map_err(|e| PieceError::Retry(format!("bad response: {e}")))?;
    Ok(body.text.unwrap_or_default())
}

type Piece = (Vec<u8>, String, String);

fn prepare(media_path: &Path, is_video: bool) -> Result<Vec<Piece>, String> {
    if !is_video {
        #[cfg(target_os = "macos")]
        if let Some(wav) = transcode_to_wav(media_path) {
            let bytes = std::fs::read(&wav);
            let _ = std::fs::remove_file(&wav);
            if let Some(pieces) = bytes.ok().and_then(|bytes| split_wav(&bytes, CHUNK_SECS)) {
                return Ok(pieces
                    .into_iter()
                    .enumerate()
                    .map(|(i, piece)| (piece, format!("audio-{i}.wav"), "audio/wav".to_string()))
                    .collect());
            }
        }
    }
    let bytes = std::fs::read(media_path).map_err(|e| format!("read media: {e}"))?;
    let (name, mime) = if is_video {
        ("clip.mp4", "video/mp4")
    } else {
        ("audio.m4a", "audio/mp4")
    };
    Ok(vec![(bytes, name.to_string(), mime.to_string())])
}

fn split_wav(bytes: &[u8], secs: usize) -> Option<Vec<Vec<u8>>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut fmt: Option<&[u8]> = None;
    let mut data: Option<&[u8]> = None;
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = bytes.get(at + 8..(at + 8 + len).min(bytes.len()))?;
        match id {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        at += 8 + len + (len & 1);
    }
    let (fmt, data) = (fmt?, data?);
    if fmt.len() < 16 || u16::from_le_bytes([fmt[0], fmt[1]]) != 1 {
        return None;
    }
    let byte_rate = u32::from_le_bytes(fmt[8..12].try_into().ok()?) as usize;
    let block_align = u16::from_le_bytes([fmt[12], fmt[13]]) as usize;
    if byte_rate == 0 || block_align == 0 {
        return None;
    }
    let piece_bytes = (byte_rate * secs / block_align).max(1) * block_align;
    Some(
        data.chunks(piece_bytes)
            .map(|pcm| {
                let mut out = Vec::with_capacity(44 + pcm.len());
                out.extend_from_slice(b"RIFF");
                out.extend_from_slice(&((36 + pcm.len()) as u32).to_le_bytes());
                out.extend_from_slice(b"WAVEfmt ");
                out.extend_from_slice(&16u32.to_le_bytes());
                out.extend_from_slice(&fmt[..16]);
                out.extend_from_slice(b"data");
                out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
                out.extend_from_slice(pcm);
                out
            })
            .collect(),
    )
}

#[cfg(target_os = "macos")]
fn transcode_to_wav(input: &Path) -> Option<PathBuf> {
    let out = std::env::temp_dir().join(format!("eavesy-{}.wav", uuid::Uuid::new_v4()));
    let status = std::process::Command::new("afconvert")
        .arg("-f")
        .arg("WAVE")
        .arg("-d")
        .arg("LEI16@16000")
        .arg(input)
        .arg(&out)
        .status()
        .ok()?;
    if status.success() && out.exists() {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: usize, extra_chunk: bool) -> Vec<u8> {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&16_000u32.to_le_bytes());
        fmt.extend_from_slice(&32_000u32.to_le_bytes());
        fmt.extend_from_slice(&2u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        let pcm: Vec<u8> = (0..samples * 2).map(|i| i as u8).collect();
        let mut out = b"RIFF\0\0\0\0WAVE".to_vec();
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        out.extend_from_slice(&fmt);
        if extra_chunk {
            out.extend_from_slice(b"FLLR");
            out.extend_from_slice(&3u32.to_le_bytes());
            out.extend_from_slice(&[0, 0, 0, 0]);
        }
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        out.extend_from_slice(&pcm);
        out
    }

    #[test]
    fn long_wavs_split_into_standalone_pieces_that_keep_every_sample() {
        let source = wav(16_000 * 5 + 7, true);
        let pieces = split_wav(&source, 2).expect("plain PCM splits");
        assert_eq!(pieces.len(), 3);
        let mut joined = Vec::new();
        for piece in &pieces {
            assert_eq!(&piece[0..4], b"RIFF");
            assert_eq!(&piece[36..40], b"data");
            let len = u32::from_le_bytes(piece[40..44].try_into().unwrap()) as usize;
            assert_eq!(len, piece.len() - 44);
            joined.extend_from_slice(&piece[44..]);
        }
        assert_eq!(pieces[0].len() - 44, 16_000 * 2 * 2);
        let original = split_wav(&source, 3600).unwrap().remove(0);
        assert_eq!(joined, original[44..]);
    }

    #[test]
    fn non_wav_input_falls_back() {
        assert!(split_wav(b"not audio at all", 60).is_none());
    }

    #[test]
    fn pieces_run_together_but_come_back_in_order() {
        let items: Vec<u64> = (0..7).collect();
        let running = std::sync::atomic::AtomicUsize::new(0);
        let peak = std::sync::atomic::AtomicUsize::new(0);
        let results = in_order_at_once(&items, 3, |item| {
            let now = running.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            peak.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(20 * (7 - item)));
            running.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            Ok(item * 10)
        });
        assert_eq!(results, Ok((0..7).map(|item| item * 10).collect()));
        assert_eq!(peak.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[test]
    fn a_failed_piece_fails_the_transcript() {
        let items = [1, 2, 3, 4];
        let result = in_order_at_once(&items, 2, |item| if *item == 3 { Err("HTTP 400".to_string()) } else { Ok(*item) });
        assert_eq!(result, Err("HTTP 400".to_string()));
    }

    #[test]
    fn retries_transient_failures_but_not_fatal_ones() {
        let mut calls = 0;
        let fatal = with_retry(|| {
            calls += 1;
            Err(PieceError::Fatal("401".into()))
        });
        assert_eq!(fatal, Err("401".to_string()));
        assert_eq!(calls, 1);
    }
}
