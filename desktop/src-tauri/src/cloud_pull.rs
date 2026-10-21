//! Brings meetings recorded on the user's other devices into this Mac's history.
//!
//! The upload loop only sends what this Mac records. This asks the server for
//! finished meetings this device did not record and writes each one into the
//! recordings folder like a local capture, without audio. Its id is the cloud
//! meeting id, so edits to its files sync back to the same meeting.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::store::StoredRecording;
use crate::sync::{Api, ResultResponse};
use crate::{fs_writer, sqlite, store};

/// How many meetings one pull downloads, so a long history arrives over a few
/// passes instead of holding up uploads.
const PER_PULL: usize = 5;
/// Meetings asked for per page of the cloud list, and how many pages one pull reads.
const PAGE: usize = 50;
const MAX_PAGES: usize = 20;
/// Changed meetings asked for per check for edits made elsewhere.
const CHANGES_PAGE: usize = 50;
/// On the first check for edits, only meetings changed this recently are downloaded again.
const FIRST_CHANGES_WINDOW_MS: i64 = 3 * 24 * 60 * 60 * 1000;
/// How many times a changed meeting that keeps failing is tried before it is given up on.
const MAX_RETRIES: u32 = 5;
/// How long a meeting that could not be downloaded or saved is left alone.
const FAILED_RETRY: Duration = Duration::from_secs(60 * 60);

static STATE_LOCK: Mutex<()> = Mutex::new(());
static FAILED: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn failed_recently(id: &str) -> bool {
    FAILED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(id)
        .is_some_and(|at| at.elapsed() < FAILED_RETRY)
}

fn mark_failed(id: &str) {
    FAILED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(id.to_string(), Instant::now());
}

#[derive(Default, Serialize, Deserialize)]
struct PullState {
    /// Meetings brought in from the cloud.
    #[serde(default)]
    pulled: BTreeSet<String>,
    /// Pulled meetings the user deleted on this Mac: never brought back.
    #[serde(default)]
    dismissed: BTreeSet<String>,
    /// Where the last pull stopped reading the cloud list, so a long history is
    /// read a few pages per pull instead of the newest pages every time.
    #[serde(default)]
    scan_offset: usize,
    /// The newest change to a meeting already brought into this Mac; `None`
    /// until the first check for edits made on other devices.
    #[serde(default)]
    changes_since: Option<i64>,
    /// The id of the last meeting handled at `changes_since`, for meetings changed at the same moment.
    #[serde(default)]
    changes_after: Option<String>,
    /// The name of the device each pulled meeting was recorded on.
    #[serde(default)]
    origins: BTreeMap<String, String>,
    /// Changed meetings whose download failed, by cloud id: the cursor has
    /// moved past them, so they are retried from here.
    #[serde(default)]
    retry: BTreeMap<String, Retry>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Retry {
    local_id: String,
    attempts: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudMeeting {
    id: String,
    started_at: i64,
    #[serde(default)]
    duration_sec: Option<i64>,
    source: String,
    #[serde(default)]
    changed_at: Option<i64>,
    #[serde(default)]
    capture_source: Option<String>,
    #[serde(default)]
    device_name: Option<String>,
}

impl CloudMeeting {
    /// The local source to file it under: a microphone-only capture is a voice
    /// memo or dictation, not a meeting.
    fn local_source(&self) -> String {
        match self.capture_source.as_deref() {
            Some(source @ ("mic" | "mixed")) => source.to_string(),
            _ => self.source.clone(),
        }
    }
}

#[derive(Deserialize)]
struct CloudMeetings {
    items: Vec<CloudMeeting>,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("cloud_pull.json"))
        .map_err(|error| format!("could not resolve app data dir: {error}"))
}

fn read_state(path: &Path) -> Result<PullState, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("decode {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PullState::default()),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

fn update_state<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut PullState)) -> Result<(), String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = state_path(app)?;
    let mut state = read_state(&path)?;
    change(&mut state);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let raw = serde_json::to_string(&state).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|error| format!("write {}: {error}", temp.display()))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("replace {}: {error}", path.display()))
}

fn load_state<R: Runtime>(app: &AppHandle<R>) -> Result<PullState, String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    read_state(&state_path(app)?)
}

/// Whether this history entry was brought in from the cloud (its id is then the cloud meeting id).
pub fn is_pulled<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    load_state(app).is_ok_and(|state| state.pulled.contains(id))
}

