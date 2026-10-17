use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    pid: i32,
}

static PRESSED: Mutex<Option<(Instant, Target)>> = Mutex::new(None);
static PENDING: Mutex<Option<(String, Instant, Target)>> = Mutex::new(None);

const PRESS_WINDOW: Duration = Duration::from_secs(5);
const DELIVER_WINDOW: Duration = Duration::from_secs(15 * 60);

pub fn note_shortcut_press() {
    let target = focused_text_target();
    *PRESSED.lock().unwrap_or_else(|e| e.into_inner()) = target.map(|t| (Instant::now(), t));
}

pub fn arm(session_id: &str) {
    let pressed = PRESSED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let target = pick_target(pressed, focused_text_target);
    *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = target.map(|t| (session_id.to_string(), Instant::now(), t));
}

/// Points a recording's paste at where the cursor is as it stops, when that is
/// a text box: a meeting can run long after the box it started in. Otherwise it
/// keeps the box it started in. Either way the paste window runs from now.
pub fn rearm_at_stop(session_id: &str) {
    let pressed = PRESSED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let now = pick_target(pressed, focused_text_target);
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let started_in = pending
        .as_ref()
        .filter(|(id, _, _)| id == session_id)
        .map(|(_, _, target)| *target);
    *pending = now.or(started_in).map(|t| (session_id.to_string(), Instant::now(), t));
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
    /// On the clipboard: Eavesy may not paste (no Accessibility permission).
    CopiedNoAccessibility,
    /// On the clipboard: the cursor is not in a text box any more.
    CopiedNoTextBox,
}

impl Delivery {
    /// What the HUD says, or None to show the words themselves.
    pub fn notice(self) -> Option<&'static str> {
        match self {
            Delivery::Pasted => None,
            Delivery::CopiedNoAccessibility => Some("Copied — allow Accessibility to paste automatically"),
            Delivery::CopiedNoTextBox => Some("Copied — press ⌘V to paste"),
        }
    }
}

fn delivery(trusted: bool, target: Option<Target>, focused: Option<Target>) -> Delivery {
    match (trusted, target) {
        (false, _) => Delivery::CopiedNoAccessibility,
        (true, Some(target)) if focused == Some(target) => Delivery::Pasted,
        _ => Delivery::CopiedNoTextBox,
    }
}

/// Delivers a dictation the moment it has text: pasted at the cursor when it
/// is still in the text box it was in, otherwise put on the clipboard. Never
/// opens the launcher, and the HUD says which happened. Called once per
/// dictation: it takes the paste target, so the cloud transcript that follows
/// does not paste a second time.
pub fn deliver_dictation(app: &AppHandle, session_id: &str, text: &str) {
    let target = take_pending(session_id);
    let text = text.trim().to_string();
    if text.is_empty() {
        return;
    }
    let app = app.clone();
    let session_id = session_id.to_string();
    std::thread::spawn(move || {
        get_launcher_out_of_the_way(&app);
        let mut how = delivery(accessibility_trusted(), target, target.and_then(|_| focused_text_target()));
        if how == Delivery::Pasted && crate::commands::paste_text(&app, &text).is_err() {
            how = Delivery::CopiedNoAccessibility;
        }
        if how != Delivery::Pasted {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            if let Err(error) = app.clipboard().write_text(text.clone()) {
                eprintln!("dictation: could not copy the text: {error}");
            }
        }
        let current = crate::hud::current();
        if current.phase != crate::hud::Phase::Recording || current.session_id.as_deref() == Some(session_id.as_str()) {
            crate::hud::set_state(&app, crate::hud::HudState {
                phase: crate::hud::Phase::Done,
                session_id: Some(session_id),
                mode: Some("audio".to_string()),
                started_at_ms: None,
                message: Some(how.notice().map_or(text, str::to_string)),
            });
        }
    });
}

fn deliver_then(app: &AppHandle, session_id: &str, text: &str, launcher_on_fallback: bool) {
    let Some(target) = take_pending(session_id) else { return };
    if text.trim().is_empty() {
        return;
    }
    let app = app.clone();
    let text = text.trim().to_string();
    std::thread::spawn(move || {
        get_launcher_out_of_the_way(&app);
        if focused_text_target() == Some(target) && crate::commands::paste_text(&app, &text).is_ok() {
            return;
        }
        use tauri_plugin_clipboard_manager::ClipboardExt;
        if app.clipboard().write_text(text).is_ok() {
            let _ = app
                .notification()
                .builder()
                .title("Transcript copied")
                .body("The text box you were in lost focus. Press ⌘V to paste it.")
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

#[cfg(target_os = "macos")]
fn focused_text_target() -> Option<Target> {
    use ax::*;
    unsafe {
        if !AXIsProcessTrusted() {
            return None;
        }
        let system = Owned(AXUIElementCreateSystemWide());
        AXUIElementSetMessagingTimeout(system.0, 0.25);
        let app = Owned(copy_attribute(system.0, "AXFocusedApplication")?);
        let mut pid = 0;
        if AXUIElementGetPid(app.0, &mut pid) != 0 || pid == std::process::id() as i32 {
            return None;
        }
        let text_focused = || copy_attribute(app.0, "AXFocusedUIElement").map(Owned).is_some_and(|el| is_text_input(el.0));
        if text_focused() {
            return Some(Target { pid });
        }
        if enable_manual_accessibility(app.0) {
            std::thread::sleep(std::time::Duration::from_millis(60));
            if text_focused() {
                return Some(Target { pid });
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
unsafe fn is_text_input(element: ax::CFTypeRef) -> bool {
    use ax::*;
    let role = copy_attribute(element, "AXRole").map(Owned).and_then(|r| cf_string(r.0));
    matches!(role.as_deref(), Some("AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"))
        || value_settable(element)
}

#[cfg(not(target_os = "macos"))]
fn focused_text_target() -> Option<Target> {
    None
}

#[cfg(target_os = "macos")]
mod ax {
    pub use crate::cf::{cf_string, CFTypeRef, Owned};
    use crate::cf::{cf_str, kCFBooleanTrue};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
        pub fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementIsAttributeSettable(element: CFTypeRef, attribute: CFTypeRef, settable: *mut u8) -> i32;
        pub fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
        pub fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
        fn AXUIElementSetAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: CFTypeRef) -> i32;
    }

    pub unsafe fn copy_attribute(element: CFTypeRef, name: &str) -> Option<CFTypeRef> {
        let attr = cf_str(name);
        let mut value: CFTypeRef = std::ptr::null();
        (AXUIElementCopyAttributeValue(element, attr.0, &mut value) == 0 && !value.is_null()).then_some(value)
    }

    pub unsafe fn enable_manual_accessibility(app: CFTypeRef) -> bool {
        let attr = cf_str("AXManualAccessibility");
        AXUIElementSetAttributeValue(app, attr.0, kCFBooleanTrue) == 0
    }

    pub unsafe fn value_settable(element: CFTypeRef) -> bool {
        let attr = cf_str("AXValue");
        let mut settable = 0u8;
        AXUIElementIsAttributeSettable(element, attr.0, &mut settable) == 0 && settable != 0
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
    fn a_dictation_pastes_only_into_the_box_it_was_in_and_otherwise_copies() {
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
