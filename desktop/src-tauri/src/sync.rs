use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::time::sleep;

use crate::{fs_writer, settings, sqlite};

const DEFAULT_BASE: &str = "https://eavesy.com";
const PART_SIZE: usize = 8 * 1024 * 1024;

pub(crate) fn api_base() -> String {
    #[cfg(debug_assertions)]
    if let Ok(base) = std::env::var("EAVESY_API_BASE") {
        return base.trim_end_matches('/').to_string();
    }
    DEFAULT_BASE.to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    meeting_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartResponse {
    next_part_number: Option<i64>,
}

#[derive(Deserialize)]
struct ResultSegment {
    #[serde(rename = "startMs")]
    start_ms: i64,
    text: String,
    #[serde(default)]
    speaker: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultSummary {
    tldr: String,
    decisions_json: String,
    action_items_json: String,
    follow_ups_json: String,
    open_questions_json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultResponse {
    status: String,
    title: String,
    transcript: Vec<ResultSegment>,
    summary: Option<ResultSummary>,
    summary_override_md: Option<String>,
    transcript_override_md: Option<String>,
    #[serde(default)]
    notes_md: String,
}

const POLL_INTERVAL_MS: i64 = 10_000;
const ERROR_BACKOFF_MS: i64 = 15_000;
/// Retry interval while the server does not support segments-only finalize yet.
const SEGMENTS_ONLY_RETRY_MS: i64 = 10 * 60 * 1_000;

#[derive(Debug)]
struct Permanent(String);
impl std::fmt::Display for Permanent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Permanent {}

/// The server rejected the device credential. Nothing is counted against the
/// upload: sync pauses until the user signs in again.
#[derive(Debug)]
struct Unauthorized(String);
impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Unauthorized {}

fn is_unauthorized(error: &anyhow::Error) -> bool {
    error.downcast_ref::<Unauthorized>().is_some()
}

/// How long a rejected credential is left alone before sync probes it again.
const SIGNED_OUT_RETRY: Duration = Duration::from_secs(5 * 60);

static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Ends the sync loop's current pause early: call when new work was queued (a
/// segment was sealed, a capture stopped, the device was paired).
pub fn wake() {
    WAKE.notify_one();
}

/// Sleeps for `duration` or until `wake` is called, whichever comes first.
async fn idle(duration: Duration) {
    tokio::select! {
        () = sleep(duration) => {}
        () = WAKE.notified() => {}
    }
}

static SIGNED_OUT: AtomicBool = AtomicBool::new(false);

/// True while uploads are paused because the server rejected this Mac's credential.
pub fn signed_out() -> bool {
    SIGNED_OUT.load(Ordering::SeqCst)
}

fn set_signed_out<R: Runtime>(app: &AppHandle<R>, signed_out: bool) {
    if SIGNED_OUT.swap(signed_out, Ordering::SeqCst) == signed_out {
        return;
    }
    if let Err(error) = app.emit("sync:status", serde_json::json!({ "signedOut": signed_out })) {
        eprintln!("desktop ingest: could not announce sign-in state: {error}");
    }
    if !signed_out {
        return;
    }
    crate::telemetry::capture("recording upload paused", "device credential rejected");
    if let Some(app) = crate::ui::wry(app) {
        let message = "Eavesy is signed out. Recordings are kept on this Mac and will upload after you reconnect your account.";
        if crate::hud::current().phase != crate::hud::Phase::Recording {
            crate::hud::set_state(app, crate::hud::HudState {
                phase: crate::hud::Phase::Failed,
                session_id: None,
                mode: None,
                started_at_ms: None,
                message: Some(message.to_string()),
            });
        }
        use tauri_plugin_notification::NotificationExt;
        if let Err(error) = app.notification().builder().title("Sign in to keep syncing").body(message).show() {
            eprintln!("desktop ingest: could not show sign-in notice: {error}");
        }
    }
}

fn is_permanent(error: &anyhow::Error) -> bool {
    error.downcast_ref::<Permanent>().is_some()
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
}

/// Where and how the sync loop talks to the server.
pub(crate) struct Api {
    client: Client,
    base: String,
}

impl Api {
    pub(crate) fn new(base: String) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .build()
            .context("build ingest HTTP client")?;
        Ok(Self { client, base })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

/// What one pass of the sync loop did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Pass {
    /// Nothing was due.
    Idle,
    /// Work was done or attempted; run again soon.
    Busy,
    /// The server rejected the device credential.
    SignedOut,
}

/// How often captures whose recovery was deferred are tried again.
const RECOVERY_RETRY: Duration = Duration::from_secs(5 * 60);

pub async fn run(app: AppHandle) -> Result<()> {
    let api = Api::new(api_base())?;
    let mut rejected: Option<(String, Instant)> = None;
    let mut recovery_retried = Instant::now();

    loop {
        if recovery_retried.elapsed() >= RECOVERY_RETRY {
            recovery_retried = Instant::now();
            let app = app.clone();
            if let Err(error) = tokio::task::spawn_blocking(move || crate::recovery::retry_deferred(&app)).await {
                eprintln!("desktop ingest: deferred recovery stopped: {error}");
            }
        }
        let Some(token) = settings::device_token(&app) else {
            idle(Duration::from_secs(5)).await;
            continue;
        };
        if let Some((rejected_token, since)) = &rejected {
            if *rejected_token == token && since.elapsed() < SIGNED_OUT_RETRY {
                idle(Duration::from_secs(5)).await;
                continue;
            }
        }
        match pass(&app, &api, &token).await {
            Pass::SignedOut => {
                set_signed_out(&app, true);
                rejected = Some((token, Instant::now()));
            }
            outcome => {
                if rejected.take().is_some() {
                    set_signed_out(&app, false);
                }
                if outcome == Pass::Idle {
                    idle(Duration::from_secs(2)).await;
                } else {
                    sleep(Duration::from_millis(250)).await;
                }
            }
        }
    }
}

/// One turn of the loop: an external file edit, else one step of the most urgent
/// recording session. Every state change it makes is persisted before it returns.
pub(crate) async fn pass<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str) -> Pass {
    match sync_file_edit(app, api, token).await {
        Ok(true) => return Pass::Busy,
        Ok(false) => {}
        Err(error) if is_unauthorized(&error) => return Pass::SignedOut,
        Err(error) => eprintln!("desktop file edit sync: {error:#}"),
    }
    let next = {
        let app = app.clone();
        blocking(move || sqlite::next_session(&app)).await
    };
    let session = match next {
        Ok(Some(session)) => session,
        Ok(None) => return Pass::Idle,
        Err(error) => {
            eprintln!("desktop ingest: {error}");
            return Pass::Idle;
        }
    };

    let outcome = sync_session(app, api, token, session.clone()).await;
    let recorded = match outcome {
        Ok(Step::Progressed) => Ok(()),
        Ok(Step::Waiting) => sqlite::defer_session(app, &session.id, POLL_INTERVAL_MS, None),
        Err(error) if is_unauthorized(&error) => return Pass::SignedOut,
        Err(error) if is_permanent(&error) => {
            eprintln!("desktop ingest: giving up on {}: {error:#}", session.id);
            crate::telemetry::capture("recording upload gave up", &format!("{error:#}"));
            sqlite::mark_session_failed(app, &session.id, &format!("{error:#}"))
                .and_then(|()| crate::store::set_status(app, &session.id, "transcript_failed"))
                .map(|()| {
                    if let Err(error) = app.emit("recordings:updated", ()) {
                        eprintln!("desktop ingest: could not announce failed upload: {error}");
                    }
                })
        }
        Err(error) => {
            eprintln!("desktop ingest paused for {}: {error:#}", session.id);
            sqlite::defer_session(app, &session.id, ERROR_BACKOFF_MS, Some(&format!("{error:#}")))
        }
    };
    if let Err(error) = recorded {
        // The session stays where it was and is retried; say so instead of hiding it.
        eprintln!("desktop ingest: could not record the outcome for {}: {error}", session.id);
        crate::telemetry::capture("recording sync state not saved", &error);
        return Pass::Idle;
    }
    Pass::Busy
}

async fn sync_file_edit<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str) -> Result<bool> {
    if let Some(edit) = sqlite::next_file_edit(app).map_err(|error| anyhow!(error))? {
        if let Some(remote_id) = sqlite::remote_meeting_id(app, &edit.local_session_id)
            .map_err(|error| anyhow!(error))?
        {
            let result = upload_file_edit(api, token, &remote_id, &edit).await;
            match result {
                Ok(()) => sqlite::mark_operation_done(app, &edit.operation_id)
                    .map_err(|error| anyhow!(error))?,
                Err(error) => {
                    sqlite::mark_operation_failed(app, &edit.operation_id, &error.to_string())
                        .map_err(|db_error| anyhow!(db_error))?;
                    return Err(error);
                }
            }
            return Ok(true);
        }
    }

    Ok(false)
}

enum Step { Progressed, Waiting }

async fn sync_session<R: Runtime>(
    app: &AppHandle<R>,
    api: &Api,
    token: &str,
    mut session: sqlite::PendingSession,
) -> Result<Step> {
    if session.remote_meeting_id.is_none() {
        let response = api
            .client
            .post(api.url("/api/sessions"))
            .bearer_auth(token)
            .json(&serde_json::json!({
                "clientSessionId": session.id,
                "title": session.title,
                "language": "en",
                "contextBlurb": session.context_blurb.as_deref().unwrap_or(""),
            }))
            .send()
            .await
            .context("create cloud recording session")?;
        if !response.status().is_success() {
            return Err(http_error("create cloud recording session", response).await);
        }
        let body: SessionResponse = response.json().await.context("decode session response")?;
        sqlite::attach_remote(app, &session.id, &body.meeting_id).map_err(|e| anyhow!(e))?;
        session.remote_meeting_id = Some(body.meeting_id);
    }
    let remote_id = session
        .remote_meeting_id
        .clone()
        .ok_or_else(|| anyhow!("cloud session id missing after creation"))?;

    if session.status == "processing" {
        let ended = session.ended_at.unwrap_or(0);
        if ended > 0 && chrono::Utc::now().timestamp_millis() - ended > sqlite::PROCESSING_GIVE_UP_MS {
            return Err(anyhow!(Permanent(
                "the transcript was not ready a day after the recording ended".to_string()
            )));
        }
        poll_result(app, api, token, &remote_id, &session).await?;
        return Ok(Step::Waiting);
    }

    if let Some(segment) = sqlite::next_segment(app, &session.id).map_err(|e| anyhow!(e))? {
        match upload_segment(api, token, &remote_id, &segment).await {
            Ok(()) => sqlite::mark_segment_uploaded(app, &segment).map_err(|e| anyhow!(e))?,
            Err(error) if is_permanent(&error) => {
                eprintln!("desktop ingest: skipping segment {}: {error:#}", segment.idx);
                crate::telemetry::capture("segment upload gave up", &format!("{error:#}"));
                sqlite::give_up_segment(app, &segment, &format!("{error:#}"))
                    .map_err(|e| anyhow!(e))?;
            }
            Err(error) if is_unauthorized(&error) => return Err(error),
            Err(error) => {
                sqlite::mark_segment_failed(app, &segment, &format!("{error:#}"))
                    .map_err(|e| anyhow!(e))?;
                return Err(error);
            }
        }
        return Ok(Step::Progressed);
    }

    if session.status == "recording" {
        poll_result(app, api, token, &remote_id, &session).await?;
        return Ok(Step::Waiting);
    }
    if !sqlite::all_segments_uploaded(app, &session.id).map_err(|e| anyhow!(e))? {
        return Ok(Step::Waiting);
    }

    if !session.archive_missing && !crate::recovery::archive_is_playable(&session.archive_path) {
        eprintln!(
            "desktop ingest: archive for {} is missing or unfinished; finishing from segments",
            session.id
        );
        sqlite::mark_archive_missing(app, &session.id).map_err(|e| anyhow!(e))?;
        session.archive_missing = true;
    }
    if session.archive_missing {
        finalize_from_segments(app, api, token, &remote_id, &session).await?;
    } else {
        upload_archive(app, api, token, &remote_id, &session).await?;
    }
    Ok(Step::Progressed)
}

async fn poll_result<R: Runtime>(
    app: &AppHandle<R>,
    api: &Api,
    token: &str,
    remote_id: &str,
    session: &sqlite::PendingSession,
) -> Result<()> {
    let response = api
        .client
        .get(api.url(&format!("/api/sessions/{remote_id}/result")))
        .bearer_auth(token)
        .send()
        .await
        .context("refresh local transcript")?;
    if !response.status().is_success() {
        return Err(http_error("refresh local transcript", response).await);
    }
    let result: ResultResponse = response.json().await.context("decode transcript result")?;
    let transcript = result
        .transcript_override_md
        .clone()
        .unwrap_or_else(|| render_transcript(&result.title, &result.transcript));
    let summary = result
        .summary_override_md
        .clone()
        .or_else(|| result.summary.as_ref().map(render_summary));
    let status = match result.status.as_str() {
        "complete" => "complete",
        "failed" => "transcript_failed",
        _ => "processing",
    };
    // The registry and the recording folder are plain file IO: keep it off the
    // async runtime, and skip it entirely when the poll brought nothing new.
    let changed = blocking({
        let app = app.clone();
        let id = session.id.clone();
        let folder = session.archive_path.parent().map(std::path::PathBuf::from);
        let remote_id = remote_id.to_string();
        let title = result.title.clone();
        let transcript = transcript.clone();
        let notes = result.notes_md.clone();
        move || -> Result<bool, String> {
            let Some((recording, changed)) =
                crate::store::set_result(&app, &id, &title, transcript, summary, Some(notes), status)?
            else {
                return Ok(false);
            };
            // The poll that completes the session always writes the folder, so a
            // write that failed on an earlier poll is not skipped forever.
            if !changed && status != "complete" {
                return Ok(false);
            }
            if let Some(folder) = folder {
                fs_writer::persist_recording_artifacts(
                    Some(&app),
                    &folder,
                    &recording,
                    Some(&remote_id),
                    recording.notes.as_deref(),
                )?;
            }
            Ok(changed)
        }
    })
    .await?;
    if changed {
        if let Err(error) = app.emit("recordings:updated", ()) {
            eprintln!("desktop ingest: could not announce refreshed transcript: {error}");
        }
    }
    if result.status == "complete" {
        if let Some(app) = crate::ui::wry(app) {
            crate::dictation::deliver(app, &session.id, &transcript);
            let current = crate::hud::current();
            if current.session_id.as_deref() == Some(session.id.as_str()) && current.phase != crate::hud::Phase::Recording {
                crate::hud::set_state(app, crate::hud::HudState { phase: crate::hud::Phase::Done, session_id: Some(session.id.clone()), mode: None, started_at_ms: None, message: Some(transcript) });
            }
        }
        sqlite::mark_complete(app, &session.id).map_err(|e| anyhow!(e))?;
    } else if result.status == "failed" {
        return Err(anyhow!(Permanent("the cloud could not process this recording".to_string())));
    }
    Ok(())
}

async fn upload_file_edit(
    api: &Api,
    token: &str,
    remote_id: &str,
    edit: &sqlite::PendingFileEdit,
) -> Result<()> {
    let response = api
        .client
        .patch(api.url(&format!("/api/sessions/{remote_id}/files")))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "role": edit.role,
            "contentMd": edit.content_md,
            "contentHash": edit.content_hash,
        }))
        .send()
        .await
        .context("sync external recording-file edit")?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(http_error("sync external recording-file edit", response).await)
    }
}

