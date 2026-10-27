use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::settings;

/// One client for every dictation request, so each one reuses a warm
/// connection instead of paying for a TLS handshake inside its time budget.
/// No client-wide timeout: every request sets its own. Only ever used from
/// plain threads or `spawn_blocking`.
static HTTP: std::sync::LazyLock<reqwest::blocking::Client> = std::sync::LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(None)
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new())
});

/// The longest a dictation waits for Whisper's words once its clip is saved.
/// Sealing the clip can take up to 30s of the HUD's 60s before it gives up
/// on "Writing it down…": words that came later would paste into whatever
/// has the keyboard by then, with nothing on screen to say why.
const PASTE_BUDGET: Duration = Duration::from_secs(20);

/// Transcribes a dictation clip for its paste only. The recording uploads
/// separately and its cloud transcript is what gets stored (and shown in
/// History). The paste waits at most `PASTE_BUDGET`; if it fails or runs out
/// of time the dictation is disarmed, so nothing pastes later, and the HUD
/// says it was saved instead. `heard_on_device` is false when the Mac's
/// recognizer ran over the whole clip and heard no words, so the server
/// keeps out the stock phrases Whisper invents for silence.
pub fn paste_with_whisper(app: AppHandle, id: String, audio: PathBuf, heard_on_device: bool) {
    std::thread::spawn(move || {
        let Some(credential) = settings::device_credential(&app) else {
            no_paste(&app, &id, "Saved. Sign in to have it typed for you");
            return;
        };
        let query = if heard_on_device { VOICE } else { VOICE_UNHEARD };
        let deadline = Instant::now() + PASTE_BUDGET;
        let (sender, receiver) = std::sync::mpsc::channel();
        // On its own thread, so a result that comes too late has nowhere to go.
        std::thread::spawn(move || {
            let _ = sender.send(run(&audio, false, query, &credential, &PASTE_RETRY_DELAYS, deadline));
        });
        match receiver.recv_timeout(PASTE_BUDGET) {
            Ok(Ok(text)) => crate::dictation::deliver_dictation(&app, &id, &text),
            Ok(Err(error)) => {
                crate::telemetry::capture("dictation.whisper_paste", &error);
                crate::dictation::disarm(&id);
                no_paste(&app, &id, "Saved. The words will be in History");
            }
            Err(_) => {
                crate::telemetry::capture("dictation.whisper_paste", "timed out");
                crate::dictation::disarm(&id);
                no_paste(&app, &id, "Saved, not typed: it took too long. The words will be in History");
            }
        }
    });
}

/// How long a paste waits for the tidied words before it types them as
/// heard. At 1.8s half of all dictations ran out and went out with their
/// "like"s and misheard words in, so a short one gets 4s and a long one,
/// which the model takes longer to write out, a little more.
fn polish_timeout(text: &str) -> std::time::Duration {
    std::time::Duration::from_millis((4_000 + text.chars().count() as u64 * 2).min(8_000))
}

/// A dictation's words as the user would have typed them: fillers, stutters
/// and false starts gone, punctuated, their own words spelled their way. The
/// words as heard when the Mac isn't signed in or the server can't help in time.
/// `project` picks that project's tone and words over the account's.
pub fn polish_dictation(app: &AppHandle, text: &str, project: Option<&str>) -> Polished {
    let Some(credential) = settings::device_credential(app) else {
        return Polished { text: strip_fillers(text), written: None };
    };
    let started = std::time::Instant::now();
    let result = polish_with(&credential, text, project, polish_timeout(text));
    let polish_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(polished) => {
            tracing::info!(polish_ms, "dictation polished");
            polished
        }
        Err(error) => {
            tracing::warn!(polish_ms, "dictation: typing the words as heard, fillers dropped ({error})");
            Polished { text: strip_fillers(text), written: None }
        }
    }
}

/// A dictation's words as they go out, and the tone they are in when the
/// server said (it didn't when the Mac typed them as heard).
#[derive(Debug, PartialEq)]
pub struct Polished {
    pub text: String,
    pub written: Option<Written>,
}

