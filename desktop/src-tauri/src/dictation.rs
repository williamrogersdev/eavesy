use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    pid: i32,
}

static PRESSED: Mutex<Option<(Instant, Target)>> = Mutex::new(None);
static PENDING: Mutex<Option<(String, Instant, Target)>> = Mutex::new(None);
/// The project a recording belongs to, read as it stops: the window the user
/// was dictating into, not whichever is in front once the words are back.
static PROJECT_AT_STOP: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

/// The last dictation's words as they went into the user's app (session,
/// words, project), so a tone change can swap them for its rewrite.
static PASTED: Mutex<Option<(String, String, Option<String>)>> = Mutex::new(None);

const PRESS_WINDOW: Duration = Duration::from_secs(5);
const DELIVER_WINDOW: Duration = Duration::from_secs(15 * 60);

pub fn note_shortcut_press() {
    let target = front_app();
    *PRESSED.lock().unwrap_or_else(|e| e.into_inner()) = target.map(|t| (Instant::now(), t));
}

pub fn arm(session_id: &str) {
    let pressed = PRESSED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let target = pick_target(pressed, front_app);
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = target.map(|t| (session_id.to_string(), Instant::now(), t));
}

/// Points a recording's paste at where the cursor is as it stops, when that is
/// a text box: a meeting can run long after the box it started in. Otherwise it
/// keeps the box it started in. Either way the paste window runs from now.
pub fn rearm_at_stop(session_id: &str) {
    let pressed = PRESSED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let now = pick_target(pressed, front_app);
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let started_in = pending
        .as_ref()
        .filter(|(id, _, _)| id == session_id)
        .map(|(_, _, target)| *target);
    *pending = now.or(started_in).map(|t| (session_id.to_string(), Instant::now(), t));
    let armed = pending.is_some();
    drop(pending);
    if armed {
        // Reading the front window can take a moment: keep it off the stop path.
        let session_id = session_id.to_string();
        std::thread::spawn(move || {
            let project = crate::projects::current_project();
            *PROJECT_AT_STOP.lock().unwrap_or_else(|e| e.into_inner()) = Some((session_id, project));
        });
    }
}

fn project_for(session_id: &str) -> Option<String> {
    let mut stopped = PROJECT_AT_STOP.lock().unwrap_or_else(|e| e.into_inner());
    match stopped.take() {
        Some((id, project)) if id == session_id => project,
        // Not read at stop (or not finished yet): the window in front now is the best guess.
        other => {
            *stopped = other;
            drop(stopped);
            crate::projects::current_project()
        }
    }
}

fn pick_target(pressed: Option<(Instant, Target)>, now: impl FnOnce() -> Option<Target>) -> Option<Target> {
    pressed
        .filter(|(at, _)| at.elapsed() < PRESS_WINDOW)
        .map(|(_, target)| target)
        .or_else(now)
}

/// Whether this recording will paste into the app the user was in.
pub fn is_armed(session_id: &str) -> bool {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|(id, armed, _)| id == session_id && armed.elapsed() < DELIVER_WINDOW)
}

fn take_pending(session_id: &str) -> Option<Target> {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    match pending.as_ref() {
        Some((id, _, _)) if id == session_id => pending
            .take()
            .filter(|(_, armed, _)| armed.elapsed() < DELIVER_WINDOW)
            .map(|(_, _, target)| target),
        _ => None,
    }
}

/// This recording will paste nothing: drops its paste target so a transcript
/// that arrives later does not paste either.
pub fn disarm(session_id: &str) {
    take_pending(session_id);
}

pub fn deliver(app: &AppHandle, session_id: &str, text: &str) {
    deliver_then(app, session_id, text, false);
}

/// `deliver` for a recording that just stopped, which skipped the launcher to
/// leave focus in the user's app: if the paste falls back to the clipboard, the
/// launcher opens after all, so the recording is not left with neither.
pub fn deliver_at_stop(app: &AppHandle, session_id: &str, text: &str) {
    deliver_then(app, session_id, text, true);
}

