use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::captions::{Caption, CaptionLog, CaptionStatus, CaptionsDone, Paste};
use crate::fs_writer;
use crate::store::{self, StoredRecording};

const START_TIMEOUT: Duration = Duration::from_secs(150);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
const NO_ACTIVE_CAPTURE: &str = "no active capture with that id";

#[derive(Default)]
pub struct Captures(pub Mutex<HashMap<String, Session>>, pub AtomicUsize);

impl Captures {
    pub fn is_busy(&self) -> bool {
        self.1.load(Ordering::SeqCst) > 0
            || self.0.lock().map(|m| !m.is_empty()).unwrap_or(false)
    }
}

pub struct Session {
    child: Child,
    stdin: ChildStdin,
    events: mpsc::Receiver<CaptureEvent>,
    out_path: PathBuf,
    started_at_ms: i64,
    mode: String,
    source: String,
    /// Settled on-device captions, when the engine was asked for them.
    captions: Arc<Mutex<CaptionLog>>,
    /// Dictation pastes its on-device text as soon as it stops; the recording
    /// still uploads like any other and the cloud transcript is its record.
    dictation: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureSession {
    pub session_id: String,
    pub started_at_ms: i64,
    pub mode: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum CaptureState {
    Idle,
    Recording { count: usize },
}

#[derive(Debug, Default, Deserialize)]
struct CaptureEvent {
    event: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, rename = "durationSec")]
    duration_sec: Option<f64>,
    #[serde(default)]
    index: Option<i64>,
    #[serde(default, rename = "startMs")]
    start_ms: Option<i64>,
    #[serde(default, rename = "durationMs")]
    duration_ms: Option<i64>,
    #[serde(default)]
    bytes: Option<i64>,
    #[serde(default)]
    track: Option<String>,
    #[serde(default, rename = "peakRms")]
    peak_rms: Option<f64>,
    #[serde(default, rename = "activeMs")]
    active_ms: Option<i64>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default, rename = "final")]
    is_final: Option<bool>,
    #[serde(default, rename = "endMs")]
    end_ms: Option<i64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    engine: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    dropped: Option<i64>,
    #[serde(default, rename = "timedOut")]
    timed_out: Option<bool>,
    #[serde(default)]
    failed: Option<bool>,
}

impl CaptureEvent {
    fn caption(&self, session_id: &str) -> Option<Caption> {
        (self.event == "caption").then_some(())?;
        Some(Caption {
            session_id: session_id.to_string(),
            track: self.track.clone().unwrap_or_else(|| "mic".to_string()),
            text: self.text.clone()?,
            is_final: self.is_final.unwrap_or(false),
            start_ms: self.start_ms.unwrap_or(0),
            end_ms: self.end_ms.or(self.start_ms).unwrap_or(0),
        })
    }

    fn caption_status(&self, session_id: &str) -> Option<CaptionStatus> {
        (self.event == "captions_status").then_some(())?;
        let live = self.status.as_deref() == Some("live");
        Some(CaptionStatus {
            session_id: session_id.to_string(),
            track: self.track.clone().unwrap_or_else(|| "mic".to_string()),
            live,
            detail: if live { self.engine.clone() } else { self.reason.clone() },
        })
    }

    fn captions_done(&self) -> Option<CaptionsDone> {
        (self.event == "captions_done").then_some(())?;
        Some(CaptionsDone {
            dropped: self.dropped.unwrap_or(0),
            timed_out: self.timed_out.unwrap_or(false),
            failed: self.failed.unwrap_or(false),
        })
    }
}

pub(crate) fn capture_bin(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("EAVESY_CAPTURE_BIN") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Ok(path);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(sidecar) = exe.parent().map(|d| d.join("SwiftAudio")) {
            if sidecar.exists() {
                return Ok(sidecar);
            }
        }
    }
    if let Ok(resource) =
        app.path().resolve("SwiftAudio", tauri::path::BaseDirectory::Resource)
    {
        if resource.exists() {
            return Ok(resource);
        }
    }
    Err("capture engine not found — build swift-audio and set EAVESY_CAPTURE_BIN, \
         or reinstall the app"
        .to_string())
}

fn captures_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("captures");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create captures dir: {e}"))?;
    Ok(dir)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub mic: bool,
    pub mic_asked: bool,
    pub screen: bool,
    pub accessibility: bool,
    /// Speech Recognition, for live captions and the dictation paste.
    #[serde(default)]
    pub speech: bool,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

