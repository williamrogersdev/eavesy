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
    let Some(target) = take_pending(session_id) else { return };
    if text.trim().is_empty() {
        return;
    }
    let app = app.clone();
    let text = text.trim().to_string();
    std::thread::spawn(move || {
        if !crate::panel::is_pinned() {
            let (tx, rx) = std::sync::mpsc::channel();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if crate::panel::is_visible(&handle) {
                    let _ = crate::panel::hide(&handle);
                }
                let _ = tx.send(());
            });
            let _ = rx.recv_timeout(Duration::from_secs(1));
            std::thread::sleep(Duration::from_millis(150));
        }
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
    });
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
    fn recent_press_wins_and_stale_press_falls_back() {
        let fresh = Some((Instant::now(), Target { pid: 7 }));
        assert_eq!(pick_target(fresh, || Some(Target { pid: 9 })), Some(Target { pid: 7 }));
        if let Some(old) = Instant::now().checked_sub(PRESS_WINDOW + Duration::from_secs(1)) {
            assert_eq!(pick_target(Some((old, Target { pid: 7 })), || Some(Target { pid: 9 })), Some(Target { pid: 9 }));
        }
        assert_eq!(pick_target(None, || None), None);
    }
}
