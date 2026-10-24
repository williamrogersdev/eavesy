// tauri-nspanel re-exports the legacy `cocoa`/`objc` crates: their APIs are deprecated and
// their `msg_send!` macros trip `unexpected_cfgs`. Moving to objc2 is a separate migration.
#![allow(deprecated, unexpected_cfgs)]

use serde::Serialize;
use crate::settings::{self, HudFrame, Settings};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Saved,
    Recording,
    /// Stopped, and the words are on their way.
    Transcribing,
    Done,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HudState {
    pub phase: Phase,
    pub session_id: Option<String>,
    pub mode: Option<String>,
    pub started_at_ms: Option<i64>,
    pub message: Option<String>,
    /// Where the words went when they could not be pasted ("Copied — …"),
    /// shown apart from `message`, which is then the words themselves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

impl HudState {
    pub fn idle() -> Self { Self { phase: Phase::Idle, session_id: None, mode: None, started_at_ms: None, message: None, notice: None } }

    /// Recording with a session: the engine is running and the mic is live.
    pub fn is_live(&self) -> bool {
        self.phase == Phase::Recording && self.session_id.is_some()
    }
}
static TRANSITION: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// What the control shows. Written in exactly one place, [`set_state_if`],
/// under [`TRANSITION`]: that is what lets a check-then-set there be atomic.
static CURRENT: std::sync::Mutex<Option<HudState>> = std::sync::Mutex::new(None);
pub fn current() -> HudState {
    CURRENT.lock().unwrap_or_else(|error| error.into_inner()).clone().unwrap_or_else(HudState::idle)
}

pub fn set_state(app: &AppHandle, state: HudState) {
    set_state_if(app, state, |_| true);
}

/// Moves `session_id` on to `state`, but only while it is still the session
/// on screen and in one of the phases `from` (say, still Transcribing), so a
/// late result never reopens a capture the user dismissed or has moved past.
/// Returns whether it did.
pub fn advance_from(app: &AppHandle, session_id: &str, from: &[Phase], state: HudState) -> bool {
    set_state_if(app, state, |now| now.session_id.as_deref() == Some(session_id) && from.contains(&now.phase))
}

/// [`set_state`], only when `allowed` says yes to the state on screen now.
/// The check and the change happen in one step: no other state can come in
/// between. `allowed` gets the current state; it must not call [`current`].
pub fn set_state_if(app: &AppHandle, state: HudState, allowed: impl FnOnce(&HudState) -> bool) -> bool {
    // Stop, completion and dismissal can arrive on different threads. Keep
    // their renderer events in the same order as CURRENT, which sizes the
    // native window. Otherwise a result can render inside an idle-sized pill.
    let _transition = TRANSITION.lock().unwrap_or_else(|error| error.into_inner());
    if !allowed(&current()) {
        return false;
    }
    let previous = CURRENT.lock().unwrap_or_else(|error| error.into_inner()).replace(state.clone());
    {
        // An open drawer belongs to the dictation it was opened on. It may be
        // opened while the words are still being heard or written down (the
        // live editor), so it survives Recording and Transcribing for that
        // session; any other session, or a dismissed/saved/failed control,
        // closes it, so it can't reopen by itself later.
        let mut peek = PEEK.lock().unwrap_or_else(|error| error.into_inner());
        let keeps_peek = matches!(state.phase, Phase::Recording | Phase::Transcribing | Phase::Done);
        if !keeps_peek || (peek.is_some() && *peek != state.session_id) {
            *peek = None;
        }
    }
    // The sound and the red tray glyph mean the mic is live, not that a key
    // was pressed: a recording still starting has no session yet.
    let was_live = previous.is_some_and(|previous| previous.is_live());
    if let Some(cue) = crate::sounds::cue_for(was_live, state.is_live(), state.phase == Phase::Failed) {
        crate::sounds::play(app, cue);
    }
    crate::tray::set_recording(app, state.is_live());
    let _ = app.emit_to("main", "capture:state", state.clone());
    if app.get_webview_window("hud").is_none() {
        return true;
    }

    // Size the window first, then tell the renderer. The other way round, a
    // result card is laid out inside the resting pill until the main thread
    // gets to the resize, which can take a while when Stop is handing focus
    // back: cramped, with Close cut off. Main-thread tasks run in order, so
    // the renderer still sees the states in the order they were set.
    let handle = app.clone();
    let emitted = state.clone();
    let dispatched = app.run_on_main_thread(move || {
        // The latest phase, like the sizing below: a queued idle must not
        // hand the keyboard away from a recording that has started since.
        if !matches!(current().phase, Phase::Recording | Phase::Transcribing | Phase::Done) {
            release_editor_on_main(&handle);
        }
        // Sized for the state this task draws, not the newest: when two are
        // queued, each is drawn in its own size, and the last one wins.
        show_on_main_for(&handle, &emitted);
        fit_for_on_main(&handle, &emitted);
        let _ = handle.emit_to("hud", "hud:state", shown(&handle, &emitted));
    });
    if let Err(error) = dispatched {
        // No main thread to size the window: the renderer still has to move on.
        tracing::warn!("capture control: could not reach the main thread: {error}");
        let _ = app.emit_to("hud", "hud:state", shown(app, &state));
    }
    true
}

/// The renderer has painted the new phase. The native shadow follows the
/// pill's opaque pixels, so it is recomputed now, not at resize time when the
/// old content was still on screen (that left a dark ring of the last shape).
pub fn repainted_on_main(app: &AppHandle) {
    imp::refresh_shadow(app);
}

/// A recording is stopping: leave the red state at once, with the stop sound,
/// and say the words are on their way. What happens next replaces it.
pub fn show_stopping(app: &AppHandle, session_id: &str) {
    let now = current();
    if now.phase != Phase::Recording || now.session_id.as_deref().is_some_and(|id| id != session_id) {
        return;
    }
    release_editor(app);
    set_state(app, HudState {
        phase: Phase::Transcribing,
        session_id: Some(session_id.to_string()),
        mode: now.mode,
        started_at_ms: None,
        message: None,
        notice: None,
    });
    // Every stop ends in Saved, Done or Failed. Should one ever not, the
    // control must not stay stuck saying it is writing.
    let app = app.clone();
    let session_id = session_id.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(STOPPING_TIMEOUT);
        let idle = HudState { session_id: Some(session_id.clone()), ..HudState::idle() };
        advance_from(&app, &session_id, &[Phase::Transcribing], idle);
    });
}