fn accessibility_granted() -> bool {
    #[cfg(target_os = "macos")]
    return unsafe { AXIsProcessTrusted() };
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command(async)]
pub fn check_permissions(
    app: AppHandle,
    need_screen: Option<bool>,
    prompt: Option<bool>,
    need_speech: Option<bool>,
) -> Result<Permissions, String> {
    let result = check_permissions_inner(
        app,
        need_screen.unwrap_or(true),
        prompt.unwrap_or(true),
        need_speech.unwrap_or(false),
    );
    if let Err(error) = &result {
        crate::telemetry::capture("capture.permissions", error);
    }
    result
}

fn check_permissions_inner(
    app: AppHandle,
    need_screen: bool,
    prompt: bool,
    need_speech: bool,
) -> Result<Permissions, String> {
    let bin = capture_bin(&app)?;
    let mut args = vec!["--preflight"];
    if need_speech && prompt {
        args.push("--need-speech");
    }
    if need_screen && prompt {
        args.push("--need-screen");
    }
    if !prompt {
        args.push("--no-prompt");
    }
    let mut permissions = run_preflight(&bin, &args)?;
    if !permissions.screen {
        std::thread::sleep(Duration::from_millis(700));
        if let Ok(again) = run_preflight(&bin, &["--preflight", "--no-prompt"]) {
            permissions.screen = again.screen;
            permissions.mic |= again.mic;
            permissions.speech |= again.speech;
        }
    }
    permissions.accessibility = accessibility_granted();
    Ok(permissions)
}

