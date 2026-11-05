//! The next meeting, named in the menu bar: "Design review • in 11m".
//!
//! A second menu bar item, beside Eavesy's own, built from the calendar the
//! meeting watcher already fetches (`/api/calendar-events`, every connected
//! calendar merged). It only exists while there is something to say:
//!
//! - It shows from `LEAD_MS` before a meeting starts until the meeting ends,
//!   and is hidden otherwise: signed out, no calendar connected, or nothing
//!   coming up. Ambient first, so no placeholder like "No meetings".
//! - With two in that window, the one whose start is nearest wins (so a
//!   meeting under way gives way to the next one once that is closer).
//! - Before the start it counts down ("in 11m", whole minutes, rounded up);
//!   from the start it says "now", or "recording" while Eavesy's own menu bar
//!   glyph shows its recording dot. Both change in the same refresh, so the
//!   two items never disagree. The text stays system ink: coral is only the
//!   recording glyph's.
//! - Titles longer than `TITLE_CHARS` are cut at a word and end in "…"; the
//!   tooltip and the details card show the whole title.
//!
//! Clicking it opens the details card (`meeting.html`) under the item: time,
//! people, the join link, and the meeting's record switch.

use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::meeting_watch::{self, Attendee, Event};

const TRAY_ID: &str = "eavesy-meeting";
pub const LABEL: &str = "meeting";
/// How long before its start a meeting shows up in the menu bar.
pub const LEAD_MS: i64 = 30 * 60_000;
/// The longest title the menu bar shows before cutting it.
pub const TITLE_CHARS: usize = 32;
const CARD_WIDTH: f64 = 320.0;
const CARD_HEIGHT: f64 = 220.0;
const CARD_MAX_HEIGHT: f64 = 520.0;
/// A click on the item right after the card lost focus to it is the click that closed it.
const REOPEN_AFTER_MS: u128 = 350;

/// The meeting to announce at `now`: within `LEAD_MS` of its start, or under
/// way, nearest start first (a tie goes to the one under way).
pub fn announced(events: &[Event], now: i64) -> Option<&Event> {
    events
        .iter()
        .filter(|event| now >= event.starts_at - LEAD_MS && now < event.ends_at)
        .min_by_key(|event| ((event.starts_at - now).abs(), event.starts_at > now))
}

/// `title`, cut to `max` characters at a word boundary when it's longer.
pub fn short_title(title: &str, max: usize) -> String {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.chars().count() <= max {
        return title;
    }
    let cut: String = title.chars().take(max.saturating_sub(1)).collect();
    // Back to the last space, unless that throws away more than half.
    let cut = match cut.rfind(' ') {
        Some(space) if cut[..space].chars().count() >= max / 2 => &cut[..space],
        _ => cut.as_str(),
    };
    format!("{}…", cut.trim_end_matches(|c: char| c.is_whitespace() || ",;:-–—|&".contains(c)))
}

/// When it starts, as the menu bar says it.
pub fn when(event: &Event, now: i64, recording: bool) -> String {
    if now >= event.starts_at {
        return if recording { "recording".into() } else { "now".into() };
    }
    let minutes = (event.starts_at - now + 59_999) / 60_000;
    if minutes < 60 { format!("in {minutes}m") } else { format!("in {}h {}m", minutes / 60, minutes % 60) }
}

pub fn label(event: &Event, now: i64, recording: bool) -> String {
    let title = if event.title.trim().is_empty() { "Meeting".to_string() } else { short_title(&event.title, TITLE_CHARS) };
    format!("{title} • {}", when(event, now, recording))
}

/// The meeting as the details card reads it (`UpcomingMeeting` in web/src/lib/api/calendar.ts).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingView {
    pub id: String,
    pub title: String,
    pub starts_at: i64,
    pub ends_at: i64,
    pub meeting_url: Option<String>,
    pub record_choice: Option<String>,
    pub attendees: Vec<Attendee>,
}

impl From<&Event> for MeetingView {
    fn from(event: &Event) -> Self {
        MeetingView {
            id: event.id.clone(),
            title: event.title.clone(),
            starts_at: event.starts_at,
            ends_at: event.ends_at,
            meeting_url: event.meeting_url.clone(),
            record_choice: event.record_choice.clone(),
            attendees: event.attendees.clone(),
        }
    }
}

