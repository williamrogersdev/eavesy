//! The app and window that were in front when the launcher opened, so the
//! launcher can pick the project the user is working in. The title needs
//! Accessibility; without it only the app name is known.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct FrontWindow {
    pub app: Option<String>,
    pub title: Option<String>,
}

static LAST: Mutex<Option<FrontWindow>> = Mutex::new(None);
/// Bumped on every capture, so a slow title read can't land on a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Records the app now, then reads its focused window title off the main
/// thread: another app's accessibility tree can be slow to answer.
pub fn capture(pid: i32, app: Option<String>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    set(FrontWindow { app: app.clone(), title: None });
    std::thread::spawn(move || {
        let title = window_title(pid);
        if title.is_none() {
            return;
        }
        let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if GENERATION.load(Ordering::SeqCst) == generation {
            *last = Some(FrontWindow { app, title });
        }
    });
}

/// The app and window title, read now. Blocks for up to a third of a second.
pub fn read(pid: i32, app: Option<String>) -> FrontWindow {
    FrontWindow { app, title: window_title(pid) }
}

fn set(front: FrontWindow) {
    *LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(front);
}

#[tauri::command]
pub fn front_window() -> Option<FrontWindow> {
    LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

#[cfg(target_os = "macos")]
fn window_title(pid: i32) -> Option<String> {
    use crate::cf::{cf_str, cf_string, CFTypeRef, Owned};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
    }

    unsafe fn attribute(element: CFTypeRef, name: &str) -> Option<Owned> {
        let attr = cf_str(name);
        let mut value: CFTypeRef = std::ptr::null();
        (AXUIElementCopyAttributeValue(element, attr.0, &mut value) == 0 && !value.is_null()).then_some(Owned(value))
    }

    unsafe {
        if pid <= 0 || !AXIsProcessTrusted() {
            return None;
        }
        let app = Owned(AXUIElementCreateApplication(pid));
        if app.0.is_null() {
            return None;
        }
        AXUIElementSetMessagingTimeout(app.0, 0.3);
        let window = attribute(app.0, "AXFocusedWindow").or_else(|| attribute(app.0, "AXMainWindow"))?;
        let title = attribute(window.0, "AXTitle")?;
        clean_title(cf_string(title.0)?)
    }
}

#[cfg(not(target_os = "macos"))]
fn window_title(_pid: i32) -> Option<String> {
    None
}

fn clean_title(title: String) -> Option<String> {
    let title: String = title.trim().chars().take(300).collect();
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_trimmed_and_bounded() {
        assert_eq!(clean_title("  summarize.ts — eavesy  ".into()), Some("summarize.ts — eavesy".into()));
        assert_eq!(clean_title("   ".into()), None);
        assert_eq!(clean_title("x".repeat(500)).map(|title| title.len()), Some(300));
    }

    #[test]
    fn the_launcher_reads_the_last_front_app() {
        set(FrontWindow { app: Some("Cursor".into()), title: None });
        assert_eq!(front_window(), Some(FrontWindow { app: Some("Cursor".into()), title: None }));
    }
}
