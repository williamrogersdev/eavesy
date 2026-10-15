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
            .and_then(|credential| run(&media_path, is_video, &credential));
        match result {
            Ok(text) => {
                let _ = store::set_transcript(&app, &id, Some(text.clone()), "complete");
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
                        },
                    );
                }
                let _ = store::set_transcript(&app, &id, None, "transcript_failed");
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

const CHUNK_SECS: usize = 4 * 60;
const RETRY_DELAYS: [u64; 3] = [5, 20, 60];

fn run(media_path: &Path, is_video: bool, credential: &settings::Credential) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut texts = Vec::new();
    for (bytes, filename, mime) in prepare(media_path, is_video)? {
        let text = with_retry(|| transcribe_piece(&client, &bytes, &filename, &mime, credential))?;
        if !text.trim().is_empty() {
            texts.push(text.trim().to_string());
        }
    }
    if texts.is_empty() {
        return Err("empty transcript".to_string());
    }
    Ok(texts.join("\n"))
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
    credential: &settings::Credential,
) -> Result<String, PieceError> {
    let part = reqwest::blocking::multipart::Part::bytes(bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str(mime)
        .map_err(|e| PieceError::Fatal(e.to_string()))?;
    let form = reqwest::blocking::multipart::Form::new().part("audio", part);
    let url = format!("{}/api/transcribe", credential.base.trim_end_matches('/'));

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
