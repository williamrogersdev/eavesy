// tauri-nspanel re-exports the legacy `cocoa`/`objc` crates: their APIs are deprecated and
// their `msg_send!` macros trip `unexpected_cfgs`. Moving to objc2 is a separate migration.
#![allow(deprecated, unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
static PINNED: AtomicBool = AtomicBool::new(false);
static YIELDS: AtomicUsize = AtomicUsize::new(0);
pub fn set_pinned(pinned: bool) { PINNED.store(pinned, Ordering::SeqCst); }
/// Pinned by the launcher, or held open while a system prompt is on screen.
pub fn is_pinned() -> bool { PINNED.load(Ordering::SeqCst) || is_yielding() }
pub fn is_yielding() -> bool { YIELDS.load(Ordering::SeqCst) > 0 }

/// Keeps the launcher and the HUD out of the way of a macOS permission prompt; dropping the
/// guard restores them.
///
/// macOS ignores clicks on a privacy (TCC) alert while another window covers it, and both
/// panels float above the alert. While any guard is alive both drop to the normal window level,
/// the HUD is ordered out, the launcher stays open (it is pinned, so the alert taking focus does
/// not close it) and is moved clear of the alert when the alert's window can be found.
#[must_use = "the panels come back as soon as the guard is dropped"]
pub struct SystemPromptYield {
    app: tauri::AppHandle,
}

pub fn yield_for_system_prompt(app: &tauri::AppHandle) -> SystemPromptYield {
    if YIELDS.fetch_add(1, Ordering::SeqCst) == 0 {
        on_main_and_wait(app, |app| imp::set_yielded(app, true));
        crate::make_room::clear_of_system_prompts(app);
    }
    SystemPromptYield { app: app.clone() }
}

impl Drop for SystemPromptYield {
    fn drop(&mut self) {
        if YIELDS.fetch_sub(1, Ordering::SeqCst) == 1 {
            on_main_and_wait(&self.app, |app| {
                if !is_yielding() { imp::set_yielded(app, false); }
            });
        }
    }
}

/// For prompts whose API returns before the user answers (Accessibility, Input Monitoring):
/// yields in the background while the prompt is likely on screen. That is at least
/// `PROMPT_MIN_HOLD`, then for as long as a prompt window can be seen, until `done()` says the
/// permission was granted, or `PROMPT_MAX_HOLD` at most.
pub fn yield_while_prompt_shows(app: &tauri::AppHandle, done: impl Fn() -> bool + Send + 'static) {
    let guard = yield_for_system_prompt(app);
    std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let elapsed = start.elapsed();
            if hold_finished(elapsed, done(), crate::make_room::system_prompt_frame().is_some()) { break; }
        }
        drop(guard);
    });
}

static SETTINGS_YIELD: AtomicBool = AtomicBool::new(false);
static SETTINGS_REOPENED: AtomicBool = AtomicBool::new(false);
const SETTINGS_MIN_HOLD: Duration = Duration::from_secs(3);
const SETTINGS_MAX_HOLD: Duration = Duration::from_secs(10 * 60);

/// System Settings opened from Eavesy (a permission, say) must not sit under the launcher. The
/// launcher already moves aside when there's room; while a Settings window is on screen the
/// panels also drop to the normal window level, so Settings comes to the front when clicked.
/// The hold ends when Settings closes, when the person clicks back into the launcher, or after
/// `SETTINGS_MAX_HOLD`.
pub fn yield_while_settings_open(app: &tauri::AppHandle) {
    if SETTINGS_YIELD.swap(true, Ordering::SeqCst) {
        // A hold is running: Settings was opened again, so the hold starts over for it.
        SETTINGS_REOPENED.store(true, Ordering::SeqCst);
        return;
    }
    SETTINGS_REOPENED.store(false, Ordering::SeqCst);
    let guard = yield_for_system_prompt(app);
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Manager;
        let mut start = Instant::now();
        // The launcher has focus when its button opens Settings: only coming back to it after
        // Settings took focus counts as a return.
        let mut left = false;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if SETTINGS_REOPENED.swap(false, Ordering::SeqCst) {
                start = Instant::now();
                left = false;
            }
            // No launcher window to yield for ends the hold; a focus error counts as away.
            let Some(main) = app.get_webview_window("main") else { break };
            let focused = main.is_focused().unwrap_or(false);
            left |= !focused;
            if settings_hold_finished(start.elapsed(), crate::make_room::settings_open(), left && focused) { break; }
        }
        SETTINGS_YIELD.store(false, Ordering::SeqCst);
        drop(guard);
        // Opened again while this hold was ending: that opening gets a hold of its own.
        if SETTINGS_REOPENED.swap(false, Ordering::SeqCst) {
            yield_while_settings_open(&app);
        }
    });
}