/// Hides the launcher if it is open and not pinned, so the paste lands in the
/// app under it. Waits for focus to move back only when it actually hid.
fn get_launcher_out_of_the_way(app: &AppHandle) {
    if crate::panel::is_pinned() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let visible = crate::panel::is_visible(&handle);
        if visible {
            let _ = crate::panel::hide(&handle);
        }
        let _ = tx.send(visible);
    });
    if rx.recv_timeout(Duration::from_millis(500)).unwrap_or(false) {
        std::thread::sleep(Duration::from_millis(80));
    }
}

/// How a dictation's text reached the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Pasted,
    /// Typed into Eavesy's own panel (the setup's practice box), which has focus.
    InEavesy,
    /// On the clipboard: Eavesy may not paste (no Accessibility permission).
    CopiedNoAccessibility,
    /// On the clipboard: no app to paste into was noted at the start, or
    /// another app is in front now.
    CopiedNoTextBox,
}

impl Delivery {
    fn event(self) -> &'static str {
        match self {
            Delivery::Pasted | Delivery::InEavesy => "dictation_pasted",
            Delivery::CopiedNoAccessibility | Delivery::CopiedNoTextBox => "dictation_copied",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Delivery::Pasted => "pasted",
            Delivery::InEavesy => "in_eavesy",
            Delivery::CopiedNoAccessibility => "no_accessibility",
            Delivery::CopiedNoTextBox => "no_text_box",
        }
    }

    /// What the HUD says, or None to show the words themselves.
    pub fn notice(self) -> Option<&'static str> {
        match self {
            Delivery::Pasted | Delivery::InEavesy => None,
            Delivery::CopiedNoAccessibility => Some("Copied — allow Accessibility to paste automatically"),
            Delivery::CopiedNoTextBox => Some("Copied — press ⌘V to paste"),
        }
    }
}

fn delivery(trusted: bool, target: Option<Target>, focused: Option<Target>) -> Delivery {
    match (trusted, target) {
        (false, _) => Delivery::CopiedNoAccessibility,
        // The same app is still in front: paste. Whether its focused element
        // calls itself a text box isn't asked (see `front_app`).
        (true, Some(target)) if focused == Some(target) => Delivery::Pasted,
        _ => Delivery::CopiedNoTextBox,
    }
}