/// The tone in force for a dictation's words, as the server tells it: the
/// style, whether as a prompt for an AI, the project when that tone is the
/// project's own rather than the account's, and whether the model applied
/// it (when not, the words went out plain). The HUD's tone row shows it and
/// changes it.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub style: String,
    pub for_agents: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub applied: bool,
}

/// The model-free part of tidying, as the server does it: "um", "uh", "hmm"
/// and the like go, with the comma after them, and so do "like", "you know"
/// and "I mean" where commas set them apart as filler; spacing is tidied.
/// Never changes a word the user meant, so it is safe on their own
/// corrections too.
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
    // "like", "you know" or "I mean" opening the text or a clause and closed
    // by a comma or the sentence's end. "I like, um, apples" and "as you
    // know, it" are not this, and nor is "like, five" (about five).
    static DISCOURSE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(^|[,.;:!?])\s*(like|you know|i mean)(,|[.?!]|$)(\s*)(\S)?").unwrap()
    });
    // Neighbouring fillers share a separator, so one pass can miss the next.
    let mut out = text.to_string();
    loop {
        let next = FILLER.replace_all(&out, "$1$2");
        let next = DISCOURSE.replace_all(&next, |caps: &regex::Captures| {
            let before = &caps[1];
            let after = caps.get(5).map_or("", |m| m.as_str());
            if caps[2].eq_ignore_ascii_case("like") && after.starts_with(|c: char| c.is_ascii_digit()) {
                return caps[0].to_string();
            }
            let end = if &caps[3] == "," { "" } else { &caps[3] };
            let space = if after.is_empty() || before.is_empty() { "" } else { " " };
            // Dropped from the start of a sentence: the next word starts it.
            let after = if end.is_empty() && matches!(before, "." | "!" | "?") { after.to_uppercase() } else { after.to_string() };
            format!("{before}{end}{space}{after}")
        }).into_owned();
        if next == out { break; }
        out = next;
    }
    let out = SPACE_BEFORE_PUNCT.replace_all(&out, "$1");
    let out = DOUBLED_PUNCT.replace_all(&out, "$2");
    let out = SPACES.replace_all(&out, " ");
    out.trim_start_matches(|c: char| c.is_whitespace() || ",.;:".contains(c)).trim_end().to_string()
}

/// How long a tone change waits for its rewrite: asked for, and watched, but
/// a long dictation takes the model a while to write out again.
fn restyle_timeout(text: &str) -> std::time::Duration {
    std::time::Duration::from_secs((12 + text.chars().count() as u64 / 400).min(60))
}

/// A dictation's words rewritten in `style` ("professional", "friendly",
/// "concise" or "natural"), as a prompt for an AI agent with `for_agents`:
/// the HUD's tone buttons. Saved settings are left as they are.
pub fn restyle_dictation(app: &AppHandle, text: &str, project: Option<&str>, style: &str, for_agents: bool) -> Result<String, String> {
    let credential = settings::device_credential(app).ok_or("Sign in to change the tone")?;
    restyle_with(&credential, text, project, style, for_agents, restyle_timeout(text))
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
    let reply = post_polish(credential, &body, timeout)?;
    // The plain cleanup came back instead: saying "Updated" would be a lie.
    match (reply.polished, reply.reason.as_deref()) {
        (true, _) => Ok(reply.text),
        (false, Some("too_long")) => Err("Too long to rewrite here".into()),
        (false, _) => Err("Couldn't rewrite it in that tone".into()),
    }
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
) -> Result<Polished, String> {
    post_polish(credential, &polish_body(text, project), timeout).map(|reply| Polished { text: reply.text, written: reply.written })
}

#[derive(serde::Deserialize)]
struct PolishReply {
    text: String,
    /// False when the server fell back to the model-free cleanup.
    #[serde(default = "yes")]
    polished: bool,
    /// Why it fell back, when it says ("too_long").
    #[serde(default)]
    reason: Option<String>,
    /// The tone the words are in, from servers that say.
    #[serde(default)]
    written: Option<Written>,
}

fn yes() -> bool {
    true
}