/// Longer than any stop takes to seal its files and paste. A duplicate stop
/// stands down for the same time (`audio::JUST_STOPPED_FOR`).
pub(crate) const STOPPING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The resting pill: the snoop, Talk, Screenshot, Video and close.
const DEFAULT_SIZE: (f64, f64) = (216.0, 36.0);
/// Recording and writing it down: controls above a scrollable transcript.
const WIDE: (f64, f64) = (400.0, 142.0);
/// Recording with the live words turned off: just the controls.
const BAR: (f64, f64) = (264.0, 40.0);

/// Recording or writing it down, with `lines` of live words under the controls.
fn live_size(lines: u8) -> (f64, f64) {
    if lines == 0 { BAR } else { (WIDE.0, WIDE.1 - 80.0 + 20.0 * f64::from(lines)) }
}
/// The transcript drawer, opened by hovering a finished dictation: recording's
/// width, so the words stay where they were read, with the tone row under them.
const RESULT: (f64, f64) = (400.0, 176.0);
/// A finished dictation at rest: the pill with what happened to the words
/// ("Pasted · 16 words", "Copied", "Not pasted" and Allow).
const RECEIPT: (f64, f64) = (248.0, 36.0);
/// A screen recording: room for the click count, Mark and the marking tools.
const VIDEO_LIVE: (f64, f64) = (420.0, 76.0);
/// A screenshot just taken, with its thumbnail.
const SHOT: (f64, f64) = (360.0, 172.0);

/// The control's size in each phase, and with a finished dictation's drawer
/// open (`peek`). The window takes it in one step when either changes and
/// never measures its content.
pub fn size_for(state: &HudState, lines: u8, peek: bool) -> (f64, f64) {
    let video = state.mode.as_deref() == Some("video");
    match state.phase {
        // Saved with a notice says why nothing was typed ("Saved. Sign in to
        // have it typed for you"): room for it, like Failed.
        Phase::Saved if state.notice.is_some() => WIDE,
        Phase::Idle | Phase::Saved => DEFAULT_SIZE,
        Phase::Recording if video => VIDEO_LIVE,
        Phase::Transcribing if video => DEFAULT_SIZE,
        Phase::Recording | Phase::Transcribing => live_size(lines),
        Phase::Failed => WIDE,
        Phase::Done => match state.mode.as_deref() {
            Some("image") => SHOT,
            Some("video") => DEFAULT_SIZE,
            _ if state.message.as_deref().is_some_and(|text| !text.trim().is_empty()) => if peek { RESULT } else { RECEIPT },
            _ if state.notice.is_some() => WIDE,
            _ => DEFAULT_SIZE,
        },
    }
}

/// Where a frame `from` goes when it becomes `size`: same centre, and its top
/// edge kept, or its bottom edge when it sits in the lower half of the screen.
fn refit(from: (f64, f64, f64, f64), size: (f64, f64), keep_bottom: bool) -> (f64, f64, f64, f64) {
    let (x, y, width, height) = from;
    let left = x + (width - size.0) / 2.0;
    let top = if keep_bottom { y + height - size.1 } else { y };
    (left.round(), top.round(), size.0, size.1)
}

/// The resting pill this frame stands for: what is saved and restored, so a
/// wide or screenshot size never outlives its phase.
fn resting(frame: (f64, f64, f64, f64), keep_bottom: bool) -> HudFrame {
    let (x, y, width, height) = refit(frame, DEFAULT_SIZE, keep_bottom);
    HudFrame { x, y, width, height }
}

