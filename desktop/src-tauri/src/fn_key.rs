use std::ffi::c_void;
use std::sync::{atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering}, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

use crate::hotkeys::{Action, HotkeyError};

/// What fn on its own does: 0 off, 1 open Eavesy, 2 dictation, `TALK` talk to
/// Eavesy, `CAPTURE` report taps (and fn chords) to Settings.
static ACTION: AtomicU8 = AtomicU8::new(0);
const CAPTURE: u8 = 3;
pub const TALK: u8 = 4;
/// The listen-only tap that hears fn on its own (Input Monitoring).
static TAP: OnceLock<usize> = OnceLock::new();
const FN: u64 = 1 << 23;
const MODIFIERS: u64 = (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20);

/// fn held with a key, one slot per action (`slot`): `BOUND | flags | keycode`,
/// or 0 when that action has no fn chord.
static CHORDS: [AtomicU64; 3] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
/// Whether each action's chord is down right now (its key-up is ours too).
static HELD: [AtomicBool; 3] = [AtomicBool::new(false), AtomicBool::new(false), AtomicBool::new(false)];
/// A chord just fired, so the fn release that follows isn't a lone tap even
/// if the listen-only tap never saw the (swallowed) key.
static CHORD_FIRED: AtomicBool = AtomicBool::new(false);
/// The active tap that catches fn chords and keeps them from the app in front
/// (Accessibility). Only enabled while a chord is bound.
static CHORD_TAP: OnceLock<usize> = OnceLock::new();
const BOUND: u64 = 1 << 63;
const CHORD_FLAGS: u64 = FN | MODIFIERS;

const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
/// `kCGKeyboardEventAutorepeat` and `kCGKeyboardEventKeycode`.
const FIELD_AUTOREPEAT: u32 = 8;
const FIELD_KEYCODE: u32 = 9;

type TapCallback = extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventTapCreate(location: u32, placement: u32, options: u32, mask: u64,
        callback: TapCallback, info: *mut c_void) -> *mut c_void;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
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
        if kind == KEY_DOWN {
            context.gesture.cancelled = true;
            if ACTION.load(Ordering::SeqCst) == CAPTURE && CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) == 0 {
                report_chord(&context.app, CGEventGetIntegerValueField(event, FIELD_KEYCODE), CGEventGetFlags(event));
            }
        }
        if kind == FLAGS_CHANGED {
            if CHORD_FIRED.swap(false, Ordering::SeqCst) { context.gesture.cancelled = true; }
            if context.gesture.flags(CGEventGetFlags(event), Instant::now()) {
                match ACTION.load(Ordering::SeqCst) {
                    1 => crate::hotkeys::toggle_launcher(&context.app),
                    2 => crate::hotkeys::trigger_dictation(&context.app),
                    TALK => crate::dictate::toggle_talk(&context.app),
                    CAPTURE => { use tauri::Emitter; let _ = context.app.emit(crate::hotkeys::EVENT_FN_TAP, ()); }
                    _ => {}
                }
            }
        }
    }));
    event
}

/// While recording a shortcut: fn held with a chord key is sent to Settings
/// as its accelerator, since the webview only sees the key.
fn report_chord(app: &AppHandle, keycode: i64, flags: u64) {
    if flags & FN == 0 { return; }
    let Ok(keycode) = u16::try_from(keycode) else { return };
    if let Some(accelerator) = crate::hotkeys::chord_accelerator(keycode, flags) {
        use tauri::Emitter;
        let _ = app.emit(crate::hotkeys::EVENT_FN_CHORD, accelerator);
    }
}

/// What the chord tap does with one key event.
#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// Not ours: the app in front gets it.
    Pass,
    /// A repeat of a chord that is down: nobody gets it.
    Swallow,
    /// That slot's chord went down.
    Down(usize),
    /// That slot's chord came up.
    Up(usize),
    /// That slot's key went down again without fn: its key-up was missed (the
    /// tap was paused), so let it go and pass the key on.
    Forget(usize),
}