fn run_preflight(bin: &std::path::Path, args: &[&str]) -> Result<Permissions, String> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("could not run the permission check: {e}"))?;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Line {
        event: String,
        #[serde(default)]
        mic: bool,
        #[serde(default)]
        mic_asked: bool,
        #[serde(default)]
        screen: bool,
        #[serde(default)]
        speech: bool,
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Ok(parsed) = serde_json::from_str::<Line>(line) {
            if parsed.event == "permissions" {
                return Ok(Permissions {
                    mic: parsed.mic,
                    mic_asked: parsed.mic_asked,
                    screen: parsed.screen,
                    accessibility: false,
                    speech: parsed.speech,
                });
            }
        }
    }
    Err(format!(
        "permission check exited with {} and produced no result: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[tauri::command(async)]
pub fn start_capture(
    app: AppHandle,
    state: State<'_, Captures>,
    source: Option<String>,
    context_blurb: Option<String>,
    dictation: Option<bool>,
) -> Result<CaptureSession, String> {
    let source = source.unwrap_or_else(|| "mixed".to_string());
    let dictation = dictation.unwrap_or(false) && source == "mic";
    let result = spawn_capture(&app, &state, "audio", &source, false, context_blurb.as_deref(), dictation);
    if let Err(error) = &result {
        crate::telemetry::capture("capture.start_audio", error);
    }
    result
}

#[tauri::command(async)]
pub fn start_screen_capture(
    app: AppHandle,
    state: State<'_, Captures>,
    mic: Option<bool>,
) -> Result<CaptureSession, String> {
    let result = spawn_capture(&app, &state, "screen", "system", mic.unwrap_or(false), None, false);
    if let Err(error) = &result {
        crate::telemetry::capture("capture.start_screen", error);
    }
    result
}

fn spawn_capture(
    app: &AppHandle,
    state: &State<'_, Captures>,
    mode: &str,
    source: &str,
    mic: bool,
    context_blurb: Option<&str>,
    dictation: bool,
) -> Result<CaptureSession, String> {
    let bin = capture_bin(app)?;
    let id = uuid::Uuid::new_v4().to_string();
    let started_at_ms = now_ms();
    let title = default_title(source, mode == "screen");
    let out_path = if mode == "screen" {
        captures_dir(app)?.join(format!("{id}.mp4"))
    } else {
        let started = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(started_at_ms)
            .unwrap_or_else(chrono::Utc::now);
        let folder = fs_writer::allocate_recording_folder(
            &fs_writer::recordings_root(app)?,
            &title,
            started,
        )?;
        folder.join("audio.m4a")
    };
    let segment_dir = captures_dir(app)?.join(&id).join("segments");
    let discard = || {
        let _ = std::fs::remove_file(&out_path);
        if mode == "audio" {
            if let Some(folder) = out_path.parent() {
                let _ = std::fs::remove_dir(folder);
            }
        }
        if let Some(queue) = segment_dir.parent() {
            let _ = std::fs::remove_dir_all(queue);
        }
    };

    let log = captures_dir(app).ok().and_then(|dir| {
        rotate_log(&dir.join("capture.log"));
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("capture.log"))
            .ok()
    });

    let mut cmd = Command::new(&bin);
    cmd.arg("--mode")
        .arg(mode)
        .arg("--out")
        .arg(&out_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(match log {
            Some(file) => Stdio::from(file),
            None => Stdio::null(),
        });
    if mode == "screen" {
        cmd.arg("--mic").arg(if mic { "true" } else { "false" });
    } else {
        // Captions run in the system language; on-device recognition either
        // supports it or says it doesn't. Dictation always runs them for its
        // paste; meetings and voice notes only with the Live captions setting.
        if dictation {
            cmd.arg("--captions").arg("mic");
        } else if crate::settings::load(app).live_captions() {
            cmd.arg("--captions").arg("all");
        }
        if let Err(e) = std::fs::create_dir_all(&segment_dir) {
            discard();
            return Err(format!("could not create segment queue: {e}"));
        }
        cmd.arg("--source")
            .arg(source)
            .arg("--segment-dir")
            .arg(&segment_dir)
            .arg("--segment-sec")
            .arg(crate::settings::load(app).segment_sec().to_string());
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            discard();
            return Err(format!("could not start capture engine: {e}"));
        }
    };
    let stdin = child.stdin.take().ok_or("capture stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("capture stdout unavailable")?;
    let reader = BufReader::new(stdout);

    state.1.fetch_add(1, Ordering::SeqCst);

    let reader = match await_ready(reader, START_TIMEOUT) {
        Ok(r) => r,
        Err(msg) => {
            let msg = match child.try_wait() {
                Ok(Some(status)) => format!("{msg} (capture engine exit status: {status})"),
                _ => msg,
            };
            let _ = child.kill();
            let _ = child.wait();
            state.1.fetch_sub(1, Ordering::SeqCst);
            discard();
            return Err(msg);
        }
    };

    if mode == "audio" {
        if let Err(error) = crate::sqlite::begin_recording(
            app,
            &id,
            &out_path,
            &segment_dir,
            source,
            &title,
            context_blurb,
            started_at_ms,
        ) {
            let _ = child.kill();
            let _ = child.wait();
            state.1.fetch_sub(1, Ordering::SeqCst);
            discard();
            return Err(error);
        }
    }
    let captions = Arc::new(Mutex::new(CaptionLog::default()));
    let events = stream_events(app.clone(), id.clone(), reader, captions.clone());
    state.0.lock().unwrap().insert(
        id.clone(),
        Session {
            child,
            stdin,
            events,
            out_path,
            started_at_ms,
            mode: mode.to_string(),
            source: source.to_string(),
            captions,
            dictation,
        },
    );
    state.1.fetch_sub(1, Ordering::SeqCst);

    if mode == "audio" && source == "mic" {
        crate::dictation::arm(&id);
    }

    crate::hud::set_state(
        app,
        crate::hud::HudState {
            phase: crate::hud::Phase::Recording,
            session_id: Some(id.clone()),
            mode: Some(mode.to_string()),
            started_at_ms: Some(started_at_ms),
            message: None,
        },
    );

    Ok(CaptureSession {
        session_id: id,
        started_at_ms,
        mode: mode.to_string(),
        source: source.to_string(),
    })
}

fn await_ready(
    reader: BufReader<ChildStdout>,
    timeout: Duration,
) -> Result<BufReader<ChildStdout>, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = reader;
        let result = loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    break Err(
                        "capture engine exited before it was ready (check permissions)".to_string(),
                    )
                }
                Ok(_) => {
                    if let Ok(ev) = serde_json::from_str::<CaptureEvent>(line.trim()) {
                        match ev.event.as_str() {
                            "ready" => break Ok(()),
                            "error" => {
                                break Err(ev.message.unwrap_or_else(|| "capture failed".to_string()))
                            }
                            _ => continue,
                        }
                    }
                }
                Err(e) => break Err(format!("capture engine read failed: {e}")),
            }
        };
        let _ = tx.send(result.map(|()| reader));
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(reader)) => Ok(reader),
        Ok(Err(msg)) => Err(msg),
        Err(_) => Err(
            "timed out starting the recording — the microphone/screen permission prompt may not \
             have been answered. Grant access in System Settings and try again."
                .to_string(),
        ),
    }
}