/// The device each meeting brought in from the cloud was recorded on.
pub fn origins<R: Runtime>(app: &AppHandle<R>) -> BTreeMap<String, String> {
    load_state(app).map(|state| state.origins).unwrap_or_default()
}

/// Called before a capture is deleted: a pulled meeting stays deleted on this
/// Mac. Returns whether it was a pulled meeting, for `undismiss`.
pub fn dismiss<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<bool, String> {
    if !load_state(app)?.pulled.contains(id) {
        return Ok(false);
    }
    update_state(app, |state| {
        state.pulled.remove(id);
        state.origins.remove(id);
        state.retry.remove(id);
        state.dismissed.insert(id.to_string());
    })?;
    Ok(true)
}

/// Undoes `dismiss` when the delete did not go through.
pub fn undismiss<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    update_state(app, |state| {
        state.dismissed.remove(id);
        state.pulled.insert(id.to_string());
    })
}

/// Downloads a few meetings this Mac does not have yet. Returns how many arrived.
pub(crate) async fn pull<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, root: &Path) -> Result<usize> {
    let state = load_state(app).map_err(|error| anyhow!(error))?;
    let mut known: HashSet<String> = store::ids(app).map_err(|error| anyhow!(error))?.into_iter().collect();
    known.extend(sqlite::remote_meeting_ids(app).map_err(|error| anyhow!(error))?);
    known.extend(state.dismissed.iter().cloned());

    // The newest page first, for meetings recorded since the last pull, then
    // onward from where the last pull stopped; the end of the list starts over.
    let resume = state.scan_offset.max(PAGE);
    let offsets: Vec<usize> = std::iter::once(0).chain((0..MAX_PAGES - 1).map(|page| resume + page * PAGE)).collect();
    let mut wanted = Vec::new();
    let mut next_offset = state.scan_offset;
    for (index, &offset) in offsets.iter().enumerate() {
        let response = api
            .client
            .get(api.url(&format!("/api/sessions?limit={PAGE}&offset={offset}")))
            .bearer_auth(token)
            .send()
            .await
            .context("list cloud meetings")?;
        if !response.status().is_success() {
            return Err(crate::sync::http_error("list cloud meetings", response).await);
        }
        let listed: CloudMeetings = response.json().await.context("decode cloud meetings")?;
        let last_page = listed.items.len() < PAGE;
        wanted.extend(
            listed
                .items
                .into_iter()
                .filter(|meeting| !known.contains(&meeting.id) && !failed_recently(&meeting.id)),
        );
        let enough = wanted.len() >= PER_PULL;
        // A page this pull did not take everything from is read again next time.
        next_offset = match (last_page, offset > 0, enough) {
            (true, _, _) => 0,
            (false, true, true) => offset,
            (false, true, false) => offset + PAGE,
            (false, false, _) => next_offset,
        };
        if last_page || enough {
            break;
        }
        if index == offsets.len() - 1 {
            eprintln!("cloud pull: read {MAX_PAGES} pages; continuing from offset {} next time", offset + PAGE);
        }
    }

    let mut arrived = 0;
    for meeting in wanted.into_iter().take(PER_PULL) {
        let result = match download(api, token, &meeting.id).await {
            Ok(result) => result,
            Err(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => return Err(error),
            Err(error) => {
                eprintln!("cloud pull: skipped {}: {error:#}", meeting.id);
                mark_failed(&meeting.id);
                continue;
            }
        };
        let recording = to_recording(&meeting, &result);
        let saved = {
            let app = app.clone();
            let root = root.to_path_buf();
            let origin = meeting.device_name.clone();
            crate::sync::blocking(move || save(&app, &root, recording, origin)).await
        };
        match saved {
            Ok(true) => arrived += 1,
            Ok(false) => {}
            Err(error) => {
                eprintln!("cloud pull: could not save {}: {error:#}", meeting.id);
                mark_failed(&meeting.id);
            }
        }
    }
    // Saved once the downloads are done, so a pull cut short reads the same pages again.
    if next_offset != state.scan_offset {
        update_state(app, |state| state.scan_offset = next_offset).map_err(|error| anyhow!(error))?;
    }
    if arrived > 0 {
        if let Err(error) = app.emit("recordings:updated", ()) {
            eprintln!("cloud pull: could not announce new meetings: {error}");
        }
    }
    Ok(arrived)
}

async fn download(api: &Api, token: &str, id: &str) -> Result<ResultResponse> {
    let response = api
        .client
        .get(api.url(&format!("/api/sessions/{id}/result")))
        .bearer_auth(token)
        .send()
        .await
        .context("download cloud meeting")?;
    if !response.status().is_success() {
        return Err(crate::sync::http_error("download cloud meeting", response).await);
    }
    response.json().await.context("decode cloud meeting")
}

fn to_recording(meeting: &CloudMeeting, result: &ResultResponse) -> StoredRecording {
    let transcript = result
        .transcript_override_md
        .clone()
        .unwrap_or_else(|| crate::sync::render_transcript(&result.title, &result.transcript));
    let summary = result
        .summary_override_md
        .clone()
        .or_else(|| result.summary.as_ref().map(crate::sync::render_summary));
    StoredRecording {
        id: meeting.id.clone(),
        title: result.title.clone(),
        started_at_ms: meeting.started_at,
        duration_sec: meeting.duration_sec.unwrap_or(0).max(0),
        source: meeting.local_source(),
        status: "complete".to_string(),
        summary,
        transcript: Some(transcript),
        notes: (!result.notes_md.trim().is_empty()).then(|| result.notes_md.clone()),
        has_audio: false,
        has_video: false,
        folder_path: None,
    }
}

/// Writes the meeting's folder, marks it pulled, then adds it to the history.
/// Marking first means a crash in between only leads to it being pulled again;
/// any failure removes the folder and the mark. Returns false when the user
/// deleted it on this Mac while the pull was running.
fn save<R: Runtime>(app: &AppHandle<R>, root: &Path, mut recording: StoredRecording, origin: Option<String>) -> Result<bool, String> {
    if load_state(app)?.dismissed.contains(&recording.id) {
        return Ok(false);
    }
    let started = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(recording.started_at_ms).unwrap_or_else(chrono::Utc::now);
    let folder = fs_writer::allocate_recording_folder(root, &recording.title, started)?;
    recording.folder_path = Some(folder.to_string_lossy().into_owned());
    let id = recording.id.clone();
    let mut dismissed = false;
    let saved = fs_writer::persist_recording_artifacts(Some(app), &folder, &recording, Some(&id), recording.notes.as_deref())
        .and_then(|()| update_state(app, |state| {
            // Checked again under the same lock as the mark: a delete may have landed meanwhile.
            dismissed = state.dismissed.contains(&id);
            if !dismissed {
                state.pulled.insert(id.clone());
                if let Some(device) = &origin {
                    state.origins.insert(id.clone(), device.clone());
                }
            }
        }))
        .and_then(|()| {
            if dismissed {
                return Ok(());
            }
            store::append(app, recording).inspect_err(|_| {
                if let Err(error) = update_state(app, |state| {
                    state.pulled.remove(&id);
                }) {
                    eprintln!("cloud pull: could not unmark {id} after a failed save: {error}");
                }
            })
        });
    if saved.is_err() || dismissed {
        let _ = std::fs::remove_dir_all(&folder);
    }
    saved.map(|()| !dismissed)
}

/// Brings changes made on other devices into meetings this Mac already has:
/// edited notes, summaries and transcripts, renames, and the device and kind
/// of meetings pulled before those were known. Files edited on this Mac and
/// not yet taken by the cloud are kept. Returns how many meetings changed.
pub(crate) async fn refresh<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str) -> Result<usize> {
    let state = load_state(app).map_err(|error| anyhow!(error))?;
    let first = state.changes_since.is_none();
    let since = state.changes_since.unwrap_or(0);
    // Everything the feed lists is past the cursor; only the first check skips old changes.
    let download_after = first.then(|| chrono::Utc::now().timestamp_millis() - FIRST_CHANGES_WINDOW_MS);
    let mut cursor = (since, state.changes_after.clone());
    let mut updated = 0;
    let mut downloads = 0;

    let mut retried = HashSet::new();
    for (remote_id, retry) in state.retry {
        if downloads >= PER_PULL {
            break;
        }
        if failed_recently(&remote_id) {
            continue;
        }
        downloads += 1;
        retried.insert(remote_id.clone());
        match fetch_and_apply(app, api, token, &retry.local_id, &remote_id).await {
            Ok(changed) => {
                update_state(app, |state| {
                    state.retry.remove(&remote_id);
                })
                .map_err(|error| anyhow!(error))?;
                updated += usize::from(changed);
            }
            Err(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => return Err(error),
            Err(error) => {
                eprintln!("cloud pull: could not refresh {remote_id} again: {error:#}");
                mark_failed(&remote_id);
                update_state(app, |state| {
                    let give_up = state.retry.get_mut(&remote_id).is_some_and(|retry| {
                        retry.attempts += 1;
                        retry.attempts >= MAX_RETRIES
                    });
                    if give_up {
                        state.retry.remove(&remote_id);
                    }
                })
                .map_err(|error| anyhow!(error))?;
            }
        }
    }

    let mut finished = false;
    for _ in 0..MAX_PAGES {
        let response = api
            .client
            .get(api.url(&match &cursor.1 {
                Some(after) => format!("/api/sessions?changedSince={}&afterId={after}&limit={CHANGES_PAGE}", cursor.0),
                None => format!("/api/sessions?changedSince={}&limit={CHANGES_PAGE}", cursor.0),
            }))
            .bearer_auth(token)
            .send()
            .await
            .context("list changed cloud meetings")?;
        if !response.status().is_success() {
            return Err(crate::sync::http_error("list changed cloud meetings", response).await);
        }
        let listed: CloudMeetings = response.json().await.context("decode changed cloud meetings")?;
        let last_page = listed.items.len() < CHANGES_PAGE;
        let state = load_state(app).map_err(|error| anyhow!(error))?;
        for meeting in &listed.items {
            let Some(changed_at) = meeting.changed_at else { continue };
            let pulled = state.pulled.contains(&meeting.id);
            let local_id = if pulled {
                Some(meeting.id.clone())
            } else {
                sqlite::completed_session_for_remote(app, &meeting.id).map_err(|error| anyhow!(error))?
            };
            let Some(local_id) = local_id.filter(|_| !state.dismissed.contains(&meeting.id)) else {
                cursor = (changed_at, Some(meeting.id.clone()));
                continue;
            };
            let mut changed = false;
            if pulled {
                changed |= remember_origin(app, &meeting.id, meeting.device_name.as_deref()).map_err(|error| anyhow!(error))?;
                changed |= store::set_source(app, &local_id, &meeting.local_source()).map_err(|error| anyhow!(error))?;
            }
            if download_after.is_none_or(|after| changed_at > after) && !retried.contains(&meeting.id) {
                if downloads >= PER_PULL {
                    update_cursor(app, &cursor)?;
                    return Ok(updated);
                }
                let outcome = if failed_recently(&meeting.id) {
                    Err(anyhow!("failed recently"))
                } else {
                    downloads += 1;
                    fetch_and_apply(app, api, token, &local_id, &meeting.id).await
                };
                match outcome {
                    Ok(applied) => changed |= applied,
                    Err(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => {
                        update_cursor(app, &cursor)?;
                        return Err(error);
                    }
                    Err(error) => {
                        eprintln!("cloud pull: could not refresh {}, will retry: {error:#}", meeting.id);
                        mark_failed(&meeting.id);
                        update_state(app, |state| {
                            state.retry.entry(meeting.id.clone()).or_insert(Retry { local_id: local_id.clone(), attempts: 0 });
                        })
                        .map_err(|error| anyhow!(error))?;
                    }
                }
            }
            if changed {
                updated += 1;
            }
            cursor = (changed_at, Some(meeting.id.clone()));
        }
        if last_page || listed.items.is_empty() {
            finished = true;
            break;
        }
    }
    if !finished {
        eprintln!("cloud pull: read {MAX_PAGES} pages of changes; continuing next time");
    }
    update_cursor(app, &cursor)?;
    if updated > 0 {
        if let Err(error) = app.emit("recordings:updated", ()) {
            eprintln!("cloud pull: could not announce changed meetings: {error}");
        }
    }
    Ok(updated)
}

async fn fetch_and_apply<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, local_id: &str, remote_id: &str) -> Result<bool> {
    let result = download(api, token, remote_id).await?;
    let app = app.clone();
    let local_id = local_id.to_string();
    let remote_id = remote_id.to_string();
    crate::sync::blocking(move || apply(&app, &local_id, &remote_id, &result)).await
}

/// The list comes oldest change first, so the last meeting handled is the new cursor.
fn update_cursor<R: Runtime>(app: &AppHandle<R>, (since, after): &(i64, Option<String>)) -> Result<()> {
    update_state(app, |state| {
        state.changes_since = Some(*since);
        state.changes_after = after.clone();
    })
    .map_err(|error| anyhow!(error))
}

fn remember_origin<R: Runtime>(app: &AppHandle<R>, id: &str, device: Option<&str>) -> Result<bool, String> {
    let Some(device) = device.filter(|device| !device.trim().is_empty()) else {
        return Ok(false);
    };
    if load_state(app)?.origins.get(id).map(String::as_str) == Some(device) {
        return Ok(false);
    }
    update_state(app, |state| {
        if state.pulled.contains(id) {
            state.origins.insert(id.to_string(), device.to_string());
        }
    })?;
    Ok(true)
}

/// Writes a meeting's latest cloud version over this Mac's copy, keeping any
/// file edited here. Returns whether anything changed.
fn apply<R: Runtime>(app: &AppHandle<R>, local_id: &str, remote_id: &str, result: &ResultResponse) -> Result<bool, String> {
    let transcript = result
        .transcript_override_md
        .clone()
        .unwrap_or_else(|| crate::sync::render_transcript(&result.title, &result.transcript));
    let summary = result
        .summary_override_md
        .clone()
        .or_else(|| result.summary.as_ref().map(crate::sync::render_summary));
    // The cloud keeps notes without their header: notes that only differ by it are the same notes.
    let notes = match store::get(app, local_id)?.and_then(|recording| recording.notes) {
        Some(local) if notes_body(&local) == notes_body(&result.notes_md) => local,
        _ => result.notes_md.clone(),
    };
    let Some((recording, changed)) =
        store::set_result(app, local_id, &result.title, transcript, summary, Some(notes), "complete", true)?
    else {
        return Ok(false);
    };
    if changed {
        if let Some(folder) = recording.folder_path.as_deref().map(Path::new) {
            fs_writer::persist_recording_artifacts(Some(app), folder, &recording, Some(remote_id), recording.notes.as_deref())?;
        }
    }
    Ok(changed)
}

fn notes_body(markdown: &str) -> &str {
    let mut body = markdown.trim_start();
    if let Some(rest) = body.strip_prefix("---\n").or_else(|| body.strip_prefix("---\r\n")) {
        if let Some(end) = rest.find("\n---") {
            body = rest[end + 4..].trim_start_matches(['\r', '\n']);
        }
    }
    body.trim_start().strip_prefix("# Notes").unwrap_or(body).trim()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;
    use tauri::test::MockRuntime;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn app() -> (tauri::App<MockRuntime>, Scratch) {
        let root = std::env::temp_dir().join(format!("eavesy-pull-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        sqlite::initialize(app.handle()).unwrap();
        (app, Scratch(root))
    }

    fn result_body(title: &str) -> serde_json::Value {
        serde_json::json!({
            "status": "complete",
            "title": title,
            "transcript": [{ "startMs": 0, "text": "Hello from the other Mac" }],
            "summary": null,
            "notesMd": "",
            "transcriptReady": true,
        })
    }

    #[test]
    fn a_cloud_meeting_becomes_a_complete_recording_without_audio() {
        let meeting = CloudMeeting { id: "m1".into(), started_at: 1_700_000_000_000, duration_sec: Some(90), source: "desktop".into(), changed_at: None, capture_source: None, device_name: None };
        let result: ResultResponse = serde_json::from_value(result_body("Standup")).unwrap();
        let recording = to_recording(&meeting, &result);
        assert_eq!(recording.id, "m1");
        assert_eq!(recording.title, "Standup");
        assert_eq!(recording.status, "complete");
        assert_eq!(recording.duration_sec, 90);
        assert!(!recording.has_audio);
        assert!(recording.transcript.unwrap().contains("Hello from the other Mac"));
    }

    #[tokio::test]
    async fn pulls_meetings_from_other_devices_once_and_respects_deletes() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let own = scratch.0.join("own");
        std::fs::create_dir_all(&own).unwrap();
        sqlite::begin_recording(handle, "local-1", &own.join("audio.m4a"), &own, "mic", "Mine", None, 1).unwrap();
        sqlite::attach_remote(handle, "local-1", "remote-own").unwrap();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "items": [
                    { "id": "remote-own", "title": "Mine", "startedAt": 1_700_000_000_000_i64, "durationSec": 60, "source": "desktop", "updatedAt": 1 },
                    { "id": "remote-1", "title": "Standup", "startedAt": 1_700_000_000_000_i64, "durationSec": 60, "source": "desktop", "updatedAt": 1 }
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/remote-1/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Standup")))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        let recordings = store::load_all(handle);
        assert_eq!(recordings.len(), 1);
        let folder = PathBuf::from(recordings[0].folder_path.clone().unwrap());
        assert!(folder.join("transcript.md").exists());
        assert!(is_pulled(handle, "remote-1"));

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "already here");

        dismiss(handle, "remote-1").unwrap();
        store::remove(handle, "remote-1").unwrap();
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "deleted on this Mac");
    }

    fn listing(items: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({ "items": items }))
    }

    fn listed(id: &str, title: &str) -> serde_json::Value {
        serde_json::json!({ "id": id, "title": title, "startedAt": 1_700_000_000_000_i64, "durationSec": 60, "source": "desktop", "updatedAt": 1 })
    }

    #[tokio::test]
    async fn a_meeting_that_cannot_be_downloaded_is_skipped_without_stalling_the_rest() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .respond_with(listing(serde_json::json!([listed("broken", "Broken"), listed("fine", "Fine")])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/broken/result"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/fine/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Fine")))
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "the broken one waits before it is tried again");
        assert_eq!(store::load_all(handle).iter().map(|recording| recording.id.as_str()).collect::<Vec<_>>(), ["fine"]);
    }

    #[tokio::test]
    async fn a_hostile_title_stays_inside_the_recordings_folder() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .respond_with(listing(serde_json::json!([listed("hostile", "../../escape")])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/hostile/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("../../escape")))
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        let folder = PathBuf::from(store::load_all(handle)[0].folder_path.clone().unwrap());
        assert_eq!(folder.parent(), Some(root.as_path()));
    }

    #[tokio::test]
    async fn an_edit_to_a_pulled_meeting_uploads_to_its_cloud_meeting() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .respond_with(listing(serde_json::json!([listed("remote-1", "Standup")])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/remote-1/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Standup")))
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/api/sessions/remote-1/files"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);

        let summary = PathBuf::from(store::load_all(handle)[0].folder_path.clone().unwrap()).join("summary.md");
        let edited = "# Brief\n\nEdited";
        std::fs::write(&summary, edited).unwrap();
        let hash = hex::encode(sha2::Sha256::digest(edited.as_bytes()));
        sqlite::record_file_observation(handle, &summary, "remote-1", "summary", &hash).unwrap();
        assert!(fs_writer::has_local_edit(handle, &summary).unwrap());
        sqlite::enqueue_file_edit(handle, "remote-1", "summary", edited, &hash).unwrap();
        crate::sync::pass(handle, &api, "token").await;
        assert!(sqlite::next_file_edit(handle).unwrap().is_none());
        assert!(!fs_writer::has_local_edit(handle, &summary).unwrap(), "what the cloud holds is no longer a local edit");
    }

    #[tokio::test]
    async fn a_long_history_is_read_onward_from_where_the_last_pull_stopped() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        let known: Vec<serde_json::Value> = (0..PAGE).map(|index| listed(&format!("known-{index}"), "Known")).collect();
        for index in 0..PAGE {
            update_state(handle, |state| {
                state.dismissed.insert(format!("known-{index}"));
            })
            .unwrap();
        }
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("offset", "0"))
            .respond_with(listing(serde_json::Value::Array(known.clone())))
            .mount(&server)
            .await;
        for page in 1..MAX_PAGES {
            Mock::given(method("GET"))
                .and(path("/api/sessions"))
                .and(wiremock::matchers::query_param("offset", (page * PAGE).to_string()))
                .respond_with(listing(serde_json::Value::Array(known.clone())))
                .mount(&server)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("offset", (MAX_PAGES * PAGE).to_string()))
            .respond_with(listing(serde_json::json!([listed("oldest", "Oldest")])))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/oldest/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Oldest")))
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "the first pull reads only its share of pages");
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1, "the next one carries on and reaches the oldest");
        assert_eq!(load_state(handle).unwrap().scan_offset, 0, "the end of the list starts over");
    }

    #[test]
    fn a_failed_delete_puts_a_pulled_meeting_back() {
        let (app, _scratch) = app();
        let handle = app.handle();
        update_state(handle, |state| {
            state.pulled.insert("remote-1".into());
        })
        .unwrap();
        assert!(!dismiss(handle, "local-only").unwrap());
        assert!(dismiss(handle, "remote-1").unwrap());
        undismiss(handle, "remote-1").unwrap();
        let state = load_state(handle).unwrap();
        assert!(state.pulled.contains("remote-1"));
        assert!(!state.dismissed.contains("remote-1"));
    }

    #[tokio::test]
    async fn a_page_the_pull_did_not_finish_is_read_again() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        let dismissed = |range: std::ops::Range<usize>| -> Vec<serde_json::Value> {
            range.map(|index| listed(&format!("known-{index}"), "Known")).collect()
        };
        update_state(handle, |state| state.dismissed.extend((0..PAGE * 2).map(|index| format!("known-{index}")))).unwrap();
        let mut second: Vec<serde_json::Value> = (0..PER_PULL + 1).map(|index| listed(&format!("new-{index}"), "New")).collect();
        second.extend(dismissed(PAGE..PAGE * 2 - PER_PULL - 1));
        for (offset, items) in [(0, dismissed(0..PAGE)), (PAGE, second), (PAGE * 2, Vec::new())] {
            Mock::given(method("GET"))
                .and(path("/api/sessions"))
                .and(wiremock::matchers::query_param("offset", offset.to_string()))
                .respond_with(listing(serde_json::Value::Array(items)))
                .mount(&server)
                .await;
        }
        for index in 0..=PER_PULL {
            Mock::given(method("GET"))
                .and(path(format!("/api/sessions/new-{index}/result")))
                .respond_with(ResponseTemplate::new(200).set_body_json(result_body("New")))
                .mount(&server)
                .await;
        }
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), PER_PULL);
        assert_eq!(load_state(handle).unwrap().scan_offset, PAGE, "the page with one meeting left is read again");
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        assert_eq!(load_state(handle).unwrap().scan_offset, 0);
    }

    #[tokio::test]
    async fn a_voice_memo_from_another_mac_is_filed_as_voice_with_its_device() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        let mut memo = listed("memo", "Voice memo");
        memo["captureSource"] = "mic".into();
        memo["deviceName"] = "Studio Mac".into();
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .respond_with(listing(serde_json::json!([memo])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/memo/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Voice memo")))
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        assert_eq!(store::load_all(handle)[0].source, "mic");
        assert_eq!(origins(handle).get("memo").map(String::as_str), Some("Studio Mac"));
    }

    fn changed(id: &str, title: &str, changed_at: i64) -> serde_json::Value {
        let mut item = listed(id, title);
        item["changedAt"] = changed_at.into();
        item["captureSource"] = "mic".into();
        item["deviceName"] = "Studio Mac".into();
        item
    }

    #[tokio::test]
    async fn edits_made_on_another_device_reach_a_pulled_meeting_but_local_edits_stay() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param_is_missing("changedSince"))
            .respond_with(listing(serde_json::json!([listed("remote-1", "Standup")])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/remote-1/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Standup")))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        assert_eq!(store::load_all(handle)[0].source, "desktop");

        let first_seen = chrono::Utc::now().timestamp_millis() - 1_000;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", "0"))
            .respond_with(listing(serde_json::json!([changed("remote-1", "Standup", first_seen)])))
            .mount(&server)
            .await;
        let mut edited = result_body("Standup renamed");
        edited["notesMd"] = "Pasted on the other Mac".into();
        Mock::given(method("GET"))
            .and(path("/api/sessions/remote-1/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(edited))
            .mount(&server)
            .await;
        assert_eq!(refresh(handle, &api, "token").await.unwrap(), 1);
        let recording = store::load_all(handle).remove(0);
        assert_eq!(recording.title, "Standup renamed");
        assert_eq!(recording.source, "mic", "a microphone-only capture is filed as voice");
        assert_eq!(origins(handle).get("remote-1").map(String::as_str), Some("Studio Mac"));
        let folder = PathBuf::from(recording.folder_path.unwrap());
        assert!(std::fs::read_to_string(folder.join("notes.md")).unwrap().contains("Pasted on the other Mac"));
        assert_eq!(load_state(handle).unwrap().changes_since, Some(first_seen));

        std::fs::write(folder.join("summary.md"), "# Mine\n\nWritten here").unwrap();
        let later = first_seen + 500;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", first_seen.to_string()))
            .and(wiremock::matchers::query_param("afterId", "remote-1"))
            .respond_with(listing(serde_json::json!([changed("remote-1", "Standup renamed", later)])))
            .expect(1)
            .mount(&server)
            .await;
        refresh(handle, &api, "token").await.unwrap();
        assert_eq!(std::fs::read_to_string(folder.join("summary.md")).unwrap(), "# Mine\n\nWritten here");
        assert_eq!(load_state(handle).unwrap().changes_since, Some(later));
    }

    #[tokio::test]
    async fn the_first_check_for_edits_leaves_old_changes_alone() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param_is_missing("changedSince"))
            .respond_with(listing(serde_json::json!([listed("old", "Old")])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/old/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Old")))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", "0"))
            .respond_with(listing(serde_json::json!([changed("old", "Old", 1_700_000_000_000)])))
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);

        assert_eq!(refresh(handle, &api, "token").await.unwrap(), 1, "only its kind and device are filled in");
        assert_eq!(store::load_all(handle)[0].source, "mic");
        assert_eq!(load_state(handle).unwrap().changes_since, Some(1_700_000_000_000));
    }

    #[test]
    fn notes_differing_only_by_their_header_are_the_same_notes() {
        assert_eq!(notes_body("---\nid: \"x\"\n---\n\n# Notes\n\nHello\n"), "Hello");
        assert_eq!(notes_body("Hello"), "Hello");
    }

    async fn pulled(handle: &AppHandle<MockRuntime>, server: &MockServer, root: &Path, ids: &[&str]) -> Api {
        let items: Vec<serde_json::Value> = ids.iter().map(|id| listed(id, "Pulled")).collect();
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param_is_missing("changedSince"))
            .respond_with(listing(serde_json::Value::Array(items)))
            .mount(server)
            .await;
        for id in ids {
            Mock::given(method("GET"))
                .and(path(format!("/api/sessions/{id}/result")))
                .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Pulled")))
                .up_to_n_times(1)
                .mount(server)
                .await;
        }
        let api = Api::new(server.uri()).unwrap();
        while pull(handle, &api, "token", root).await.unwrap() > 0 {}
        api
    }

    #[tokio::test]
    async fn meetings_changed_at_the_same_moment_are_all_refreshed_across_passes() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        let ids: Vec<String> = (0..=PER_PULL).map(|index| format!("m{index}")).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let api = pulled(handle, &server, &root, &refs).await;
        let at = chrono::Utc::now().timestamp_millis() - 1_000;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", "0"))
            .respond_with(listing(serde_json::Value::Array(ids.iter().map(|id| changed(id, "Renamed", at)).collect())))
            .mount(&server)
            .await;
        let last = ids[PER_PULL - 1].clone();
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", at.to_string()))
            .and(wiremock::matchers::query_param("afterId", last.as_str()))
            .respond_with(listing(serde_json::json!([changed(&ids[PER_PULL], "Renamed", at)])))
            .expect(1..)
            .mount(&server)
            .await;
        for id in &ids {
            Mock::given(method("GET"))
                .and(path(format!("/api/sessions/{id}/result")))
                .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Renamed")))
                .mount(&server)
                .await;
        }

        assert_eq!(refresh(handle, &api, "token").await.unwrap(), PER_PULL);
        assert_eq!(load_state(handle).unwrap().changes_after.as_deref(), Some(last.as_str()));
        assert_eq!(refresh(handle, &api, "token").await.unwrap(), 1, "the one left at that moment still comes");
        assert!(store::load_all(handle).iter().all(|recording| recording.title == "Renamed"));
    }

    #[tokio::test]
    async fn a_refresh_that_fails_is_retried_after_the_cursor_moves_on() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let server = MockServer::start().await;
        let api = pulled(handle, &server, &root, &["flaky"]).await;
        let at = chrono::Utc::now().timestamp_millis() - 1_000;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", "0"))
            .respond_with(listing(serde_json::json!([changed("flaky", "Fixed", at)])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions"))
            .and(wiremock::matchers::query_param("changedSince", at.to_string()))
            .respond_with(listing(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/flaky/result"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/sessions/flaky/result"))
            .respond_with(ResponseTemplate::new(200).set_body_json(result_body("Fixed")))
            .mount(&server)
            .await;

        refresh(handle, &api, "token").await.unwrap();
        let state = load_state(handle).unwrap();
        assert_eq!(state.changes_after.as_deref(), Some("flaky"));
        assert!(state.retry.contains_key("flaky"));

        FAILED.lock().unwrap().remove("flaky");
        assert_eq!(refresh(handle, &api, "token").await.unwrap(), 1);
        assert_eq!(store::load_all(handle)[0].title, "Fixed");
        assert!(load_state(handle).unwrap().retry.is_empty());
    }
}
