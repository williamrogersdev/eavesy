use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::{fs_writer, settings, store};

#[allow(dead_code)] // Legacy audio retry path retained for recovery.
pub fn spawn(
    app: AppHandle,
    id: String,
    media_path: PathBuf,
    folder: Option<PathBuf>,
    is_video: bool,
) {
    std::thread::spawn(move || {
        let result = crate::fs_watcher::wait_for_recovery_on_worker(&app).and_then(|()| settings::device_credential(&app)
            .ok_or_else(|| {
                "Pair this Mac with your Eavesy account before transcribing recordings.".to_string()
            })
            .and_then(|credential| run(&media_path, is_video, "", &credential, &RETRY_DELAYS)));
        match result {
            Ok(text) => {
                let _ = store::set_transcript(&app, &id, Some(text.clone()), "complete");
                crate::dictation::deliver(&app, &id, &text);
                if let Some(dir) = &folder {
                    if let Some(recording) = store::get(&app, &id).ok().flatten() {
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
                    && !store::get(&app, &id)
                        .ok()
                        .flatten()
                        .is_some_and(|rec| rec.has_video)
                {
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
                    && !store::get(&app, &id)
                        .ok()
                        .flatten()
                        .is_some_and(|rec| rec.has_video)
                {
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
/// that transcript is pasted once it is ready instead. `heard_on_device` is
/// false when the Mac's recognizer ran over the whole clip and heard no words,
/// so the server keeps out the stock phrases Whisper invents for silence.
pub fn paste_with_whisper(app: AppHandle, id: String, audio: PathBuf, heard_on_device: bool) {
    std::thread::spawn(move || {
        let Some(credential) = settings::device_credential(&app) else {
            no_paste(&app, &id, "Saved. Sign in to have it typed for you");
            return;
        };
        let query = if heard_on_device { VOICE } else { VOICE_UNHEARD };
        match run(&audio, false, query, &credential, &PASTE_RETRY_DELAYS) {
            Ok(text) => crate::dictation::deliver_dictation(&app, &id, &text),
            Err(error) => {
                crate::telemetry::capture("dictation.whisper_paste", &error);
                no_paste(&app, &id, "Saved. The words will be in History");
            }
        }
    });
}

/// How long a paste waits for the tidied words before it types them as heard.
const POLISH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1800);

/// A dictation's words as the user would have typed them: fillers, stutters
/// and false starts gone, punctuated, their own words spelled their way. The
/// words as heard when the Mac isn't signed in or the server can't help in time.
/// `project` picks that project's tone and words over the account's.
pub fn polish_dictation(app: &AppHandle, text: &str, project: Option<&str>) -> String {
    let Some(credential) = settings::device_credential(app) else {
        return strip_fillers(text);
    };
    let started = std::time::Instant::now();
    let result = polish_with(&credential, text, project, POLISH_TIMEOUT);
    let polish_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(polished) => {
            tracing::info!(polish_ms, "dictation polished");
            polished
        }
        Err(error) => {
            tracing::warn!(polish_ms, "dictation: typing the words as heard, fillers dropped ({error})");
            strip_fillers(text)
        }
    }
}

/// The model-free part of tidying, as the server does it: "um", "uh", "hmm"
/// and the like go, with the comma after them, and spacing is tidied. Never
/// changes a word the user meant, so it is safe on their own corrections too.
pub fn strip_fillers(text: &str) -> String {
    let out = drop_fillers(text);
    let mut chars = out.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// [`strip_fillers`] without capitalising what is left: for the user's own
/// corrections, whose first letter is theirs to choose.
pub fn drop_fillers(text: &str) -> String {
    static FILLER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(^|[\s,.;:!?])(?:u+m+|u+h+m*|e+r+m+|h+m+|m+h*m+)[,.]?([\s,.;:!?]|$)").unwrap()
    });
    static SPACE_BEFORE_PUNCT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\s+([,.;:!?])").unwrap());
    static DOUBLED_PUNCT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"([,;:])([,.;:!?])").unwrap());
    static SPACES: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r" {2,}").unwrap());
    // Neighbouring fillers share a separator, so one pass can miss the next.
    let mut out = text.to_string();
    loop {
        let next = FILLER.replace_all(&out, "$1$2").into_owned();
        if next == out { break; }
        out = next;
    }
    let out = SPACE_BEFORE_PUNCT.replace_all(&out, "$1");
    let out = DOUBLED_PUNCT.replace_all(&out, "$2");
    let out = SPACES.replace_all(&out, " ");
    out.trim_start_matches(|c: char| c.is_whitespace() || ",.;:".contains(c)).trim_end().to_string()
}

/// How long a tone change waits for its rewrite: asked for, and watched.
const RESTYLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(12);

/// A dictation's words rewritten in `style` ("professional", "friendly",
/// "concise" or "natural"), as a prompt for an AI agent with `for_agents`:
/// the HUD's tone buttons. Saved settings are left as they are.
pub fn restyle_dictation(app: &AppHandle, text: &str, project: Option<&str>, style: &str, for_agents: bool) -> Result<String, String> {
    let credential = settings::device_credential(app).ok_or("Sign in to change the tone")?;
    restyle_with(&credential, text, project, style, for_agents, RESTYLE_TIMEOUT)
}

fn restyle_with(
    credential: &settings::Credential,
    text: &str,
    project: Option<&str>,
    style: &str,
    for_agents: bool,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let mut body = polish_body(text, project);
    body["style"] = serde_json::Value::from(style);
    body["forAgents"] = serde_json::Value::from(for_agents);
    post_polish(credential, &body, timeout)
}

fn polish_body(text: &str, project: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({ "text": text });
    if let Some(project) = project {
        body["projectId"] = serde_json::Value::from(project);
    }
    body
}

fn polish_with(
    credential: &settings::Credential,
    text: &str,
    project: Option<&str>,
    timeout: std::time::Duration,
) -> Result<String, String> {
    post_polish(credential, &polish_body(text, project), timeout)
}

fn post_polish(credential: &settings::Credential, body: &serde_json::Value, timeout: std::time::Duration) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!(
            "{}/api/dictations/polish",
            credential.base.trim_end_matches('/')
        ))
        .bearer_auth(&credential.token)
        .json(body)
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("polish HTTP {}", resp.status()));
    }
    #[derive(serde::Deserialize)]
    struct Body {
        text: String,
    }
    let polished = resp
        .json::<Body>()
        .map_err(|e| format!("bad response: {e}"))?
        .text;
    if polished.trim().is_empty() {
        return Err("empty polish".to_string());
    }
    Ok(polished)
}