fn stream_events(
    app: AppHandle,
    session_id: String,
    mut reader: BufReader<ChildStdout>,
    captions: Arc<Mutex<CaptionLog>>,
) -> mpsc::Receiver<CaptureEvent> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
    let mut warning: Option<String> = None;
    let writer = crate::live_transcript::CaptionWriter::spawn(app.clone());
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let Ok(ev) = serde_json::from_str::<CaptureEvent>(line.trim()) else {
                    continue;
                };
                if ev.event == "segment" {
                    if let (Some(path), Some(index), Some(start_ms), Some(duration_ms), Some(bytes)) = (
                        ev.path.clone(),
                        ev.index,
                        ev.start_ms,
                        ev.duration_ms,
                        ev.bytes,
                    ) {
                        let segment = crate::sqlite::SegmentManifest {
                            path,
                            index,
                            track: ev.track.clone().unwrap_or_else(|| "mixed".to_string()),
                            start_ms,
                            duration_ms,
                            bytes,
                            peak_rms: ev.peak_rms,
                            active_ms: ev.active_ms,
                        };
                        if let Err(error) = crate::sqlite::record_segment(&app, &session_id, &segment) {
                            eprintln!("could not queue segment {index}: {error}");
                        } else {
                            crate::sync::wake();
                            let _ = app.emit("recording:segment", index);
                        }
                    }
                    continue;
                }
                if let Some(caption) = ev.caption(&session_id) {
                    captions.lock().unwrap_or_else(|e| e.into_inner()).record(&caption);
                    if caption.is_final && !writer.push(caption.clone()) && writer.dropped() == 1 {
                        eprintln!("live captions: storing is behind; dropping finals until it catches up");
                    }
                    let _ = app.emit("recording:caption", &caption);
                    continue;
                }
                if let Some(status) = ev.caption_status(&session_id) {
                    if !status.live {
                        eprintln!("live captions off: {}", status.detail.as_deref().unwrap_or("unavailable"));
                    }
                    captions.lock().unwrap_or_else(|e| e.into_inner()).note_status(&status);
                    let _ = app.emit("recording:captions_status", &status);
                    continue;
                }
                if let Some(done) = ev.captions_done() {
                    captions.lock().unwrap_or_else(|e| e.into_inner()).finish(done);
                    continue;
                }
                if ev.event == "segment_error" {
                    let message = ev.message.unwrap_or_else(|| "segment finalization failed".to_string());
                    eprintln!("segment could not be written: {message}");
                    crate::telemetry::capture("capture.segment_failed", &message);
                    continue;
                }
                if ev.event == "warning" {
                    let message = ev.message.unwrap_or_else(|| "capture stopped".to_string());
                    crate::telemetry::capture("capture.stopped_early", &message);
                    warning = Some(message);
                    continue;
                }
                if matches!(ev.event.as_str(), "done" | "error") {
                    let _ = tx.send(ev);
                    break;
                }
            }
            Err(error) => {
                let _ = tx.send(CaptureEvent {
                    event: "error".to_string(),
                    message: Some(format!("capture engine read failed: {error}")),
                    ..Default::default()
                });
                break;
            }
        }
    }
    drop(tx);
    stopped_on_its_own(&app, &session_id, warning);
    });
    rx
}

