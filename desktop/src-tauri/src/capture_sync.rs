//! Screenshots, pasted images and notes, shared between the user's Macs.
//!
//! Meetings travel through `/api/sessions` (see `sync` and `cloud_pull`), but
//! these never did: a screenshot taken or a note written on one Mac stayed in
//! that Mac's history. This uploads this Mac's images and notes to
//! `/api/devices/captures` and brings the ones from the user's other devices
//! into the history here, filed under the id the original Mac gave them so
//! they are never doubled.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use tauri::{AppHandle, Emitter, Runtime};

use crate::store::StoredRecording;
use crate::sync::sync_state::{deep_walk_due, ListWalk, RetryGate, StateFile, DAY_MS};
use crate::sync::Api;
use crate::{fs_writer, store};

/// Captures one pass uploads or downloads, so a long history moves over a few
/// passes instead of holding up meeting uploads.
const PER_PASS: usize = 10;
/// Captures asked for per page of the cloud list, and how many pages one pull reads.
const PAGE: usize = 50;
const MAX_PAGES: usize = 20;
/// History rows looked at per pass for captures added since the last pass.
const HISTORY_PAGE: usize = 500;
/// The server's limits.
const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_NOTE_BYTES: u64 = 1024 * 1024;
const NOTE_TYPE: &str = "text/markdown";
/// What one pass uploads before it leaves the rest to the next pass. The
/// first capture of a pass always goes, whatever its size.
const PASS_BYTES: u64 = 64 * 1024 * 1024;
const PASS_TIME: Duration = Duration::from_secs(120);
/// How long a capture that could not be downloaded is left alone, and how
/// long an upload that was started is left alone if its outcome was lost.
const FAILED_RETRY: Duration = Duration::from_secs(60 * 60);
/// An upload that keeps failing is tried this many times, a minute after the
/// first failure and twice as long after each one (at most a day), then given up on.
const UPLOAD_MAX_ATTEMPTS: u32 = 10;
/// How long uploads pause after a 429 that gave no usable Retry-After.
const RATE_PAUSE_MS: i64 = 60 * 60 * 1_000;
/// A device the server will not take captures from (403) asks again when its
/// credential changes, or after this long.
const REFUSED_RECHECK_MS: i64 = DAY_MS;

static STATE: StateFile = StateFile::new("capture_sync.json");
static FAILED: RetryGate = RetryGate::new(FAILED_RETRY);

#[derive(Default, Serialize, Deserialize)]
struct SyncState {
    /// This Mac's captures the server has.
    #[serde(default)]
    uploaded: BTreeSet<String>,
    /// This Mac's captures the server will never take (unsupported format, too large).
    #[serde(default)]
    unsendable: BTreeSet<String>,
    /// Captures brought in from other devices, by local id.
    #[serde(default)]
    pulled: BTreeSet<String>,
    /// Pulled captures the user deleted on this Mac: never brought back.
    #[serde(default)]
    dismissed: BTreeSet<String>,
    /// The device each pulled capture came from.
    #[serde(default)]
    origins: BTreeMap<String, String>,
    /// Where the last pull stopped reading the cloud list.
    #[serde(default)]
    scan_offset: usize,
    /// When a pull last read the cloud list to its end.
    #[serde(default)]
    walked_at: Option<i64>,
    /// Every capture at or before this history row has been looked at for upload.
    #[serde(default)]
    upload_mark: i64,
    /// Uploads that failed, and when each is tried again.
    #[serde(default)]
    upload_retry: BTreeMap<String, UploadRetry>,
    /// When the whole history was last checked for captures the mark passed by.
    #[serde(default)]
    swept_at: Option<i64>,
    /// No uploads before this time: the server asked to slow down (429).
    #[serde(default)]
    paused_until: Option<i64>,
    /// The server refused captures from this device (403).
    #[serde(default)]
    refused: Option<Refusal>,
    /// The folder of each capture being pulled, used again if its save was cut short.
    #[serde(default)]
    saving: BTreeMap<String, PathBuf>,
}

#[derive(Clone, Serialize, Deserialize)]
struct UploadRetry {
    at: i64,
    attempts: u32,
}

