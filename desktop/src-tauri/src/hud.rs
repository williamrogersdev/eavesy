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
static CURRENT: std::sync::Mutex<Option<HudState>> = std::sync::Mutex::new(None);
pub fn current() -> HudState {
    CURRENT.lock().unwrap_or_else(|error| error.into_inner()).clone().unwrap_or_else(HudState::idle)
}

pub fn set_state(app: &AppHandle, state: HudState) {
    let previous = CURRENT.lock().unwrap_or_else(|error| error.into_inner()).replace(state.clone());
    // The sound and the red tray glyph mean the mic is live, not that a key
    // was pressed: a recording still starting has no session yet.
    let was_live = previous.is_some_and(|previous| previous.is_live());
    if let Some(cue) = crate::sounds::cue_for(was_live, state.is_live(), state.phase == Phase::Failed) {
        crate::sounds::play(app, cue);
    }
    crate::tray::set_recording(app, state.is_live());
    let _ = app.emit_to("main", "capture:state", state.clone());
    let Some(window) = app.get_webview_window("hud") else {
        return;
    };
    let _ = window.emit_to("hud", "hud:state", state);

    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        show_on_main(&app);
        fit_on_main(&app);
    });
}

/// A recording is stopping: leave the red state at once, with the stop sound,
/// and say the words are on their way. What happens next replaces it.
pub fn show_stopping(app: &AppHandle, session_id: &str) {
    let now = current();
    if now.phase != Phase::Recording || now.session_id.as_deref().is_some_and(|id| id != session_id) {
        return;
    }
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
        let now = current();
        if now.phase == Phase::Transcribing && now.session_id.as_deref() == Some(session_id.as_str()) {
            set_state(&app, HudState { session_id: Some(session_id), ..HudState::idle() });
        }
    });
}

/// Longer than any stop takes to seal its files and paste.
const STOPPING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The resting pill: the snoop, Talk, Screenshot, Video, history and close.
const DEFAULT_SIZE: (f64, f64) = (248.0, 40.0);
/// Recording, writing it down, and the words that landed: two lines.
const WIDE: (f64, f64) = (360.0, 64.0);
/// A screenshot just taken, with its thumbnail.
const SHOT: (f64, f64) = (360.0, 172.0);