/// Runs blocking file or database work on tokio's blocking pool.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .context("local sync work stopped")?
        .map_err(|error| anyhow!(error))
}

fn render_transcript(title: &str, segments: &[ResultSegment]) -> String {
    let mut output = format!("# {title}\n\n## Transcript\n\n");
    let mut previous: Option<&str> = None;
    for segment in segments {
        match segment.speaker.as_deref() {
            Some(speaker) if previous != Some(speaker) => output.push_str(&format!(
                "**[{}] {}:** {}\n\n",
                timestamp(segment.start_ms),
                speaker,
                segment.text.trim()
            )),
            Some(_) => {
                if output.ends_with("\n\n") {
                    output.truncate(output.len() - 2);
                }
                output.push_str(&format!(" {}\n\n", segment.text.trim()));
            }
            None => output.push_str(&format!("[{}] {}\n\n", timestamp(segment.start_ms), segment.text.trim())),
        }
        previous = segment.speaker.as_deref();
    }
    output
}

fn render_summary(summary: &ResultSummary) -> String {
    let mut output = format!("# Summary\n\n{}\n", summary.tldr.trim());
    append_json_items(&mut output, "Decisions", &summary.decisions_json);
    append_json_items(&mut output, "Action items", &summary.action_items_json);
    append_json_items(&mut output, "Follow-ups", &summary.follow_ups_json);
    append_json_items(&mut output, "Open questions", &summary.open_questions_json);
    output
}

