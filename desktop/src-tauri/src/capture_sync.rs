//! Screenshots and pasted images, shared between the user's Macs.
//!
//! Meetings travel through `/api/sessions` (see `sync` and `cloud_pull`), but
//! images never did: a screenshot taken on one Mac stayed in that Mac's
//! history. This uploads this Mac's images to `/api/devices/captures` and
//! brings the ones taken on the user's other devices into the history here,
//! filed under the id the original Mac gave them so they are never doubled.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::store::StoredRecording;
use crate::sync::Api;
use crate::{fs_writer, store};

/// Images one pass uploads or downloads, so a long history moves over a few
/// passes instead of holding up meeting uploads.
const PER_PASS: usize = 10;
/// Images asked for per page of the cloud list, and how many pages one pull reads.
const PAGE: usize = 50;
const MAX_PAGES: usize = 20;
/// History entries read per page while looking for images to upload.
const HISTORY_PAGE: usize = 200;
/// The server's limit.
const MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;
/// How long an image that could not be uploaded or downloaded is left alone.
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
struct SyncState {
    /// This Mac's images the server has.
    #[serde(default)]
    uploaded: BTreeSet<String>,
    /// This Mac's images the server will never take (unsupported format, too large).
    #[serde(default)]
    unsendable: BTreeSet<String>,
    /// Images brought in from other devices, by local id.
    #[serde(default)]
    pulled: BTreeSet<String>,
    /// Pulled images the user deleted on this Mac: never brought back.
    #[serde(default)]
    dismissed: BTreeSet<String>,
    /// The device each pulled image was taken on.
    #[serde(default)]
    origins: BTreeMap<String, String>,
    /// Where the last pull stopped reading the cloud list.
    #[serde(default)]
    scan_offset: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudCapture {
    id: String,
    #[serde(default)]
    client_capture_id: Option<String>,
    title: String,
    content_type: String,
    #[serde(default)]
    transcript: Option<String>,
    created_at: i64,
    #[serde(default)]
    device_name: Option<String>,
}

impl CloudCapture {
    /// The id it has in every Mac's history: the one the Mac that took it gave
    /// it, or the cloud id for an image from the web.
    fn local_id(&self) -> String {
        self.client_capture_id
            .as_deref()
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
            .unwrap_or(&self.id)
            .to_string()
    }
}

#[derive(Deserialize)]
struct CloudCaptures {
    items: Vec<CloudCapture>,
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("capture_sync.json"))
        .map_err(|error| format!("could not resolve app data dir: {error}"))
}

fn read_state(path: &Path) -> Result<SyncState, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| format!("decode {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SyncState::default()),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

fn update_state<R: Runtime, T>(app: &AppHandle<R>, change: impl FnOnce(&mut SyncState) -> T) -> Result<T, String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let path = state_path(app)?;
    let mut state = read_state(&path)?;
    let out = change(&mut state);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let raw = serde_json::to_string(&state).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|error| format!("write {}: {error}", temp.display()))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("replace {}: {error}", path.display()))?;
    Ok(out)
}

fn load_state<R: Runtime>(app: &AppHandle<R>) -> Result<SyncState, String> {
    let _guard = STATE_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    read_state(&state_path(app)?)
}

/// The device each image brought in from another device was taken on.
pub fn origins<R: Runtime>(app: &AppHandle<R>) -> BTreeMap<String, String> {
    load_state(app).map(|state| state.origins).unwrap_or_default()
}

