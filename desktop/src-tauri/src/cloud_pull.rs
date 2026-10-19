//! Brings meetings recorded on the user's other devices into this Mac's history.
//!
//! The upload loop only sends what this Mac records. This asks the server for
//! finished meetings this device did not record and writes each one into the
//! recordings folder like a local capture, without audio. Its id is the cloud
//! meeting id, so edits to its files sync back to the same meeting.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::store::StoredRecording;
use crate::sync::{Api, ResultResponse};
use crate::{fs_writer, sqlite, store};

/// How many meetings one pull downloads, so a long history arrives over a few
/// passes instead of holding up uploads.
const PER_PULL: usize = 5;

static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct PullState {
    /// Meetings brought in from the cloud.
    #[serde(default)]
    pulled: BTreeSet<String>,
    /// Pulled meetings the user deleted on this Mac: never brought back.
    #[serde(default)]
    dismissed: BTreeSet<String>,
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

/// Called after a capture is deleted: a pulled meeting stays deleted on this Mac.
pub fn dismiss<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    if !is_pulled(app, id) {
        return Ok(());
    }
    update_state(app, |state| {
        state.pulled.remove(id);
        state.dismissed.insert(id.to_string());
    })
}

/// Downloads a few meetings this Mac does not have yet. Returns how many arrived.
pub(crate) async fn pull<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, root: &Path) -> Result<usize> {
    let response = api
        .client
        .get(api.url("/api/sessions?limit=100"))
        .bearer_auth(token)
        .send()
        .await
        .context("list cloud meetings")?;
    if !response.status().is_success() {
        return Err(crate::sync::http_error("list cloud meetings", response).await);
    }
    let listed: CloudMeetings = response.json().await.context("decode cloud meetings")?;

    let state = load_state(app).map_err(|error| anyhow!(error))?;
    let mut known: HashSet<String> = store::load_all(app).into_iter().map(|recording| recording.id).collect();
    known.extend(sqlite::remote_meeting_ids(app).map_err(|error| anyhow!(error))?);
    known.extend(state.dismissed);

    let mut arrived = 0;
    for meeting in listed.items.into_iter().filter(|meeting| !known.contains(&meeting.id)).take(PER_PULL) {
        let result = api
            .client
            .get(api.url(&format!("/api/sessions/{}/result", meeting.id)))
            .bearer_auth(token)
            .send()
            .await
            .context("download cloud meeting")?;
        if !result.status().is_success() {
            eprintln!("cloud pull: skipped {}: {:#}", meeting.id, crate::sync::http_error("download cloud meeting", result).await);
            continue;
        }
        let result: ResultResponse = result.json().await.context("decode cloud meeting")?;
        let recording = to_recording(&meeting, &result);
        let app = app.clone();
        let root = root.to_path_buf();
        crate::sync::blocking(move || save(&app, &root, recording)).await?;
        arrived += 1;
    }
    if arrived > 0 {
        if let Err(error) = app.emit("recordings:updated", ()) {
            eprintln!("cloud pull: could not announce new meetings: {error}");
        }
    }
    Ok(arrived)
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

fn save<R: Runtime>(app: &AppHandle<R>, root: &Path, mut recording: StoredRecording) -> Result<(), String> {
    let started = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(recording.started_at_ms).unwrap_or_else(chrono::Utc::now);
    let folder = fs_writer::allocate_recording_folder(root, &recording.title, started)?;
    recording.folder_path = Some(folder.to_string_lossy().into_owned());
    fs_writer::persist_recording_artifacts(Some(app), &folder, &recording, Some(&recording.id), recording.notes.as_deref())?;
    let id = recording.id.clone();
    update_state(app, |state| {
        state.pulled.insert(id.clone());
    })?;
    store::append(app, recording)
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

        store::remove(handle, "remote-1").unwrap();
        dismiss(handle, "remote-1").unwrap();
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "deleted on this Mac");
    }
}