/// The control's size in each phase. The window takes it in one step when the
/// phase changes and never measures its content, so stopping, writing and
/// pasting all happen in the same frame and nothing jumps.
pub fn size_for(state: &HudState) -> (f64, f64) {
    let video = state.mode.as_deref() == Some("video");
    match state.phase {
        Phase::Idle | Phase::Saved => DEFAULT_SIZE,
        Phase::Recording | Phase::Transcribing if video => DEFAULT_SIZE,
        Phase::Recording | Phase::Transcribing | Phase::Failed => WIDE,
        Phase::Done => match state.mode.as_deref() {
            Some("image") => SHOT,
            Some("video") => DEFAULT_SIZE,
            _ if state.message.as_deref().is_some_and(|text| !text.trim().is_empty()) || state.notice.is_some() => WIDE,
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

/// Gives the control the size of the phase it is in.
pub fn fit_on_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("hud") else { return };
    let Some(from) = frame_of(&window) else { return };
    let size = size_for(&current());
    if (from.2 - size.0).abs() < 1.0 && (from.3 - size.1).abs() < 1.0 {
        return;
    }
    let low = crate::placement::in_lower_half(app, from.0 + from.2 / 2.0, from.1, from.3);
    let visible = window.is_visible().unwrap_or(false);
    imp::resize(&window, from, size, low, visible);
}

/// The user closed the control with its X: it stays hidden while idle.
pub fn hidden_by_user(app: &AppHandle) -> bool {
    prefs(app).hidden
}

fn is_active(phase: &Phase) -> bool {
    matches!(phase, Phase::Recording | Phase::Transcribing)
}

#[derive(Clone, Copy)]
struct Prefs {
    frame: Option<HudFrame>,
    hidden: bool,
}
static PREFS: std::sync::Mutex<Option<Prefs>> = std::sync::Mutex::new(None);

fn prefs(app: &AppHandle) -> Prefs {
    let mut guard = PREFS.lock().unwrap_or_else(|error| error.into_inner());
    *guard.get_or_insert_with(|| {
        let config = settings::load(app);
        Prefs { frame: config.hud_frame, hidden: config.hud_hidden }
    })
}

fn update_prefs(app: &AppHandle, change: impl Fn(&mut Settings)) {
    let mut config = settings::load(app);
    change(&mut config);
    let _ = settings::save(app, &config);
    *PREFS.lock().unwrap_or_else(|error| error.into_inner()) =
        Some(Prefs { frame: config.hud_frame, hidden: config.hud_hidden });
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
    if crate::panel::is_visible(app) { return; }
    show_unchecked(app);
}

pub fn collapse_from_panel_on_main(app: &AppHandle) {
    follow_panel(app);
    show_unchecked(app);
}

fn show_unchecked(app: &AppHandle) {
    let Some(window) = app.get_webview_window("hud") else {
        return;
    };
    let prefs = prefs(app);
    if prefs.hidden && !is_active(&current().phase) {
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
    }
    fit_on_main(app);
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
    let low = crate::placement::in_lower_half(app, current.0 + current.2 / 2.0, current.1, current.3);
    let frame = resting(current, low);
    if prefs(app).frame != Some(frame) {
        update_prefs(app, |config| config.hud_frame = Some(frame));
    }
}

pub fn hide_on_main(app: &AppHandle) { imp::hide(app); }

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};

    pub fn hide(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel("hud") { panel.order_out(None); }
    }

    /// Gives the window `size` in one step, animated when it is on screen,
    /// keeping its centre and its top edge (or bottom edge when `keep_bottom`).
    /// Works only in the live Cocoa frame, so a change that lands while the
    /// last one is still settling starts from where the window really is.
    pub fn resize(window: &WebviewWindow, _from: (f64, f64, f64, f64), size: (f64, f64), keep_bottom: bool, animate: bool) {
        use tauri_nspanel::cocoa::{base::id, foundation::NSRect};
        use tauri_nspanel::objc::{msg_send, sel, sel_impl};
        let Ok(ns_window) = window.ns_window() else { return };
        let ns_window = ns_window as id;
        unsafe {
            let rect: NSRect = msg_send![ns_window, frame];
            let (x, y, width, height) = super::refit_cocoa(
                (rect.origin.x, rect.origin.y, rect.size.width, rect.size.height),
                size,
                keep_bottom,
            );
            let mut target = rect;
            target.origin.x = x;
            target.origin.y = y;
            target.size.width = width;
            target.size.height = height;
            let _: () = msg_send![ns_window, setFrame: target display: true animate: animate];
            let _: () = msg_send![ns_window, invalidateShadow];
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
    pub fn hide(app: &AppHandle) { if let Some(window) = app.get_webview_window("hud") { let _ = window.hide(); } }
    pub fn show(_app: &AppHandle, window: &WebviewWindow) {
        let _ = window.show();
    }
    pub fn resize(window: &WebviewWindow, from: (f64, f64, f64, f64), size: (f64, f64), keep_bottom: bool, _animate: bool) {
        let (x, y, width, height) = super::refit(from, size, keep_bottom);
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

#[cfg(test)]
mod tests {
    use super::{refit, refit_cocoa, resting, size_for, HudFrame, HudState, Phase, DEFAULT_SIZE, SHOT, WIDE};

    fn state(phase: Phase, mode: Option<&str>, message: Option<&str>) -> HudState {
        HudState { phase, mode: mode.map(str::to_string), message: message.map(str::to_string), ..HudState::idle() }
    }

    #[test]
    fn talking_writing_and_the_pasted_words_share_one_size() {
        let talk = Some("audio");
        assert_eq!(size_for(&state(Phase::Recording, talk, None)), WIDE);
        assert_eq!(size_for(&state(Phase::Transcribing, talk, None)), WIDE);
        assert_eq!(size_for(&state(Phase::Done, talk, Some("hello there"))), WIDE);
    }

    #[test]
    fn resting_saved_and_video_stay_a_small_pill() {
        assert_eq!(size_for(&HudState::idle()), DEFAULT_SIZE);
        assert_eq!(size_for(&state(Phase::Saved, Some("audio"), None)), DEFAULT_SIZE);
        assert_eq!(size_for(&state(Phase::Recording, Some("video"), None)), DEFAULT_SIZE);
        assert_eq!(size_for(&state(Phase::Done, Some("audio"), Some("  "))), DEFAULT_SIZE);
    }

    #[test]
    fn a_screenshot_makes_room_for_its_thumbnail() {
        assert_eq!(size_for(&state(Phase::Done, Some("image"), None)), SHOT);
    }

    #[test]
    fn refitting_keeps_the_centre_and_the_top_edge() {
        assert_eq!(refit((500.0, 40.0, 248.0, 40.0), WIDE, false), (444.0, 40.0, 360.0, 64.0));
    }

    #[test]
    fn low_on_the_screen_refitting_keeps_the_bottom_edge() {
        assert_eq!(refit((500.0, 800.0, 248.0, 40.0), WIDE, true), (444.0, 776.0, 360.0, 64.0));
        assert_eq!(refit((444.0, 776.0, 360.0, 64.0), DEFAULT_SIZE, true), (500.0, 800.0, 248.0, 40.0));
    }

    #[test]
    fn in_cocoa_coordinates_the_top_edge_is_the_one_kept() {
        assert_eq!(refit_cocoa((500.0, 800.0, 248.0, 40.0), WIDE, false), (444.0, 776.0, 360.0, 64.0));
        assert_eq!(refit_cocoa((500.0, 100.0, 248.0, 40.0), WIDE, true), (444.0, 100.0, 360.0, 64.0));
    }

    #[test]
    fn only_the_resting_pill_is_ever_saved() {
        assert_eq!(resting((444.0, 24.0, 360.0, 64.0), false), HudFrame { x: 500.0, y: 24.0, width: 248.0, height: 40.0 });
        assert_eq!(resting((444.0, 776.0, 360.0, 64.0), true), HudFrame { x: 500.0, y: 800.0, width: 248.0, height: 40.0 });
        assert_eq!(resting((488.0, 24.0, 272.0, 34.0), false), HudFrame { x: 500.0, y: 24.0, width: 248.0, height: 40.0 });
    }
}