/// Called before a capture is deleted: a pulled image stays deleted on this
/// Mac. Returns whether it was a pulled image, for `undismiss`.
pub fn dismiss<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<bool, String> {
    if !load_state(app)?.pulled.contains(id) {
        return Ok(false);
    }
    update_state(app, |state| {
        state.pulled.remove(id);
        state.origins.remove(id);
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

/// One pass each way. Returns how many images moved, so the loop can come
/// back sooner when more are waiting.
pub(crate) async fn run<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, root: &Path) -> Result<usize> {
    let sent = upload(app, api, token).await?;
    let arrived = pull(app, api, token, root).await?;
    Ok(sent + arrived)
}

/// This Mac's own images the server does not have yet.
fn pending_uploads<R: Runtime>(app: &AppHandle<R>, state: &SyncState) -> Result<Vec<StoredRecording>, String> {
    let mut pending = Vec::new();
    let mut offset = Some(0);
    while let Some(at) = offset {
        let page = store::page(app, at, HISTORY_PAGE, "", "screens", None)?;
        for item in page.items {
            if !matches!(item.source.as_str(), "screenshot" | "image")
                || state.uploaded.contains(&item.id)
                || state.unsendable.contains(&item.id)
                || state.pulled.contains(&item.id)
                || failed_recently(&item.id)
            {
                continue;
            }
            if let Some(recording) = store::get(app, &item.id)? {
                pending.push(recording);
                if pending.len() >= PER_PASS {
                    return Ok(pending);
                }
            }
        }
        offset = page.next_offset;
    }
    Ok(pending)
}

/// The image file in a capture's folder.
fn image_file(folder: &Path) -> Option<PathBuf> {
    ["screenshot.png", "image.png"].iter().map(|name| folder.join(name)).find(|path| path.is_file()).or_else(|| {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(folder).ok()?.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
        entries.sort();
        entries.into_iter().find(|path| {
            matches!(path.file_stem().and_then(|stem| stem.to_str()), Some("image" | "screenshot"))
                && path.is_file()
                && content_type(path).is_some()
        })
    })
}

fn content_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        _ => return None,
    })
}

fn extension(content_type: &str) -> Option<&'static str> {
    Some(match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/heic" => "heic",
        _ => return None,
    })
}

enum Sent {
    Uploaded,
    /// The server will never take it.
    Unsendable,
}

