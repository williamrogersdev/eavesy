use std::ffi::c_void;
use std::sync::{atomic::{AtomicU8, Ordering}, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::hotkeys::HotkeyError;

/// 0 off, 1 open Eavesy, 2 dictation, `CAPTURE` report taps to Settings.
static ACTION: AtomicU8 = AtomicU8::new(0);
const CAPTURE: u8 = 3;
static TAP: OnceLock<usize> = OnceLock::new();
const FN: u64 = 1 << 23;
const MODIFIERS: u64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventTapCreate(location: u32, placement: u32, options: u32, mask: u64,
        callback: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
        info: *mut c_void) -> *mut c_void;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: *const c_void;
    fn CFMachPortCreateRunLoopSource(allocator: *const c_void, port: *mut c_void, order: isize) -> *mut c_void;
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopAddSource(loop_ref: *mut c_void, source: *mut c_void, mode: *const c_void);
    fn CFRunLoopRun();
    fn CFRelease(value: *const c_void);
}

#[derive(Default)]
struct Gesture { pressed: Option<Instant>, cancelled: bool }
impl Gesture {
    fn flags(&mut self, flags: u64, now: Instant) -> bool {
        if flags & FN != 0 {
            if self.pressed.is_none() { self.pressed = Some(now); self.cancelled = false; }
            self.cancelled |= flags & MODIFIERS != 0;
            false
        } else {
            let tap = self.pressed.take().is_some_and(|start|
                !self.cancelled && now.duration_since(start) < Duration::from_millis(500));
            self.cancelled = false;
            tap
        }
    }
}
struct Context { app: AppHandle, gesture: Gesture }
extern "C" fn receive(_: *mut c_void, kind: u32, event: *mut c_void, info: *mut c_void) -> *mut c_void {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        if kind >= u32::MAX - 1 {
            if ACTION.load(Ordering::SeqCst) != 0 {
                if let Some(tap) = TAP.get() { CGEventTapEnable(*tap as *mut c_void, true); }
            }
            return;
        }
        if event.is_null() || info.is_null() { return; }
        let context = &mut *(info as *mut Context);
        if ACTION.load(Ordering::SeqCst) == 0 { context.gesture = Gesture::default(); return; }
        if kind == 10 { context.gesture.cancelled = true; }
        if kind == 12 && context.gesture.flags(CGEventGetFlags(event), Instant::now()) {
            match ACTION.load(Ordering::SeqCst) {
                1 => crate::hotkeys::toggle_launcher(&context.app),
                2 => crate::hotkeys::trigger_dictation(&context.app),
                CAPTURE => { use tauri::Emitter; let _ = context.app.emit(crate::hotkeys::EVENT_FN_TAP, ()); }
                _ => {}
            }
        }
    }));
    event
}

/// Whether Eavesy may watch the fn key (Input Monitoring, applied at launch).
pub fn input_monitoring_granted() -> bool {
    unsafe { CGPreflightListenEventAccess() }
}

pub fn bind(app: &AppHandle, action: u8) -> Result<(), HotkeyError> {
    if !input_monitoring_granted() { return Err(HotkeyError::InputMonitoring); }
    ensure_tap(app).map_err(HotkeyError::invalid)?;
    ACTION.store(action, Ordering::SeqCst);
    if let Some(tap) = TAP.get() { unsafe { CGEventTapEnable(*tap as *mut c_void, true); } }
    Ok(())
}

/// While Settings records a shortcut, a lone fn tap is reported to it rather
/// than acted on. Fails without Input Monitoring; Settings reads `fn_status`
/// and offers a "Use fn" button instead of promising that a tap works.
pub fn capture(app: &AppHandle) -> Result<(), HotkeyError> {
    bind(app, CAPTURE)
}

fn ensure_tap(app: &AppHandle) -> Result<(), String> {
    if TAP.get().is_some() { return Ok(()); }
    let app = app.clone();
    let (send, receive_result) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let context = Box::into_raw(Box::new(Context { app, gesture: Gesture::default() }));
        let tap = CGEventTapCreate(1, 0, 1, (1 << 12) | (1 << 10), receive, context.cast());
        if tap.is_null() {
            drop(Box::from_raw(context));
            let _ = send.send(Err("macOS could not watch the fn key. Check Input Monitoring and relaunch Eavesy.".to_string()));
            return;
        }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            CFRelease(tap); drop(Box::from_raw(context));
            let _ = send.send(Err("Could not start watching the fn key.".to_string()));
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        let _ = TAP.set(tap as usize);
        let _ = send.send(Ok(()));
        CFRunLoopRun();
    });
    receive_result.recv_timeout(Duration::from_secs(3))
        .map_err(|_| "The fn key listener did not start; relaunch Eavesy.".to_string())?
}

/// What the 🌐 key does on its own (System Settings → Keyboard → "Press 🌐 key to").
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GlobeAction { DoNothing, InputSource, Emoji, Dictation, Unknown }

impl GlobeAction {
    /// `AppleFnUsageType` in com.apple.HIToolbox. Unset means the macOS
    /// default, which shows the emoji picker.
    pub fn from_usage_type(value: Option<&str>) -> Self {
        match value.map(str::trim) {
            Some("0") => GlobeAction::DoNothing,
            Some("1") => GlobeAction::InputSource,
            Some("2") | None => GlobeAction::Emoji,
            Some("3") => GlobeAction::Dictation,
            Some(_) => GlobeAction::Unknown,
        }
    }

    pub fn read() -> Self {
        let output = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "com.apple.HIToolbox", "AppleFnUsageType"]).output();
        match output {
            Ok(out) if out.status.success() => Self::from_usage_type(Some(&String::from_utf8_lossy(&out.stdout))),
            Ok(_) => Self::from_usage_type(None),
            Err(_) => GlobeAction::Unknown,
        }
    }
}

pub fn unbind() {
    ACTION.store(0, Ordering::SeqCst);
    if let Some(tap) = TAP.get() { unsafe { CGEventTapEnable(*tap as *mut c_void, false); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn globe_setting_maps_to_what_the_key_does() {
        assert_eq!(GlobeAction::from_usage_type(Some("0\n")), GlobeAction::DoNothing);
        assert_eq!(GlobeAction::from_usage_type(Some("1")), GlobeAction::InputSource);
        assert_eq!(GlobeAction::from_usage_type(None), GlobeAction::Emoji);
        assert_eq!(GlobeAction::from_usage_type(Some("3")), GlobeAction::Dictation);
        assert_eq!(GlobeAction::from_usage_type(Some("9")), GlobeAction::Unknown);
    }
    #[test]
    fn standalone_tap_fires_on_release_once() {
        let mut g = Gesture::default(); let t = Instant::now();
        assert!(!g.flags(FN, t));
        assert!(!g.flags(FN, t + Duration::from_millis(20)));
        assert!(g.flags(0, t + Duration::from_millis(100)));
        assert!(!g.flags(0, t + Duration::from_millis(101)));
    }
    #[test]
    fn fn_chords_modifiers_and_holds_do_not_fire() {
        let t = Instant::now(); let mut g = Gesture::default();
        g.flags(FN, t); g.cancelled = true;
        assert!(!g.flags(0, t + Duration::from_millis(100)));
        g.flags(FN | (1 << 17), t);
        assert!(!g.flags(0, t + Duration::from_millis(100)));
        g.flags(FN, t);
        assert!(!g.flags(0, t + Duration::from_secs(1)));
    }
}
