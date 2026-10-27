use crate::settings::{self, LauncherPosition};
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize};

fn active_monitor(app: &AppHandle) -> Option<Monitor> {
    if let Some(hud) = app.get_webview_window("hud") {
        if hud.is_visible().unwrap_or(false) { return hud.current_monitor().ok().flatten(); }
    }
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) { return main.current_monitor().ok().flatten(); }
    }
    if let Ok(point) = app.cursor_position() {
        if let Ok(Some(monitor)) = app.monitor_from_point(point.x, point.y) { return Some(monitor); }
    }
    app.primary_monitor().ok().flatten()
}

fn companion_positions(origin: PhysicalPosition<i32>, area: PhysicalSize<u32>, panel: PhysicalSize<u32>, pill: PhysicalSize<u32>, scale: f64, position: LauncherPosition) -> (PhysicalPosition<i32>, PhysicalPosition<i32>) {
    let margin = (16.0 * scale).round() as i32;
    let horizontal = |width: u32| {
        let offset = match position {
            LauncherPosition::TopLeft => margin,
            LauncherPosition::TopRight => area.width as i32 - margin - width as i32,
            LauncherPosition::TopCenter | LauncherPosition::BottomCenter => (area.width as i32 - width as i32) / 2,
        };
        origin.x + offset.max(0)
    };
    let max_panel_y = origin.y + (area.height as i32 - panel.height as i32).max(0);
    if matches!(position, LauncherPosition::BottomCenter) {
        // Docked at the bottom: the panel opens upwards and ends where the control does.
        let hud_y = origin.y + (area.height as i32 - margin - pill.height as i32).max(0);
        let hud = PhysicalPosition::new(horizontal(pill.width), hud_y);
        let launcher_y = (hud_y + pill.height as i32 - panel.height as i32).clamp(origin.y, max_panel_y);
        return (PhysicalPosition::new(horizontal(panel.width), launcher_y), hud);
    }
    let hud = PhysicalPosition::new(horizontal(pill.width), origin.y + margin);
    let launcher = PhysicalPosition::new(horizontal(panel.width), hud.y.min(max_panel_y));
    (launcher, hud)
}

pub fn work_area_at(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
    app.available_monitors().ok()?.iter().find_map(|monitor| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let rect = (
            area.position.x as f64 / scale,
            area.position.y as f64 / scale,
            area.size.width as f64 / scale,
            area.size.height as f64 / scale,
        );
        (x >= rect.0 && x < rect.0 + rect.2 && y >= rect.1 && y < rect.1 + rect.3).then_some(rect)
    })
}

fn panel_origin_for(anchor_x: f64, anchor_y: f64, panel: (f64, f64), area: (f64, f64, f64, f64)) -> (f64, f64) {
    let max_x = (area.0 + area.2 - panel.0).max(area.0);
    let max_y = (area.1 + area.3 - panel.1).max(area.1);
    ((anchor_x - panel.0 / 2.0).clamp(area.0, max_x), anchor_y.clamp(area.1, max_y))
}

/// Whether a control at this frame sits in the lower half of its screen, so
/// the panel and the transcript open upwards and the control stays put.
pub fn in_lower_half(app: &AppHandle, x: f64, y: f64, height: f64) -> bool {
    let middle = y + height / 2.0;
    work_area_at(app, x, middle).is_some_and(|area| middle > area.1 + area.3 / 2.0)
}