fn step(chords: [u64; 3], held: [bool; 3], kind: u32, keycode: u16, flags: u64, repeat: bool) -> Step {
    let on_key = |slot: usize| chords[slot] & BOUND != 0 && (chords[slot] & 0xFFFF) as u16 == keycode;
    let held_slot = (0..3).find(|&slot| held[slot] && on_key(slot));
    match kind {
        KEY_DOWN if repeat => if held_slot.is_some() { Step::Swallow } else { Step::Pass },
        KEY_DOWN => {
            let wanted = flags & CHORD_FLAGS;
            match (0..3).find(|&slot| on_key(slot) && chords[slot] & CHORD_FLAGS == wanted) {
                Some(slot) => Step::Down(slot),
                None => held_slot.map_or(Step::Pass, Step::Forget),
            }
        }
        KEY_UP => held_slot.map_or(Step::Pass, Step::Up),
        _ => Step::Pass,
    }
}

fn slot(action: Action) -> usize {
    match action { Action::Toggle => 0, Action::Dictation => 1, Action::Assistant => 2 }
}

/// The same handlers a registered shortcut uses: open Eavesy on press, and
/// hold-or-tap for the two talk shortcuts.
fn chord_down(app: &AppHandle, slot: usize) {
    match slot {
        0 => crate::hotkeys::toggle_launcher(app),
        1 => crate::dictate::key_down(app),
        _ => crate::dictate::talk_key_down(app),
    }
}

fn chord_up(app: &AppHandle, slot: usize) {
    match slot {
        0 => {}
        1 => crate::dictate::key_up(app),
        _ => crate::dictate::talk_key_up(app),
    }
}

fn any_chord() -> bool {
    CHORDS.iter().any(|chord| chord.load(Ordering::SeqCst) != 0)
}

/// Lets go of every chord that is down, as if its key came up.
fn release_held(app: &AppHandle) {
    for (slot, held) in HELD.iter().enumerate() {
        if held.swap(false, Ordering::SeqCst) { chord_up(app, slot); }
    }
}

extern "C" fn receive_chord(_: *mut c_void, kind: u32, event: *mut c_void, info: *mut c_void) -> *mut c_void {
    let swallow = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        if info.is_null() { return false; }
        let app = &*(info as *const AppHandle);
        if kind >= u32::MAX - 1 {
            // macOS paused the tap (slow callback or user input): a key-up may
            // have been missed, so nothing stays held.
            release_held(app);
            if any_chord() {
                if let Some(tap) = CHORD_TAP.get() { CGEventTapEnable(*tap as *mut c_void, true); }
            }
            return false;
        }
        if event.is_null() || (kind != KEY_DOWN && kind != KEY_UP) { return false; }
        let Ok(keycode) = u16::try_from(CGEventGetIntegerValueField(event, FIELD_KEYCODE)) else { return false };
        // Separate loads can see a binding change half done; at worst one key
        // event is judged against the old binding, and the next one is right.
        let chords = [0, 1, 2].map(|slot| CHORDS[slot].load(Ordering::SeqCst));
        let held = [0, 1, 2].map(|slot| HELD[slot].load(Ordering::SeqCst));
        let repeat = CGEventGetIntegerValueField(event, FIELD_AUTOREPEAT) != 0;
        match step(chords, held, kind, keycode, CGEventGetFlags(event), repeat) {
            Step::Pass => false,
            Step::Swallow => true,
            Step::Down(slot) => {
                HELD[slot].store(true, Ordering::SeqCst);
                CHORD_FIRED.store(true, Ordering::SeqCst);
                chord_down(app, slot);
                true
            }
            Step::Up(slot) => {
                HELD[slot].store(false, Ordering::SeqCst);
                chord_up(app, slot);
                true
            }
            Step::Forget(slot) => {
                if HELD[slot].swap(false, Ordering::SeqCst) { chord_up(app, slot); }
                false
            }
        }
    })).unwrap_or(false);
    if swallow { std::ptr::null_mut() } else { event }
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

