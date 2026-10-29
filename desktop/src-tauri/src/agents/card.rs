//! The reply card: a small panel at the top right of the screen you're on that
//! shows the session at the front of the queue. It never takes focus by
//! itself, so a session finishing can't pull your typing away; clicking it
//! lets you edit the reply.
//!
//! Eavesy only speaks once the card says it has drawn the item
//! (`agents_rendered`), so nothing is ever said without the card on screen.

use tauri::AppHandle;

pub const LABEL: &str = "agents";
const WIDTH: f64 = 380.0;
/// Where the card starts before it has measured itself.
const HEIGHT: f64 = 260.0;
const MIN_HEIGHT: f64 = 96.0;
const MAX_HEIGHT: f64 = 560.0;
const MARGIN: f64 = 16.0;
/// Below the menu bar.
const TOP: f64 = 24.0;

/// The height the card asked for, kept within reason.
pub fn clamp_height(height: f64) -> f64 {
    if height.is_finite() { height.clamp(MIN_HEIGHT, MAX_HEIGHT) } else { HEIGHT }
}

/// Top right of the screen with the pointer, where you're looking, rather
/// than the main display.
#[cfg(target_os = "macos")]
fn place(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let size = area.size.to_logical::<f64>(scale);
    let origin = area.position.to_logical::<f64>(scale);
    let _ = window.set_position(tauri::LogicalPosition::new(origin.x + size.width - WIDTH - MARGIN, origin.y + MARGIN.min(TOP)));
}

// tauri-nspanel's collection-behaviour type is marked deprecated; the HUD and
// the launcher use the same one.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn show(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        use tauri::Manager;
        use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};
        const NONACTIVATING_PANEL: i32 = 1 << 7;
        /// Level with the HUD and the launcher (hud.rs, panel.rs).
        const CARD_LEVEL: i32 = 25;
        if let Ok(panel) = app.get_webview_panel(LABEL) {
            if !panel.is_visible() {
                if let Some(window) = app.get_webview_window(LABEL) {
                    place(&app, &window);
                }
            }
            panel.order_front_regardless();
            return;
        }
        let window = match tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::App("agents.html".into()))
            .title("Eavesy Sessions")
            .inner_size(WIDTH, HEIGHT)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(true)
            .focused(false)
            .visible(false)
            .accept_first_mouse(true)
            .build()
        {
            Ok(window) => window,
            Err(error) => {
                tracing::warn!("could not open the reply card: {error}");
                return;
            }
        };
        place(&app, &window);
        match window.to_panel() {
            Ok(panel) => {
                panel.set_style_mask(NONACTIVATING_PANEL);
                panel.set_level(CARD_LEVEL);
                panel.set_collection_behaviour(
                    NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                );
                panel.set_released_when_closed(false);
                panel.order_front_regardless();
            }
            Err(_) => {
                let _ = window.show();
            }
        }
    });
}

/// Fits the card to what it drew; its top edge stays put.
#[cfg(target_os = "macos")]
pub fn fit(app: &AppHandle, height: f64) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri::Manager;
        if let Some(window) = handle.get_webview_window(LABEL) {
            let _ = window.set_size(tauri::LogicalSize::new(WIDTH, clamp_height(height)));
        }
    });
}

#[cfg(target_os = "macos")]
pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.order_out(None);
        }
    });
}

/// You clicked into the reply to edit it: let the card take the keyboard.
#[cfg(target_os = "macos")]
pub fn take_keys(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = handle.get_webview_panel(LABEL) {
            panel.make_key_window();
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn show(_app: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn fit(_app: &AppHandle, _height: f64) {}
#[cfg(not(target_os = "macos"))]
pub fn hide(_app: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn take_keys(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    #[test]
    fn heights_stay_on_screen() {
        assert_eq!(super::clamp_height(10.0), 96.0);
        assert_eq!(super::clamp_height(300.0), 300.0);
        assert_eq!(super::clamp_height(5000.0), 560.0);
        assert_eq!(super::clamp_height(f64::NAN), 260.0);
    }
}
