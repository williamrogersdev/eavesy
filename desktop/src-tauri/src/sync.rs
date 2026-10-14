use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::time::sleep;

use crate::{fs_writer, settings, sqlite};

const PART_SIZE: usize = 8 * 1024 * 1024;

pub(crate) fn api_base() -> String {
    crate::base_url::api_base()
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

#[derive(Debug)]
struct Permanent(String);
impl std::fmt::Display for Permanent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Permanent {}

fn is_permanent(error: &anyhow::Error) -> bool {
    error.downcast_ref::<Permanent>().is_some()
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
}

pub async fn run(app: AppHandle) -> Result<()> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .context("build ingest HTTP client")?;

    loop {
        let Some(token) = settings::device_token(&app) else {
            sleep(Duration::from_secs(5)).await;
            continue;
        };
        match sync_file_edit(&app, &client, &token).await {
            Ok(true) => continue,
            Ok(false) => {},
            Err(error) => {
                eprintln!("desktop file edit sync: {error:#}");
                sleep(Duration::from_secs(2)).await;
            }
        }
        let session = match sqlite::next_session(&app) {
            Ok(Some(session)) => session,
            Ok(None) => {
                sleep(Duration::from_secs(2)).await;
                continue;
            }
            Err(error) => {
                eprintln!("desktop ingest: {error}");
                sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        match sync_session(&app, &client, &token, session.clone()).await {
            Ok(Step::Progressed) => {}
            Ok(Step::Waiting) => {
                let _ = sqlite::defer_session(&app, &session.id, POLL_INTERVAL_MS, None);
            }
            Err(error) if is_permanent(&error) => {
                eprintln!("desktop ingest: giving up on {}: {error:#}", session.id);
                crate::telemetry::capture("recording upload gave up", &format!("{error:#}"));
                let _ = sqlite::mark_session_failed(&app, &session.id, &format!("{error:#}"));
                let _ = crate::store::set_status(&app, &session.id, "transcript_failed");
            }
            Err(error) => {
                eprintln!("desktop ingest paused for {}: {error:#}", session.id);
                let _ = sqlite::defer_session(&app, &session.id, ERROR_BACKOFF_MS, Some(&format!("{error:#}")));
            }
        }
        sleep(Duration::from_millis(250)).await;
    }
}

async fn sync_file_edit(app: &AppHandle, client: &Client, token: &str) -> Result<bool> {
    if let Some(edit) = sqlite::next_file_edit(app).map_err(|error| anyhow!(error))? {
        if let Some(remote_id) = sqlite::remote_meeting_id(app, &edit.local_session_id)
            .map_err(|error| anyhow!(error))?
        {
            let result = upload_file_edit(client, token, &remote_id, &edit).await;
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

async fn sync_session(
    app: &AppHandle,
    client: &Client,
    token: &str,
    mut session: sqlite::PendingSession,
) -> Result<Step> {
    if session.remote_meeting_id.is_none() {
        let response = client
            .post(format!("{}/api/sessions", api_base()))
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
        poll_result(app, client, token, &remote_id, &session).await?;
        return Ok(Step::Waiting);
    }

    if let Some(segment) = sqlite::next_segment(app, &session.id).map_err(|e| anyhow!(e))? {
        match upload_segment(client, token, &remote_id, &segment).await {
            Ok(()) => sqlite::mark_segment_uploaded(app, &segment).map_err(|e| anyhow!(e))?,
            Err(error) if is_permanent(&error) => {
                eprintln!("desktop ingest: skipping segment {}: {error:#}", segment.idx);
                crate::telemetry::capture("segment upload gave up", &format!("{error:#}"));
                sqlite::give_up_segment(app, &segment, &format!("{error:#}"))
                    .map_err(|e| anyhow!(e))?;
            }
            Err(error) => {
                sqlite::mark_segment_failed(app, &segment, &format!("{error:#}"))
                    .map_err(|e| anyhow!(e))?;
                return Err(error);
            }
        }
        return Ok(Step::Progressed);
    }

    if session.status == "recording" {
        poll_result(app, client, token, &remote_id, &session).await?;
        return Ok(Step::Waiting);
    }
    if !sqlite::all_segments_uploaded(app, &session.id).map_err(|e| anyhow!(e))? {
        return Ok(Step::Waiting);
    }

    upload_archive(app, client, token, &remote_id, &session).await?;
    Ok(Step::Progressed)
}

async fn poll_result(
    app: &AppHandle,
    client: &Client,
    token: &str,
    remote_id: &str,
    session: &sqlite::PendingSession,
) -> Result<()> {
    let response = client
        .get(format!("{}/api/sessions/{}/result", api_base(), remote_id))
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
    crate::store::set_result(
        app,
        &session.id,
        &result.title,
        transcript.clone(),
        summary,
        Some(result.notes_md),
        match result.status.as_str() {
            "complete" => "complete",
            "failed" => "transcript_failed",
            _ => "processing",
        },
    )
    .map_err(|e| anyhow!(e))?;
    if let Some(recording) = crate::store::load_all(app)
        .into_iter()
        .find(|recording| recording.id == session.id)
    {
        if let Some(folder) = session.archive_path.parent() {
            fs_writer::persist_recording_artifacts(
                Some(app),
                folder,
                &recording,
                Some(remote_id),
                recording.notes.as_deref(),
            )
            .map_err(|error| anyhow!(error))?;
        }
    }
    let _ = app.emit("recordings:updated", ());
    if result.status == "complete" {
        crate::dictation::deliver(app, &session.id, &transcript);
        let current = crate::hud::current();
        if current.session_id.as_deref() == Some(session.id.as_str()) && current.phase != crate::hud::Phase::Recording {
            crate::hud::set_state(app, crate::hud::HudState { phase: crate::hud::Phase::Done, session_id: Some(session.id.clone()), mode: None, started_at_ms: None, message: Some(transcript) });
        }
        sqlite::mark_complete(app, &session.id).map_err(|e| anyhow!(e))?;
    } else if result.status == "failed" {
        return Err(anyhow!(Permanent("the cloud could not process this recording".to_string())));
    }
    Ok(())
}

async fn upload_file_edit(
    client: &Client,
    token: &str,
    remote_id: &str,
    edit: &sqlite::PendingFileEdit,
) -> Result<()> {
    let response = client
        .patch(format!("{}/api/sessions/{}/files", api_base(), remote_id))
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
    client: &Client,
    token: &str,
    remote_id: &str,
    segment: &sqlite::PendingSegment,
) -> Result<()> {
    let bytes = tokio::fs::read(&segment.file_path)
        .await
        .with_context(|| format!("read segment {}", segment.file_path.display()))?;
    let request = client
        .put(format!(
            "{}/api/sessions/{}/segments/{}",
            api_base(), remote_id, segment.idx
        ))
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

async fn upload_archive(
    app: &AppHandle,
    client: &Client,
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
        let response = client
            .put(format!(
                "{}/api/sessions/{}/parts/{}",
                api_base(), remote_id, session.next_part_number
            ))
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
    let response = client
        .post(format!("{}/api/sessions/{}/finalize", api_base(), remote_id))
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
    let message = if status == StatusCode::UNAUTHORIZED {
        format!("{operation}: device is not paired or its credential was revoked")
    } else {
        format!("{operation}: HTTP {status}: {}", body.chars().take(500).collect::<String>())
    };
    let permanent = status.is_client_error()
        && !matches!(status.as_u16(), 401 | 408 | 425 | 429);
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

    #[test]
    fn transcript_without_speakers_keeps_timestamps() {
        let rendered = render_transcript("Memo", &[line(0, None, "Buy milk.")]);
        assert_eq!(rendered, "# Memo\n\n## Transcript\n\n[00:00:00] Buy milk.\n\n");
    }
}