/// What the menu bar shows: the label and the meeting it names.
#[derive(Clone, Debug, PartialEq)]
struct Shown {
    label: String,
    tooltip: String,
    meeting: MeetingView,
}

/// What the item shows now (None: hidden), and when the card last closed by losing focus.
struct Bar {
    shown: Option<Shown>,
    applied: bool,
    /// An `apply` is queued on the main thread: don't queue another.
    queued: bool,
    lost_focus_at: Option<Instant>,
}

static BAR: Mutex<Bar> = Mutex::new(Bar { shown: None, applied: true, queued: false, lost_focus_at: None });

fn with_bar<T>(f: impl FnOnce(&mut Bar) -> T) -> T {
    let mut guard = BAR.lock().unwrap_or_else(|error| error.into_inner());
    f(&mut guard)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Brings the item in line with the calendar and the recording glyph.
/// Callable from any thread; only a change reaches the main thread.
pub fn refresh(app: &AppHandle) {
    let now = now_ms();
    let recording = crate::tray::is_recording();
    let events = meeting_watch::events();
    let next = announced(&events, now).map(|event| Shown {
        label: label(event, now, recording),
        tooltip: event.title.clone(),
        meeting: MeetingView::from(event),
    });
    // Changed: tell the card. Not yet applied (a change, or an earlier failure): try again.
    let (changed, pending) = with_bar(|bar| {
        let changed = bar.shown != next;
        if changed {
            bar.shown = next.clone();
            bar.applied = false;
        }
        let pending = !bar.applied && !bar.queued;
        bar.queued |= pending;
        (changed, pending)
    });
    if changed {
        let _ = app.emit_to(LABEL, "meeting:updated", next.as_ref().map(|shown| &shown.meeting));
    }
    if !pending {
        return;
    }
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || apply(&handle)) {
        // `applied` stays false, so the next refresh (2s) schedules it again.
        with_bar(|bar| bar.queued = false);
        tracing::warn!("meeting bar: couldn't schedule an update: {error}");
    }
}

/// Main thread only. Makes the item on first use and hides it rather than
/// removing it, so it keeps its place in the menu bar.
fn apply(app: &AppHandle) {
    let shown = with_bar(|bar| {
        bar.queued = false;
        bar.shown.clone()
    });
    let tray = match (app.tray_by_id(TRAY_ID), &shown) {
        (Some(tray), _) => tray,
        (None, None) => {
            with_bar(|bar| bar.applied = true);
            return;
        }
        (None, Some(_)) => match install(app) {
            Ok(tray) => tray,
            Err(error) => {
                tracing::warn!("meeting bar: couldn't add the menu bar item: {error}");
                return;
            }
        },
    };
    let result = match &shown {
        Some(shown) => tray
            .set_title(Some(&shown.label))
            .and_then(|()| tray.set_tooltip(Some(&shown.tooltip)))
            .and_then(|()| tray.set_visible(true)),
        None => {
            hide_card(app);
            tray.set_visible(false)
        }
    };
    match result {
        Ok(()) => with_bar(|bar| {
            // Applied unless it changed again meanwhile; the next refresh covers that.
            if bar.shown == shown {
                bar.applied = true;
            }
        }),
        Err(error) => tracing::warn!("meeting bar: couldn't update the menu bar item: {error}"),
    }
}

fn install(app: &AppHandle) -> tauri::Result<tauri::tray::TrayIcon> {
    TrayIconBuilder::with_id(TRAY_ID)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, rect, .. } = event {
                toggle_card(tray.app_handle(), position, rect);
            }
        })
        .build(app)
}

fn toggle_card(app: &AppHandle, click: tauri::PhysicalPosition<f64>, item: tauri::Rect) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) {
            hide_card(app);
            return;
        }
    }
    // This click took focus from the card and so already closed it.
    if with_bar(|bar| bar.lost_focus_at.take().is_some_and(|at| at.elapsed().as_millis() < REOPEN_AFTER_MS)) {
        return;
    }
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => match build_card(app) {
            Ok(window) => window,
            Err(error) => {
                tracing::warn!("meeting bar: couldn't open the meeting card: {error}");
                return;
            }
        },
    };
    with_bar(|bar| bar.lost_focus_at = None);
    place_card(app, &window, click, item);
    let _ = window.emit("meeting:updated", with_bar(|bar| bar.shown.as_ref().map(|shown| shown.meeting.clone())));
    let _ = window.show();
    let _ = window.set_focus();
}