/// `refit` for Cocoa's bottom-left origin: keeping the top edge there means
/// keeping `y + height`, and keeping the bottom edge means keeping `y`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn refit_cocoa(from: (f64, f64, f64, f64), size: (f64, f64), keep_bottom: bool) -> (f64, f64, f64, f64) {
    let (x, y, width, height) = from;
    let left = x + (width - size.0) / 2.0;
    let bottom = if keep_bottom { y } else { y + height - size.1 };
    (left.round(), bottom.round(), size.0, size.1)
}

fn frame_of(window: &tauri::WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let (Ok(scale), Ok(position), Ok(size)) = (window.scale_factor(), window.outer_position(), window.outer_size()) else {
        return None;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    Some((position.x, position.y, size.width, size.height))
}

type Frame = (f64, f64, f64, f64);

fn near(a: Frame, b: Frame) -> bool {
    (a.0 - b.0).abs() < 1.0 && (a.1 - b.1).abs() < 1.0 && (a.2 - b.2).abs() < 1.0 && (a.3 - b.3).abs() < 1.0
}

/// The control's resting pill, which it grows from and shrinks back to, and
/// the frame Eavesy last gave the window (both in one coordinate space).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    anchor: Frame,
    set: Frame,
}

/// Where the window goes to become `size`, and the resting anchor it went
/// from. While the window is still where Eavesy last put it, that is the
/// anchor kept from before: a grow pushed in from a screen edge then shrinks
/// back to exactly where the user left the pill. Once anything else moved it
/// (a drag, a restore), its own frame is the new anchor.
fn anchored(current: Frame, last: Option<Placement>, size: (f64, f64), keep_bottom: bool, refit: fn(Frame, (f64, f64), bool) -> Frame) -> (Frame, Frame) {
    let anchor = match last {
        Some(placement) if near(placement.set, current) => placement.anchor,
        _ => refit(current, DEFAULT_SIZE, keep_bottom),
    };
    (refit(anchor, size, keep_bottom), anchor)
}

/// The window frame (logical, as `frame_of` reads it) Eavesy set last. A
/// move or resize event that leaves the window there was Eavesy's own, and
/// is not saved as where the user wants the pill.
static PLACED: std::sync::Mutex<Option<Frame>> = std::sync::Mutex::new(None);

fn note_placed(window: &tauri::WebviewWindow) {
    *PLACED.lock().unwrap_or_else(|error| error.into_inner()) = frame_of(window);
}

/// Gives the control the size of the phase it is in.
pub fn fit_on_main(app: &AppHandle) {
    fit_for_on_main(app, &current());
}

/// Gives the control the size of `state`.
fn fit_for_on_main(app: &AppHandle, state: &HudState) {
    let Some(window) = app.get_webview_window("hud") else { return };
    let Some(from) = frame_of(&window) else { return };
    let prefs = prefs(app);
    let size = size_for(state, prefs.lines, peeking(state) || opens_by_itself(state, prefs.preview));
    // The NSPanel is resized through Cocoa below. Keep the embedded webview's
    // viewport in step too, including when the outer frame already matches.
    // Otherwise the toolbar can still render inside the resting pill's width.
    let webview: &tauri::Webview = window.as_ref();
    let _ = webview.set_size(tauri::LogicalSize::new(size.0, size.1));
    if (from.2 - size.0).abs() < 1.0 && (from.3 - size.1).abs() < 1.0 {
        return;
    }
    let low = crate::placement::in_lower_half(app, from.0 + from.2 / 2.0, from.1, from.3);
    imp::resize(&window, size, low);
    note_placed(&window);
}

/// The finished dictation whose transcript drawer is open under the pointer.
static PEEK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The state as the HUD gets it, with this side's reading of it: `receipt`
/// (what happened to a finished dictation's words), `opensItself`, and
/// `written` (the tone the words are in, when the server said). The
/// renderer draws from these instead of working them out again, so it draws
/// the drawer exactly when the window is sized for it.
pub fn shown(app: &AppHandle, state: &HudState) -> serde_json::Value {
    let mut value = match serde_json::to_value(state) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!("capture control: could not send the state: {error}");
            return serde_json::Value::Null;
        }
    };
    if let Some(object) = value.as_object_mut() {
        object.insert("receipt".into(), receipt(state).into());
        object.insert("opensItself".into(), opens_by_itself(state, prefs(app).preview).into());
        if let Some(written) = state.session_id.as_deref().and_then(crate::dictation::written_as).and_then(|written| serde_json::to_value(written).ok()) {
            object.insert("written".into(), written);
        }
    }
    value
}

/// What a finished dictation's pill says happened to its words: pasted,
/// copied, or blocked (copied, and Accessibility is needed to paste). None
/// for anything that isn't a finished dictation with words.
fn receipt(state: &HudState) -> Option<&'static str> {
    let words = state.message.as_deref().is_some_and(|text| !text.trim().is_empty());
    if state.phase != Phase::Done || matches!(state.mode.as_deref(), Some("image" | "video")) || !words {
        return None;
    }
    Some(match state.notice.as_deref() {
        None => "pasted",
        notice if notice == crate::dictation::Delivery::CopiedNoAccessibility.notice() => "blocked",
        Some(_) => "copied",
    })
}