fn append_json_items(output: &mut String, heading: &str, raw: &str) {
    let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else { return };
    let texts = items
        .iter()
        .filter_map(|item| item.get("text").and_then(serde_json::Value::as_str))
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>();
    if texts.is_empty() { return; }
    output.push_str(&format!("\n## {heading}\n\n"));
    for text in texts { output.push_str(&format!("- {}\n", text.trim())); }
}

fn timestamp(ms: i64) -> String {
    let total = ms.max(0) / 1_000;
    format!("{:02}:{:02}:{:02}", total / 3_600, (total / 60) % 60, total % 60)
}

async fn upload_segment(
    api: &Api,
    token: &str,
    remote_id: &str,
    segment: &sqlite::PendingSegment,
) -> Result<()> {
    let bytes = tokio::fs::read(&segment.file_path)
        .await
        .with_context(|| format!("read segment {}", segment.file_path.display()))?;
    let request = api
        .client
        .put(api.url(&format!("/api/sessions/{remote_id}/segments/{}", segment.idx)))
        .bearer_auth(token)
        .header("content-type", "audio/mp4")
        .header("x-segment-start-ms", segment.start_ms)
        .header("x-segment-duration-ms", segment.duration_ms)
        .header("x-segment-track", &segment.track)
        .body(bytes);
    let request = match segment.active_ms {
        Some(active_ms) => request.header("x-segment-active-ms", active_ms),
        None => request,
    };
    let response = request
        .send()
        .await
        .with_context(|| format!("upload transcript segment {} ({})", segment.idx, segment.track))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(http_error("upload transcript segment", response).await)
    }
}