/// Binds fn held with `keycode` (and the ⇧⌃⌥⌘ in `flags`) to `action`. The
/// tap that catches it must be able to drop the key, which macOS allows only
/// with Accessibility.
pub fn bind_chord(app: &AppHandle, action: Action, keycode: u16, flags: u64) -> Result<(), HotkeyError> {
    if !crate::permissions::accessibility_granted() { return Err(HotkeyError::Accessibility); }
    ensure_chord_tap(app).map_err(HotkeyError::invalid)?;
    let slot = slot(action);
    // A chord rebound while its key is down: let go of it first.
    if HELD[slot].swap(false, Ordering::SeqCst) { chord_up(app, slot); }
    CHORDS[slot].store(BOUND | FN | (flags & MODIFIERS) | u64::from(keycode), Ordering::SeqCst);
    if let Some(tap) = CHORD_TAP.get() { unsafe { CGEventTapEnable(*tap as *mut c_void, true); } }
    Ok(())
}

/// While Settings records a shortcut, a lone fn tap is reported to it rather
/// than acted on, and so is fn held with a key. Fails without Input
/// Monitoring; Settings reads `fn_status` and offers a "Use fn" button instead
/// of promising that a tap works.
pub fn capture(app: &AppHandle) -> Result<(), HotkeyError> {
    bind(app, CAPTURE)
}

fn ensure_tap(app: &AppHandle) -> Result<(), String> {
    if TAP.get().is_some() { return Ok(()); }
    let app = app.clone();
    start_tap(
        &TAP,
        // Listen only: flagsChanged and keyDown.
        1,
        (1 << FLAGS_CHANGED) | (1 << KEY_DOWN),
        receive,
        move || Box::into_raw(Box::new(Context { app, gesture: Gesture::default() })).cast(),
        |info| unsafe { drop(Box::from_raw(info as *mut Context)) },
        "macOS could not watch the fn key. Check Input Monitoring and relaunch Eavesy.",
        "The fn key listener did not start; relaunch Eavesy.",
    )
}

fn ensure_chord_tap(app: &AppHandle) -> Result<(), String> {
    if CHORD_TAP.get().is_some() { return Ok(()); }
    let app = app.clone();
    start_tap(
        &CHORD_TAP,
        // Active: it can drop a chord's key so the app in front never sees it.
        0,
        (1 << KEY_DOWN) | (1 << KEY_UP),
        receive_chord,
        move || Box::into_raw(Box::new(app)).cast(),
        |info| unsafe { drop(Box::from_raw(info as *mut AppHandle)) },
        "macOS would not let Eavesy catch fn with a key. Check Accessibility in Privacy & Security, then relaunch Eavesy.",
        "The fn shortcut listener did not start; relaunch Eavesy.",
    )
}