async fn upload<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str) -> Result<usize> {
    let pending = {
        let state = load_state(app).map_err(|error| anyhow!(error))?;
        pending_uploads(app, &state).map_err(|error| anyhow!(error))?
    };
    let mut sent = 0;
    for recording in pending {
        match upload_one(api, token, &recording).await {
            Ok(outcome) => {
                let id = recording.id.clone();
                update_state(app, |state| match outcome {
                    Sent::Uploaded => state.uploaded.insert(id),
                    Sent::Unsendable => state.unsendable.insert(id),
                })
                .map_err(|error| anyhow!(error))?;
                sent += 1;
            }
            Err(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => return Err(error),
            Err(error) => {
                eprintln!("capture sync: could not upload {}: {error:#}", recording.id);
                mark_failed(&recording.id);
            }
        }
    }
    Ok(sent)
}

/// Header values are ASCII only; the server percent-decodes.
fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

async fn upload_one(api: &Api, token: &str, recording: &StoredRecording) -> Result<Sent> {
    let Some(folder) = recording.folder_path.as_deref().map(Path::new) else { return Ok(Sent::Unsendable) };
    let Some(path) = image_file(folder) else { return Ok(Sent::Unsendable) };
    let Some(kind) = content_type(&path) else { return Ok(Sent::Unsendable) };
    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_UPLOAD_BYTES {
        return Ok(Sent::Unsendable);
    }
    let bytes = tokio::fs::read(&path).await.with_context(|| format!("read {}", path.display()))?;
    let response = api
        .client
        .post(api.url("/api/devices/captures"))
        .bearer_auth(token)
        .header("content-type", kind)
        .header("x-client-capture-id", &recording.id)
        .header("x-title", percent_encode(&recording.title))
        .header("x-captured-at", recording.started_at_ms.to_string())
        .body(bytes)
        .send()
        .await
        .context("upload capture")?;
    let status = response.status();
    if status.is_success() {
        return Ok(Sent::Uploaded);
    }
    if matches!(status.as_u16(), 413 | 415) {
        return Ok(Sent::Unsendable);
    }
    Err(crate::sync::http_error("upload capture", response).await)
}

/// Downloads a few images taken on other devices. Returns how many arrived.
async fn pull<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, root: &Path) -> Result<usize> {
    let state = load_state(app).map_err(|error| anyhow!(error))?;
    let mut known: HashSet<String> = store::ids(app).map_err(|error| anyhow!(error))?.into_iter().collect();
    known.extend(state.dismissed.iter().cloned());

    // The newest page first, for images taken since the last pull, then onward
    // from where the last pull stopped; the end of the list starts over.
    let resume = state.scan_offset.max(PAGE);
    let offsets: Vec<usize> = std::iter::once(0).chain((0..MAX_PAGES - 1).map(|page| resume + page * PAGE)).collect();
    let mut wanted = Vec::new();
    let mut next_offset = state.scan_offset;
    for &offset in &offsets {
        let response = api
            .client
            .get(api.url(&format!("/api/devices/captures?limit={PAGE}&offset={offset}")))
            .bearer_auth(token)
            .send()
            .await
            .context("list cloud captures")?;
        if !response.status().is_success() {
            return Err(crate::sync::http_error("list cloud captures", response).await);
        }
        let listed: CloudCaptures = response.json().await.context("decode cloud captures")?;
        let last_page = listed.items.len() < PAGE;
        wanted.extend(listed.items.into_iter().filter(|capture| {
            let id = capture.local_id();
            !known.contains(&id) && !failed_recently(&id) && extension(&capture.content_type).is_some()
        }));
        let enough = wanted.len() >= PER_PASS;
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
    }

    let mut arrived = 0;
    for capture in wanted.into_iter().take(PER_PASS) {
        let id = capture.local_id();
        let image = match download(api, token, &capture.id).await {
            Ok(image) => image,
            Err(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => return Err(error),
            Err(error) => {
                eprintln!("capture sync: skipped {}: {error:#}", capture.id);
                mark_failed(&id);
                continue;
            }
        };
        let saved = {
            let app = app.clone();
            let root = root.to_path_buf();
            crate::sync::blocking(move || save(&app, &root, &capture, &image)).await
        };
        match saved {
            Ok(true) => arrived += 1,
            Ok(false) => {}
            Err(error) => {
                eprintln!("capture sync: could not save {id}: {error:#}");
                mark_failed(&id);
            }
        }
    }
    if next_offset != state.scan_offset {
        update_state(app, |state| state.scan_offset = next_offset).map_err(|error| anyhow!(error))?;
    }
    if arrived > 0 {
        if let Err(error) = app.emit("recordings:updated", ()) {
            eprintln!("capture sync: could not announce new images: {error}");
        }
    }
    Ok(arrived)
}

async fn download(api: &Api, token: &str, id: &str) -> Result<Vec<u8>> {
    let response = api
        .client
        .get(api.url(&format!("/api/devices/captures/{}", percent_encode(id))))
        .bearer_auth(token)
        .send()
        .await
        .context("download capture")?;
    if !response.status().is_success() {
        return Err(crate::sync::http_error("download capture", response).await);
    }
    Ok(response.bytes().await.context("read capture")?.to_vec())
}

/// Writes the image's folder, marks it pulled, then adds it to the history.
/// Any failure removes the folder and the mark. Returns false when the user
/// deleted it on this Mac while the pull was running.
fn save<R: Runtime>(app: &AppHandle<R>, root: &Path, capture: &CloudCapture, image: &[u8]) -> Result<bool, String> {
    let id = capture.local_id();
    let ext = extension(&capture.content_type).ok_or("unsupported image type")?;
    let started = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(capture.created_at).unwrap_or_else(chrono::Utc::now);
    let title = if capture.title.trim().is_empty() { "Screenshot" } else { capture.title.trim() };
    let folder = fs_writer::allocate_recording_folder(root, title, started)?;
    let recording = StoredRecording {
        id: id.clone(),
        title: title.to_string(),
        started_at_ms: capture.created_at,
        duration_sec: 0,
        source: "image".into(),
        status: "complete".into(),
        summary: None,
        transcript: capture.transcript.clone().filter(|text| !text.trim().is_empty()),
        notes: None,
        has_audio: false,
        has_video: false,
        folder_path: Some(folder.to_string_lossy().into_owned()),
    };
    let saved = std::fs::write(folder.join(format!("image.{ext}")), image)
        .map_err(|error| error.to_string())
        .and_then(|()| serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string()))
        .and_then(|json| std::fs::write(folder.join("capture.json"), json).map_err(|error| error.to_string()))
        // Checked again under the same lock as the mark: a delete may have landed meanwhile.
        .and_then(|()| {
            update_state(app, |state| {
                if state.dismissed.contains(&id) {
                    return false;
                }
                state.pulled.insert(id.clone());
                if let Some(device) = &capture.device_name {
                    state.origins.insert(id.clone(), device.clone());
                }
                true
            })
        });
    let kept = match saved {
        Ok(true) => store::append(app, recording).map(|()| true).inspect_err(|_| {
            if let Err(error) = update_state(app, |state| {
                state.pulled.remove(&id);
                state.origins.remove(&id);
            }) {
                eprintln!("capture sync: could not unmark {id} after a failed save: {error}");
            }
        }),
        other => other,
    };
    if !matches!(kept, Ok(true)) {
        let _ = std::fs::remove_dir_all(&folder);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::MockRuntime;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn app() -> (tauri::App<MockRuntime>, Scratch) {
        let root = std::env::temp_dir().join(format!("eavesy-capture-sync-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        crate::sqlite::initialize(app.handle()).unwrap();
        (app, Scratch(root))
    }

    fn screenshot(handle: &AppHandle<MockRuntime>, root: &Path, id: &str) {
        let folder = root.join(format!("Screenshot-{id}"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("screenshot.png"), b"png bytes").unwrap();
        store::append(handle, StoredRecording {
            id: id.into(),
            title: "Screenshot".into(),
            started_at_ms: 1_700_000_000_000,
            duration_sec: 0,
            source: "screenshot".into(),
            status: "complete".into(),
            summary: None,
            transcript: None,
            notes: None,
            has_audio: false,
            has_video: false,
            folder_path: Some(folder.to_string_lossy().into_owned()),
        })
        .unwrap();
    }

    fn listing(items: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({ "items": items }))
    }

    #[tokio::test]
    async fn a_screenshot_is_uploaded_once_under_its_own_id() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let id = uuid::Uuid::new_v4().to_string();
        screenshot(handle, &root, &id);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .and(header("x-client-capture-id", id.as_str()))
            .and(header("content-type", "image/png"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "cap_1" })))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(upload(handle, &api, "token").await.unwrap(), 1);
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0, "already uploaded");
    }

    #[tokio::test]
    async fn an_image_from_another_mac_arrives_once_with_its_device_and_stays_deleted() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let own = uuid::Uuid::new_v4().to_string();
        screenshot(handle, &root, &own);
        let theirs = uuid::Uuid::new_v4().to_string();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/devices/captures"))
            .respond_with(listing(serde_json::json!([
                { "id": "cap_own", "clientCaptureId": own, "title": "Screenshot", "contentType": "image/png", "bytes": 9, "createdAt": 1_700_000_000_000_i64, "deviceName": "This Mac" },
                { "id": "cap_theirs", "clientCaptureId": theirs, "title": "Pasted image", "contentType": "image/png", "bytes": 3, "transcript": "Hello", "createdAt": 1_700_000_100_000_i64, "deviceName": "MacBook Air" }
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/devices/captures/cap_theirs"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"png".to_vec()))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 1);
        let pulled = store::get(handle, &theirs).unwrap().expect("in the history");
        assert_eq!(pulled.source, "image");
        assert_eq!(pulled.transcript.as_deref(), Some("Hello"));
        let folder = PathBuf::from(pulled.folder_path.unwrap());
        assert_eq!(std::fs::read(folder.join("image.png")).unwrap(), b"png");
        assert_eq!(origins(handle).get(&theirs).map(String::as_str), Some("MacBook Air"));

        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "already here");

        assert!(dismiss(handle, &theirs).unwrap());
        store::remove(handle, &theirs).unwrap();
        assert_eq!(pull(handle, &api, "token", &root).await.unwrap(), 0, "deleted on this Mac");
    }

    #[tokio::test]
    async fn a_pulled_image_is_not_uploaded_back() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let theirs = uuid::Uuid::new_v4().to_string();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/devices/captures"))
            .respond_with(listing(serde_json::json!([
                { "id": "cap_theirs", "clientCaptureId": theirs, "title": "Screenshot", "contentType": "image/png", "bytes": 3, "createdAt": 1_700_000_100_000_i64 }
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/devices/captures/cap_theirs"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"png".to_vec()))
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/api/devices/captures")).respond_with(ResponseTemplate::new(201)).expect(0).mount(&server).await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(run(handle, &api, "token", &root).await.unwrap(), 1);
        assert_eq!(run(handle, &api, "token", &root).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn an_image_the_server_cannot_take_is_not_retried() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let id = uuid::Uuid::new_v4().to_string();
        screenshot(handle, &root, &id);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .respond_with(ResponseTemplate::new(415))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        upload(handle, &api, "token").await.unwrap();
        upload(handle, &api, "token").await.unwrap();
        assert!(load_state(handle).unwrap().unsendable.contains(&id));
    }
}
