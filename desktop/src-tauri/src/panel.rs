// tauri-nspanel re-exports the legacy `cocoa`/`objc` crates: their APIs are deprecated and
// their `msg_send!` macros trip `unexpected_cfgs`. Moving to objc2 is a separate migration.
#![allow(deprecated, unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, Ordering};
static PINNED: AtomicBool = AtomicBool::new(false);
pub fn set_pinned(pinned: bool) { PINNED.store(pinned, Ordering::SeqCst); }
pub fn is_pinned() -> bool { PINNED.load(Ordering::SeqCst) }

fn remember_size(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(main) = app.get_webview_window("main") else { return };
    let (Ok(scale), Ok(size)) = (main.scale_factor(), main.inner_size()) else { return };
    let size = size.to_logical::<f64>(scale);
    let size = crate::settings::PanelSize { width: size.width.round(), height: size.height.round() };
    let mut config = crate::settings::load(app);
    if config.panel_size != Some(size) {
        config.panel_size = Some(size);
        let _ = crate::settings::save(app, &config);
    }
}

fn restore_size(app: &tauri::AppHandle) {
    use tauri::Manager;
    let (Some(main), Some(size)) = (app.get_webview_window("main"), crate::settings::load(app).panel_size) else { return };
    let _ = main.set_size(tauri::LogicalSize::new(size.width, size.height));
}

const MIN_SIZE: (f64, f64) = (360.0, 320.0);
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
    main.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
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

    pub fn install(app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;

        apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
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

    pub fn show(app: &AppHandle, _window: &WebviewWindow) -> Result<(), String> {
        crate::placement::place(app);
        let panel = app
            .get_webview_panel("main")
            .map_err(|e| format!("panel not found: {e:?}"))?;
        panel.show();
        panel.make_key_window();
        crate::hud::hide_on_main(app);
        Ok(())
    }

    pub fn hide(app: &AppHandle) -> Result<(), String> {
        let panel = app
            .get_webview_panel("main")
            .map_err(|e| format!("panel not found: {e:?}"))?;
        super::remember_size(app);
        crate::hud::collapse_from_panel_on_main(app);
        panel.order_out(None);
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