/// Delivers a dictation the moment it has text, tidied first: pasted at the
/// cursor when the app it was dictated in is still in front, otherwise put
/// on the clipboard. Never
/// opens the launcher, and the HUD says which happened. Called once per
/// dictation: it takes the paste target, so the cloud transcript that follows
/// does not paste a second time.
pub fn deliver_dictation(app: &AppHandle, session_id: &str, text: &str) {
    let target = take_pending(session_id);
    let project = project_for(session_id);
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    let app = app.clone();
    let session_id = session_id.to_string();
    std::thread::spawn(move || {
        let started = Instant::now();
        // Should the transcript box still have the keyboard, the paste (and
        // the focus check before it) must see the user's app, not Eavesy.
        crate::hud::release_editor_and_wait(&app);
        // Deliberate live corrections already express the user's wording. Keep
        // the untouched remainder as heard too: polishing the whole sentence
        // could rewrite a correction or make its source offsets ambiguous.
        let corrected = crate::live_edit::corrected(&session_id, &text);
        let source_text = corrected.as_ref().map(|_| text.clone());
        // Fillers still go: nobody types "um", corrected or not.
        let text = match corrected {
            Some(corrected) => crate::transcribe::drop_fillers(&corrected),
            None => crate::transcribe::polish_dictation(&app, &text, project.as_deref()),
        };
        let front = target.and_then(|_| front_app());
        let mut how = if panel_wants_it(&app) {
            Delivery::InEavesy
        } else {
            delivery(accessibility_trusted(), target, front)
        };
        match how {
            // The box acknowledges delivery; otherwise the clipboard remains available.
            Delivery::InEavesy if !hand_to_panel(&app, &session_id, &text) => {
                how = Delivery::CopiedNoTextBox;
            }
            Delivery::InEavesy => {}
            Delivery::Pasted => {
                get_launcher_out_of_the_way(&app);
                if crate::commands::paste_text(&app, &text).is_ok() {
                    *PASTED.lock().unwrap_or_else(|e| e.into_inner()) = Some((session_id.clone(), text.clone(), project.clone()));
                } else {
                    // Say what actually stopped it: the permission, or anything else.
                    how = if accessibility_trusted() { Delivery::CopiedNoTextBox } else { Delivery::CopiedNoAccessibility };
                }
            }
            _ => {}
        }
        if matches!(how, Delivery::CopiedNoAccessibility | Delivery::CopiedNoTextBox) {
            // A failed paste may have left the text on the clipboard already;
            // writing it again makes sure it is there whatever step failed.
            use tauri_plugin_clipboard_manager::ClipboardExt;
            if let Err(error) = app.clipboard().write_text(text.clone()) {
                eprintln!("dictation: could not copy the text: {error}");
            }
        }
        let delivery_ms = started.elapsed().as_millis() as u64;
        tracing::info!(
            session_id = %session_id, delivery = how.label(), delivery_ms, corrected = source_text.is_some(),
            target_pid = target.map(|t| t.pid), front_pid = front.map(|t| t.pid), "dictation delivered"
        );
        crate::telemetry::track(how.event(), serde_json::json!({ "delivery": how.label(), "delivery_ms": delivery_ms }));
        // Never over a newer recording that is running or being written down.
        let current = crate::hud::current();
        let busy_elsewhere = matches!(current.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing)
            && current.session_id.as_deref() != Some(session_id.as_str());
        if !busy_elsewhere {
            crate::hud::set_state(&app, crate::hud::HudState {
                phase: crate::hud::Phase::Done,
                session_id: Some(session_id),
                mode: Some("audio".to_string()),
                started_at_ms: None,
                message: Some(source_text.unwrap_or(text)),
                notice: how.notice().map(str::to_string),
            });
        }
    });
}

/// The project a dictation was written for, while it is the last one pasted:
/// a tone change keeps its words and spellings.
pub fn pasted_project(session_id: &str) -> Option<String> {
    PASTED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(id, _, _)| id == session_id).and_then(|(_, _, project)| project.clone())
}

/// Puts a dictation's rewrite where its words went: in place of the pasted
/// words when they are still there exactly as pasted, otherwise on the
/// clipboard. Says which: "replaced" or "copied". Never on the main thread.
pub fn deliver_rewrite(app: &AppHandle, session_id: &str, text: &str) -> Result<&'static str, String> {
    // Clicking in the transcript box may have taken the keyboard: hand it back first.
    crate::hud::release_editor_and_wait(app);
    let pasted = PASTED.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|(id, _, _)| id == session_id);
    if let Some((_, previous, project)) = pasted {
        match crate::paste_learning::replace(app, &previous, text) {
            Ok(()) => {
                *PASTED.lock().unwrap_or_else(|e| e.into_inner()) = Some((session_id.to_string(), text.to_string(), project));
                return Ok("replaced");
            }
            Err(why) => tracing::info!(session_id, "rewrite copied instead of replaced: {why}"),
        }
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text.to_string()).map_err(|e| format!("could not copy the rewrite: {e}"))?;
    Ok("copied")
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DictationText {
    session_id: String,
    text: String,
}

/// How long the panel has to confirm it put the words in its box.
const PANEL_ACK_TIMEOUT: Duration = Duration::from_millis(1500);

static PANEL_ACK: std::sync::Mutex<Option<(String, std::sync::mpsc::Sender<()>)>> = std::sync::Mutex::new(None);