async fn finalize_from_segments<R: Runtime>(
    app: &AppHandle<R>,
    api: &Api,
    token: &str,
    remote_id: &str,
    session: &sqlite::PendingSession,
) -> Result<()> {
    if sqlite::uploaded_segment_count(app, &session.id).map_err(|e| anyhow!(e))? == 0 {
        return Err(anyhow!(Permanent(
            "the audio file could not be saved and no part of the recording reached the cloud".to_string()
        )));
    }
    let response = api
        .client
        .post(api.url(&format!("/api/sessions/{remote_id}/finalize?archive=none")))
        .bearer_auth(token)
        .send()
        .await
        .context("finish recording from its segments")?;
    if response.status() == StatusCode::BAD_REQUEST {
        // A server from before segments-only finalize rejects the empty body. That
        // is not this recording's fault: wait for the server to be updated rather
        // than failing it, so the desktop and server can ship in either order.
        let error = http_error("finish recording from its segments", response).await;
        eprintln!("desktop ingest: server cannot finish {} from segments yet: {error:#}", session.id);
        sqlite::defer_session(app, &session.id, SEGMENTS_ONLY_RETRY_MS, Some(&format!("{error:#}")))
            .map_err(|e| anyhow!(e))?;
        return Ok(());
    }
    if !response.status().is_success() {
        return Err(http_error("finish recording from its segments", response).await);
    }
    sqlite::mark_processing(app, &session.id).map_err(|e| anyhow!(e))?;
    Ok(())
}