pub fn place(app: &AppHandle) {
    if let (Some(frame), Some(main)) = (crate::hud::user_frame(app), app.get_webview_window("main")) {
        let anchor = (frame.x + frame.width / 2.0, frame.y);
        if let (Some(area), Ok(scale), Ok(size)) = (work_area_at(app, anchor.0, anchor.1 + 1.0), main.scale_factor(), main.outer_size()) {
            let size = size.to_logical::<f64>(scale);
            let top = if in_lower_half(app, anchor.0, frame.y, frame.height) {
                frame.y + frame.height - size.height
            } else {
                anchor.1
            };
            let (x, y) = panel_origin_for(anchor.0, top, (size.width, size.height), area);
            let _ = main.set_position(tauri::LogicalPosition::new(x, y));
            return;
        }
    }
    let Some(monitor) = active_monitor(app) else { return; };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let main = app.get_webview_window("main");
    let hud = app.get_webview_window("hud");
    let size = main.as_ref().and_then(|w| w.outer_size().ok()).unwrap_or(PhysicalSize::new((420.0*scale) as u32,(440.0*scale) as u32));
    let pill = hud.as_ref().and_then(|w| w.outer_size().ok()).unwrap_or(PhysicalSize::new((272.0*scale) as u32,(40.0*scale) as u32));
    let (launcher_position, hud_position) = companion_positions(area.position, area.size, size, pill, scale, settings::load(app).launcher_position);
    if let Some(window) = main { let _ = window.set_position(launcher_position); }
    if let Some(window) = hud { let _ = window.set_position(hud_position); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn surfaces_share_top_anchor_and_respects_negative_display_origin() {
        let (panel,pill) = companion_positions(PhysicalPosition::new(-1920,24),PhysicalSize::new(1920,1056),PhysicalSize::new(620,440),PhysicalSize::new(260,44),1.0, LauncherPosition::TopRight);
        assert_eq!(pill,PhysicalPosition::new(-276,40));
        assert_eq!(panel,PhysicalPosition::new(-636,40));
        assert_eq!(panel.x+620,pill.x+260);
        assert_eq!(pill.y,panel.y);
    }
    #[test]
    fn panel_expands_from_the_control_anchor_and_stays_on_screen() {
        let area = (0.0, 25.0, 1440.0, 875.0);
        assert_eq!(panel_origin_for(700.0, 300.0, (420.0, 440.0), area), (490.0, 300.0));
        assert_eq!(panel_origin_for(1400.0, 300.0, (420.0, 440.0), area), (1020.0, 300.0));
        assert_eq!(panel_origin_for(700.0, 800.0, (420.0, 440.0), area), (490.0, 460.0));
    }
    #[test]
    fn bottom_center_docks_the_control_low_and_opens_the_panel_upwards() {
        let (panel, pill) = companion_positions(PhysicalPosition::new(0,25), PhysicalSize::new(1440,875), PhysicalSize::new(420,440), PhysicalSize::new(272,40), 1.0, LauncherPosition::BottomCenter);
        assert_eq!(pill.y + 40, 25 + 875 - 16);
        assert_eq!(panel.y + 440, pill.y + 40);
        assert_eq!(panel.x + 210, pill.x + 136);
    }
    #[test]
    fn top_left_hugs_the_left_margin() {
        let (panel, pill) = companion_positions(PhysicalPosition::new(0,25), PhysicalSize::new(1440,875), PhysicalSize::new(420,440), PhysicalSize::new(272,40), 1.0, LauncherPosition::TopLeft);
        assert_eq!((panel.x, pill.x), (16, 16));
        assert_eq!(panel.y, pill.y);
    }
    #[test]
    fn top_center_aligns_both_windows_by_their_centers() {
        let (panel, pill) = companion_positions(PhysicalPosition::new(100,48), PhysicalSize::new(1440,900), PhysicalSize::new(620,440), PhysicalSize::new(260,44), 1.0, LauncherPosition::TopCenter);
        assert_eq!(panel.x+310,820);
        assert_eq!(pill.x+130,820);
        assert_eq!(panel.y,64);
    }
    #[test]
    fn retina_spacing_and_small_display_stay_inside_work_area() {
        let (panel,pill) = companion_positions(PhysicalPosition::new(0,48),PhysicalSize::new(1280,950),PhysicalSize::new(1240,880),PhysicalSize::new(520,88),2.0, LauncherPosition::TopRight);
        assert!(panel.x>=0 && panel.y>=48);
        assert!(pill.x>=0 && pill.y>=48);
        assert!(pill.y+88<=998);
        assert!(panel.y+880<=998);
    }
}