/// A finished dictation opens straight into its drawer when the words are
/// shown after dictation, unless it is blocked on Accessibility: then the
/// pill keeps its Allow button. Without a recording there is nothing to edit.
fn opens_by_itself(state: &HudState, preview: bool) -> bool {
    preview && state.session_id.is_some() && matches!(receipt(state), Some("pasted" | "copied"))
}

fn peeking(state: &HudState) -> bool {
    state.session_id.is_some() && *PEEK.lock().unwrap_or_else(|error| error.into_inner()) == state.session_id
}

/// Opens or closes the transcript drawer of a finished dictation, and gives
/// the control its size. Returns once the window has it, so the drawer never
/// renders inside the smaller pill. Never call on the main thread.
pub fn set_peek(app: &AppHandle, session_id: String, open: bool) {
    {
        let mut peek = PEEK.lock().unwrap_or_else(|error| error.into_inner());
        if open {
            *peek = Some(session_id);
        } else if peek.as_deref() == Some(session_id.as_str()) {
            *peek = None;
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        fit_on_main(&handle);
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
}

/// The user closed the control with its X: it stays hidden while idle, until
/// the panel folds back into it, which brings the pill back.
pub fn hidden_by_user(app: &AppHandle) -> bool {
    prefs(app).hidden
}

/// Shown even when the user closed the pill: a capture running, and what it
/// just produced, stay on screen until the result is dismissed.
fn is_active(phase: &Phase) -> bool {
    matches!(phase, Phase::Recording | Phase::Transcribing | Phase::Done | Phase::Saved | Phase::Failed)
}

#[derive(Clone, Copy)]
struct Prefs {
    frame: Option<HudFrame>,
    hidden: bool,
    lines: u8,
    preview: bool,
}
static PREFS: std::sync::Mutex<Option<Prefs>> = std::sync::Mutex::new(None);

fn prefs(app: &AppHandle) -> Prefs {
    let mut guard = PREFS.lock().unwrap_or_else(|error| error.into_inner());
    *guard.get_or_insert_with(|| {
        let config = settings::load(app);
        Prefs { frame: config.hud_frame, hidden: config.hud_hidden, lines: config.hud_preview_lines(), preview: config.hud_result_preview() }
    })
}

fn update_prefs(app: &AppHandle, change: impl Fn(&mut Settings)) {
    let config = settings::update(app, &change).unwrap_or_else(|error| {
        // Not saved, but it still applies for as long as Eavesy runs.
        tracing::warn!("capture control: could not save its settings: {error}");
        let mut config = settings::load(app);
        change(&mut config);
        config
    });
    *PREFS.lock().unwrap_or_else(|error| error.into_inner()) =
        Some(Prefs { frame: config.hud_frame, hidden: config.hud_hidden, lines: config.hud_preview_lines(), preview: config.hud_result_preview() });
}

/// How the control looks: how many lines of live words while recording,
/// whether it is see-through, and (when given) whether a finished dictation
/// opens with its words. Takes effect at once, mid-recording too.
/// Faster live words, when given, apply from the next recording.
pub fn set_look(app: &AppHandle, lines: u8, translucent: bool, fast_live_words: Option<bool>, result_preview: Option<bool>) {
    update_prefs(app, |config| {
        config.hud_preview_lines = Some(lines);
        config.hud_translucent = Some(translucent);
        if let Some(fast) = fast_live_words {
            config.fast_live_words = Some(fast);
        }
        if let Some(preview) = result_preview {
            config.hud_result_preview = Some(preview);
        }
    });
    let look = serde_json::json!({ "lines": lines, "translucent": translucent, "preview": prefs(app).preview });
    let handle = app.clone();
    let emitted = look.clone();
    // In line with set_state's tasks, so the state sent below is never
    // followed by an older one still queued.
    let _transition = TRANSITION.lock().unwrap_or_else(|error| error.into_inner());
    let dispatched = app.run_on_main_thread(move || {
        fit_on_main(&handle);
        let _ = handle.emit_to("hud", "hud:look", emitted);
        // The window was just resized for the new look, and whether a result
        // opens by itself may have changed with it: the renderer must read
        // that from the state, or it draws a drawer in a receipt-sized pill.
        let _ = handle.emit_to("hud", "hud:state", shown(&handle, &current()));
    });
    if let Err(error) = dispatched {
        tracing::warn!("capture control: could not reach the main thread: {error}");
        let _ = app.emit_to("hud", "hud:look", look);
        let _ = app.emit_to("hud", "hud:state", shown(app, &current()));
    }
}

pub fn user_frame(app: &AppHandle) -> Option<HudFrame> {
    prefs(app).frame
}

pub fn reset_frame(app: &AppHandle) {
    update_prefs(app, |config| config.hud_frame = None);
}

pub fn set_hidden_on_main(app: &AppHandle, hidden: bool) {
    update_prefs(app, |config| config.hud_hidden = hidden);
    if hidden && !is_active(&current().phase) {
        imp::hide(app);
    } else {
        show_on_main(app);
    }
}

fn on_screen(app: &AppHandle, frame: &HudFrame) -> bool {
    crate::placement::work_area_at(app, frame.x + frame.width / 2.0, frame.y + frame.height / 2.0).is_some()
}

pub fn show_on_main(app: &AppHandle) {
    show_on_main_for(app, &current());
}

fn show_on_main_for(app: &AppHandle, state: &HudState) {
    if crate::panel::is_visible(app) { return; }
    show_unchecked(app, state);
}

/// The panel folds back into the pill, even one the user closed earlier: the
/// panel's close is "collapse", and the pill's own close is how to put it away.
pub fn collapse_from_panel_on_main(app: &AppHandle) {
    if prefs(app).hidden {
        update_prefs(app, |config| config.hud_hidden = false);
    }
    follow_panel(app);
    show_unchecked(app, &current());
}

fn show_unchecked(app: &AppHandle, state: &HudState) {
    let Some(window) = app.get_webview_window("hud") else {
        return;
    };
    let prefs = prefs(app);
    if prefs.hidden && !is_active(&state.phase) {
        imp::hide(app);
        return;
    }
    if !window.is_visible().unwrap_or(false) {
        match prefs.frame.filter(|frame| on_screen(app, frame)) {
            Some(frame) => {
                let low = crate::placement::in_lower_half(app, frame.x + frame.width / 2.0, frame.y, frame.height);
                let frame = resting((frame.x, frame.y, frame.width, frame.height), low);
                let _ = window.set_size(tauri::LogicalSize::new(frame.width, frame.height));
                let _ = window.set_position(tauri::LogicalPosition::new(frame.x, frame.y));
            }
            None => {
                let _ = window.set_size(tauri::LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1));
                crate::placement::place(app);
            }
        }
        note_placed(&window);
    }
    fit_for_on_main(app, state);
    imp::show(app, &window);
}

pub fn geometry_changed(app: &AppHandle) {
    static SAVER: std::sync::OnceLock<std::sync::mpsc::Sender<()>> = std::sync::OnceLock::new();
    let sender = SAVER.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        let app = app.clone();
        std::thread::spawn(move || {
            use std::sync::mpsc::RecvTimeoutError;
            while receiver.recv().is_ok() {
                loop {
                    match receiver.recv_timeout(std::time::Duration::from_millis(400)) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                save_frame(&app);
            }
        });
        sender
    });
    let _ = sender.send(());
}