/// Sends the words to the panel's box and waits for it to confirm it took them.
fn hand_to_panel(app: &AppHandle, session_id: &str, text: &str) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    *PANEL_ACK.lock().unwrap_or_else(|e| e.into_inner()) = Some((session_id.to_string(), tx));
    let sent = app
        .emit_to("main", "dictation:text", DictationText { session_id: session_id.to_string(), text: text.to_string() })
        .is_ok();
    let taken = sent && rx.recv_timeout(PANEL_ACK_TIMEOUT).is_ok();
    let mut slot = PANEL_ACK.lock().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref().is_some_and(|(id, _)| id == session_id) {
        *slot = None;
    }
    taken
}

/// The panel put a dictation's words in its box.
pub fn ack_panel_dictation(session_id: &str) {
    let slot = PANEL_ACK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((id, tx)) = slot.as_ref() {
        if id == session_id {
            let _ = tx.send(());
        }
    }
}

static PANEL_WANTS_DICTATION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The panel has a box of its own waiting for dictation (setup's practice
/// box). Dictation goes there directly, but only while the panel is open and
/// focused: a synthetic ⌘V can't be aimed at it.
pub fn set_panel_wants_dictation(wants: bool) {
    PANEL_WANTS_DICTATION.store(wants, std::sync::atomic::Ordering::SeqCst);
}

fn panel_wants_it(app: &AppHandle) -> bool {
    if !PANEL_WANTS_DICTATION.load(std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let focused = crate::panel::is_visible(&handle)
            && handle.get_webview_window("main").is_some_and(|window| window.is_focused().unwrap_or(false));
        let _ = tx.send(focused);
    });
    rx.recv_timeout(Duration::from_millis(300)).unwrap_or(false)
}

fn deliver_then(app: &AppHandle, session_id: &str, text: &str, launcher_on_fallback: bool) {
    let Some(target) = take_pending(session_id) else { return };
    if text.trim().is_empty() {
        return;
    }
    let app = app.clone();
    let text = crate::live_edit::corrected(session_id, text).unwrap_or_else(|| text.trim().to_string());
    let text = crate::transcribe::drop_fillers(&text);
    std::thread::spawn(move || {
        crate::hud::release_editor_and_wait(&app);
        get_launcher_out_of_the_way(&app);
        if front_app() == Some(target) && crate::commands::paste_text(&app, &text).is_ok() {
            return;
        }
        use tauri_plugin_clipboard_manager::ClipboardExt;
        if app.clipboard().write_text(text).is_ok() {
            let _ = app
                .notification()
                .builder()
                .title("Transcript copied")
                .body("You switched apps before it was ready. Press ⌘V to paste it.")
                .show();
        }
        if launcher_on_fallback {
            crate::commands::show_launcher(app);
        }
    });
}

fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    return unsafe { ax::AXIsProcessTrusted() };
    #[cfg(not(target_os = "macos"))]
    false
}