/// A dictation whose words could not be had in time: say it is saved, so
/// "Writing it down…" doesn't hang.
fn no_paste(app: &AppHandle, id: &str, notice: &str) {
    let current = crate::hud::current();
    if current.phase == crate::hud::Phase::Transcribing && current.session_id.as_deref() == Some(id)
    {
        crate::hud::set_state(
            app,
            crate::hud::HudState {
                phase: crate::hud::Phase::Saved,
                session_id: Some(id.to_string()),
                mode: Some("audio".to_string()),
                started_at_ms: None,
                message: None,
                notice: Some(notice.to_string()),
            },
        );
    }
}

const CHUNK_SECS: usize = 4 * 60;
#[allow(dead_code)] // Used by the legacy recovery retry path.
const RETRY_DELAYS: [u64; 3] = [5, 20, 60];
/// A paste is only worth waiting a moment for: after that the user has moved
/// on, and the stored recording is transcribed with full retries anyway.
const PASTE_RETRY_DELAYS: [u64; 1] = [2];
/// How many pieces of a long recording upload at once.
const PIECES_AT_ONCE: usize = 3;

/// `voice=1` marks the user's own mic alone (a dictation), which the server
/// filters more gently and retries when quiet speech is cut.
const VOICE: &str = "?voice=1";
/// A dictation the Mac heard no words in: filtered strictly after all.
const VOICE_UNHEARD: &str = "?voice=1&heard_on_device=0";