#[derive(Clone, Serialize, Deserialize)]
struct Refusal {
    /// A hash of the refused credential, never the credential itself.
    credential: String,
    at: i64,
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
    /// it, or the cloud id for one from the web.
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

fn load_state<R: Runtime>(app: &AppHandle<R>) -> Result<SyncState, String> {
    STATE.load(app)
}

fn update_state<R: Runtime, T>(app: &AppHandle<R>, change: impl FnOnce(&mut SyncState) -> T) -> Result<T, String> {
    STATE.update(app, change)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Identifies a credential in the state file without storing it.
fn fingerprint(token: &str) -> String {
    hex::encode(sha2::Sha256::digest(token.as_bytes()))
}

/// The device each capture brought in from another device came from.
pub fn origins<R: Runtime>(app: &AppHandle<R>) -> BTreeMap<String, String> {
    load_state(app).map(|state| state.origins).unwrap_or_default()
}

/// Called before a capture is deleted: a pulled capture stays deleted on this
/// Mac. Returns whether it was a pulled capture, for `undismiss`.
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

/// One pass each way. Returns how many captures moved, so the loop can come
/// back sooner when more are waiting.
pub(crate) async fn run<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, root: &Path) -> Result<usize> {
    let sent = upload(app, api, token).await?;
    let arrived = pull(app, api, token, root).await?;
    Ok(sent + arrived)
}

/// A history row the upload scan looked at.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Seen {
    /// Already sent, unsendable, pulled from elsewhere or queued for a retry.
    Settled,
    /// To upload this pass.
    Chosen,
    /// Tried moments ago with no outcome recorded: the mark must not pass it.
    Held,
}

struct Plan {
    /// The captures to upload, in order: due retries, new captures, then any the mark passed by.
    items: Vec<StoredRecording>,
    /// The rows after the mark, in order.
    scanned: Vec<(i64, String, Seen)>,
    mark: i64,
    /// Retries whose capture is gone from the history.
    gone: Vec<String>,
    /// Captures the sweep chose, when it found nothing else: the sweep is
    /// complete once these are handled.
    swept: Option<Vec<String>>,
}

/// What to upload this pass, or `None` while the server asked us to wait.
fn plan_uploads<R: Runtime>(app: &AppHandle<R>, credential: &str, now: i64) -> Result<Option<Plan>, String> {
    let state = load_state(app)?;
    if state.paused_until.is_some_and(|until| now < until) {
        return Ok(None);
    }
    if state.refused.as_ref().is_some_and(|refused| refused.credential == credential && now - refused.at < REFUSED_RECHECK_MS) {
        return Ok(None);
    }
    let settled = |id: &str| {
        state.uploaded.contains(id)
            || state.unsendable.contains(id)
            || state.pulled.contains(id)
            || state.upload_retry.contains_key(id)
    };
    let mut items = Vec::new();
    let mut chosen = HashSet::new();
    let mut gone = Vec::new();

    let mut due: Vec<(&String, &UploadRetry)> = state.upload_retry.iter().filter(|(_, retry)| retry.at <= now).collect();
    due.sort_by_key(|(_, retry)| retry.at);
    for (id, _) in due {
        if items.len() >= PER_PASS {
            break;
        }
        if FAILED.failed_recently(id) {
            continue;
        }
        match store::get(app, id)? {
            Some(recording) => {
                chosen.insert(id.clone());
                items.push(recording);
            }
            None => gone.push(id.clone()),
        }
    }

    // A history smaller than the mark was rebuilt: look at all of it again.
    let mark = if state.upload_mark > store::last_row(app)? { 0 } else { state.upload_mark };
    let mut scanned = Vec::new();
    if items.len() < PER_PASS {
        for (row, id) in store::shared_after(app, mark, HISTORY_PAGE)? {
            if items.len() >= PER_PASS {
                break;
            }
            let seen = if settled(&id) || chosen.contains(&id) {
                Seen::Settled
            } else if FAILED.failed_recently(&id) {
                Seen::Held
            } else if let Some(recording) = store::get(app, &id)? {
                chosen.insert(id.clone());
                items.push(recording);
                Seen::Chosen
            } else {
                Seen::Settled
            };
            scanned.push((row, id, seen));
        }
    }

    // Once per launch and once a day: captures the mark passed by, such as one
    // whose state was lost.
    let mut swept = None;
    if items.len() < PER_PASS && deep_walk_due(state.swept_at, now) {
        let mut left = store::shared_upto(app, mark)?
            .into_iter()
            .filter(|id| !settled(id) && !chosen.contains(id) && !FAILED.failed_recently(id));
        let mut taken = Vec::new();
        while items.len() < PER_PASS {
            let Some(id) = left.next() else { break };
            if let Some(recording) = store::get(app, &id)? {
                taken.push(id);
                items.push(recording);
            }
        }
        if left.next().is_none() {
            swept = Some(taken);
        }
    }
    Ok(Some(Plan { items, scanned, mark, gone, swept }))
}