fn follow_panel(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else { return };
    let (Ok(scale), Ok(position), Ok(size)) = (main.scale_factor(), main.outer_position(), main.outer_size()) else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let saved = prefs(app).frame;
    let (width, height) = DEFAULT_SIZE;
    // A control docked low opened the panel upwards: hand it back at the bottom.
    let low = match saved {
        Some(frame) => crate::placement::in_lower_half(app, frame.x + frame.width / 2.0, frame.y, frame.height),
        None => matches!(settings::load(app).launcher_position, settings::LauncherPosition::BottomCenter),
    };
    let y = if low {
        position.y + size.height - height
    } else {
        position.y
    };
    let frame = HudFrame { x: position.x + (size.width - width) / 2.0, y, width, height };
    if prefs(app).frame != Some(frame) {
        update_prefs(app, |config| config.hud_frame = Some(frame));
    }
}

fn save_frame(app: &AppHandle) {
    let Some(window) = app.get_webview_window("hud") else { return };
    if !window.is_visible().unwrap_or(false) { return; }
    let Some(current) = frame_of(&window) else { return };
    // Still where Eavesy put it: the events were a resize for a phase, or a
    // restore, not the user moving the pill. Saving those would let a grow
    // pushed in from a screen edge creep into where the pill rests.
    if PLACED.lock().unwrap_or_else(|error| error.into_inner()).is_some_and(|placed| near(placed, current)) {
        return;
    }
    let low = crate::placement::in_lower_half(app, current.0 + current.2 / 2.0, current.1, current.3);
    let frame = resting(current, low);
    if prefs(app).frame != Some(frame) {
        update_prefs(app, |config| config.hud_frame = Some(frame));
    }
}

pub fn hide_on_main(app: &AppHandle) { imp::hide(app); }

static EDITOR_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// When the editor last handed the keyboard back, so a paste right after
/// waits for focus to arrive even if another thread did the handing back.
static RELEASED_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
/// How long focus takes to reach the other app once Eavesy lets go.
const FOCUS_SETTLE: std::time::Duration = std::time::Duration::from_millis(150);
/// The longest a paste waits for focus to settle, however the stamp moves.
const SETTLE_LIMIT: std::time::Duration = std::time::Duration::from_millis(400);

/// Editing opts into app activation so AppKit routes the Edit menu shortcuts
/// to WKWebView. Merely showing a completed dictation remains passive.
pub fn focus_editor_on_main(app: &AppHandle) {
    EDITOR_ACTIVE.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::app_menu::activate();
    imp::focus_editor(app);
}

/// The transcript box let go of the keyboard (blur, Esc, a tone or Copy):
/// hand it back to the app the user was in. Nothing to do if it never took it.
pub fn release_preview_editor_on_main(app: &AppHandle) {
    release_editor_on_main(app);
}