async fn upload_archive<R: Runtime>(
    app: &AppHandle<R>,
    api: &Api,
    token: &str,
    remote_id: &str,
    session: &sqlite::PendingSession,
) -> Result<()> {
    let file_len = tokio::fs::metadata(&session.archive_path)
        .await
        .with_context(|| format!("stat archive {}", session.archive_path.display()))?
        .len() as i64;
    let offset = session.next_archive_offset;
    if offset < 0 || offset >= file_len {
        return Err(anyhow!("archive resume offset {offset} is invalid for {file_len} bytes"));
    }
    let remaining = file_len - offset;

    if remaining > PART_SIZE as i64 {
        let bytes = read_range(&session.archive_path, offset, PART_SIZE).await?;
        let response = api
            .client
            .put(api.url(&format!("/api/sessions/{remote_id}/parts/{}", session.next_part_number)))
            .bearer_auth(token)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .context("upload archive part")?;
        if response.status() == StatusCode::CONFLICT {
            let body: serde_json::Value = response.json().await.unwrap_or_default();
            if let Some(next) = body.get("nextPartNumber").and_then(serde_json::Value::as_i64) {
                let next_offset = (next - 1) * PART_SIZE as i64;
                if next >= 1 && next_offset < file_len {
                    sqlite::advance_archive(app, &session.id, next, next_offset)
                        .map_err(|e| anyhow!(e))?;
                    return Ok(());
                }
            }
            return Err(anyhow!(Permanent(format!("upload archive part: server refused ({body})"))));
        }
        if !response.status().is_success() {
            return Err(http_error("upload archive part", response).await);
        }
        let body: PartResponse = response.json().await.context("decode archive part response")?;
        let next_part = body.next_part_number.unwrap_or(session.next_part_number + 1);
        sqlite::advance_archive(app, &session.id, next_part, offset + PART_SIZE as i64)
            .map_err(|e| anyhow!(e))?;
        return Ok(());
    }

    let bytes = read_range(&session.archive_path, offset, remaining as usize).await?;
    let response = api
        .client
        .post(api.url(&format!("/api/sessions/{remote_id}/finalize")))
        .bearer_auth(token)
        .header("content-type", "audio/mp4")
        .body(bytes)
        .send()
        .await
        .context("finalize archive upload")?;
    if !response.status().is_success() {
        return Err(http_error("finalize archive upload", response).await);
    }
    sqlite::mark_processing(app, &session.id).map_err(|e| anyhow!(e))?;
    Ok(())
}

async fn read_range(path: &Path, offset: i64, length: usize) -> Result<Vec<u8>> {
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("open archive {}", path.display()))?;
    file.seek(std::io::SeekFrom::Start(offset as u64))
        .await
        .context("seek archive")?;
    let mut bytes = vec![0_u8; length];
    file.read_exact(&mut bytes).await.context("read archive range")?;
    Ok(bytes)
}