/// The new mark: past every row that was settled or handled this pass, up to
/// the first that was not.
fn advance_mark(mark: i64, scanned: &[(i64, String, Seen)], handled: &HashSet<String>) -> i64 {
    let mut mark = mark;
    for (row, id, seen) in scanned {
        match seen {
            Seen::Settled => {}
            Seen::Chosen if handled.contains(id) => {}
            _ => break,
        }
        mark = *row;
    }
    mark
}

fn retry_delay_ms(attempts: u32) -> i64 {
    (60_000_i64 << attempts.saturating_sub(1).min(16)).min(DAY_MS)
}

enum Sent {
    /// Uploaded, with its size.
    Uploaded(u64),
    /// The server will never take it.
    Unsendable,
}

enum Outcome {
    Uploaded,
    Unsendable,
    Retry,
}

/// The server asked to slow down until then (epoch ms).
#[derive(Debug)]
struct RateLimited(i64);
impl std::fmt::Display for RateLimited {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "upload capture: rate limited until {}", self.0)
    }
}
impl std::error::Error for RateLimited {}

/// The server does not take captures from this device.
#[derive(Debug)]
struct Refused;
impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("upload capture: this device may not sync captures")
    }
}
impl std::error::Error for Refused {}

async fn upload<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str) -> Result<usize> {
    let now = now_ms();
    let credential = fingerprint(token);
    let plan = {
        let app = app.clone();
        let credential = credential.clone();
        crate::sync::blocking(move || plan_uploads(&app, &credential, now)).await?
    };
    let Some(plan) = plan else { return Ok(0) };
    let unchanged = plan.items.is_empty()
        && plan.gone.is_empty()
        && plan.swept.is_none()
        && advance_mark(plan.mark, &plan.scanned, &HashSet::new()) == plan.mark;
    if unchanged {
        return Ok(0);
    }

    let started = Instant::now();
    let mut bytes = 0_u64;
    let mut outcomes = Vec::new();
    let mut halt: Option<anyhow::Error> = None;
    for recording in &plan.items {
        if !outcomes.is_empty() && (bytes >= PASS_BYTES || started.elapsed() >= PASS_TIME) {
            break;
        }
        // Marked before it is sent: an upload cut short is not first in line again.
        FAILED.mark(&recording.id);
        let outcome = match upload_one(api, token, recording).await {
            Ok(Sent::Uploaded(size)) => {
                bytes += size;
                Outcome::Uploaded
            }
            Ok(Sent::Unsendable) => Outcome::Unsendable,
            Err(error)
                if error.downcast_ref::<crate::sync::Unauthorized>().is_some()
                    || error.downcast_ref::<RateLimited>().is_some()
                    || error.downcast_ref::<Refused>().is_some() =>
            {
                // Nothing counts against this capture: the whole pass stops.
                FAILED.forget(&recording.id);
                halt = Some(error);
                break;
            }
            Err(error) if crate::sync::is_permanent(&error) => {
                tracing::warn!(id = %recording.id, "capture sync: the server will not take this capture: {error:#}");
                Outcome::Unsendable
            }
            Err(error) => {
                tracing::warn!(id = %recording.id, "capture sync: could not upload: {error:#}");
                Outcome::Retry
            }
        };
        outcomes.push((recording.id.clone(), outcome));
    }

    let sent = outcomes.iter().filter(|(_, outcome)| matches!(outcome, Outcome::Uploaded)).count();
    let handled: HashSet<String> = outcomes.iter().map(|(id, _)| id.clone()).collect();
    let mark = advance_mark(plan.mark, &plan.scanned, &handled);
    let swept = plan.swept.as_ref().is_some_and(|taken| taken.iter().all(|id| handled.contains(id)));
    let pause = halt.as_ref().and_then(|error| error.downcast_ref::<RateLimited>()).map(|limited| limited.0);
    let refused = halt.as_ref().is_some_and(|error| error.downcast_ref::<Refused>().is_some());
    let gone = plan.gone;
    // Written once per pass.
    let recorded = {
        let app = app.clone();
        crate::sync::blocking(move || {
            update_state(&app, |state| {
                for (id, outcome) in outcomes {
                    let attempts = state.upload_retry.remove(&id).map_or(0, |retry| retry.attempts) + 1;
                    match outcome {
                        Outcome::Uploaded => {
                            state.uploaded.insert(id);
                        }
                        Outcome::Unsendable => {
                            state.unsendable.insert(id);
                        }
                        Outcome::Retry if attempts >= UPLOAD_MAX_ATTEMPTS => {
                            state.unsendable.insert(id);
                        }
                        Outcome::Retry => {
                            state.upload_retry.insert(id, UploadRetry { at: now + retry_delay_ms(attempts), attempts });
                        }
                    }
                }
                for id in gone {
                    state.upload_retry.remove(&id);
                }
                state.upload_mark = mark;
                if swept {
                    state.swept_at = Some(now);
                }
                if sent > 0 {
                    state.refused = None;
                }
                if let Some(until) = pause {
                    state.paused_until = Some(until);
                }
                if refused {
                    state.refused = Some(Refusal { credential, at: now });
                }
            })
        })
        .await
    };
    match &recorded {
        // Recorded: the persisted schedule decides when each is tried again.
        Ok(()) => handled.iter().for_each(|id| FAILED.forget(id)),
        Err(error) => tracing::warn!("capture sync: could not record uploads: {error:#}"),
    }
    if let Some(until) = pause {
        tracing::info!(paused_for_s = (until - now) / 1_000, "capture sync: the server asked to slow down; uploads paused");
    }
    if refused {
        tracing::info!("capture sync: this device may not sync captures; uploads paused until the account changes");
    }
    match halt {
        Some(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => Err(error),
        _ => recorded.map(|()| sent),
    }
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

/// Enough time for a slow connection (about 1 Mbit/s) to send `bytes`.
fn upload_timeout(bytes: u64) -> Duration {
    Duration::from_secs(30 + bytes / (128 * 1024))
}

/// When a 429 says to try again: its Retry-After in seconds, between a minute and a day.
fn retry_after(response: &reqwest::Response, now: i64) -> i64 {
    let seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<i64>().ok());
    now + seconds.map_or(RATE_PAUSE_MS, |seconds| seconds.clamp(60, DAY_MS / 1_000) * 1_000)
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
        NOTE_TYPE => "md",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/heic" => "heic",
        _ => return None,
    })
}