fn release_editor_on_main(app: &AppHandle) {
    if EDITOR_ACTIVE.swap(false, std::sync::atomic::Ordering::SeqCst) && !crate::panel::is_visible(app) {
        crate::app_menu::return_focus();
        mark_released();
    }
}

fn mark_released() {
    *RELEASED_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
}

/// A recording is stopping: if the transcript box has the keyboard, give it
/// back to the app the user was in. Otherwise the paste, and the user's own
/// ⌘V after "Copied", land in Eavesy's box instead of where they were typing.
/// Safe on any thread; does not wait.
pub fn release_editor(app: &AppHandle) {
    // Stamped before the check, and again once focus moves, so a paste after
    // Stop always waits out the settle. With nothing to release, a paste
    // within FOCUS_SETTLE of Stop waits out the rest of it (150ms at most).
    mark_released();
    if !EDITOR_ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let _ = app.emit_to("hud", "hud:release-editor", ());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || release_editor_on_main(&handle));
}

/// [`release_editor`], then waits for focus to reach the other app so a paste
/// right after it lands there. Never call on the main thread.
pub fn release_editor_and_wait(app: &AppHandle) {
    if EDITOR_ACTIVE.load(std::sync::atomic::Ordering::SeqCst) {
        // Stamped here too, so the settle below waits even if the main
        // thread is too busy to hand focus back within the timeout.
        mark_released();
        let _ = app.emit_to("hud", "hud:release-editor", ());
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            release_editor_on_main(&handle);
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    }
    // Stop may have handed focus back a moment ago: let it arrive. The main
    // thread stamps again once it actually hands focus back, so re-read the
    // stamp after each wait, up to SETTLE_LIMIT in all.
    let deadline = std::time::Instant::now() + SETTLE_LIMIT;
    loop {
        let released = *RELEASED_AT.lock().unwrap_or_else(|e| e.into_inner());
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match released.and_then(|at| settle_left(at.elapsed())).map(|wait| wait.min(left)) {
            Some(wait) if !wait.is_zero() => std::thread::sleep(wait),
            _ => break,
        }
    }
}

/// What is left of the focus settle, `elapsed` after the hand-back.
fn settle_left(elapsed: std::time::Duration) -> Option<std::time::Duration> {
    FOCUS_SETTLE.checked_sub(elapsed).filter(|left| !left.is_zero())
}

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};

    pub fn focus_editor(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel("hud") {
            panel.make_key_window();
        }
    }

    pub fn hide(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel("hud") { panel.order_out(None); }
    }

    pub fn refresh_shadow(app: &AppHandle) {
        use tauri_nspanel::cocoa::base::id;
        use tauri_nspanel::objc::{msg_send, sel, sel_impl};
        use tauri::Manager;
        let Some(window) = app.get_webview_window("hud") else { return };
        let Ok(ns_window) = window.ns_window() else { return };
        unsafe {
            let _: () = msg_send![ns_window as id, invalidateShadow];
        }
    }

    /// Where the pill rests and where it was last put, in Cocoa coordinates.
    static PLACEMENT: std::sync::Mutex<Option<super::Placement>> = std::sync::Mutex::new(None);

    /// Gives the window `size` in one step, without animation, keeping the
    /// resting pill's centre and its top edge (or bottom edge when
    /// `keep_bottom`). Reads the live Cocoa frame, so repeated state changes
    /// cannot leave the renderer inside a partially resized window.
    pub fn resize(window: &WebviewWindow, size: (f64, f64), keep_bottom: bool) {
        use tauri_nspanel::cocoa::{base::id, foundation::NSRect};
        use tauri_nspanel::objc::{msg_send, sel, sel_impl};
        let Ok(ns_window) = window.ns_window() else { return };
        let ns_window = ns_window as id;
        let mut placement = PLACEMENT.lock().unwrap_or_else(|error| error.into_inner());
        unsafe {
            let rect: NSRect = msg_send![ns_window, frame];
            let current = (rect.origin.x, rect.origin.y, rect.size.width, rect.size.height);
            let ((mut x, mut y, width, height), anchor) =
                super::anchored(current, *placement, size, keep_bottom, super::refit_cocoa);
            let screen: id = msg_send![ns_window, screen];
            if !screen.is_null() {
                let area: NSRect = msg_send![screen, visibleFrame];
                x = x.clamp(area.origin.x, (area.origin.x + area.size.width - width).max(area.origin.x));
                y = y.clamp(area.origin.y, (area.origin.y + area.size.height - height).max(area.origin.y));
            }
            let mut target = rect;
            target.origin.x = x;
            target.origin.y = y;
            target.size.width = width;
            target.size.height = height;
            let _: () = msg_send![ns_window, setFrame: target display: true animate: false];
            let _: () = msg_send![ns_window, invalidateShadow];
            let set: NSRect = msg_send![ns_window, frame];
            *placement = Some(super::Placement {
                anchor,
                set: (set.origin.x, set.origin.y, set.size.width, set.size.height),
            });
        }
    }

    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: i32 = 1 << 7;
    const HUD_WINDOW_LEVEL: i32 = 25;

    pub fn show(app: &AppHandle, window: &WebviewWindow) {
        if let Ok(panel) = app.get_webview_panel("hud") {
            panel.order_front_regardless();
            return;
        }
        let Ok(panel) = window.to_panel() else {
            let _ = window.show();
            return;
        };
        // No native glass: the pill draws itself, so its corners and the
        // window's always agree.
        panel.set_style_mask(NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL);
        panel.set_level(HUD_WINDOW_LEVEL);
        panel.set_collection_behaviour(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
        );
        panel.set_released_when_closed(false);
        panel.order_front_regardless();
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{AppHandle, Manager, WebviewWindow};
    pub fn focus_editor(app: &AppHandle) {
        if let Some(window) = app.get_webview_window("hud") { let _ = window.set_focus(); }
    }
    pub fn hide(app: &AppHandle) { if let Some(window) = app.get_webview_window("hud") { let _ = window.hide(); } }
    pub fn refresh_shadow(_app: &AppHandle) {}
    pub fn show(_app: &AppHandle, window: &WebviewWindow) {
        let _ = window.show();
    }
    static PLACEMENT: std::sync::Mutex<Option<super::Placement>> = std::sync::Mutex::new(None);

    pub fn resize(window: &WebviewWindow, size: (f64, f64), keep_bottom: bool) {
        let Some(current) = super::frame_of(window) else { return };
        let mut placement = PLACEMENT.lock().unwrap_or_else(|error| error.into_inner());
        let ((x, y, width, height), anchor) = super::anchored(current, *placement, size, keep_bottom, super::refit);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        *placement = super::frame_of(window).map(|set| super::Placement { anchor, set });
    }
}