fn settings_hold_finished(elapsed: Duration, settings_open: bool, launcher_focused: bool) -> bool {
    elapsed >= SETTINGS_MAX_HOLD || (elapsed >= SETTINGS_MIN_HOLD && (!settings_open || launcher_focused))
}

const PROMPT_MIN_HOLD: Duration = Duration::from_secs(8);
const PROMPT_MAX_HOLD: Duration = Duration::from_secs(90);

fn hold_finished(elapsed: Duration, granted: bool, prompt_visible: bool) -> bool {
    granted || elapsed >= PROMPT_MAX_HOLD || (elapsed >= PROMPT_MIN_HOLD && !prompt_visible)
}

fn on_main_and_wait(app: &tauri::AppHandle, work: impl FnOnce(&tauri::AppHandle) + Send + 'static) {
    if std::thread::current().name() == Some("main") {
        work(app);
        return;
    }
    let (done, wait) = std::sync::mpsc::channel();
    let handle = app.clone();
    if app.run_on_main_thread(move || { work(&handle); let _ = done.send(()); }).is_ok() {
        let _ = wait.recv_timeout(Duration::from_millis(500));
    }
}

fn remember_size(app: &tauri::AppHandle) {
    use tauri::Manager;
    // Setup's roomier size is setup's own, not a size the person chose.
    if SETUP_LAYOUT.load(Ordering::SeqCst) { return; }
    let Some(main) = app.get_webview_window("main") else { return };
    let (Ok(scale), Ok(size)) = (main.scale_factor(), main.inner_size()) else { return };
    let size = size.to_logical::<f64>(scale);
    let size = crate::settings::PanelSize { width: size.width.round(), height: size.height.round() };
    if crate::settings::load(app).panel_size != Some(size) {
        let _ = crate::settings::update(app, |config| config.panel_size = Some(size));
    }
}

fn restore_size(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (Some(main), Some(size)) = (app.get_webview_window("main"), crate::settings::load(app).panel_size) else { return };
    let _ = main.set_size(tauri::LogicalSize::new(size.width, size.height));
}

const MIN_SIZE: (f64, f64) = (360.0, 320.0);
/// The panel's size before anyone resizes it (tauri.conf.json).
const DEFAULT_SIZE: (f64, f64) = (420.0, 440.0);
/// First-run setup: room for a step without crowding, still clear of most of the screen.
const SETUP_SIZE: (f64, f64) = (540.0, 600.0);
static SETUP_LAYOUT: AtomicBool = AtomicBool::new(false);

/// Setup shows in a roomier panel. Leaving it puts back the size the person chose, or the default.
#[tauri::command]
pub fn set_setup_layout(app: tauri::AppHandle, active: bool) -> Result<(), String> {
    if SETUP_LAYOUT.swap(active, Ordering::SeqCst) == active {
        return Ok(());
    }
    let (width, height) = if active {
        SETUP_SIZE
    } else {
        crate::settings::load(&app).panel_size.map_or(DEFAULT_SIZE, |size| (size.width, size.height))
    };
    let resized = resize_panel(app, width, height);
    if resized.is_err() {
        // Not resized: the next call tries again, and the person's size can still be saved.
        SETUP_LAYOUT.store(!active, Ordering::SeqCst);
    }
    resized
}
const MAX_SIZE: (f64, f64) = (960.0, 1200.0);

fn resized_frame(current: (f64, f64, f64, f64), requested: (f64, f64), area: Option<(f64, f64, f64, f64)>) -> (f64, f64, f64, f64) {
    let (x, y, w, _) = current;
    let centre = x + w / 2.0;
    let (mut max_w, mut max_h) = MAX_SIZE;
    if let Some((_, ay, aw, ah)) = area {
        max_w = max_w.min(aw).max(MIN_SIZE.0);
        max_h = max_h.min(ay + ah - y).max(MIN_SIZE.1);
    }
    let width = requested.0.clamp(MIN_SIZE.0, max_w).round();
    let height = requested.1.clamp(MIN_SIZE.1, max_h).round();
    let mut left = centre - width / 2.0;
    if let Some((ax, _, aw, _)) = area {
        left = left.clamp(ax, (ax + aw - width).max(ax));
    }
    (left.round(), y, width, height)
}