/// The file a capture shares, its media type and the most the server takes.
fn shared_file(recording: &StoredRecording, folder: &Path) -> Option<(PathBuf, &'static str, u64)> {
    if recording.source == "note" {
        let path = folder.join("note.md");
        return path.is_file().then_some((path, NOTE_TYPE, MAX_NOTE_BYTES));
    }
    let path = image_file(folder)?;
    let kind = content_type(&path)?;
    Some((path, kind, MAX_IMAGE_BYTES))
}

/// Sends the capture straight from its file, never whole in memory.
async fn upload_one(api: &Api, token: &str, recording: &StoredRecording) -> Result<Sent> {
    let Some(folder) = recording.folder_path.as_deref().map(Path::new) else { return Ok(Sent::Unsendable) };
    let Some((path, kind, max_bytes)) = shared_file(recording, folder) else { return Ok(Sent::Unsendable) };
    let file = tokio::fs::File::open(&path).await.with_context(|| format!("open {}", path.display()))?;
    let size = file.metadata().await.with_context(|| format!("stat {}", path.display()))?.len();
    if size == 0 || size > max_bytes {
        return Ok(Sent::Unsendable);
    }
    let response = api
        .client
        .post(api.url("/api/devices/captures"))
        .bearer_auth(token)
        .timeout(upload_timeout(size))
        .header("content-type", kind)
        // The server needs the size up front (411 without it); a streamed body has none of its own.
        .header("content-length", size)
        .header("x-client-capture-id", &recording.id)
        .header("x-title", percent_encode(&recording.title))
        .header("x-captured-at", recording.started_at_ms.to_string())
        .body(reqwest::Body::from(file))
        .send()
        .await
        .context("upload capture")?;
    let status = response.status();
    if status.is_success() {
        return Ok(Sent::Uploaded(size));
    }
    match status.as_u16() {
        413 | 415 => Ok(Sent::Unsendable),
        429 => Err(anyhow!(RateLimited(retry_after(&response, now_ms())))),
        403 => Err(anyhow!(Refused)),
        _ => {
            let error = crate::sync::http_error("upload capture", response).await;
            // The body was cut off on the way: not this capture's fault.
            if format!("{error}").contains("upload interrupted") {
                Err(anyhow!("{error}"))
            } else {
                Err(error)
            }
        }
    }
}