#[cfg(test)]
mod tests {
    use super::{anchored, is_active, live_size, opens_by_itself, receipt, refit, refit_cocoa, resting, settle_left, size_for, HudFrame, Placement, FOCUS_SETTLE, HudState, Phase, BAR, DEFAULT_SIZE, RECEIPT, RESULT, SHOT, VIDEO_LIVE, WIDE};

    #[test]
    fn saved_without_typing_has_room_to_say_why() {
        let saved = HudState { notice: Some("Saved. Sign in to have it typed for you".into()), ..state(Phase::Saved, Some("audio"), None) };
        assert_eq!(size_for(&saved, 4, false), WIDE);
        assert_eq!(size_for(&saved, 0, false), WIDE);
        let failed = HudState { notice: Some("x".into()), ..state(Phase::Failed, Some("audio"), Some("no mic")) };
        assert_eq!(size_for(&saved, 4, false), size_for(&failed, 4, false));
    }

    #[test]
    fn a_grow_pushed_in_from_the_edge_shrinks_back_to_where_the_pill_rests() {
        // Resting near the right edge; growing gets clamped 50pt to the left.
        let rest = (900.0, 40.0, 216.0, 36.0);
        let (wide, anchor) = anchored(rest, None, WIDE, false, refit);
        assert_eq!(anchor, rest);
        assert_eq!(wide, (808.0, 40.0, 400.0, 142.0));
        let clamped = (758.0, 40.0, 400.0, 142.0);
        let placed = Some(Placement { anchor, set: clamped });
        let (back, anchor) = anchored(clamped, placed, DEFAULT_SIZE, false, refit);
        assert_eq!(back, rest, "not re-centred on the clamped frame");
        assert_eq!(anchor, rest);
    }

    #[test]
    fn a_pill_moved_since_its_last_resize_rests_where_it_was_moved() {
        let placed = Some(Placement { anchor: (900.0, 40.0, 216.0, 36.0), set: (758.0, 40.0, 400.0, 142.0) });
        let dragged = (300.0, 200.0, 400.0, 142.0);
        let (back, anchor) = anchored(dragged, placed, DEFAULT_SIZE, false, refit);
        assert_eq!(anchor, (392.0, 200.0, 216.0, 36.0));
        assert_eq!(back, anchor);
    }

    fn state(phase: Phase, mode: Option<&str>, message: Option<&str>) -> HudState {
        HudState { phase, mode: mode.map(str::to_string), message: message.map(str::to_string), ..HudState::idle() }
    }

    #[test]
    fn talking_writing_and_the_pasted_words_share_one_width() {
        let talk = Some("audio");
        assert_eq!(size_for(&state(Phase::Recording, talk, None), 4, false), WIDE);
        assert_eq!(size_for(&state(Phase::Transcribing, talk, None), 4, false), WIDE);
        assert_eq!(size_for(&state(Phase::Done, talk, Some("hello there")), 4, true), RESULT);
        assert_eq!(RESULT.0, WIDE.0);
    }

    #[test]
    fn a_finished_dictation_rests_as_a_receipt_until_hovered() {
        let pasted = state(Phase::Done, Some("audio"), Some("hello there"));
        assert_eq!(size_for(&pasted, 4, false), RECEIPT);
        assert_eq!(size_for(&pasted, 4, true), RESULT);
        // The drawer is only ever a finished dictation's.
        assert_eq!(size_for(&state(Phase::Recording, Some("audio"), None), 4, true), WIDE);
        assert_eq!(size_for(&HudState::idle(), 4, true), DEFAULT_SIZE);
    }