fn stopped_on_its_own(app: &AppHandle, session_id: &str, warning: Option<String>) {
    let captures = app.state::<Captures>();
    if !captures.0.lock().unwrap().contains_key(session_id) {
        return;
    }
    let reason = warning.unwrap_or_else(|| "the capture engine stopped unexpectedly".to_string());
    let (title, body) = match stop_capture_inner(app.clone(), captures, session_id.to_string()) {
        Ok(_) => ("Recording stopped early", format!("Everything up to that point was saved. Reason: {reason}")),
        Err(error) if error == NO_ACTIVE_CAPTURE => return,
        Err(error) => {
            show_stop_failed(app, session_id, &error);
            ("Recording failed", error)
        }
    };
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

fn await_done(
    events: mpsc::Receiver<CaptureEvent>,
    timeout: Duration,
) -> Result<(f64, Option<String>), String> {
    match events.recv_timeout(timeout) {
        Ok(ev) if ev.event == "done" => Ok((ev.duration_sec.unwrap_or(0.0), ev.path)),
        Ok(ev) => Err(ev.message.unwrap_or_else(|| "capture failed".to_string())),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "the capture engine did not finish saving within {}s",
            timeout.as_secs()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Ok((0.0, None)),
    }
}

#[tauri::command(async)]
pub fn stop_capture(
    app: AppHandle,
    state: State<'_, Captures>,
    session_id: String,
) -> Result<StoredRecording, String> {
    let result = stop_capture_inner(app.clone(), state, session_id.clone());
    if let Err(error) = &result {
        crate::telemetry::capture("capture.stop", error);
        if error != NO_ACTIVE_CAPTURE {
            show_stop_failed(&app, &session_id, error);
        }
    }
    result
}

fn show_stop_failed(app: &AppHandle, session_id: &str, error: &str) {
    crate::hud::set_state(
        app,
        crate::hud::HudState {
            phase: crate::hud::Phase::Failed,
            session_id: Some(session_id.to_string()),
            mode: None,
            started_at_ms: None,
            message: Some(error.to_string()),
        },
    );
}

fn stop_capture_inner(
    app: AppHandle,
    state: State<'_, Captures>,
    session_id: String,
) -> Result<StoredRecording, String> {
    let session = state
        .0
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or(NO_ACTIVE_CAPTURE)?;
    let Session {
        mut child,
        mut stdin,
        events,
        out_path,
        started_at_ms,
        mode,
        source,
        captions,
        dictation,
    } = session;

    let reserved_audio_folder = (mode == "audio")
        .then(|| out_path.parent().map(PathBuf::from))
        .flatten();

    let _ = writeln!(stdin, "stop");
    let _ = stdin.flush();

    let result = match await_done(events, STOP_TIMEOUT) {
        Ok(done) => finish_stopped_capture(
            &app,
            &session_id,
            &mut child,
            done,
            out_path,
            started_at_ms,
            &mode,
            &source,
            reserved_audio_folder,
            dictation.then_some(captions),
        ),
        Err(msg) => {
            crate::telemetry::capture("capture failed to finalize", &msg);
            let _ = child.kill();
            let _ = child.wait();
            Err(msg)
        }
    };
    match result {
        Err(error) if mode == "audio" => Err(salvage_after_failed_stop(&app, &session_id, error)),
        result => result,
    }
}

/// A stop that failed still leaves sealed segments, and sometimes a usable archive.
/// Keep whatever can be kept now instead of waiting for the next launch, and say
/// what happened in the error the HUD shows.
fn salvage_after_failed_stop(app: &AppHandle, session_id: &str, error: String) -> String {
    let message = match crate::recovery::recover_or_defer(app, session_id, &error).ok_or(()) {
        Ok(crate::recovery::Salvage::Archive) => {
            format!("{error}. The saved audio will still be uploaded and transcribed.")
        }
        Ok(crate::recovery::Salvage::Segments(_)) => format!(
            "{error}. The final audio file was lost, but the parts already recorded will be transcribed."
        ),
        Ok(crate::recovery::Salvage::Nothing) => {
            format!("{error}. No audio could be saved from this recording.")
        }
        Err(()) => format!("{error}. Eavesy will finish saving it as soon as it can."),
    };
    crate::sync::wake();
    if let Err(emit_error) = app.emit("recordings:updated", ()) {
        eprintln!("could not announce recovered recording: {emit_error}");
    }
    message
}

#[allow(clippy::too_many_arguments)]
fn finish_stopped_capture(
    app: &AppHandle,
    session_id: &str,
    child: &mut Child,
    (duration_sec, path_override): (f64, Option<String>),
    out_path: PathBuf,
    started_at_ms: i64,
    mode: &str,
    source: &str,
    reserved_audio_folder: Option<PathBuf>,
    dictation: Option<Arc<Mutex<CaptionLog>>>,
) -> Result<StoredRecording, String> {
    let app = app.clone();
    let session_id = session_id.to_string();
    let source = source.to_string();
    let final_src = path_override
        .map(PathBuf::from)
        .unwrap_or_else(|| out_path.clone());
    reap_child(child);

    let is_screen = mode == "screen";
    let title = default_title(&source, is_screen);
    let started = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(started_at_ms)
        .unwrap_or_else(chrono::Utc::now);
    let root = fs_writer::recordings_root(&app)?;
    let folder = if is_screen {
        fs_writer::allocate_recording_folder(&root, &title, started)?
    } else {
        reserved_audio_folder.ok_or("audio capture lost its reserved recording folder")?
    };

    let rec = StoredRecording {
        id: session_id.clone(),
        title,
        started_at_ms,
        duration_sec: duration_sec.round() as i64,
        source: if is_screen {
            "screen".to_string()
        } else {
            source.clone()
        },
        status: "processing".to_string(),
        summary: None,
        transcript: None,
        notes: None,
        has_audio: true,
        has_video: is_screen,
        folder_path: folder.to_str().map(|s| s.to_string()),
    };
    let audio_dest = finalize_recording_folder(Some(&app), &final_src, &folder, &rec)?;
    store::append(&app, rec.clone())?;
    let _ = app.emit("recordings:updated", ());

    crate::hud::set_state(
        &app,
        crate::hud::HudState {
            phase: if is_screen {
                crate::hud::Phase::Done
            } else {
                crate::hud::Phase::Saved
            },
            session_id: Some(rec.id.clone()),
            mode: Some(if is_screen { "video" } else { "audio" }.to_string()),
            started_at_ms: None,
            message: None,
        },
    );

    if is_screen {
        crate::transcribe::spawn(
            app.clone(),
            rec.id.clone(),
            audio_dest,
            Some(folder.clone()),
            false,
        );
    } else {
        let archive_bytes = std::fs::metadata(&audio_dest)
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        crate::sqlite::finish_recording(
            &app,
            &session_id,
            &audio_dest,
            (duration_sec * 1000.0).round() as i64,
            archive_bytes,
        )?;
        crate::sync::wake();
        if let Some(captions) = dictation {
            let pasting = crate::dictation::is_armed(&rec.id);
            paste_dictation(&app, &rec.id, audio_dest, &captions);
            if pasting {
                // The text goes back into the app the user was in; don't take focus from it.
                return Ok(rec);
            }
        }
    }

    crate::commands::show_launcher(app.clone());
    Ok(rec)
}

/// Pastes a dictation the moment it stops: the on-device text when it can be
/// trusted, otherwise a quick cloud Whisper pass on the clip. Either way the
/// recording is already queued to upload, and the cloud transcript stays its
/// record; if both of these fail, that transcript is pasted when it is ready.
fn paste_dictation(app: &AppHandle, session_id: &str, audio: PathBuf, captions: &Mutex<CaptionLog>) {
    let decision = captions.lock().unwrap_or_else(|e| e.into_inner()).paste();
    match decision {
        Paste::OnDevice(text) => {
            crate::dictation::deliver(app, session_id, &text);
            crate::hud::set_state(
                app,
                crate::hud::HudState {
                    phase: crate::hud::Phase::Done,
                    session_id: Some(session_id.to_string()),
                    mode: None,
                    started_at_ms: None,
                    message: Some(text),
                },
            );
        }
        Paste::Whisper(reason) => {
            eprintln!("dictation: using Whisper for the paste ({reason})");
            crate::transcribe::paste_with_whisper(app.clone(), session_id.to_string(), audio);
        }
    }
}

fn finalize_recording_folder(
    app: Option<&AppHandle>,
    source: &std::path::Path,
    folder: &std::path::Path,
    recording: &StoredRecording,
) -> Result<PathBuf, String> {
    let audio_destination = folder.join("audio.m4a");
    let video_destination = folder.join("screen.mp4");

    if recording.has_video {
        let audio_source = source.with_extension("m4a");
        validate_media_file(source, "screen recording")?;
        validate_media_file(&audio_source, "screen recording audio")?;
        move_recording_file(source, &video_destination)?;
        move_recording_file(&audio_source, &audio_destination)?;
        validate_media_file(&video_destination, "saved screen recording")?;
    } else {
        validate_media_file(source, "recording audio")?;
        move_recording_file(source, &audio_destination)?;
    }
    validate_media_file(&audio_destination, "saved recording audio")?;
    fs_writer::persist_recording_artifacts(app, folder, recording, None, None)?;
    Ok(audio_destination)
}

fn validate_media_file(path: &std::path::Path, label: &str) -> Result<(), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("{label} is unavailable at {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(format!(
            "{label} is empty or invalid at {} — the capture was not finalized",
            path.display()
        ));
    }
    Ok(())
}