/// Downloads a few images and notes from other devices. Returns how many arrived.
async fn pull<R: Runtime>(app: &AppHandle<R>, api: &Api, token: &str, root: &Path) -> Result<usize> {
    let state = {
        let app = app.clone();
        crate::sync::blocking(move || load_state(&app)).await?
    };
    let now = now_ms();
    let mut walk = ListWalk::new(state.scan_offset, deep_walk_due(state.walked_at, now), PAGE, MAX_PAGES);
    let mut wanted = Vec::new();
    while let Some(offset) = walk.next() {
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
        let ids: Vec<String> = listed.items.iter().map(CloudCapture::local_id).collect();
        let present = {
            let app = app.clone();
            crate::sync::blocking(move || store::existing(&app, &ids)).await?
        };
        let len = listed.items.len();
        let mut any_new = false;
        for capture in listed.items {
            let id = capture.local_id();
            if present.contains(&id)
                || state.dismissed.contains(&id)
                || extension(&capture.content_type).is_none()
                || FAILED.failed_recently(&id)
            {
                continue;
            }
            any_new = true;
            wanted.push(capture);
        }
        walk.record(len, any_new, wanted.len() >= PER_PASS);
    }

    let mut arrived = 0;
    for capture in wanted.into_iter().take(PER_PASS) {
        let id = capture.local_id();
        let body = match download(api, token, &capture.id).await {
            Ok(body) => body,
            Err(error) if error.downcast_ref::<crate::sync::Unauthorized>().is_some() => return Err(error),
            Err(error) => {
                tracing::warn!(id = %capture.id, "capture sync: skipped: {error:#}");
                FAILED.mark(&id);
                continue;
            }
        };
        let saved = {
            let app = app.clone();
            let root = root.to_path_buf();
            crate::sync::blocking(move || save(&app, &root, &capture, &body)).await
        };
        match saved {
            Ok(true) => arrived += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(%id, "capture sync: could not save: {error:#}");
                FAILED.mark(&id);
            }
        }
    }
    let (next_offset, wrapped) = (walk.next_scan_offset, walk.wrapped);
    if next_offset != state.scan_offset || wrapped {
        let app = app.clone();
        crate::sync::blocking(move || {
            update_state(&app, |state| {
                state.scan_offset = next_offset;
                if wrapped {
                    state.walked_at = Some(now);
                }
            })
        })
        .await?;
    }
    if arrived > 0 {
        if let Err(error) = app.emit("recordings:updated", ()) {
            tracing::warn!("capture sync: could not announce new captures: {error}");
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

/// Writes the capture's folder, marks it pulled, then adds it to the history.
/// Any failure removes the folder and the mark. Returns false when the user
/// deleted it on this Mac while the pull was running.
fn save<R: Runtime>(app: &AppHandle<R>, root: &Path, capture: &CloudCapture, body: &[u8]) -> Result<bool, String> {
    let id = capture.local_id();
    let ext = extension(&capture.content_type).ok_or("unsupported capture type")?;
    let note = capture.content_type == NOTE_TYPE;
    let (file, source, untitled) = if note { ("note.md".to_string(), "note", "Note") } else { (format!("image.{ext}"), "image", "Screenshot") };
    let started = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(capture.created_at).unwrap_or_else(chrono::Utc::now);
    let title = if capture.title.trim().is_empty() { untitled } else { capture.title.trim() };
    // A save cut short (the app quit) left its folder behind: use it again
    // rather than leave an orphan next to a second copy.
    let earlier = load_state(app)?
        .saving
        .get(&id)
        .filter(|folder| folder.parent() == Some(root) && folder.is_dir())
        .cloned();
    let folder = match earlier {
        Some(folder) => folder,
        None => {
            let folder = fs_writer::allocate_recording_folder(root, title, started)?;
            if let Err(error) = update_state(app, |state| state.saving.insert(id.clone(), folder.clone())) {
                let _ = std::fs::remove_dir_all(&folder);
                return Err(error);
            }
            folder
        }
    };
    let recording = StoredRecording {
        id: id.clone(),
        title: title.to_string(),
        started_at_ms: capture.created_at,
        duration_sec: 0,
        source: source.into(),
        status: "complete".into(),
        summary: None,
        // A note's text is its transcript, as for one written on this Mac.
        transcript: if note { Some(String::from_utf8_lossy(body).into_owned()) } else { capture.transcript.clone() }
            .filter(|text| !text.trim().is_empty()),
        notes: None,
        has_audio: false,
        has_video: false,
        folder_path: Some(folder.to_string_lossy().into_owned()),
    };
    let saved = std::fs::write(folder.join(file), body)
        .map_err(|error| error.to_string())
        .and_then(|()| serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string()))
        .and_then(|json| std::fs::write(folder.join("capture.json"), json).map_err(|error| error.to_string()))
        // Checked again under the same lock as the mark: a delete may have landed meanwhile.
        .and_then(|()| {
            update_state(app, |state| {
                state.saving.remove(&id);
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
                tracing::warn!(%id, "capture sync: could not unmark after a failed save: {error}");
            }
        }),
        other => other,
    };
    if !matches!(kept, Ok(true)) {
        let _ = std::fs::remove_dir_all(&folder);
        if let Err(error) = update_state(app, |state| state.saving.remove(&id)) {
            tracing::warn!(%id, "capture sync: could not forget a removed folder: {error}");
        }
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

    fn note(handle: &AppHandle<MockRuntime>, root: &Path, id: &str, text: &str) {
        let folder = root.join(format!("Note-{id}"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("note.md"), text).unwrap();
        store::append(handle, StoredRecording {
            id: id.into(),
            title: "Note".into(),
            started_at_ms: 1_700_000_000_000,
            duration_sec: 0,
            source: "note".into(),
            status: "complete".into(),
            summary: None,
            transcript: Some(text.into()),
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
    async fn a_note_is_uploaded_once_as_markdown() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let id = uuid::Uuid::new_v4().to_string();
        note(handle, &root, &id, "# Groceries\n\n- oat milk");
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .and(header("x-client-capture-id", id.as_str()))
            .and(header("content-type", "text/markdown"))
            .and(header("content-length", "23"))
            .and(header("x-title", "Note"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "cap_1" })))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(upload(handle, &api, "token").await.unwrap(), 1);
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0, "already uploaded");
    }

    #[tokio::test]
    async fn a_note_over_the_server_limit_is_never_sent() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let id = uuid::Uuid::new_v4().to_string();
        note(handle, &root, &id, &"x".repeat(MAX_NOTE_BYTES as usize + 1));
        let server = MockServer::start().await;
        Mock::given(method("POST")).and(path("/api/devices/captures")).respond_with(ResponseTemplate::new(201)).expect(0).mount(&server).await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0);
        assert!(load_state(handle).unwrap().unsendable.contains(&id));
    }

    #[tokio::test]
    async fn a_note_from_another_mac_arrives_as_a_note() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let theirs = uuid::Uuid::new_v4().to_string();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/devices/captures"))
            .respond_with(listing(serde_json::json!([
                { "id": "cap_note", "kind": "note", "clientCaptureId": theirs, "title": "Groceries", "contentType": "text/markdown", "bytes": 23, "createdAt": 1_700_000_100_000_i64, "deviceName": "MacBook Air" }
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/devices/captures/cap_note"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes("# Groceries\n\n- oat milk".as_bytes().to_vec()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST")).and(path("/api/devices/captures")).respond_with(ResponseTemplate::new(201)).expect(0).mount(&server).await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(run(handle, &api, "token", &root).await.unwrap(), 1);
        let pulled = store::get(handle, &theirs).unwrap().expect("in the history");
        assert_eq!(pulled.source, "note");
        assert_eq!(pulled.title, "Groceries");
        assert_eq!(pulled.transcript.as_deref(), Some("# Groceries\n\n- oat milk"));
        let folder = PathBuf::from(pulled.folder_path.unwrap());
        assert_eq!(std::fs::read_to_string(folder.join("note.md")).unwrap(), "# Groceries\n\n- oat milk");
        assert_eq!(origins(handle).get(&theirs).map(String::as_str), Some("MacBook Air"));
        assert_eq!(run(handle, &api, "token", &root).await.unwrap(), 0, "already here, and not sent back");
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

    #[tokio::test]
    async fn a_429_pauses_uploads_for_as_long_as_the_server_asks() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        screenshot(handle, &root, &first);
        screenshot(handle, &root, &second);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "120"))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        let before = now_ms();
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0);
        let state = load_state(handle).unwrap();
        let until = state.paused_until.expect("paused");
        assert!(until >= before + 120_000 && until <= now_ms() + 120_000);
        assert!(state.upload_retry.is_empty(), "nothing counts against the images");
        assert_eq!(state.upload_mark, 0);
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0, "still paused: nothing sent");
    }

    #[tokio::test]
    async fn a_403_pauses_uploads_until_the_account_changes() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let id = uuid::Uuid::new_v4().to_string();
        screenshot(handle, &root, &id);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .respond_with(ResponseTemplate::new(403))
            .expect(2)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0);
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0, "same account: not asked again");
        let state = load_state(handle).unwrap();
        let refused = state.refused.expect("refused");
        assert_ne!(refused.credential, "token", "only a hash of the token is kept");
        assert!(!std::fs::read_to_string(STATE.path(handle).unwrap()).unwrap().contains("\"token\""));
        assert_eq!(upload(handle, &api, "another-token").await.unwrap(), 0, "signed in again: tried again");
    }

    #[tokio::test]
    async fn the_mark_moves_past_uploaded_images_and_each_upload_says_its_size() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        for _ in 0..3 {
            screenshot(handle, &root, &uuid::Uuid::new_v4().to_string());
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .and(header("content-length", "9"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": "cap" })))
            .expect(3)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        assert_eq!(upload(handle, &api, "token").await.unwrap(), 3);
        assert_eq!(load_state(handle).unwrap().upload_mark, store::last_row(handle).unwrap());
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_server_error_schedules_a_later_retry_without_holding_the_mark_back() {
        let (app, scratch) = app();
        let handle = app.handle();
        let root = scratch.0.join("Recordings");
        let id = uuid::Uuid::new_v4().to_string();
        screenshot(handle, &root, &id);
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/devices/captures"))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        let api = Api::new(server.uri()).unwrap();

        let before = now_ms();
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0);
        let state = load_state(handle).unwrap();
        let retry = state.upload_retry.get(&id).expect("scheduled");
        assert_eq!(retry.attempts, 1);
        assert!(retry.at >= before + 60_000);
        assert_eq!(state.upload_mark, store::last_row(handle).unwrap());
        assert_eq!(upload(handle, &api, "token").await.unwrap(), 0, "not due yet");
        assert_eq!(retry_delay_ms(2), 120_000);
        assert_eq!(retry_delay_ms(40), DAY_MS);
    }
}
