//! The reply card: a small panel at the top right that shows the session at
//! the front of the queue. It never takes focus by itself, so a session
//! finishing can't pull your typing away; clicking it lets you edit the reply.

use tauri::AppHandle;

pub const LABEL: &str = "agents";
const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 260.0;
const MARGIN: f64 = 16.0;

// tauri-nspanel's collection-behaviour type is marked deprecated; the HUD and
// the launcher use the same one.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
pub fn show(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};
        const NONACTIVATING_PANEL: i32 = 1 << 7;
        /// Level with the HUD and the launcher (hud.rs, panel.rs).
        const CARD_LEVEL: i32 = 25;
        if let Ok(panel) = app.get_webview_panel(LABEL) {
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
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let scale = monitor.scale_factor();
            let size = monitor.size().to_logical::<f64>(scale);
            let origin = monitor.position().to_logical::<f64>(scale);
            let _ = window.set_position(tauri::LogicalPosition::new(origin.x + size.width - WIDTH - MARGIN, origin.y + MARGIN + 24.0));
        }
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
pub fn hide(_app: &AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn take_keys(_app: &AppHandle) {}