    #[test]
    fn a_finished_dictation_opens_with_its_words_unless_it_needs_allowing() {
        let pasted = HudState { session_id: Some("s1".into()), ..state(Phase::Done, Some("audio"), Some("hello there")) };
        assert!(opens_by_itself(&pasted, true));
        assert!(!opens_by_itself(&pasted, false));
        let copied = HudState { notice: Some("Copied — press ⌘V to paste".into()), ..pasted.clone() };
        assert!(opens_by_itself(&copied, true));
        let blocked = HudState { notice: Some("Copied — allow Accessibility to paste automatically".into()), ..pasted.clone() };
        assert!(!opens_by_itself(&blocked, true));
        assert_eq!(receipt(&pasted), Some("pasted"));
        assert_eq!(receipt(&copied), Some("copied"));
        assert_eq!(receipt(&blocked), Some("blocked"));
        let empty = HudState { session_id: Some("s1".into()), ..state(Phase::Done, Some("audio"), Some("  ")) };
        assert!(!opens_by_itself(&empty, true));
        let shot = HudState { session_id: Some("s1".into()), ..state(Phase::Done, Some("image"), None) };
        assert!(!opens_by_itself(&shot, true));
    }

    #[test]
    fn fewer_preview_lines_make_a_shorter_control() {
        let talk = Some("audio");
        assert_eq!(live_size(4), WIDE);
        assert_eq!(size_for(&state(Phase::Recording, talk, None), 1, false), (WIDE.0, 82.0));
        assert_eq!(size_for(&state(Phase::Transcribing, talk, None), 2, false), (WIDE.0, 102.0));
        assert_eq!(size_for(&state(Phase::Recording, talk, None), 0, false), BAR);
        assert_eq!(size_for(&state(Phase::Failed, talk, Some("no mic")), 0, false), WIDE);
    }

    #[test]
    fn a_result_stays_on_screen_even_with_the_pill_put_away() {
        assert!(is_active(&Phase::Done));
        // A paste right after Stop's hand-back waits out the rest of the settle.
        assert_eq!(settle_left(std::time::Duration::ZERO), Some(FOCUS_SETTLE));
        assert_eq!(settle_left(std::time::Duration::from_millis(100)), Some(std::time::Duration::from_millis(50)));
        assert_eq!(settle_left(FOCUS_SETTLE), None);
        assert!(is_active(&Phase::Failed));
        assert!(!is_active(&Phase::Idle));
    }

    #[test]
    fn resting_saved_and_video_stay_a_small_pill() {
        assert_eq!(size_for(&HudState::idle(), 4, false), DEFAULT_SIZE);
        assert_eq!(size_for(&state(Phase::Saved, Some("audio"), None), 4, false), DEFAULT_SIZE);
        assert_eq!(size_for(&state(Phase::Transcribing, Some("video"), None), 4, false), DEFAULT_SIZE);
        assert_eq!(size_for(&state(Phase::Done, Some("audio"), Some("  ")), 4, false), DEFAULT_SIZE);
    }

    #[test]
    fn a_screen_recording_makes_room_for_clicks_and_marking() {
        assert_eq!(size_for(&state(Phase::Recording, Some("video"), None), 4, false), VIDEO_LIVE);
        assert_eq!(VIDEO_LIVE, (420.0, 76.0));
    }

    #[test]
    fn a_screenshot_makes_room_for_its_thumbnail() {
        assert_eq!(size_for(&state(Phase::Done, Some("image"), None), 4, false), SHOT);
    }

    #[test]
    fn refitting_keeps_the_centre_and_the_top_edge() {
        assert_eq!(refit((500.0, 40.0, 216.0, 36.0), WIDE, false), (408.0, 40.0, 400.0, 142.0));
    }

    #[test]
    fn low_on_the_screen_refitting_keeps_the_bottom_edge() {
        assert_eq!(refit((500.0, 800.0, 216.0, 36.0), WIDE, true), (408.0, 694.0, 400.0, 142.0));
        assert_eq!(refit((408.0, 694.0, 400.0, 142.0), DEFAULT_SIZE, true), (500.0, 800.0, 216.0, 36.0));
    }

    #[test]
    fn in_cocoa_coordinates_the_top_edge_is_the_one_kept() {
        assert_eq!(refit_cocoa((500.0, 800.0, 216.0, 36.0), WIDE, false), (408.0, 694.0, 400.0, 142.0));
        assert_eq!(refit_cocoa((500.0, 100.0, 216.0, 36.0), WIDE, true), (408.0, 100.0, 400.0, 142.0));
    }

    #[test]
    fn only_the_resting_pill_is_ever_saved() {
        assert_eq!(resting((408.0, 24.0, 400.0, 142.0), false), HudFrame { x: 500.0, y: 24.0, width: 216.0, height: 36.0 });
        assert_eq!(resting((408.0, 694.0, 400.0, 142.0), true), HudFrame { x: 500.0, y: 800.0, width: 216.0, height: 36.0 });
        assert_eq!(resting((488.0, 24.0, 240.0, 40.0), false), HudFrame { x: 500.0, y: 24.0, width: 216.0, height: 36.0 });
    }
}