/// Presses ⌘V in whatever app is frontmost, straight through Quartz events:
/// no AppleScript process to launch, so the paste lands in milliseconds.
/// Needs the Accessibility permission, like any synthetic key press.
#[cfg(target_os = "macos")]
pub fn press_paste() -> Result<(), String> {
    use crate::cf::CFTypeRef;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state: i32) -> CFTypeRef;
        fn CGEventCreateKeyboardEvent(source: CFTypeRef, key: u16, down: bool) -> CFTypeRef;
        fn CGEventSetFlags(event: CFTypeRef, flags: u64);
        fn CGEventPost(tap: u32, event: CFTypeRef);
    }
    const HID_SYSTEM_STATE: i32 = 1;
    const KEY_V: u16 = 9;
    const COMMAND: u64 = 1 << 20;
    const HID_EVENT_TAP: u32 = 0;
    if !accessibility_trusted() {
        return Err("Accessibility permission is off".to_string());
    }
    unsafe {
        let source = crate::cf::Owned(CGEventSourceCreate(HID_SYSTEM_STATE));
        for down in [true, false] {
            let event = CGEventCreateKeyboardEvent(source.0, KEY_V, down);
            if event.is_null() {
                return Err("could not create the paste key press".to_string());
            }
            let event = crate::cf::Owned(event);
            // Exactly ⌘: modifiers still held from the hotkey must not turn
            // this into ⌘⇧V or similar.
            CGEventSetFlags(event.0, COMMAND);
            CGEventPost(HID_EVENT_TAP, event.0);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn press_paste() -> Result<(), String> {
    Err("pasting is only supported on macOS".to_string())
}

/// The app the user is dictating into: the frontmost one, never Eavesy.
///
/// It doesn't ask whether the focused element is a text box. Chat apps built
/// on web views (Claude, ChatGPT, Slack, Chrome) often report their message
/// box as a web area or a group, so requiring a text role made most
/// dictations fall back to the clipboard. A ⌘V where there is no text box
/// does nothing, and the words stay in the HUD to copy.
#[cfg(target_os = "macos")]
fn front_app() -> Option<Target> {
    use ax::*;
    unsafe {
        if !AXIsProcessTrusted() {
            return None;
        }
        let system = Owned(AXUIElementCreateSystemWide());
        AXUIElementSetMessagingTimeout(system.0, 0.25);
        let app = Owned(copy_attribute(system.0, "AXFocusedApplication")?);
        let mut pid = 0;
        if AXUIElementGetPid(app.0, &mut pid) != 0 || pid <= 0 || pid == std::process::id() as i32 {
            return None;
        }
        Some(Target { pid })
    }
}

#[cfg(not(target_os = "macos"))]
fn front_app() -> Option<Target> {
    None
}

#[cfg(target_os = "macos")]
mod ax {
    pub use crate::cf::{CFTypeRef, Owned};
    use crate::cf::cf_str;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
        pub fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
        pub fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
        pub fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
    }

    pub unsafe fn copy_attribute(element: CFTypeRef, name: &str) -> Option<CFTypeRef> {
        let attr = cf_str(name);
        let mut value: CFTypeRef = std::ptr::null();
        (AXUIElementCopyAttributeValue(element, attr.0, &mut value) == 0 && !value.is_null()).then_some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_armed_recording_delivers() {
        *PENDING.lock().unwrap() = Some(("a".into(), Instant::now(), Target { pid: 42 }));
        assert_eq!(take_pending("b"), None);
        assert_eq!(take_pending("a"), Some(Target { pid: 42 }));
        assert_eq!(take_pending("a"), None);
        if let Some(old) = Instant::now().checked_sub(DELIVER_WINDOW) {
            *PENDING.lock().unwrap() = Some(("c".into(), old, Target { pid: 42 }));
            assert_eq!(take_pending("c"), None);
        }
    }

    #[test]
    fn a_dictation_pastes_into_the_app_it_was_in_and_otherwise_copies() {
        let box_a = Some(Target { pid: 7 });
        assert_eq!(delivery(true, box_a, box_a), Delivery::Pasted);
        assert_eq!(delivery(true, box_a, Some(Target { pid: 8 })), Delivery::CopiedNoTextBox);
        assert_eq!(delivery(true, None, None), Delivery::CopiedNoTextBox);
        // Without Accessibility there is no target and no way to paste.
        assert_eq!(delivery(false, None, None), Delivery::CopiedNoAccessibility);
        assert_eq!(Delivery::CopiedNoAccessibility.notice(), Some("Copied — allow Accessibility to paste automatically"));
        assert_eq!(Delivery::Pasted.notice(), None);
    }

    #[test]
    fn recent_press_wins_and_stale_press_falls_back() {
        let fresh = Some((Instant::now(), Target { pid: 7 }));
        assert_eq!(pick_target(fresh, || Some(Target { pid: 9 })), Some(Target { pid: 7 }));
        if let Some(old) = Instant::now().checked_sub(PRESS_WINDOW + Duration::from_secs(1)) {
            assert_eq!(pick_target(Some((old, Target { pid: 7 })), || Some(Target { pid: 9 })), Some(Target { pid: 9 }));
        }
        assert_eq!(pick_target(None, || None), None);
    }
}