fn move_recording_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("{} has no destination folder", destination.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| {
        format!(
            "could not create recording folder {}: {error}",
            parent.display()
        )
    })?;

    if source == destination {
        return sync_file_and_parent(destination);
    }

    std::fs::File::open(source)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("could not flush recording {}: {error}", source.display()))?;

    if std::fs::rename(source, destination).is_ok() {
        sync_parent_directory(parent);
        return Ok(());
    }

    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("recording"),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        std::fs::copy(source, &temporary).map_err(|error| {
            format!(
                "could not copy recording to {}: {error}",
                destination.display()
            )
        })?;
        std::fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("could not flush recording copy: {error}"))?;
        std::fs::rename(&temporary, destination)
            .map_err(|error| format!("could not publish recording copy: {error}"))?;
        sync_parent_directory(parent);
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        return result;
    }

    let _ = std::fs::remove_file(source);
    Ok(())
}

fn sync_file_and_parent(path: &std::path::Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("could not flush recording {}: {error}", path.display()))?;
    if let Some(parent) = path.parent() {
        sync_parent_directory(parent);
    }
    Ok(())
}

fn sync_parent_directory(parent: &std::path::Path) {
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
}

#[tauri::command]
pub fn capture_state(state: State<'_, Captures>) -> CaptureState {
    let count = state.0.lock().unwrap().len();
    if count == 0 {
        CaptureState::Idle
    } else {
        CaptureState::Recording { count }
    }
}