#[tauri::command]
pub fn resize_panel(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    use tauri::Manager;
    let main = app.get_webview_window("main").ok_or("main window not found")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let pos = main.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let size = main.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let area = crate::placement::work_area_at(&app, pos.x + size.width / 2.0, pos.y + 1.0);
    let (x, y, w, h) = resized_frame((pos.x, pos.y, size.width, size.height), (width, height), area);
    main.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())?;
    if let Err(error) = main.set_position(tauri::LogicalPosition::new(x, y)) {
        // All or nothing: a caller that sees the error can trust the size is unchanged.
        let _ = main.set_size(tauri::LogicalSize::new(size.width, size.height));
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const AREA: Option<(f64, f64, f64, f64)> = Some((0.0, 25.0, 1440.0, 875.0));

    #[test]
    fn width_grows_around_the_centre_and_top_stays_put() {
        assert_eq!(resized_frame((500.0, 60.0, 420.0, 440.0), (520.0, 500.0), AREA), (450.0, 60.0, 520.0, 500.0));
    }

    #[test]
    fn settings_hold_ends_when_settings_closes_or_the_launcher_is_back() {
        let s = Duration::from_secs;
        assert!(!settings_hold_finished(s(1), false, false), "Settings may still be opening");
        assert!(!settings_hold_finished(s(30), true, false));
        assert!(settings_hold_finished(s(30), false, false));
        assert!(settings_hold_finished(s(30), true, true));
        assert!(settings_hold_finished(SETTINGS_MAX_HOLD, true, false));
    }

    #[test]
    fn prompt_hold_waits_for_the_prompt_but_not_forever() {
        let s = Duration::from_secs;
        assert!(!hold_finished(s(2), false, false), "a prompt may not be on screen yet");
        assert!(!hold_finished(s(20), false, true), "still showing");
        assert!(hold_finished(s(20), false, false), "gone");
        assert!(hold_finished(s(1), true, true), "granted");
        assert!(hold_finished(PROMPT_MAX_HOLD, false, true), "never longer than the cap");
    }

    #[test]
    fn yields_nest_and_pin_the_launcher() {
        assert!(!is_yielding());
        YIELDS.fetch_add(1, Ordering::SeqCst);
        assert!(is_pinned());
        YIELDS.fetch_sub(1, Ordering::SeqCst);
        assert!(!is_pinned());
    }

    #[test]
    fn clamps_to_limits_and_the_screen() {
        assert_eq!(resized_frame((500.0, 60.0, 420.0, 440.0), (100.0, 100.0), AREA), (530.0, 60.0, 360.0, 320.0));
        assert_eq!(resized_frame((500.0, 60.0, 420.0, 440.0), (420.0, 2000.0), AREA).3, 840.0);
        assert_eq!(resized_frame((0.0, 60.0, 420.0, 440.0), (700.0, 440.0), AREA).0, 0.0);
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, Manager, WebviewWindow};
    use tauri_nspanel::{
        cocoa::appkit::NSWindowCollectionBehavior, panel_delegate, ManagerExt, WebviewWindowExt,
    };
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: i32 = 1 << 7;
    const NS_WINDOW_STYLE_MASK_RESIZABLE: i32 = 1 << 3;

    const PANEL_WINDOW_LEVEL: i32 = 25;
    /// Matches `HUD_WINDOW_LEVEL` in hud.rs.
    const HUD_WINDOW_LEVEL: i32 = 25;
    const NORMAL_WINDOW_LEVEL: i32 = 0;

    static HUD_WAS_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    pub fn set_yielded(app: &AppHandle, yielded: bool) {
        use std::sync::atomic::Ordering;
        if let Ok(panel) = app.get_webview_panel("main") {
            panel.set_level(if yielded { NORMAL_WINDOW_LEVEL } else { PANEL_WINDOW_LEVEL });
            if !yielded && panel.is_visible() {
                panel.order_front_regardless();
            }
        }
        if let Ok(hud) = app.get_webview_panel("hud") {
            if yielded {
                HUD_WAS_VISIBLE.store(hud.is_visible(), Ordering::SeqCst);
                hud.set_level(NORMAL_WINDOW_LEVEL);
                hud.order_out(None);
            } else {
                hud.set_level(HUD_WINDOW_LEVEL);
                if HUD_WAS_VISIBLE.swap(false, Ordering::SeqCst) || hud.is_visible() {
                    hud.order_front_regardless();
                }
            }
        }
    }

    pub fn install(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;

        // Popover follows the system appearance; the always-dark HudWindow material is the
        // pill's, and under the panel's paper it read as a black slab (DESIGN.md §4).
        apply_vibrancy(
            &window,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(12.0),
        )
        .map_err(|e| format!("failed to apply vibrancy: {e}"))?;

        let panel = window
            .to_panel()
            .map_err(|e| format!("failed to convert window to NSPanel: {e}"))?;

        panel.set_style_mask(NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL | NS_WINDOW_STYLE_MASK_RESIZABLE);
        super::restore_size(app);
        panel.set_level(PANEL_WINDOW_LEVEL);

        panel.set_collection_behaviour(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
        );

        let delegate = panel_delegate!(EavesyPanelDelegate { window_did_resign_key });
        let handle = app.clone();
        delegate.set_listener(Box::new(move |name: String| {
            if name == "window_did_resign_key" && !super::is_pinned() {
                let collapse = handle.clone();
                let _ = handle.run_on_main_thread(move || { let _ = hide(&collapse); });
            }
        }));
        panel.set_delegate(delegate);

        panel.set_released_when_closed(false);

        Ok(())
    }

    /// How long the pill stays under the panel while the panel fades in over it.
    const PILL_HANDOFF: std::time::Duration = std::time::Duration::from_millis(220);

    pub fn show(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
        crate::placement::place(app);
        let panel = app
            .get_webview_panel("main")
            .map_err(|e| format!("panel not found: {e:?}"))?;
        let was_visible = panel.is_visible();
        if !was_visible { set_alpha(window, 0.0, false); }
        panel.show();
        panel.make_key_window();
        crate::app_menu::activate();
        if was_visible {
            crate::hud::hide_on_main(app);
            return Ok(());
        }
        // Fade in over the pill, then put the pill away once it's covered: a hand-off, not a cut.
        set_alpha(window, 1.0, true);
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(PILL_HANDOFF);
            let main = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if is_visible(&main) { crate::hud::hide_on_main(&main); }
            });
        });
        Ok(())
    }

    /// Sets the window's alpha, through the animator (AppKit's default 0.25 s) when `animate`.
    fn set_alpha(window: &WebviewWindow, alpha: f64, animate: bool) {
        use tauri_nspanel::cocoa::base::id;
        use tauri_nspanel::objc::{msg_send, sel, sel_impl};
        let Ok(ns_window) = window.ns_window() else { return };
        let ns_window = ns_window as id;
        unsafe {
            if animate {
                let animator: id = msg_send![ns_window, animator];
                let _: () = msg_send![animator, setAlphaValue: alpha];
            } else {
                let _: () = msg_send![ns_window, setAlphaValue: alpha];
            }
        }
    }

    pub fn hide(app: &AppHandle) -> Result<(), String> {
        let panel = app
            .get_webview_panel("main")
            .map_err(|e| format!("panel not found: {e:?}"))?;
        super::remember_size(app);
        crate::hud::collapse_from_panel_on_main(app);
        panel.order_out(None);
        // The clipboard panel taking the keyboard closes this one: it keeps the focus.
        if !crate::clipboard::is_visible(app) {
            crate::app_menu::return_focus();
        }
        Ok(())
    }

    pub fn is_visible(app: &AppHandle) -> bool {
        app.get_webview_panel("main")
            .map(|p| p.is_visible())
            .unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{AppHandle, Manager, WebviewWindow};

    pub fn set_yielded(_app: &AppHandle, _yielded: bool) {}

    pub fn install(app: &AppHandle) -> Result<(), String> {
        super::restore_size(app);
        Ok(())
    }

    pub fn show(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
        crate::placement::place(app);
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        crate::hud::hide_on_main(app);
        Ok(())
    }

    pub fn hide(app: &AppHandle) -> Result<(), String> {
        super::remember_size(app);
        crate::hud::collapse_from_panel_on_main(app);
        if let Some(w) = app.get_webview_window("main") {
            w.hide().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn is_visible(app: &AppHandle) -> bool {
        app.get_webview_window("main")
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false)
    }
}

pub use imp::{hide, install, is_visible, show};
