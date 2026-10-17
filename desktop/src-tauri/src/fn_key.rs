use std::ffi::c_void;
use std::sync::{atomic::{AtomicU8, Ordering}, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

static ACTION: AtomicU8 = AtomicU8::new(0);
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
                _ => {}
            }
        }
    }));
    event
}

pub fn bind(app: &AppHandle, action: u8) -> Result<(), String> {
    unsafe {
        if !CGPreflightListenEventAccess() {
            crate::permissions::request_input_monitoring_inner(app);
            return Err("Allow Eavesy in System Settings → Privacy & Security → Input Monitoring, then quit and reopen Eavesy and select Fn / Globe again. Set Keyboard → Press Fn/Globe key to → Do Nothing to avoid triggering macOS too.".into());
        }
    }
    if TAP.get().is_none() {
        let app = app.clone();
        let (send, receive_result) = std::sync::mpsc::channel();
        std::thread::spawn(move || unsafe {
            let context = Box::into_raw(Box::new(Context { app, gesture: Gesture::default() }));
            let tap = CGEventTapCreate(1, 0, 1, (1 << 12) | (1 << 10), receive, context.cast());
            if tap.is_null() {
                drop(Box::from_raw(context));
                let _ = send.send(Err("macOS could not enable Fn / Globe. Check Input Monitoring and reopen Eavesy.".to_string()));
                return;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            if source.is_null() {
                CFRelease(tap); drop(Box::from_raw(context));
                let _ = send.send(Err("Could not start the Fn / Globe listener.".to_string()));
                return;
            }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            let _ = TAP.set(tap as usize);
            let _ = send.send(Ok(()));
            CFRunLoopRun();
        });
        receive_result.recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Fn / Globe listener did not start; reopen Eavesy.".to_string())??;
    }
    ACTION.store(action, Ordering::SeqCst);
    if let Some(tap) = TAP.get() { unsafe { CGEventTapEnable(*tap as *mut c_void, true); } }
    Ok(())
}

pub fn unbind() {
    ACTION.store(0, Ordering::SeqCst);
    if let Some(tap) = TAP.get() { unsafe { CGEventTapEnable(*tap as *mut c_void, false); } }
}

#[cfg(test)]
mod tests {
    use super::*;
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