fn build_card(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("meeting.html".into()))
        .title("Next meeting")
        .inner_size(CARD_WIDTH, CARD_HEIGHT)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .visible(false)
        .accept_first_mouse(true)
        .build()?;
    above_capture_control(&window);
    let handle = app.clone();
    window.on_window_event(move |event| {
        // Like a menu: clicking anywhere else closes it. macOS sends the focus loss
        // before the click that caused it reaches the item, so `toggle_card` can tell
        // a click on the item itself apart (`lost_focus_at`).
        if let tauri::WindowEvent::Focused(false) = event {
            if hide_card(&handle) {
                with_bar(|bar| bar.lost_focus_at = Some(Instant::now()));
            }
        }
    });
    Ok(window)
}

/// One level above the capture control and the launcher (25, hud.rs and
/// panel.rs), so the pill never covers the card. Main thread only.
#[cfg(target_os = "macos")]
fn above_capture_control(window: &tauri::WebviewWindow) {
    const CARD_LEVEL: isize = 26;
    if let Ok(ns_window) = window.ns_window() {
        // SAFETY: an NSWindow Tauri just made, on the main thread (the tray's click handler).
        unsafe {
            let ns_window = &*ns_window.cast::<objc2::runtime::AnyObject>();
            let _: () = objc2::msg_send![ns_window, setLevel: CARD_LEVEL];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn above_capture_control(_window: &tauri::WebviewWindow) {}

/// Under the item, its left edge with the item's, kept on the item's screen.
fn place_card(app: &AppHandle, window: &tauri::WebviewWindow, click: tauri::PhysicalPosition<f64>, item: tauri::Rect) {
    let Some(monitor) = app.monitor_from_point(click.x, click.y).ok().flatten().or_else(|| window.primary_monitor().ok().flatten()) else { return };
    let scale = monitor.scale_factor();
    let screen_origin = monitor.position().to_logical::<f64>(scale);
    let screen = monitor.size().to_logical::<f64>(scale);
    let origin = item.position.to_logical::<f64>(scale);
    let size = item.size.to_logical::<f64>(scale);
    let (x, y) = card_origin((origin.x, origin.y, size.height), (screen_origin.x, screen_origin.y, screen.width));
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// Top left of the card for an item at `(x, y, height)` on a screen at
/// `(left, top, width)`: 6pt under the item, at least 8pt from the screen's sides.
pub fn card_origin(item: (f64, f64, f64), screen: (f64, f64, f64)) -> (f64, f64) {
    let (x, y, height) = item;
    let (left, _top, width) = screen;
    let max_x = left + width - CARD_WIDTH - 8.0;
    (x.min(max_x).max(left + 8.0), y + height + 6.0)
}

/// Whether it was open.
fn hide_card(app: &AppHandle) -> bool {
    let Some(window) = app.get_webview_window(LABEL) else { return false };
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let _ = window.hide();
    true
}

/// The meeting the menu bar names, for the details card.
#[tauri::command]
pub fn menu_bar_meeting() -> Option<MeetingView> {
    with_bar(|bar| bar.shown.as_ref().map(|shown| shown.meeting.clone()))
}

/// Opens the join link of meeting `id`, which must be the one the menu bar
/// names (what the card shows). Only that link, and only an https one.
#[tauri::command(async)]
pub fn open_meeting_link(app: AppHandle, id: String) -> Result<(), String> {
    let meeting = menu_bar_meeting().filter(|meeting| meeting.id == id).ok_or("That meeting isn't the next one any more.")?;
    let url = meeting.meeting_url.ok_or("This meeting has no link.")?;
    if !url.starts_with("https://") {
        return Err("That link isn't one Eavesy opens.".into());
    }
    hide_card(&app);
    let status = std::process::Command::new("open").arg(&url).stdin(std::process::Stdio::null()).status().map_err(|error| error.to_string())?;
    if status.success() { Ok(()) } else { Err("macOS couldn't open the link.".into()) }
}

#[tauri::command]
pub fn close_meeting_card(app: AppHandle) {
    hide_card(&app);
}

/// Fits the card to what it drew; its top edge stays put.
#[tauri::command]
pub fn fit_meeting_card(app: AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let height = if height.is_finite() { height.clamp(96.0, CARD_MAX_HEIGHT) } else { CARD_HEIGHT };
        let _ = window.set_size(tauri::LogicalSize::new(CARD_WIDTH, height));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000_000;

    fn event(id: &str, start_min: i64, end_min: i64) -> Event {
        Event {
            id: id.into(),
            title: format!("{id} meeting"),
            starts_at: T + start_min * 60_000,
            ends_at: T + end_min * 60_000,
            meeting_url: None,
            record_choice: None,
            attendees: Vec::new(),
        }
    }

    #[test]
    fn it_shows_from_half_an_hour_before_until_the_end() {
        let events = vec![event("standup", 0, 15)];
        assert_eq!(announced(&events, T - LEAD_MS - 1), None);
        assert!(announced(&events, T - LEAD_MS).is_some());
        assert!(announced(&events, T + 14 * 60_000).is_some());
        assert_eq!(announced(&events, T + 15 * 60_000), None);
        assert_eq!(announced(&[], T), None);
    }

    #[test]
    fn the_nearest_start_wins() {
        let events = vec![event("long", -40, 60), event("next", 25, 55), event("later", 28, 40)];
        assert_eq!(announced(&events, T).map(|e| e.id.as_str()), Some("next"));
        let events = vec![event("under-way", -10, 60), event("next", 20, 55)];
        assert_eq!(announced(&events, T).map(|e| e.id.as_str()), Some("under-way"));
        // A tie goes to the meeting under way.
        let events = vec![event("next", 5, 30), event("under-way", -5, 30)];
        assert_eq!(announced(&events, T).map(|e| e.id.as_str()), Some("under-way"));
    }

    #[test]
    fn it_counts_down_in_whole_minutes_then_says_now_or_recording() {
        let standup = event("standup", 0, 15);
        assert_eq!(when(&standup, T - 11 * 60_000, false), "in 11m");
        assert_eq!(when(&standup, T - 10 * 60_000 - 1, false), "in 11m");
        assert_eq!(when(&standup, T - 1_000, false), "in 1m");
        assert_eq!(when(&standup, T, false), "now");
        assert_eq!(when(&standup, T + 60_000, true), "recording");
        // A recording before the start isn't this meeting's.
        assert_eq!(when(&standup, T - 60_000, true), "in 1m");
        assert_eq!(when(&standup, T - 75 * 60_000, false), "in 1h 15m");
        assert_eq!(label(&standup, T - 11 * 60_000, false), "standup meeting • in 11m");
    }

    #[test]
    fn long_titles_are_cut_at_a_word() {
        assert_eq!(short_title("William & Ben | Numeral Intro", 32), "William & Ben | Numeral Intro");
        assert_eq!(short_title("Quarterly planning with the platform and growth teams", 32), "Quarterly planning with the…");
        assert_eq!(short_title("William & Ben | Numeral Intro and roadmap", 32), "William & Ben | Numeral Intro…");
        assert_eq!(short_title("Supercalifragilisticexpialidocious-sync", 20), "Supercalifragilisti…");
        assert_eq!(short_title("  spaced   out  ", 32), "spaced out");
        assert_eq!(short_title("Café résumé review über alles zusammen", 20), "Café résumé review…");
        let mut untitled = event("x", 0, 15);
        untitled.title = "  ".into();
        assert_eq!(label(&untitled, T, false), "Meeting • now");
    }

    #[test]
    fn the_card_sits_under_the_item_and_on_its_screen() {
        assert_eq!(card_origin((900.0, 0.0, 24.0), (0.0, 0.0, 1512.0)), (900.0, 30.0));
        assert_eq!(card_origin((1400.0, 0.0, 24.0), (0.0, 0.0, 1512.0)), (1512.0 - CARD_WIDTH - 8.0, 30.0));
        assert_eq!(card_origin((1600.0, 0.0, 24.0), (1512.0, 0.0, 1920.0)), (1600.0, 30.0));
    }
}