/// `query` is what the server is told about the clip: "", `VOICE` or `VOICE_UNHEARD`.
fn run(
    media_path: &Path,
    is_video: bool,
    query: &str,
    credential: &settings::Credential,
    delays: &[u64],
) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let pieces = prepare(media_path, is_video)?;
    let texts = crate::work_queue::run(&pieces.pieces, PIECES_AT_ONCE, |piece| {
        with_retry(delays, || transcribe_piece(&client, piece, query, credential))
    })?;
    let texts: Vec<&str> = texts
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect();
    if texts.is_empty() {
        return Err("empty transcript".to_string());
    }
    Ok(texts.join("\n"))
}


enum PieceError {
    Retry(String),
    Fatal(String),
}

fn with_retry(
    delays: &[u64],
    mut attempt: impl FnMut() -> Result<String, PieceError>,
) -> Result<String, String> {
    for delay in delays.iter().map(Some).chain(std::iter::once(None)) {
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
    piece: &crate::audio_upload::AudioPiece,
    query: &str,
    credential: &settings::Credential,
) -> Result<String, PieceError> {
    let part =
        reqwest::blocking::multipart::Part::reader_with_length(piece.reader(), piece.body_len())
            .file_name(piece.filename.clone())
            .mime_str(piece.mime)
            .map_err(|e| PieceError::Fatal(e.to_string()))?;
    let form = reqwest::blocking::multipart::Form::new().part("audio", part);
    let url = format!(
        "{}/api/transcribe{query}",
        credential.base.trim_end_matches('/'),
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
        return Err(
            if status.is_server_error() || status.as_u16() == 429 || status.as_u16() == 408 {
                PieceError::Retry(message)
            } else {
                PieceError::Fatal(message)
            },
        );
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

fn prepare(
    media_path: &Path,
    is_video: bool,
) -> Result<crate::audio_upload::PreparedAudio, String> {
    if !is_video {
        #[cfg(target_os = "macos")]
        if let Some(wav) = transcode_to_wav(media_path) {
            if let Ok(pieces) = crate::audio_upload::PreparedAudio::converted_wav(wav, CHUNK_SECS) {
                return Ok(pieces);
            }
        }
    }
    crate::audio_upload::PreparedAudio::original(media_path, is_video)
}

#[cfg(test)]
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
        .ok();
    if status.is_some_and(|status| status.success()) && out.exists() {
        Some(out)
    } else {
        let _ = std::fs::remove_file(&out);
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn fillers_go_and_words_stay() {
        use super::strip_fillers;
        assert_eq!(strip_fillers("Also add, um,"), "Also add,");
        assert_eq!(strip_fillers("um so ship it, uh, today"), "So ship it, today");
        assert_eq!(strip_fillers("when this shit um, pastes"), "When this shit pastes");
        assert_eq!(strip_fillers("Hmm. Umbrella and drums stay"), "Umbrella and drums stay");
        assert_eq!(strip_fillers("um uh"), "");
        // A correction keeps its own first letter.
        assert_eq!(super::drop_fillers("um, iOS build, uh, fixed"), "iOS build, fixed");
    }

    use super::*;

    #[test]
    fn streamed_wav_bodies_match_the_buffered_reference() {
        use std::io::Read;
        let source = wav(16_000 * 5 + 7, true);
        let path = std::env::temp_dir().join(format!(
            "eavesy-stream-reference-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, &source).unwrap();
        let expected = split_wav(&source, 2).unwrap();
        let prepared = crate::audio_upload::PreparedAudio::converted_wav(path.clone(), 2).unwrap();
        let actual: Vec<Vec<u8>> = prepared
            .pieces
            .iter()
            .map(|piece| {
                let mut bytes = Vec::new();
                piece.reader().read_to_end(&mut bytes).unwrap();
                bytes
            })
            .collect();
        assert_eq!(actual, expected);
        drop(prepared);
        assert!(!path.exists());
    }

    #[test]
    fn streamed_wav_preserves_legacy_duplicate_and_truncated_chunks() {
        use std::io::Read;
        let source = wav(16_000 * 5 + 7, true);
        let mut duplicate_data = source.clone();
        duplicate_data.extend_from_slice(b"data\x04\0\0\0\x01\x02\x03\x04");
        let mut duplicate_format = source.clone();
        duplicate_format.extend_from_slice(b"fmt \x10\0\0\0");
        duplicate_format.extend_from_slice(&source[20..36]);
        let truncated = source[..source.len() - 5].to_vec();
        for source in [duplicate_data, duplicate_format, truncated] {
            let expected = split_wav(&source, 2).unwrap();
            let path = std::env::temp_dir()
                .join(format!("eavesy-stream-legacy-{}.wav", uuid::Uuid::new_v4()));
            std::fs::write(&path, source).unwrap();
            let prepared = crate::audio_upload::PreparedAudio::converted_wav(path, 2).unwrap();
            let actual: Vec<Vec<u8>> = prepared
                .pieces
                .iter()
                .map(|piece| {
                    let mut bytes = Vec::new();
                    piece.reader().read_to_end(&mut bytes).unwrap();
                    bytes
                })
                .collect();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn streamed_multipart_body_is_replayed_on_retry() {
        use std::io::Read;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use wiremock::{
            matchers::{method, path as request_path, query_param},
            Mock, ResponseTemplate,
        };
        let source = wav(16_000, true);
        let path =
            std::env::temp_dir().join(format!("eavesy-stream-retry-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&path, &source).unwrap();
        let prepared = crate::audio_upload::PreparedAudio::converted_wav(path, 240).unwrap();
        let piece = &prepared.pieces[0];
        let mut expected = Vec::new();
        piece.reader().read_to_end(&mut expected).unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed = attempts.clone();
        let (runtime, server) = mock_server();
        runtime.block_on(
            Mock::given(method("POST"))
                .and(request_path("/api/transcribe"))
                .and(query_param("voice", "1"))
                .and(query_param("heard_on_device", "0"))
                .and(move |request: &wiremock::Request| {
                    request
                        .headers
                        .get("content-length")
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.parse::<usize>().ok())
                        == Some(request.body.len())
                        && request
                            .body
                            .windows(expected.len())
                            .any(|bytes| bytes == expected)
                })
                .respond_with(move |_: &wiremock::Request| {
                    if observed.fetch_add(1, Ordering::SeqCst) == 0 {
                        ResponseTemplate::new(503)
                    } else {
                        ResponseTemplate::new(200)
                            .set_body_json(serde_json::json!({ "text": "replayed" }))
                    }
                })
                .expect(2)
                .mount(&server),
        );
        let client = reqwest::blocking::Client::new();
        let credential = credential(&server);
        let result = with_retry(&[0], || {
            transcribe_piece(&client, piece, VOICE_UNHEARD, &credential)
        });
        assert_eq!(result.unwrap(), "replayed");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

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
        let results = crate::work_queue::run(&items, 3, |item| {
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
        let result = crate::work_queue::run(&items, 2, |item| if *item == 3 { Err("HTTP 400".to_string()) } else { Ok(*item) });
        assert_eq!(result, Err("HTTP 400".to_string()));
    }

    #[test]
    fn retries_transient_failures_but_not_fatal_ones() {
        let mut calls = 0;
        let fatal = with_retry(&RETRY_DELAYS, || {
            calls += 1;
            Err(PieceError::Fatal("401".into()))
        });
        assert_eq!(fatal, Err("401".to_string()));
        assert_eq!(calls, 1);
    }

    fn mock_server() -> (tokio::runtime::Runtime, wiremock::MockServer) {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let server = runtime.block_on(wiremock::MockServer::start());
        (runtime, server)
    }

    fn credential(server: &wiremock::MockServer) -> settings::Credential {
        settings::Credential {
            base: format!("{}/", server.uri()),
            token: "device-token".into(),
        }
    }

    #[test]
    fn polish_returns_the_tidied_words() {
        use wiremock::matchers::{body_json, header, method, path};
        let (runtime, server) = mock_server();
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .and(path("/api/dictations/polish"))
                .and(header("authorization", "Bearer device-token"))
                .and(body_json(
                    serde_json::json!({ "text": "um so ship it ship it today" }),
                ))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({ "text": "So ship it today.", "polished": true }),
                ))
                .mount(&server),
        );
        let polished = polish_with(
            &credential(&server),
            "um so ship it ship it today",
            None,
            POLISH_TIMEOUT,
        );
        assert_eq!(polished, Ok("So ship it today.".to_string()));
    }

    #[test]
    fn polish_names_the_project_when_there_is_one() {
        use wiremock::matchers::{body_json, method, path};
        let (runtime, server) = mock_server();
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .and(path("/api/dictations/polish"))
                .and(body_json(serde_json::json!({ "text": "fix the build", "projectId": "proj_1" })))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({ "text": "Fix the build.", "polished": true }),
                ))
                .mount(&server),
        );
        let polished = polish_with(&credential(&server), "fix the build", Some("proj_1"), POLISH_TIMEOUT);
        assert_eq!(polished, Ok("Fix the build.".to_string()));
    }

    #[test]
    fn a_tone_change_asks_for_that_tone() {
        use wiremock::matchers::{body_json, method, path};
        let (runtime, server) = mock_server();
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .and(path("/api/dictations/polish"))
                .and(body_json(serde_json::json!({ "text": "Ship it today.", "projectId": "proj_1", "style": "friendly", "forAgents": false })))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({ "text": "Let's ship it today!", "polished": true }),
                ))
                .mount(&server),
        );
        let restyled = restyle_with(&credential(&server), "Ship it today.", Some("proj_1"), "friendly", false, RESTYLE_TIMEOUT);
        assert_eq!(restyled, Ok("Let's ship it today!".to_string()));
    }

    #[test]
    fn polish_gives_up_on_errors_empty_text_and_slow_servers() {
        use wiremock::matchers::method;
        let (runtime, server) = mock_server();
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .respond_with(wiremock::ResponseTemplate::new(429))
                .up_to_n_times(1)
                .mount(&server),
        );
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .respond_with(
                    wiremock::ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({ "text": " " })),
                )
                .up_to_n_times(1)
                .mount(&server),
        );
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .respond_with(
                    wiremock::ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({ "text": "Late." }))
                        .set_delay(std::time::Duration::from_millis(500)),
                )
                .mount(&server),
        );
        let credential = credential(&server);
        let short = std::time::Duration::from_millis(100);
        assert!(polish_with(&credential, "words", None, short)
            .unwrap_err()
            .contains("429"));
        assert_eq!(
            polish_with(&credential, "words", None, short),
            Err("empty polish".to_string())
        );
        assert!(polish_with(&credential, "words", None, short).is_err());
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct WalkthroughTranscription {
    pub text: String,
    #[serde(rename = "rawText")]
    pub raw_text: Option<String>,
    #[serde(default)]
    pub segments: Vec<crate::walkthrough::Segment>,
    #[serde(default, rename = "timestampSource")]
    pub timestamp_source: Option<String>,
}

