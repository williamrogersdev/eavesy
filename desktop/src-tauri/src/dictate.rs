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
/// The same for the Talk to Eavesy shortcut, which records the same way.
static TALK_KEY_DOWN: AtomicBool = AtomicBool::new(false);

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

/// What letting go of the key does.
#[derive(Debug, PartialEq, Eq)]
enum OnRelease {
    Nothing,
    Stop(String),
    /// Held, but the capture is still starting: stop it once it runs.
    StopWhenReady,
}

fn on_release(started_by: Option<Instant>, now: Instant, active: Option<String>, starting: bool) -> OnRelease {
    if !release_stops(started_by, now) {
        return OnRelease::Nothing;
    }
    match active {
        Some(id) => OnRelease::Stop(id),
        None if starting => OnRelease::StopWhenReady,
        None => OnRelease::Nothing,
    }
}

/// Forgets a key that is down: the shortcut was re-registered or suspended,
/// so its release may never arrive and must not leave the hotkey stuck.
pub fn reset_key() {
    KEY_DOWN.store(false, Ordering::SeqCst);
    TALK_KEY_DOWN.store(false, Ordering::SeqCst);
    *press() = Press::default();
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
    pressed(app, true, false);
}

/// The Talk to Eavesy shortcut went down: like dictation, but the words go to Eavesy.
pub fn talk_key_down(app: &AppHandle) {
    if TALK_KEY_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    pressed(app, true, true);
}

/// The Talk to Eavesy shortcut came up.
pub fn talk_key_up(app: &AppHandle) {
    TALK_KEY_DOWN.store(false, Ordering::SeqCst);
    released(app);
}

/// The dictation hotkey came up.
pub fn key_up(app: &AppHandle) {
    KEY_DOWN.store(false, Ordering::SeqCst);
    released(app);
}

/// `can_hold`: a real key press, whose release can end a push-to-talk. `for_eavesy`:
/// a recording this press starts is a message to Eavesy.
fn pressed(app: &AppHandle, can_hold: bool, for_eavesy: bool) {
    let at = Instant::now();
    let app = app.clone();
    std::thread::spawn(move || {
        let (active, starting) = active_session(&app);
        match on_press(active, starting) {
            // A second tap while the mic is still opening: stop as soon as it is open.
            OnPress::Ignore => press().stop_when_ready = true,
            OnPress::Stop(id) => {
                *press() = Press::default();
                crate::hud::show_stopping(&app, &id);
                note_press_in_background();
                stop(&app, id);
            }
            OnPress::Start => {
                *press() = Press { started_by: can_hold.then_some(at), stop_when_ready: false };
                start(&app, at, for_eavesy);
            }
        }
    });
}

/// Ends a push-to-talk dictation; a tap leaves it running.
fn released(app: &AppHandle) {
    let mut state = press();
    let started_by = state.started_by.take();
    let (active, starting) = active_session(app);
    match on_release(started_by, Instant::now(), active, starting) {
        OnRelease::Nothing => {}
        OnRelease::StopWhenReady => state.stop_when_ready = true,
        OnRelease::Stop(id) => {
            drop(state);
            let app = app.clone();
            std::thread::spawn(move || {
                crate::hud::show_stopping(&app, &id);
                note_press_in_background();
                stop(&app, id);
            });
        }
    }
}

/// A press that toggles without a release (Fn tap, menu bar).
pub fn toggle(app: &AppHandle) {
    pressed(app, false, false);
}

/// Talk to Eavesy as a toggle (fn tap).
#[cfg(target_os = "macos")]
pub fn toggle_talk(app: &AppHandle) {
    pressed(app, false, true);
}

/// Where the cursor is right now: the paste goes back there. Looking it up
/// can take a while in some apps, so it never holds up the mic or the stop;
/// whoever needs the target looks it up afresh if this hasn't finished.
fn note_press_in_background() {
    std::thread::spawn(crate::dictation::note_shortcut_press);
}

fn start(app: &AppHandle, pressed_at: Instant, for_eavesy: bool) {
    // Decided before Eavesy stops talking: a dictation that starts over (or
    // just after) a question it read out answers that question's card. Talking
    // to Eavesy is never an answer to a card.
    let answering = if for_eavesy { None } else { crate::agents::claim_dictation() };
    // You're talking: Eavesy stops talking.
    crate::assistant::voice::hush(app);
    if for_eavesy {
        crate::assistant::voice::begin();
    }
    // Say "Starting…" at once: the engine takes a moment to open the mic. The
    // red state, the timer and the start sound wait until it really is open.
    crate::hud::set_state(app, crate::hud::HudState {
        phase: crate::hud::Phase::Recording,
        session_id: None,
        mode: Some(if for_eavesy { crate::assistant::voice::MODE } else { "audio" }.to_string()),
        started_at_ms: None,
        message: None,
        notice: None,
    });
    note_press_in_background();
    let result = crate::audio::start_audio_capture(
        app,
        &app.state::<Captures>(),
        Some("mic".to_string()),
        None,
        Some(true),
        None,
        pressed_at,
    );
    match result {
        Ok(session) => {
            if for_eavesy {
                crate::assistant::voice::bind(&session.session_id);
            }
            if let Some(claim) = answering {
                crate::agents::answer_with(&session.session_id, claim);
            }
            crate::telemetry::track("dictation_started", serde_json::json!({}));
            crate::projects::assign_in_background(app, &session.session_id);
            let stop_now = std::mem::take(&mut press().stop_when_ready);
            if stop_now {
                stop(app, session.session_id);
            }
        }
        Err(error) => {
            crate::assistant::voice::cancel();
            *press() = Press::default();
            crate::hud::set_state(app, crate::hud::HudState {
                phase: crate::hud::Phase::Failed,
                session_id: None,
                mode: None,
                started_at_ms: None,
                message: Some(error),
                notice: None,
            });
        }
    }
}

fn stop(app: &AppHandle, session_id: String) {
    // Failures are reported by the stop itself (HUD and telemetry).
    let _ = crate::audio::stop_capture(app.clone(), app.state::<Captures>(), session_id);
    crate::agents::dictation_ended(app);
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
    fn letting_go_after_a_hold_stops_now_or_once_the_capture_runs() {
        let now = Instant::now();
        let held = Some(now);
        let later = now + Duration::from_millis(800);
        assert_eq!(on_release(held, later, Some("a".into()), false), OnRelease::Stop("a".into()));
        assert_eq!(on_release(held, later, None, true), OnRelease::StopWhenReady);
        assert_eq!(on_release(held, later, None, false), OnRelease::Nothing);
        // A tap, or a toggle that never armed a hold, leaves it running.
        assert_eq!(on_release(held, now + Duration::from_millis(100), Some("a".into()), false), OnRelease::Nothing);
        assert_eq!(on_release(None, later, Some("a".into()), false), OnRelease::Nothing);
    }

    #[test]
    fn a_reset_unsticks_a_key_whose_release_was_lost() {
        KEY_DOWN.store(true, Ordering::SeqCst);
        reset_key();
        assert!(!KEY_DOWN.load(Ordering::SeqCst));
    }

    #[test]
    fn a_hold_stops_on_release_and_a_tap_does_not() {
        let now = Instant::now();
        assert!(!release_stops(None, now));
        assert!(!release_stops(Some(now), now + Duration::from_millis(120)));
        assert!(release_stops(Some(now), now + Duration::from_millis(600)));
    }
}