/// Creates a session event tap on its own thread and run loop, and records it
/// in `slot`. `info` is made on that thread and lives as long as the tap.
#[allow(clippy::too_many_arguments)]
fn start_tap(
    slot: &'static OnceLock<usize>,
    options: u32,
    mask: u64,
    callback: TapCallback,
    info: impl FnOnce() -> *mut c_void + Send + 'static,
    free: fn(*mut c_void),
    refused: &'static str,
    timed_out: &'static str,
) -> Result<(), String> {
    let (send, receive_result) = std::sync::mpsc::channel();
    std::thread::spawn(move || unsafe {
        let info = info();
        let tap = CGEventTapCreate(1, 0, options, mask, callback, info);
        if tap.is_null() {
            free(info);
            let _ = send.send(Err(refused.to_string()));
            return;
        }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
            CFRelease(tap); free(info);
            let _ = send.send(Err("Could not start watching the fn key.".to_string()));
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        let _ = slot.set(tap as usize);
        let _ = send.send(Ok(()));
        CFRunLoopRun();
    });
    receive_result.recv_timeout(Duration::from_secs(3)).map_err(|_| timed_out.to_string())?
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
    for (chord, held) in CHORDS.iter().zip(&HELD) {
        chord.store(0, Ordering::SeqCst);
        held.store(false, Ordering::SeqCst);
    }
    if let Some(tap) = CHORD_TAP.get() { unsafe { CGEventTapEnable(*tap as *mut c_void, false); } }
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

    const SPACE: u16 = 49;
    const E: u16 = 14;
    const SHIFT: u64 = 1 << 17;
    fn talk_on_fn_space() -> [u64; 3] { [0, 0, BOUND | FN | u64::from(SPACE)] }

    #[test]
    fn a_bound_chord_goes_down_and_up_and_its_repeats_are_swallowed() {
        let chords = talk_on_fn_space();
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, FN, false), Step::Down(2));
        assert_eq!(step(chords, [false, false, true], KEY_DOWN, SPACE, FN, true), Step::Swallow);
        // Letting go of fn first: the key-up is still ours.
        assert_eq!(step(chords, [false, false, true], KEY_UP, SPACE, 0, false), Step::Up(2));
        assert_eq!(step(chords, [false; 3], KEY_UP, SPACE, 0, false), Step::Pass);
    }

    #[test]
    fn keys_that_are_not_a_bound_chord_pass_through() {
        let chords = talk_on_fn_space();
        // Plain Space, Space with another modifier, and fn+E (the emoji picker).
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, 0, false), Step::Pass);
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, FN | SHIFT, false), Step::Pass);
        assert_eq!(step(chords, [false; 3], KEY_DOWN, E, FN, false), Step::Pass);
        // Caps Lock and the numeric-pad flag don't matter.
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, FN | (1 << 16) | (1 << 21), false), Step::Down(2));
        // A repeat of a press that began before the chord was bound isn't ours.
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, FN, true), Step::Pass);
        // Nothing bound: nothing caught.
        assert_eq!(step([0; 3], [false; 3], KEY_DOWN, SPACE, FN, false), Step::Pass);
    }

    #[test]
    fn a_missed_key_up_never_leaves_the_key_swallowed() {
        let chords = talk_on_fn_space();
        assert_eq!(step(chords, [false, false, true], KEY_DOWN, SPACE, 0, false), Step::Forget(2));
    }

    #[test]
    fn changing_modifiers_mid_hold_keeps_the_hold() {
        // Pressing or releasing fn/⇧ while the key is held only sends repeats
        // (a fresh key-down needs a new press), and those stay swallowed.
        let chords = talk_on_fn_space();
        assert_eq!(step(chords, [false, false, true], KEY_DOWN, SPACE, SHIFT, true), Step::Swallow);
        assert_eq!(step(chords, [false, false, true], KEY_DOWN, SPACE, 0, true), Step::Swallow);
    }

    #[test]
    fn each_action_has_its_own_chord() {
        let chords = [BOUND | FN | u64::from(SPACE), 0, BOUND | FN | SHIFT | u64::from(SPACE)];
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, FN, false), Step::Down(0));
        assert_eq!(step(chords, [false; 3], KEY_DOWN, SPACE, FN | SHIFT, false), Step::Down(2));
    }

    #[test]
    fn a_chord_cancels_the_lone_fn_tap_that_would_follow() {
        // The listen-only tap marks the gesture cancelled when a chord fired,
        // even if it never saw the swallowed key.
        let t = Instant::now(); let mut g = Gesture::default();
        assert!(!g.flags(FN, t));
        g.cancelled = true; // what CHORD_FIRED does on the next flagsChanged
        assert!(!g.flags(0, t + Duration::from_millis(100)));
        // A stale mark is cleared by the next fn press.
        g.cancelled = true;
        assert!(!g.flags(FN, t + Duration::from_millis(200)));
        assert!(g.flags(0, t + Duration::from_millis(300)));
    }
}