/// Each walkthrough chunk is bounded to two minutes. Preserve the provider's
/// timing instead of flattening it through the dictation/meeting text path.
pub(crate) fn run_walkthrough(
    app: &AppHandle,
    media: &Path,
) -> Result<WalkthroughTranscription, String> {
    let credential =
        settings::device_credential(app).ok_or("Sign in to transcribe this walkthrough")?;
    let wav = transcode_to_wav(media).ok_or("Could not decode walkthrough audio")?;
    if std::fs::metadata(&wav).map_err(|e| e.to_string())?.len() > 8_000_000 {
        let _ = std::fs::remove_file(&wav);
        return Err("Walkthrough audio chunk is too large".into());
    }
    let bytes = std::fs::read(&wav).map_err(|e| e.to_string());
    let _ = std::fs::remove_file(&wav);
    let bytes = bytes?;
    if bytes.len() > 8_000_000 {
        return Err("Walkthrough audio chunk is too large".into());
    }
    let part = reqwest::blocking::multipart::Part::bytes(bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!(
            "{}/api/transcribe",
            credential.base.trim_end_matches('/')
        ))
        .bearer_auth(&credential.token)
        .multipart(reqwest::blocking::multipart::Form::new().part("audio", part))
        .send()
        .map_err(|e| format!("Transcription request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Transcription HTTP {}", response.status()));
    }
    response
        .json()
        .map_err(|e| format!("Invalid transcription response: {e}"))
}
