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
    // Not produced by the Rust side today, but launcher-ui renders this phase.
    #[allow(dead_code)]
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
}

impl HudState {
    pub fn idle() -> Self { Self { phase: Phase::Idle, session_id: None, mode: None, started_at_ms: None, message: None } }
}
static CURRENT: std::sync::Mutex<Option<HudState>> = std::sync::Mutex::new(None);
pub fn current() -> HudState {
    CURRENT.lock().unwrap_or_else(|error| error.into_inner()).clone().unwrap_or_else(HudState::idle)
}

pub fn set_state(app: &AppHandle, state: HudState) {
    *CURRENT.lock().unwrap_or_else(|error| error.into_inner()) = Some(state.clone());
    let _ = app.emit_to("main", "capture:state", state.clone());
    let Some(window) = app.get_webview_window("hud") else {
        return;
    };
    let _ = window.emit_to("hud", "hud:state", state);

    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        show_on_main(&app);
    });
}

const DEFAULT_SIZE: (f64, f64) = (272.0, 40.0);

/// How much taller the HUD gets to show the running transcript under its bar.
const TRANSCRIPT_HEIGHT: f64 = 72.0;

/// Extra height the HUD has now for its transcript, and how far it moved up
/// to make room at the bottom of the screen. Never saved as the user's frame.
static EXPANDED: std::sync::Mutex<Option<(f64, f64)>> = std::sync::Mutex::new(None);

fn expanded() -> Option<(f64, f64)> {
    *EXPANDED.lock().unwrap_or_else(|error| error.into_inner())
}

/// Grows the HUD to show the transcript under its bar, or shrinks it back.
/// The HUD asks for it once it has words to show.
pub fn set_expanded_on_main(app: &AppHandle, expand: bool) {
    let Some(window) = app.get_webview_window("hud") else { return };
    let (Ok(scale), Ok(position), Ok(size)) = (window.scale_factor(), window.outer_position(), window.outer_size()) else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let mut state = EXPANDED.lock().unwrap_or_else(|error| error.into_inner());
    match (expand, *state) {
        (true, None) => {
            let bottom = crate::placement::work_area_at(app, position.x + size.width / 2.0, position.y + 1.0)
                .map_or(f64::MAX, |area| area.1 + area.3);
            let lift = (position.y + size.height + TRANSCRIPT_HEIGHT - bottom).max(0.0);
            *state = Some((TRANSCRIPT_HEIGHT, lift));
            drop(state);
            let _ = window.set_size(tauri::LogicalSize::new(size.width, size.height + TRANSCRIPT_HEIGHT));
            if lift > 0.0 {
                let _ = window.set_position(tauri::LogicalPosition::new(position.x, position.y - lift));
            }
        }
        (false, Some((extra, lift))) => {
            *state = None;
            drop(state);
            let _ = window.set_size(tauri::LogicalSize::new(size.width, (size.height - extra).max(DEFAULT_SIZE.1)));
            if lift > 0.0 {
                let _ = window.set_position(tauri::LogicalPosition::new(position.x, position.y + lift));
            }
        }
        _ => {}
    }
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
        // Shown afresh at the saved frame: any transcript room is gone.
        *EXPANDED.lock().unwrap_or_else(|error| error.into_inner()) = None;
        match prefs.frame.filter(|frame| on_screen(app, frame)) {
            Some(frame) => {
                let _ = window.set_size(tauri::LogicalSize::new(frame.width, frame.height));
                let _ = window.set_position(tauri::LogicalPosition::new(frame.x, frame.y));
            }
            None => {
                let _ = window.set_size(tauri::LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1));
                crate::placement::place(app);
            }
        }
    }
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
    let (width, height) = prefs(app).frame.map_or(DEFAULT_SIZE, |frame| (frame.width, frame.height));
    let frame = HudFrame { x: position.x + (size.width - width) / 2.0, y: position.y, width, height };
    if prefs(app).frame != Some(frame) {
        update_prefs(app, |config| config.hud_frame = Some(frame));
    }
}

fn save_frame(app: &AppHandle) {
    let Some(window) = app.get_webview_window("hud") else { return };
    if !window.is_visible().unwrap_or(false) { return; }
    let (Ok(scale), Ok(position), Ok(size)) =
        (window.scale_factor(), window.outer_position(), window.outer_size())
    else {
        return;
    };
    let position = position.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    // While the transcript shows, save the frame the HUD returns to.
    let (extra, lift) = expanded().unwrap_or((0.0, 0.0));
    let frame = HudFrame { x: position.x, y: position.y + lift, width: size.width, height: size.height - extra };
    if prefs(app).frame != Some(frame) {
        update_prefs(app, |config| config.hud_frame = Some(frame));
    }
}

pub fn hide_on_main(app: &AppHandle) { imp::hide(app); }

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    pub fn hide(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel("hud") { panel.order_out(None); }
    }

    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: i32 = 1 << 7;
    const NS_WINDOW_STYLE_MASK_RESIZABLE: i32 = 1 << 3;
    const CORNER_RADIUS: f64 = 14.0;
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
        let _ = apply_vibrancy(
            window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(CORNER_RADIUS),
        );
        panel.set_style_mask(NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL | NS_WINDOW_STYLE_MASK_RESIZABLE);
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
}
