//! Brings meetings recorded on the user's other devices into this Mac's history.
//!
//! The upload loop only sends what this Mac records. This asks the server for
//! finished meetings this device did not record and writes each one into the
//! recordings folder like a local capture, without audio. Its id is the cloud
//! meeting id, so edits to its files sync back to the same meeting.

use std::collections::{BTreeSet, HashMap, HashSet};
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudMeeting {
    id: String,
    started_at: i64,
    #[serde(default)]
    duration_sec: Option<i64>,
    source: String,
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

/// Called before a capture is deleted: a pulled meeting stays deleted on this
/// Mac. Returns whether it was a pulled meeting, for `undismiss`.
pub fn dismiss<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<bool, String> {
    if !load_state(app)?.pulled.contains(id) {
        return Ok(false);
    }
    update_state(app, |state| {
        state.pulled.remove(id);
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
    let mut known: HashSet<String> = store::load_all(app).into_iter().map(|recording| recording.id).collect();
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
            crate::sync::blocking(move || save(&app, &root, recording)).await
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
        source: meeting.source.clone(),
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
fn save<R: Runtime>(app: &AppHandle<R>, root: &Path, mut recording: StoredRecording) -> Result<bool, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
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
        let meeting = CloudMeeting { id: "m1".into(), started_at: 1_700_000_000_000, duration_sec: Some(90), source: "desktop".into() };
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

        sqlite::enqueue_file_edit(handle, "remote-1", "summary", "# Brief\n\nEdited", "hash").unwrap();
        crate::sync::pass(handle, &api, "token").await;
        assert!(sqlite::next_file_edit(handle).unwrap().is_none());
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
}
