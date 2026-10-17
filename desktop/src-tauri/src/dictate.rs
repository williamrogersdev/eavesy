//! The dictation hotkey, owned here rather than by the launcher webview: one
//! place decides whether a press starts or stops a capture, and nothing on the
//! way opens the launcher or takes focus from the app being typed into.
//!
//! A tap toggles: press to start, press again to stop. Holding the key past
//! `HOLD_TO_TALK` turns the press into push-to-talk: letting go stops it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::audio::Captures;

/// A press held at least this long is push-to-talk; a shorter one is a tap.
const HOLD_TO_TALK: Duration = Duration::from_millis(350);

#[derive(Debug, Default)]
struct Press {
    /// When the press that started the current dictation went down.
    started_by: Option<Instant>,
    /// The key came up during a hold while the capture was still starting:
    /// stop it as soon as it is running.
    stop_when_ready: bool,
}

/// The hotkey is down. A held key can repeat its press; only the first counts.
static KEY_DOWN: AtomicBool = AtomicBool::new(false);

static PRESS: Mutex<Press> = Mutex::new(Press { started_by: None, stop_when_ready: false });

fn press() -> std::sync::MutexGuard<'static, Press> {
    PRESS.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a key press should do, given what is capturing now.
#[derive(Debug, PartialEq, Eq)]
enum OnPress {
    Start,
    Stop(String),
    /// A capture is starting: a second press must not start another.
    Ignore,
}

fn on_press(active: Option<String>, starting: bool) -> OnPress {
    match (active, starting) {
        (Some(id), _) => OnPress::Stop(id),
        (None, true) => OnPress::Ignore,
        (None, false) => OnPress::Start,
    }
}

/// Whether letting go of the key ends the dictation that press started.
fn release_stops(started_by: Option<Instant>, now: Instant) -> bool {
    started_by.is_some_and(|at| now.duration_since(at) >= HOLD_TO_TALK)
}

fn active_session(app: &AppHandle) -> (Option<String>, bool) {
    let captures = app.state::<Captures>();
    let active = captures.0.lock().unwrap_or_else(|e| e.into_inner()).keys().next().cloned();
    (active, captures.is_starting())
}

/// The dictation hotkey went down.
pub fn key_down(app: &AppHandle) {
    if KEY_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    pressed(app);
}

/// The dictation hotkey came up.
pub fn key_up(app: &AppHandle) {
    KEY_DOWN.store(false, Ordering::SeqCst);
    released(app);
}

fn pressed(app: &AppHandle) {
    let at = Instant::now();
    let app = app.clone();
    std::thread::spawn(move || {
        // Where the cursor is right now: the paste goes back there.
        crate::dictation::note_shortcut_press();
        let (active, starting) = active_session(&app);
        match on_press(active, starting) {
            OnPress::Ignore => {}
            OnPress::Stop(id) => {
                *press() = Press::default();
                stop(&app, id);
            }
            OnPress::Start => {
                *press() = Press { started_by: Some(at), stop_when_ready: false };
                start(&app);
            }
        }
    });
}

/// Ends a push-to-talk dictation; a tap leaves it running.
fn released(app: &AppHandle) {
    let mut state = press();
    if !release_stops(state.started_by, Instant::now()) {
        state.started_by = None;
        return;
    }
    state.started_by = None;
    let (active, starting) = active_session(app);
    match active {
        Some(id) => {
            drop(state);
            let app = app.clone();
            std::thread::spawn(move || {
                crate::dictation::note_shortcut_press();
                stop(&app, id);
            });
        }
        None if starting => state.stop_when_ready = true,
        None => {}
    }
}

/// A press that toggles without a release (Fn tap, menu bar).
pub fn toggle(app: &AppHandle) {
    pressed(app);
}

fn start(app: &AppHandle) {
    // Say so at once: the engine takes a moment to open the mic.
    crate::hud::set_state(app, crate::hud::HudState {
        phase: crate::hud::Phase::Recording,
        session_id: None,
        mode: Some("audio".to_string()),
        started_at_ms: Some(chrono::Utc::now().timestamp_millis()),
        message: None,
    });
    let result = crate::audio::start_capture(app.clone(), app.state::<Captures>(), Some("mic".to_string()), None, Some(true));
    match result {
        Ok(session) => {
            let stop_now = std::mem::take(&mut press().stop_when_ready);
            if stop_now {
                stop(app, session.session_id);
            }
        }
        Err(error) => {
            *press() = Press::default();
            crate::hud::set_state(app, crate::hud::HudState {
                phase: crate::hud::Phase::Failed,
                session_id: None,
                mode: None,
                started_at_ms: None,
                message: Some(error),
            });
        }
    }
}

fn stop(app: &AppHandle, session_id: String) {
    // Failures are reported by the stop itself (HUD and telemetry).
    let _ = crate::audio::stop_capture(app.clone(), app.state::<Captures>(), session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_press_stops_what_runs_starts_otherwise_and_never_starts_twice() {
        assert_eq!(on_press(None, false), OnPress::Start);
        assert_eq!(on_press(Some("a".into()), false), OnPress::Stop("a".into()));
        assert_eq!(on_press(None, true), OnPress::Ignore);
        assert_eq!(on_press(Some("a".into()), true), OnPress::Stop("a".into()));
    }

    #[test]
    fn a_hold_stops_on_release_and_a_tap_does_not() {
        let now = Instant::now();
        assert!(!release_stops(None, now));
        assert!(!release_stops(Some(now), now + Duration::from_millis(120)));
        assert!(release_stops(Some(now), now + Duration::from_millis(600)));
    }
}