fn post_polish(credential: &settings::Credential, body: &serde_json::Value, timeout: std::time::Duration) -> Result<PolishReply, String> {
    let resp = HTTP
        .post(format!(
            "{}/api/dictations/polish",
            credential.base.trim_end_matches('/')
        ))
        .timeout(timeout)
        .bearer_auth(&credential.token)
        .json(body)
        .send()
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("polish HTTP {}", resp.status()));
    }
    let reply = resp.json::<PolishReply>().map_err(|e| format!("bad response: {e}"))?;
    if reply.text.trim().is_empty() {
        return Err("empty polish".to_string());
    }
    Ok(reply)
}

/// A dictation whose words could not be had in time: say it is saved, so
/// "Writing it down…" doesn't hang.
fn no_paste(app: &AppHandle, id: &str, notice: &str) {
    crate::hud::advance_from(
        app,
        id,
        &[crate::hud::Phase::Transcribing],
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

const CHUNK_SECS: usize = 4 * 60;
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
/// Every request, and every retry, ends by `deadline`.
fn run(
    media_path: &Path,
    is_video: bool,
    query: &str,
    credential: &settings::Credential,
    delays: &[u64],
    deadline: Instant,
) -> Result<String, String> {
    let pieces = prepare(media_path, is_video)?;
    let texts = crate::work_queue::run(&pieces.pieces, PIECES_AT_ONCE, |piece| {
        with_retry(delays, deadline, || transcribe_piece(&HTTP, piece, query, credential, deadline))
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

/// Tries `attempt`, again after each of `delays` while it fails in a way
/// worth retrying, but never retries past `deadline`.
fn with_retry(
    delays: &[u64],
    deadline: Instant,
    mut attempt: impl FnMut() -> Result<String, PieceError>,
) -> Result<String, String> {
    for delay in delays.iter().map(Some).chain(std::iter::once(None)) {
        match attempt() {
            Ok(text) => return Ok(text),
            Err(PieceError::Fatal(e)) => return Err(e),
            Err(PieceError::Retry(e)) => match delay.map(|secs| Duration::from_secs(*secs)) {
                Some(wait) if Instant::now() + wait < deadline => std::thread::sleep(wait),
                _ => return Err(e),
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
    deadline: Instant,
) -> Result<String, PieceError> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(PieceError::Fatal("out of time".to_string()));
    }
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
        .timeout(left)
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

    #[test]
    fn spoken_filler_goes_where_commas_set_it_apart() {
        use super::strip_fillers;
        assert_eq!(strip_fillers("And, like, for example, but, like, yeah"), "And, for example, but, yeah");
        assert_eq!(strip_fillers("Like, you know, it works."), "It works.");
        assert_eq!(strip_fillers("It was huge, you know."), "It was huge.");
        assert_eq!(strip_fillers("Ship it. I mean, today."), "Ship it. Today.");
        assert_eq!(strip_fillers("So, like, you know, the build"), "So, the build");
        // Meant words stay.
        assert_eq!(strip_fillers("I like, um, apples"), "I like, apples");
        assert_eq!(strip_fillers("As you know, it broke"), "As you know, it broke");
        assert_eq!(strip_fillers("It costs, like, 5 dollars"), "It costs, like, 5 dollars");
        assert_eq!(strip_fillers("What I mean, is this"), "What I mean, is this");
        assert_eq!(strip_fillers("Looks like rain"), "Looks like rain");
    }

    #[test]
    fn a_longer_dictation_waits_longer_for_its_polish() {
        assert_eq!(super::polish_timeout("ship it"), std::time::Duration::from_millis(4_014));
        assert_eq!(super::polish_timeout(&"word ".repeat(400)), std::time::Duration::from_millis(8_000));
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
        let deadline = Instant::now() + Duration::from_secs(30);
        let result = with_retry(&[0], deadline, || {
            transcribe_piece(&client, piece, VOICE_UNHEARD, &credential, deadline)
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
        let later = Instant::now() + Duration::from_secs(60);
        let fatal = with_retry(&PASTE_RETRY_DELAYS, later, || {
            calls += 1;
            Err(PieceError::Fatal("401".into()))
        });
        assert_eq!(fatal, Err("401".to_string()));
        assert_eq!(calls, 1);
        let mut calls = 0;
        let transient = with_retry(&[0], later, || {
            calls += 1;
            if calls == 1 { Err(PieceError::Retry("503".into())) } else { Ok("words".into()) }
        });
        assert_eq!(transient, Ok("words".to_string()));
    }

    #[test]
    fn a_paste_never_retries_past_its_deadline() {
        let mut calls = 0;
        let started = Instant::now();
        let result = with_retry(&PASTE_RETRY_DELAYS, started + Duration::from_millis(500), || {
            calls += 1;
            Err(PieceError::Retry("503".into()))
        });
        assert_eq!(result, Err("503".to_string()));
        assert_eq!(calls, 1, "a 2s wait does not fit in what is left");
        assert!(started.elapsed() < Duration::from_secs(1));
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
            polish_timeout("um so ship it ship it today"),
        );
        assert_eq!(polished.map(|polished| polished.text), Ok("So ship it today.".to_string()));
    }

    #[test]
    fn polish_says_which_tone_the_words_are_in() {
        use wiremock::matchers::{method, path};
        let (runtime, server) = mock_server();
        runtime.block_on(
            wiremock::Mock::given(method("POST"))
                .and(path("/api/dictations/polish"))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "text": "Ship it today.", "polished": true,
                    "written": { "style": "concise", "forAgents": true, "projectId": "proj_1", "applied": true }
                })))
                .mount(&server),
        );
        let polished = polish_with(&credential(&server), "um ship it today", Some("proj_1"), polish_timeout("")).unwrap();
        assert_eq!(polished.text, "Ship it today.");
        assert_eq!(polished.written, Some(Written { style: "concise".into(), for_agents: true, project_id: Some("proj_1".into()), applied: true }));
        // Sent on to the HUD as the server spelled it, and without a project when there is none.
        let written = Written { style: "natural".into(), for_agents: false, project_id: None, applied: false };
        assert_eq!(serde_json::to_value(written).unwrap(), serde_json::json!({ "style": "natural", "forAgents": false, "applied": false }));
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
        let polished = polish_with(&credential(&server), "fix the build", Some("proj_1"), polish_timeout(""));
        assert_eq!(polished.map(|polished| polished.text), Ok("Fix the build.".to_string()));
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
        let restyled = restyle_with(&credential(&server), "Ship it today.", Some("proj_1"), "friendly", false, restyle_timeout("Ship it today."));
        assert_eq!(restyled, Ok("Let's ship it today!".to_string()));
    }

    #[test]
    fn a_tone_change_the_server_could_not_make_is_an_error_not_an_update() {
        use wiremock::matchers::{body_partial_json, method, path};
        let (runtime, server) = mock_server();
        runtime.block_on(async {
            wiremock::Mock::given(method("POST"))
                .and(path("/api/dictations/polish"))
                .and(body_partial_json(serde_json::json!({ "style": "concise" })))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({ "text": "Long words.", "polished": false, "reason": "too_long" }),
                ))
                .mount(&server)
                .await;
            wiremock::Mock::given(method("POST"))
                .and(path("/api/dictations/polish"))
                .and(body_partial_json(serde_json::json!({ "style": "friendly" })))
                .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(
                    serde_json::json!({ "text": "Ship it today.", "polished": false }),
                ))
                .mount(&server)
                .await;
        });
        let credential = credential(&server);
        assert_eq!(restyle_with(&credential, "Long words.", None, "concise", false, polish_timeout("")), Err("Too long to rewrite here".into()));
        assert_eq!(restyle_with(&credential, "Ship it today.", None, "friendly", false, polish_timeout("")), Err("Couldn't rewrite it in that tone".into()));
    }

    #[test]
    fn a_long_dictation_gets_longer_to_rewrite() {
        assert_eq!(restyle_timeout("short"), std::time::Duration::from_secs(12));
        assert_eq!(restyle_timeout(&"word ".repeat(2000)), std::time::Duration::from_secs(37));
        assert_eq!(restyle_timeout(&"word ".repeat(40_000)), std::time::Duration::from_secs(60));
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
