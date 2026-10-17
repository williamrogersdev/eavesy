use std::time::Duration;

use tauri::{AppHandle, Manager};

type Rect = (f64, f64, f64, f64);

const GAP: f64 = 16.0;

fn clear_position(panel: Rect, other: Rect, area: Rect) -> Option<(f64, f64)> {
    let (px, py, pw, ph) = panel;
    let (ox, oy, ow, oh) = other;
    let overlaps = px < ox + ow && ox < px + pw && py < oy + oh && oy < py + ph;
    if !overlaps {
        return None;
    }
    let (ax, _, aw, _) = area;
    let room_left = ox - ax;
    let room_right = ax + aw - (ox + ow);
    let x = if room_right >= pw + GAP || room_right >= room_left {
        (ox + ow + GAP).min(ax + aw - pw - GAP).max(ax)
    } else {
        (ox - pw - GAP).max(ax + GAP).min(ax + aw - pw)
    };
    Some((x.round(), py))
}

pub fn after_opening_settings(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        for _ in 0..30 {
            std::thread::sleep(Duration::from_millis(100));
            let Some(settings) = system_settings_frame() else { continue };
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || move_clear_of(&handle, settings));
            return;
        }
    });
}

fn move_clear_of(app: &AppHandle, other: Rect) {
    let Some(main) = app.get_webview_window("main") else { return };
    if !main.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(scale), Ok(pos), Ok(size)) = (main.scale_factor(), main.outer_position(), main.outer_size()) else { return };
    let (pos, size) = (pos.to_logical::<f64>(scale), size.to_logical::<f64>(scale));
    let Some(area) = crate::placement::work_area_at(app, other.0 + other.2 / 2.0, other.1 + 1.0) else { return };
    if let Some((x, y)) = clear_position((pos.x, pos.y, size.width, size.height), other, area) {
        let _ = main.set_position(tauri::LogicalPosition::new(x, y));
    }
}

fn system_settings_frame() -> Option<Rect> {
    frontmost_window_of(&["System Settings", "System Preferences"], Layer::Normal)
}

/// Processes that draw macOS privacy (TCC) and permission alerts.
const SYSTEM_PROMPT_OWNERS: &[&str] = &[
    "UserNotificationCenter",
    "universalAccessAuthWarn",
    "CoreServicesUIAgent",
    "SecurityAgent",
    "tccd",
];

/// The frame of a macOS permission alert on screen, if one can be seen.
pub fn system_prompt_frame() -> Option<Rect> {
    frontmost_window_of(SYSTEM_PROMPT_OWNERS, Layer::Any)
}

/// While the launcher yields to a system prompt, moves it beside the prompt whenever one appears.
pub fn clear_of_system_prompts(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<Rect> = None;
        for _ in 0..600 {
            std::thread::sleep(Duration::from_millis(150));
            if !crate::panel::is_yielding() {
                return;
            }
            let Some(prompt) = system_prompt_frame() else { continue };
            if last == Some(prompt) {
                continue;
            }
            last = Some(prompt);
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || move_clear_of(&handle, prompt));
        }
    });
}

#[derive(Clone, Copy)]
enum Layer {
    /// Ordinary app windows only.
    Normal,
    /// Any layer: system alerts float above ordinary windows.
    Any,
}

#[cfg(target_os = "macos")]
fn frontmost_window_of(owners: &[&str], layer: Layer) -> Option<Rect> {
    use crate::cf::*;

    #[repr(C)]
    #[derive(Default)]
    struct CGRect { x: f64, y: f64, w: f64, h: f64 }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFTypeRef, rect: *mut CGRect) -> bool;
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;

    unsafe {
        let list = Owned(CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0));
        if list.0.is_null() {
            return None;
        }
        let (owner_key, layer_key, bounds_key) = (cf_str("kCGWindowOwnerName"), cf_str("kCGWindowLayer"), cf_str("kCGWindowBounds"));
        (0..CFArrayGetCount(list.0)).find_map(|i| {
            let window = CFArrayGetValueAtIndex(list.0, i);
            let owner = cf_string(CFDictionaryGetValue(window, owner_key.0))?;
            if !owners.contains(&owner.as_str()) {
                return None;
            }
            if matches!(layer, Layer::Normal) && cf_i32(CFDictionaryGetValue(window, layer_key.0)) != Some(0) {
                return None;
            }
            let mut rect = CGRect::default();
            let bounds = CFDictionaryGetValue(window, bounds_key.0);
            (!bounds.is_null() && CGRectMakeWithDictionaryRepresentation(bounds, &mut rect) && rect.w > 100.0)
                .then_some((rect.x, rect.y, rect.w, rect.h))
        })
    }
}

#[cfg(not(target_os = "macos"))]
fn frontmost_window_of(_owners: &[&str], _layer: Layer) -> Option<Rect> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    const AREA: Rect = (0.0, 25.0, 1440.0, 875.0);

    #[test]
    #[ignore = "needs a window server; run by hand"]
    fn reads_a_real_window_frame() {
        let frame = frontmost_window_of(&["Claude"], Layer::Normal).expect("Claude window on screen");
        tracing::debug!("Claude window: {frame:?}");
        assert!(frame.2 > 100.0 && frame.3 > 100.0);
    }

    #[test]
    fn leaves_a_panel_that_is_already_clear_alone() {
        assert_eq!(clear_position((20.0, 60.0, 420.0, 440.0), (600.0, 100.0, 700.0, 600.0), AREA), None);
    }

    #[test]
    fn moves_beside_settings_on_the_roomier_side() {
        assert_eq!(clear_position((700.0, 60.0, 420.0, 440.0), (650.0, 100.0, 700.0, 600.0), AREA), Some((214.0, 60.0)));
        assert_eq!(clear_position((300.0, 60.0, 420.0, 440.0), (100.0, 100.0, 700.0, 600.0), AREA), Some((816.0, 60.0)));
    }

    #[test]
    fn hugs_the_edge_when_the_screen_is_too_narrow() {
        let narrow = (0.0, 25.0, 1000.0, 700.0);
        let (x, _) = clear_position((300.0, 60.0, 420.0, 440.0), (150.0, 100.0, 700.0, 500.0), narrow).unwrap();
        assert_eq!(x, 1000.0 - 420.0 - GAP);
    }
}