/// The capture engine appends its stderr to capture.log for every recording; keep
/// one previous generation once it passes `CAPTURE_LOG_LIMIT` instead of growing forever.
const CAPTURE_LOG_LIMIT: u64 = 5 * 1024 * 1024;

fn rotate_log(path: &std::path::Path) {
    if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > CAPTURE_LOG_LIMIT) {
        if let Err(error) = std::fs::rename(path, path.with_extension("log.1")) {
            eprintln!("could not rotate {}: {error}", path.display());
        }
    }
}

fn default_title(source: &str, is_screen: bool) -> String {
    if is_screen {
        "Screen recording".to_string()
    } else {
        match source {
            "mic" => "Voice memo".to_string(),
            _ => "Meeting recording".to_string(),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn reap_child(child: &mut Child) {
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_log_is_rotated_once_it_is_large() {
        let dir = std::env::temp_dir().join(format!("eavesy-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("capture.log");
        std::fs::write(&log, b"small").unwrap();
        rotate_log(&log);
        assert!(log.exists());
        std::fs::write(&log, vec![b'x'; CAPTURE_LOG_LIMIT as usize + 1]).unwrap();
        rotate_log(&log);
        assert!(!log.exists());
        assert!(dir.join("capture.log.1").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn caption_lines_from_the_engine_become_captions() {
        let line = r#"{"endMs":2050,"event":"caption","final":true,"startMs":1200,"text":"hello","track":"mic"}"#;
        let ev: CaptureEvent = serde_json::from_str(line).unwrap();
        assert_eq!(
            ev.caption("rec"),
            Some(Caption {
                session_id: "rec".into(),
                track: "mic".into(),
                text: "hello".into(),
                is_final: true,
                start_ms: 1200,
                end_ms: 2050,
            })
        );
        assert_eq!(ev.caption_status("rec"), None);
        let partial: CaptureEvent =
            serde_json::from_str(r#"{"event":"caption","startMs":0,"text":"hel","track":"system"}"#).unwrap();
        let partial = partial.caption("rec").unwrap();
        assert!(!partial.is_final);
        assert_eq!(partial.track, "system");
        let segment: CaptureEvent = serde_json::from_str(r#"{"event":"segment","index":1}"#).unwrap();
        assert_eq!(segment.caption("rec"), None);
    }

    #[test]
    fn captions_done_lines_say_how_captions_ended() {
        let ev: CaptureEvent = serde_json::from_str(
            r#"{"dropped":2,"event":"captions_done","failed":false,"timedOut":true,"track":"mic"}"#,
        )
        .unwrap();
        assert_eq!(ev.captions_done(), Some(CaptionsDone { dropped: 2, timed_out: true, failed: false }));
        assert_eq!(ev.caption("rec"), None);
    }

    #[test]
    fn caption_status_lines_say_whether_captions_run() {
        let live: CaptureEvent = serde_json::from_str(
            r#"{"engine":"speech-analyzer","event":"captions_status","status":"live","track":"mic"}"#,
        )
        .unwrap();
        let live = live.caption_status("rec").unwrap();
        assert!(live.live);
        assert_eq!(live.detail.as_deref(), Some("speech-analyzer"));
        let off: CaptureEvent = serde_json::from_str(
            r#"{"event":"captions_status","reason":"speech recognition not authorized","status":"unavailable","track":"mic"}"#,
        )
        .unwrap();
        let off = off.caption_status("rec").unwrap();
        assert!(!off.live);
        let mut log = CaptionLog::default();
        log.note_status(&off);
        log.finish(CaptionsDone { dropped: 0, timed_out: false, failed: false });
        assert_eq!(log.paste(), Paste::Whisper("captions unavailable: speech recognition not authorized".into()));
    }

    #[test]
    fn stop_timeout_is_an_error_not_an_empty_success() {
        let (_tx, rx) = mpsc::channel::<CaptureEvent>();
        let result = await_done(rx, Duration::from_millis(10));
        assert!(result.unwrap_err().contains("did not finish saving"));
    }

    fn sample_recording(folder: &std::path::Path, has_video: bool) -> StoredRecording {
        StoredRecording {
            id: "meeting-1".to_string(),
            title: "Design review".to_string(),
            started_at_ms: 1_751_808_600_000,
            duration_sec: 125,
            source: if has_video { "screen" } else { "mixed" }.to_string(),
            status: "processing".to_string(),
            summary: None,
            transcript: None,
            notes: None,
            has_audio: true,
            has_video,
            folder_path: Some(folder.to_string_lossy().into_owned()),
        }
    }

    #[test]
    fn finalizes_audio_capture_as_a_complete_five_file_folder() {
        let root = std::env::temp_dir().join(format!("eavesy-finalize-{}", uuid::Uuid::new_v4()));
        let folder = root.join("recording");
        let source = folder.join("audio.m4a");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&source, b"non-empty audio").unwrap();
        let recording = sample_recording(&folder, false);

        let audio = finalize_recording_folder(None, &source, &folder, &recording).unwrap();

        assert_eq!(audio, folder.join("audio.m4a"));
        for filename in [
            "audio.m4a",
            "transcript.md",
            "summary.md",
            "notes.md",
            "meeting.json",
        ] {
            assert!(folder.join(filename).is_file(), "missing {filename}");
        }
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(folder.join("meeting.json")).unwrap()).unwrap();
        assert_eq!(manifest["files"]["audio"], "audio.m4a");
        assert!(manifest["files"]["video"].is_null());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finalizes_screen_capture_only_after_video_and_audio_are_ready() {
        let root =
            std::env::temp_dir().join(format!("eavesy-screen-success-{}", uuid::Uuid::new_v4()));
        let source = root.join("capture.mp4");
        let audio_source = root.join("capture.m4a");
        let folder = root.join("recording");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, b"non-empty video").unwrap();
        std::fs::write(&audio_source, b"non-empty audio").unwrap();
        let recording = sample_recording(&folder, true);

        finalize_recording_folder(None, &source, &folder, &recording).unwrap();

        assert!(!source.exists());
        assert!(!audio_source.exists());
        assert_eq!(std::fs::read(folder.join("screen.mp4")).unwrap(), b"non-empty video");
        assert_eq!(std::fs::read(folder.join("audio.m4a")).unwrap(), b"non-empty audio");
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(folder.join("meeting.json")).unwrap()).unwrap();
        assert_eq!(manifest["files"]["audio"], "audio.m4a");
        assert_eq!(manifest["files"]["video"], "screen.mp4");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_both_screen_media_files_before_moving_either() {
        let root =
            std::env::temp_dir().join(format!("eavesy-screen-finalize-{}", uuid::Uuid::new_v4()));
        let source = root.join("capture.mp4");
        let folder = root.join("recording");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, b"non-empty video").unwrap();
        let recording = sample_recording(&folder, true);

        let error = finalize_recording_folder(None, &source, &folder, &recording).unwrap_err();

        assert!(error.contains("screen recording audio is unavailable"));
        assert!(source.is_file(), "the valid video must remain recoverable");
        assert!(!folder.join("screen.mp4").exists());
        assert!(!folder.join("meeting.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_an_empty_audio_capture_before_writing_a_manifest() {
        let root =
            std::env::temp_dir().join(format!("eavesy-empty-finalize-{}", uuid::Uuid::new_v4()));
        let source = root.join("capture.m4a");
        let folder = root.join("recording");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, b"").unwrap();
        let recording = sample_recording(&folder, false);

        let error = finalize_recording_folder(None, &source, &folder, &recording).unwrap_err();

        assert!(error.contains("recording audio is empty or invalid"));
        assert!(source.is_file());
        assert!(!folder.join("meeting.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