async fn http_error(operation: &str, response: reqwest::Response) -> anyhow::Error {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status == StatusCode::UNAUTHORIZED {
        return anyhow!(Unauthorized(format!("{operation}: {}", sqlite::UNAUTHORIZED_MARKER)));
    }
    let message = format!("{operation}: HTTP {status}: {}", body.chars().take(500).collect::<String>());
    let permanent = status.is_client_error() && !matches!(status.as_u16(), 408 | 425 | 429);
    if permanent { anyhow!(Permanent(message)) } else { anyhow!(message) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start_ms: i64, speaker: Option<&str>, text: &str) -> ResultSegment {
        ResultSegment { start_ms, text: text.to_string(), speaker: speaker.map(str::to_string) }
    }

    #[test]
    fn transcript_groups_turns_by_speaker() {
        let rendered = render_transcript(
            "Sync",
            &[
                line(1_000, Some("You"), "Morning."),
                line(3_000, Some("You"), "I can present first."),
                line(65_000, Some("Them"), "Go ahead."),
            ],
        );
        assert_eq!(
            rendered,
            "# Sync\n\n## Transcript\n\n**[00:00:01] You:** Morning. I can present first.\n\n**[00:01:05] Them:** Go ahead.\n\n"
        );
    }

    #[tokio::test]
    async fn wake_ends_an_idle_pause_early() {
        let started = std::time::Instant::now();
        let waiter = tokio::spawn(idle(Duration::from_secs(30)));
        tokio::time::sleep(Duration::from_millis(20)).await;
        wake();
        tokio::time::timeout(Duration::from_secs(2), waiter).await.unwrap().unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    mod state_machine {
        use super::super::*;
        use std::path::PathBuf;
        use tauri::test::MockRuntime;
        use wiremock::matchers::{body_bytes, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        const TOKEN: &str = "device-token";

        struct Harness {
            root: PathBuf,
            app: tauri::App<MockRuntime>,
            server: MockServer,
            api: Api,
        }

        impl Harness {
            async fn new() -> Self {
                let root = std::env::temp_dir().join(format!("eavesy-sync-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&root).unwrap();
                let mut context = tauri::test::mock_context(tauri::test::noop_assets());
                context.config_mut().identifier = root.to_string_lossy().into_owned();
                let app = tauri::test::mock_builder().build(context).unwrap();
                sqlite::initialize(app.handle()).unwrap();
                let server = MockServer::start().await;
                let api = Api::new(server.uri()).unwrap();
                Self { root, app, server, api }
            }

            fn handle(&self) -> &AppHandle<MockRuntime> {
                self.app.handle()
            }

            /// A capture already attached to cloud meeting `remote-<id>`, with
            /// `segments` queued segments.
            fn session(&self, id: &str, status: &str, segments: i64) -> PathBuf {
                let folder = self.root.join(id);
                std::fs::create_dir_all(&folder).unwrap();
                let archive = folder.join("audio.m4a");
                sqlite::begin_recording(self.handle(), id, &archive, &folder, "mic", "Memo", None, 1).unwrap();
                sqlite::attach_remote(self.handle(), id, &format!("remote-{id}")).unwrap();
                for index in 0..segments {
                    let file = folder.join(format!("segment-{index}.m4a"));
                    std::fs::write(&file, b"segment").unwrap();
                    let manifest: sqlite::SegmentManifest = serde_json::from_value(serde_json::json!({
                        "path": file, "index": index, "startMs": index * 1_000, "durationMs": 1_000, "bytes": 7,
                    }))
                    .unwrap();
                    sqlite::record_segment(self.handle(), id, &manifest).unwrap();
                }
                if status != "recording" {
                    std::fs::write(&archive, crate::recovery::playable_m4a()).unwrap();
                    sqlite::finish_recording(self.handle(), id, &archive, segments * 1_000, 96).unwrap();
                }
                archive
            }

            fn row(&self, sql: &str, id: &str) -> (String, i64) {
                sqlite::with_conn(self.handle(), |conn| {
                    conn.query_row(sql, [id], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
                })
            }

            fn session_state(&self, id: &str) -> (String, i64) {
                self.row("SELECT status, archive_missing FROM recording_sessions WHERE id=?1", id)
            }

            fn segment_state(&self, id: &str) -> (String, i64) {
                self.row(
                    "SELECT status || ':' || gave_up, attempts FROM recording_segments WHERE session_id=?1 AND idx=0",
                    id,
                )
            }

            async fn pass(&self) -> Pass {
                pass(self.handle(), &self.api, TOKEN).await
            }
        }

        impl Drop for Harness {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }

        fn result_body(status: &str) -> serde_json::Value {
            serde_json::json!({ "status": status, "title": "Memo", "transcript": [] })
        }

        #[tokio::test]
        async fn a_401_pauses_sync_without_spending_segment_attempts() {
            let harness = Harness::new().await;
            harness.session("meeting", "recording", 1);
            Mock::given(method("PUT"))
                .respond_with(ResponseTemplate::new(401))
                .mount(&harness.server)
                .await;

            for _ in 0..3 {
                assert_eq!(harness.pass().await, Pass::SignedOut);
            }

            assert_eq!(harness.segment_state("meeting"), ("pending:0".to_string(), 0));
            assert_eq!(harness.session_state("meeting").0, "recording");
        }

        #[tokio::test]
        async fn a_401_creating_the_cloud_session_does_not_fail_the_recording() {
            let harness = Harness::new().await;
            let folder = harness.root.join("new");
            std::fs::create_dir_all(&folder).unwrap();
            sqlite::begin_recording(harness.handle(), "new", &folder.join("audio.m4a"), &folder, "mic", "Memo", None, 1).unwrap();
            Mock::given(method("POST"))
                .and(path("/api/sessions"))
                .respond_with(ResponseTemplate::new(401))
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::SignedOut);
            assert_eq!(harness.session_state("new").0, "recording");
        }

        #[tokio::test]
        async fn other_client_errors_still_give_up_on_a_segment() {
            let harness = Harness::new().await;
            harness.session("meeting", "recording", 1);
            Mock::given(method("PUT"))
                .respond_with(ResponseTemplate::new(413))
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::Busy);
            assert_eq!(harness.segment_state("meeting"), ("failed:1".to_string(), 1));
        }

        #[tokio::test]
        async fn a_capture_without_its_archive_is_finished_from_segments() {
            let harness = Harness::new().await;
            harness.session("meeting", "recording", 1);
            sqlite::finish_from_segments(harness.handle(), "meeting", 1_000, "stop timed out").unwrap();
            Mock::given(method("PUT"))
                .and(path("/api/sessions/remote-meeting/segments/0"))
                .respond_with(ResponseTemplate::new(202))
                .expect(1)
                .mount(&harness.server)
                .await;
            Mock::given(method("POST"))
                .and(path("/api/sessions/remote-meeting/finalize"))
                .and(query_param("archive", "none"))
                .and(body_bytes(Vec::<u8>::new()))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "ok": true })))
                .expect(1)
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::Busy);
            assert_eq!(harness.pass().await, Pass::Busy);

            assert_eq!(harness.session_state("meeting"), ("processing".to_string(), 1));
        }

        #[tokio::test]
        async fn an_older_server_refusing_segments_only_finalize_is_retried_later() {
            let harness = Harness::new().await;
            harness.session("meeting", "recording", 1);
            sqlite::finish_from_segments(harness.handle(), "meeting", 1_000, "stop timed out").unwrap();
            sqlite::with_conn(harness.handle(), |conn| {
                conn.execute("UPDATE recording_segments SET status='uploaded'", []).unwrap();
            });
            Mock::given(method("POST"))
                .and(path("/api/sessions/remote-meeting/finalize"))
                .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({ "error": "invalid_final_part" })))
                .expect(1)
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::Busy);

            assert_eq!(harness.session_state("meeting"), ("uploading".to_string(), 1));
            let next_attempt_at: i64 = sqlite::with_conn(harness.handle(), |conn| {
                conn.query_row("SELECT next_attempt_at FROM recording_sessions WHERE id='meeting'", [], |row| row.get(0))
                    .unwrap()
            });
            assert!(next_attempt_at > chrono::Utc::now().timestamp_millis() + 5 * 60 * 1_000);
            assert_eq!(harness.pass().await, Pass::Idle);
        }

        #[tokio::test]
        async fn an_archive_deleted_before_upload_falls_back_to_segments() {
            let harness = Harness::new().await;
            let archive = harness.session("meeting", "uploading", 1);
            sqlite::with_conn(harness.handle(), |conn| {
                conn.execute("UPDATE recording_segments SET status='uploaded'", []).unwrap();
            });
            std::fs::remove_file(archive).unwrap();
            Mock::given(method("POST"))
                .and(path("/api/sessions/remote-meeting/finalize"))
                .and(query_param("archive", "none"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "ok": true })))
                .expect(1)
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::Busy);
            assert_eq!(harness.session_state("meeting"), ("processing".to_string(), 1));
        }

        #[tokio::test]
        async fn a_lost_archive_with_nothing_uploaded_fails_visibly() {
            let harness = Harness::new().await;
            harness.session("meeting", "recording", 1);
            sqlite::finish_from_segments(harness.handle(), "meeting", 1_000, "stop timed out").unwrap();
            sqlite::with_conn(harness.handle(), |conn| {
                conn.execute("UPDATE recording_segments SET status='failed', gave_up=1", []).unwrap();
            });

            assert_eq!(harness.pass().await, Pass::Busy);

            let error: String = sqlite::with_conn(harness.handle(), |conn| {
                conn.query_row("SELECT last_error FROM recording_sessions WHERE id='meeting'", [], |row| row.get(0))
                    .unwrap()
            });
            assert_eq!(harness.session_state("meeting").0, "failed");
            assert!(error.contains("no part of the recording reached the cloud"), "{error}");
        }

        #[tokio::test]
        async fn a_finished_session_uploads_its_archive_then_polls_to_complete() {
            let harness = Harness::new().await;
            harness.session("meeting", "uploading", 0);
            Mock::given(method("POST"))
                .and(path("/api/sessions/remote-meeting/finalize"))
                .and(body_bytes(crate::recovery::playable_m4a()))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "ok": true })))
                .expect(1)
                .mount(&harness.server)
                .await;
            Mock::given(method("GET"))
                .and(path("/api/sessions/remote-meeting/result"))
                .respond_with(ResponseTemplate::new(200).set_body_json(result_body("complete")))
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::Busy);
            assert_eq!(harness.session_state("meeting").0, "processing");
            assert_eq!(harness.pass().await, Pass::Busy);
            assert_eq!(harness.session_state("meeting").0, "complete");
            assert_eq!(harness.pass().await, Pass::Idle);
        }

        #[tokio::test]
        async fn files_that_failed_to_write_are_written_when_the_session_completes() {
            let harness = Harness::new().await;
            harness.session("meeting", "uploading", 0);
            sqlite::mark_processing(harness.handle(), "meeting").unwrap();
            let folder = harness.root.join("meeting");
            crate::store::append(harness.handle(), crate::store::StoredRecording {
                id: "meeting".into(),
                title: "Memo".into(),
                started_at_ms: 1,
                duration_sec: 0,
                source: "mic".into(),
                status: "processing".into(),
                summary: None,
                transcript: None,
                notes: None,
                has_audio: true,
                has_video: false,
                folder_path: Some(folder.to_string_lossy().into_owned()),
            })
            .unwrap();
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "status": "complete", "title": "Memo",
                    "transcript": [{ "startMs": 0, "text": "Hello." }],
                })))
                .mount(&harness.server)
                .await;
            let set_mode = |mode: u32| {
                let mut permissions = std::fs::metadata(&folder).unwrap().permissions();
                std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, mode);
                std::fs::set_permissions(&folder, permissions).unwrap();
            };

            // The completing poll updates the registry, then cannot write the folder.
            set_mode(0o500);
            assert_eq!(harness.pass().await, Pass::Busy);
            set_mode(0o700);
            assert_eq!(harness.session_state("meeting").0, "processing", "not complete until written");
            assert!(!folder.join("transcript.md").exists());

            // The same result again: unchanged in the registry, but still written.
            sqlite::with_conn(harness.handle(), |conn| {
                conn.execute("UPDATE recording_sessions SET next_attempt_at=0", []).unwrap();
            });
            assert_eq!(harness.pass().await, Pass::Busy);

            assert_eq!(harness.session_state("meeting").0, "complete");
            let transcript = std::fs::read_to_string(folder.join("transcript.md")).unwrap();
            assert!(transcript.contains("Hello."), "{transcript}");
        }

        #[tokio::test]
        async fn a_server_error_defers_the_session_and_keeps_the_segment() {
            let harness = Harness::new().await;
            harness.session("meeting", "recording", 1);
            Mock::given(method("PUT"))
                .respond_with(ResponseTemplate::new(503))
                .mount(&harness.server)
                .await;

            assert_eq!(harness.pass().await, Pass::Busy);
            assert_eq!(harness.segment_state("meeting"), ("failed:0".to_string(), 1));
            // Deferred: nothing else is due until the backoff passes.
            assert_eq!(harness.pass().await, Pass::Idle);
        }
    }

    #[test]
    fn transcript_without_speakers_keeps_timestamps() {
        let rendered = render_transcript("Memo", &[line(0, None, "Buy milk.")]);
        assert_eq!(rendered, "# Memo\n\n## Transcript\n\n[00:00:00] Buy milk.\n\n");
    }
}
