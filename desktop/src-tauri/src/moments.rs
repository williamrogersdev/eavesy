//! What the user pointed at during a screen recording: every click, with the
//! element under the pointer read off the accessibility tree, and the elements
//! and areas they tagged on purpose with the marking tool. Saved next to the
//! video as `moments.json`; walkthrough processing adds a close-up of each one,
//! the text inside it and what was said around it.
// The marking panel uses tauri-nspanel's legacy `cocoa`/`objc` re-exports, like hud.rs.
#![allow(deprecated, unexpected_cfgs)]

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{mpsc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Plenty for a walkthrough; a recording left running all day stops adding clicks.
const MAX_CLICKS: usize = 500;
const MAX_MARKS: usize = 99;
const HOVER_EVERY: Duration = Duration::from_millis(50);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
    fn clipped(self, display: Rect) -> Option<Self> {
        let x = self.x.max(display.x);
        let y = self.y.max(display.y);
        let width = (self.x + self.width).min(display.x + display.width) - x;
        let height = (self.y + self.height).min(display.y + display.height) - y;
        (width > 0.0 && height > 0.0).then_some(Self { x, y, width, height })
    }
    fn moved(self, dx: f64, dy: f64) -> Self {
        Self { x: self.x + dx, y: self.y + dy, ..self }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// The control under the pointer, as the app describes it to accessibility.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The role in words ("button", "link", "text field").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Tooltip or help text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The HTML id and classes, which Safari and Chromium expose for web content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dom_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dom_classes: Vec<String>,
    /// Where a link goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// The labelled groups it sits in, outermost first ("Settings", "Profile").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
    /// Its frame, relative to the recorded display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<Rect>,
}

impl Element {
    /// `button “Save changes”`, the way a person would point at it.
    pub fn summary(&self) -> Option<String> {
        let kind = self.kind.clone().or_else(|| self.role.as_deref().map(|role| role.trim_start_matches("AX").to_lowercase()));
        let label = self.label.as_deref().or(self.value.as_deref()).map(one_line);
        match (kind, label) {
            (Some(kind), Some(label)) if !label.is_empty() => Some(format!("{kind} “{label}”")),
            (Some(kind), _) => Some(kind),
            (None, Some(label)) if !label.is_empty() => Some(format!("“{label}”")),
            _ => None,
        }
    }
}

/// Where on the Mac it happened.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// The web page's address, for browsers and web views.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_title: Option<String>,
    /// The open file, for document apps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<String>,
}

impl Place {
    pub fn is_empty(&self) -> bool {
        self == &Place::default()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Click,
    Element,
    Area,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Element,
    Area,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Moment {
    /// 1, 2, 3… in time order: names the close-up file.
    pub number: u32,
    pub kind: Kind,
    /// The evidence tag the user saw, for elements and areas they marked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark: Option<u32>,
    /// From the start of the video.
    pub timestamp_ms: u64,
    /// Where the pointer was, relative to the recorded display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
    /// What was pointed at, relative to the recorded display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element: Option<Element>,
    #[serde(default, skip_serializing_if = "Place::is_empty")]
    pub place: Place,
    /// Added by walkthrough processing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub screen_text: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub narration: String,
}

/// `moments.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Moments {
    pub schema_version: u32,
    pub display: Rect,
    pub moments: Vec<Moment>,
}

pub fn load(folder: &Path) -> Option<Moments> {
    serde_json::from_slice(&std::fs::read(folder.join("moments.json")).ok()?).ok()
}

/// What the pointer was over.
#[derive(Clone, Debug, Default, PartialEq)]
struct Target {
    element: Option<Element>,
    rect: Option<Rect>,
    place: Place,
}

/// A click or mark as it happened: wall time and global points.
struct Pending {
    kind: Kind,
    mark: Option<u32>,
    at_ms: i64,
    point: Option<Point>,
    target: Target,
}

struct Live {
    session_id: String,
    started_at_ms: i64,
    /// The video's first frame in wall time, and the display it shows.
    video: Option<(i64, Rect)>,
    pending: Vec<Pending>,
    tool: Option<Tool>,
    hover: Option<Target>,
    shortcut: bool,
}

impl Live {
    fn display(&self) -> Rect {
        self.video.map(|(_, display)| display).unwrap_or_else(imp::main_display)
    }
    fn marks(&self) -> impl Iterator<Item = &Pending> {
        self.pending.iter().filter(|p| p.mark.is_some())
    }
    fn clicks(&self) -> usize {
        self.pending.iter().filter(|p| p.kind == Kind::Click).count()
    }
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

fn live() -> MutexGuard<'static, Option<Live>> {
    LIVE.lock().unwrap_or_else(|error| error.into_inner())
}

fn mark_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::KeyH)
}

fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// A screen recording went live: start noting clicks, and offer ⌥H for marking.
pub fn begin(app: &AppHandle, session_id: &str, started_at_ms: i64) {
    end_quietly(app);
    let shortcut = app
        .global_shortcut()
        .on_shortcut(mark_shortcut(), |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = toggle(&app);
                });
            }
        })
        .map_err(|error| tracing::warn!("⌥H for marking is unavailable: {error}"))
        .is_ok();
    *live() = Some(Live {
        session_id: session_id.to_string(),
        started_at_ms,
        video: None,
        pending: vec![],
        tool: None,
        hover: None,
        shortcut,
    });
    let (sender, receiver) = mpsc::channel::<(f64, f64, i64)>();
    imp::watch_clicks(sender);
    let app_for_clicks = app.clone();
    let session = session_id.to_string();
    std::thread::spawn(move || {
        while let Ok((x, y, at_ms)) = receiver.recv() {
            // Clicks on Eavesy itself (Stop, the marking panel) are not evidence.
            let Ok(target) = imp::target_at(x, y, false) else { continue };
            let mut guard = live();
            let Some(live) = guard.as_mut().filter(|live| live.session_id == session) else { break };
            if live.tool.is_some() || live.clicks() >= MAX_CLICKS || !live.display().contains(x, y) {
                continue;
            }
            live.pending.push(Pending { kind: Kind::Click, mark: None, at_ms, point: Some(Point { x, y }), target: target.unwrap_or_default() });
            drop(guard);
            emit_state(&app_for_clicks);
        }
    });
    emit_state(app);
}

/// The engine wrote the video's first frame.
pub fn video_started(session_id: &str, epoch_ms: i64, display: Rect) {
    if let Some(live) = live().as_mut().filter(|live| live.session_id == session_id) {
        live.video = Some((epoch_ms, display));
    }
}

/// The recording is stopping: stop watching now, so nothing after the last
/// frame is counted and the marker never outlives the recording.
pub fn end(app: &AppHandle, session_id: &str) -> Option<Moments> {
    let taken = {
        let mut guard = live();
        if guard.as_ref().is_some_and(|live| live.session_id == session_id) { guard.take() } else { None }
    };
    let live = taken?;
    wind_down(app, &live);
    let moments = settle(&live);
    (!moments.moments.is_empty()).then_some(moments)
}

/// Writes what was pointed at into the saved recording's folder.
pub fn save(moments: &Moments, folder: &Path) {
    match serde_json::to_vec_pretty(moments) {
        Ok(bytes) => {
            if let Err(error) = crate::fs_writer::atomic_write(&folder.join("moments.json"), &bytes) {
                tracing::warn!("could not save clicks and marks: {error}");
            }
        }
        Err(error) => tracing::warn!("could not save clicks and marks: {error}"),
    }
}

fn end_quietly(app: &AppHandle) {
    let taken = live().take();
    if let Some(live) = taken {
        wind_down(app, &live);
    }
}

fn wind_down(app: &AppHandle, live: &Live) {
    imp::stop_clicks();
    if live.shortcut {
        let _ = app.global_shortcut().unregister(mark_shortcut());
    }
    if live.tool.is_some() {
        let _ = app.global_shortcut().unregister(escape_shortcut());
        imp::hide_marker(app);
    }
    let _ = app.emit("moments:state", serde_json::json!({ "sessionId": null, "clicks": 0, "marks": [], "tool": null, "shortcut": null }));
}

/// Wall time and global points become video time and display points, in order.
fn settle(live: &Live) -> Moments {
    let display = live.display();
    let start = live.video.map(|(epoch, _)| epoch).unwrap_or(live.started_at_ms);
    let mut pending: Vec<&Pending> = live.pending.iter().collect();
    pending.sort_by_key(|p| p.at_ms);
    let moments = pending
        .into_iter()
        .enumerate()
        .map(|(index, p)| {
            let local = |rect: Rect| rect.moved(-display.x, -display.y);
            let element = p.target.element.clone().map(|mut element| {
                element.frame = element.frame.map(local);
                element
            });
            Moment {
                number: index as u32 + 1,
                kind: p.kind,
                mark: p.mark,
                timestamp_ms: (p.at_ms - start).max(0) as u64,
                point: p.point.map(|point| Point { x: point.x - display.x, y: point.y - display.y }),
                rect: p.target.rect.map(local),
                element,
                place: p.target.place.clone(),
                crop: None,
                screen_text: String::new(),
                narration: String::new(),
            }
        })
        .collect();
    Moments { schema_version: 1, display: Rect { x: 0.0, y: 0.0, ..display }, moments }
}

fn emit_state(app: &AppHandle) {
    let payload = {
        let guard = live();
        let Some(live) = guard.as_ref() else { return };
        let display = live.display();
        let marks: Vec<_> = live
            .marks()
            .map(|p| serde_json::json!({ "number": p.mark, "rect": p.target.rect.map(|rect| rect.moved(-display.x, -display.y)) }))
            .collect();
        serde_json::json!({
            "sessionId": live.session_id,
            "clicks": live.clicks(),
            "marks": marks,
            "tool": live.tool,
            "shortcut": live.shortcut.then_some("⌥H"),
        })
    };
    let _ = app.emit("moments:state", payload);
}

fn toggle(app: &AppHandle) -> Result<(), String> {
    let tool = live().as_ref().ok_or(NOT_RECORDING)?.tool;
    match tool {
        None => use_tool(app, Tool::Area),
        Some(_) => stop(app),
    }
}

const NOT_RECORDING: &str = "Marking works while a screen recording is running";
const NOT_STARTED: &str = "The recording is still starting. Try again in a moment";

fn use_tool(app: &AppHandle, tool: Tool) -> Result<(), String> {
    let (was, display) = {
        let mut guard = live();
        let live = guard.as_mut().ok_or(NOT_RECORDING)?;
        if live.video.is_none() {
            return Err(NOT_STARTED.into());
        }
        let was = live.tool.replace(tool);
        live.hover = None;
        (was, live.display())
    };
    if was.is_none() {
        let _ = app.global_shortcut().on_shortcut(escape_shortcut(), |app, _, event| {
            if event.state == ShortcutState::Pressed {
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = stop(&app);
                });
            }
        });
        imp::show_marker(app, display);
        // A stop that landed in between must not leave Escape taken.
        let put_away = live().as_ref().is_none_or(|live| live.tool.is_none());
        if put_away {
            let _ = app.global_shortcut().unregister(escape_shortcut());
            imp::hide_marker(app);
            return Ok(());
        }
    }
    if tool == Tool::Element && was != Some(Tool::Element) {
        follow_pointer(app.clone());
    }
    let _ = app.emit("marker:hover", serde_json::Value::Null);
    emit_state(app);
    Ok(())
}

fn stop(app: &AppHandle) -> Result<(), String> {
    let was = {
        let mut guard = live();
        let live = guard.as_mut().ok_or(NOT_RECORDING)?;
        live.hover = None;
        live.tool.take()
    };
    if was.is_some() {
        let _ = app.global_shortcut().unregister(escape_shortcut());
        imp::hide_marker(app);
    }
    emit_state(app);
    Ok(())
}

/// While the element tool is out, outline whatever is under the pointer.
fn follow_pointer(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        let mut looked = Instant::now();
        loop {
            std::thread::sleep(HOVER_EVERY);
            let display = {
                let guard = live();
                match guard.as_ref() {
                    Some(live) if live.tool == Some(Tool::Element) => live.display(),
                    _ => return,
                }
            };
            let cursor = imp::cursor();
            // A still pointer is looked up again now and then: the page under it may scroll.
            if last == Some(cursor) && looked.elapsed() < Duration::from_millis(400) {
                continue;
            }
            last = Some(cursor);
            looked = Instant::now();
            let target = pointer_target(cursor.0, cursor.1, display);
            let changed = {
                let mut guard = live();
                let Some(live) = guard.as_mut().filter(|live| live.tool == Some(Tool::Element)) else { return };
                let changed = live.hover != target;
                live.hover = target.clone();
                changed
            };
            if changed {
                let _ = app.emit(
                    "marker:hover",
                    target.map(|target| serde_json::json!({
                        "rect": target.rect.map(|rect| rect.moved(-display.x, -display.y)),
                        "label": target.element.as_ref().and_then(Element::summary).or_else(|| Some("Screen region · drag Area for a larger selection".into())),
                    })),
                );
            }
        }
    });
}

/// A visible region remains taggable when an app exposes no accessible control.
/// The saved element stays absent in that case; OCR reads the resulting crop.
fn pointer_target(x: f64, y: f64, display: Rect) -> Option<Target> {
    if !display.contains(x, y) { return None; }
    let mut target = imp::target_at(x, y, true).ok().flatten().unwrap_or_default();
    target.rect = target.rect.and_then(|rect| rect.clipped(display)).or_else(|| {
        Rect { x: x - 48.0, y: y - 36.0, width: 96.0, height: 72.0 }.clipped(display)
    });
    Some(target)
}

fn add_mark(app: &AppHandle, kind: Kind, point: Option<Point>, target: Target) -> Result<u32, String> {
    let (number, rect) = {
        let mut guard = live();
        let live = guard.as_mut().ok_or(NOT_RECORDING)?;
        let number = live.marks().filter_map(|p| p.mark).max().unwrap_or(0) + 1;
        if live.marks().count() >= MAX_MARKS {
            return Err("That's as many marks as one recording holds".into());
        }
        let display = live.display();
        let rect = target.rect.map(|rect| rect.moved(-display.x, -display.y));
        live.pending.push(Pending { kind, mark: Some(number), at_ms: now_ms(), point, target });
        (number, rect)
    };
    let _ = app.emit("moments:tagged", serde_json::json!({ "number": number, "rect": rect }));
    emit_state(app);
    Ok(number)
}

#[tauri::command(async)]
pub fn toggle_marking(app: AppHandle) -> Result<(), String> {
    toggle(&app)
}

#[tauri::command(async)]
pub fn set_marking_tool(app: AppHandle, tool: Tool) -> Result<(), String> {
    use_tool(&app, tool)
}

#[tauri::command(async)]
pub fn stop_marking(app: AppHandle) -> Result<(), String> {
    stop(&app)
}

/// Tags whatever the element tool has outlined.
#[tauri::command(async)]
pub fn mark_element(app: AppHandle, point: Option<Point>) -> Result<u32, String> {
    let display = live().as_ref().filter(|live| live.tool == Some(Tool::Element)).ok_or(NOT_RECORDING)?.display();
    // The webview supplies the click point; never save a stale hover from before
    // a fast pointer movement or a slow accessibility lookup.
    let (x, y) = point.map(|p| (p.x + display.x, p.y + display.y)).unwrap_or_else(imp::cursor);
    let target = pointer_target(x, y, display).ok_or("Point inside the recorded display to tag it")?;
    add_mark(&app, Kind::Element, Some(Point { x, y }), target)
}

/// Tags an area dragged out on the marking panel, in its own points.
#[tauri::command(async)]
pub fn mark_area(app: AppHandle, rect: Rect) -> Result<u32, String> {
    if rect.width < 4.0 || rect.height < 4.0 {
        return Err("Drag a bigger box".into());
    }
    let display = live().as_ref().ok_or(NOT_RECORDING)?.display();
    if ![rect.x, rect.y, rect.width, rect.height].iter().all(|n| n.is_finite()) {
        return Err("Choose an area inside the recorded display".into());
    }
    let global = rect.moved(display.x, display.y).clipped(display).ok_or("Choose an area inside the recorded display")?;
    let (cx, cy) = (global.x + global.width / 2.0, global.y + global.height / 2.0);
    // The app and page it sits on, not one control: what is inside is read from the close-up.
    let place = imp::target_at(cx, cy, true).ok().flatten().map(|t| t.place).unwrap_or_default();
    add_mark(&app, Kind::Area, None, Target { element: None, rect: Some(global), place })
}

#[tauri::command(async)]
pub fn undo_mark(app: AppHandle) -> Result<(), String> {
    {
        let mut guard = live();
        let live = guard.as_mut().ok_or(NOT_RECORDING)?;
        let last = live.pending.iter().rposition(|p| p.mark.is_some()).ok_or("No tags to undo")?;
        live.pending.remove(last);
    }
    emit_state(&app);
    Ok(())
}

/// Clicks and marks so far, for a control that opens mid-recording.
#[tauri::command]
pub fn marking_state(app: AppHandle) {
    emit_state(&app);
    let guard = live();
    if let Some(live) = guard.as_ref() {
        if let Some(target) = &live.hover {
            let display = live.display();
            let _ = app.emit("marker:hover", serde_json::json!({
                "rect": target.rect.map(|r| r.moved(-display.x, -display.y)),
                "label": target.element.as_ref().and_then(Element::summary).unwrap_or_else(|| "Screen region · drag Area for a larger selection".into()),
            }));
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{one_line, Element, Place, Rect, Target};
    use crate::cf::{cf_str, cf_text, CFArrayGetCount, CFArrayGetValueAtIndex, CFDictionaryGetValue, CFTypeRef, Owned};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};
    use tauri::{AppHandle, Manager};

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    type TapCallback = extern "C" fn(*const c_void, u32, CFTypeRef, *mut c_void) -> CFTypeRef;

    // fn_key.rs and make_room.rs declare some of these with their own pointer types.
    #[allow(clashing_extern_declarations)]
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyElementAtPosition(element: CFTypeRef, x: f32, y: f32, out: *mut CFTypeRef) -> i32;
        fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
        fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
        fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, callback: TapCallback, info: *mut c_void) -> CFTypeRef;
        fn CGEventTapEnable(tap: CFTypeRef, enable: bool);
        fn CGEventGetLocation(event: CFTypeRef) -> CGPoint;
        fn CGEventCreate(source: CFTypeRef) -> CFTypeRef;
        fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFTypeRef;
        fn CGRectMakeWithDictionaryRepresentation(dict: CFTypeRef, rect: *mut CGRect) -> bool;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> CGRect;
        static kCGWindowOwnerPID: CFTypeRef;
        static kCGWindowBounds: CFTypeRef;
        static kCGWindowAlpha: CFTypeRef;
    }

    #[allow(clashing_extern_declarations)]
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(alloc: CFTypeRef, port: CFTypeRef, order: isize) -> CFTypeRef;
        fn CFMachPortInvalidate(port: CFTypeRef);
        fn CFRunLoopGetCurrent() -> CFTypeRef;
        fn CFRunLoopAddSource(run_loop: CFTypeRef, source: CFTypeRef, mode: CFTypeRef);
        fn CFRunLoopRun();
        fn CFRunLoopStop(run_loop: CFTypeRef);
        fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: CFTypeRef) -> bool;
        fn CFURLGetTypeID() -> usize;
        fn CFURLGetString(url: CFTypeRef) -> CFTypeRef;
        fn CFArrayGetTypeID() -> usize;
        fn CFNumberGetValue(number: CFTypeRef, kind: isize, value: *mut c_void) -> bool;
        static kCFRunLoopCommonModes: CFTypeRef;
    }

    const SESSION_EVENT_TAP: u32 = 1;
    const HEAD_INSERT: u32 = 0;
    const LISTEN_ONLY: u32 = 1;
    const LEFT_MOUSE_DOWN: u32 = 1;
    const RIGHT_MOUSE_DOWN: u32 = 3;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const AX_POINT: u32 = 1;
    const AX_SIZE: u32 = 2;
    const ON_SCREEN_ONLY: u32 = 1;
    const EXCLUDE_DESKTOP: u32 = 16;
    const COMBINED_SESSION_STATE: i32 = 0;
    const MARKER_LEVEL: i32 = 24;
    const NONACTIVATING_PANEL: i32 = 1 << 7;

    static SINK: Mutex<Option<mpsc::Sender<(f64, f64, i64)>>> = Mutex::new(None);
    static TAP: AtomicUsize = AtomicUsize::new(0);
    static RUN_LOOP: AtomicUsize = AtomicUsize::new(0);
    static POLLING: AtomicUsize = AtomicUsize::new(0);

    fn send(x: f64, y: f64) {
        if let Some(sink) = SINK.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = sink.send((x, y, super::now_ms()));
        }
    }

    extern "C" fn on_event(_proxy: *const c_void, kind: u32, event: CFTypeRef, _info: *mut c_void) -> CFTypeRef {
        match kind {
            TAP_DISABLED_BY_TIMEOUT | TAP_DISABLED_BY_USER_INPUT => {
                let tap = TAP.load(Ordering::SeqCst);
                if tap != 0 {
                    unsafe { CGEventTapEnable(tap as CFTypeRef, true) };
                }
            }
            LEFT_MOUSE_DOWN | RIGHT_MOUSE_DOWN => {
                let at = unsafe { CGEventGetLocation(event) };
                send(at.x, at.y);
            }
            _ => {}
        }
        event
    }

    /// Mouse-down positions go to `sink` until `stop_clicks`. A listen-only tap
    /// sees them without delaying them; where macOS refuses one, the button
    /// state is polled instead.
    pub fn watch_clicks(sink: mpsc::Sender<(f64, f64, i64)>) {
        stop_clicks();
        *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
        let (ready, started) = mpsc::channel::<bool>();
        std::thread::spawn(move || unsafe {
            let mask = (1u64 << LEFT_MOUSE_DOWN) | (1u64 << RIGHT_MOUSE_DOWN);
            let tap = CGEventTapCreate(SESSION_EVENT_TAP, HEAD_INSERT, LISTEN_ONLY, mask, on_event, std::ptr::null_mut());
            if tap.is_null() {
                let _ = ready.send(false);
                return;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            let run_loop = CFRunLoopGetCurrent();
            CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            TAP.store(tap as usize, Ordering::SeqCst);
            RUN_LOOP.store(CFRetain(run_loop) as usize, Ordering::SeqCst);
            let _ = ready.send(true);
            CFRunLoopRun();
            TAP.store(0, Ordering::SeqCst);
            CGEventTapEnable(tap, false);
            CFMachPortInvalidate(tap);
            CFRelease(source);
            CFRelease(tap);
        });
        if started.recv().unwrap_or(false) {
            return;
        }
        tracing::info!("no event tap for clicks; polling the mouse buttons instead");
        let generation = POLLING.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            let mut down = [false; 2];
            while POLLING.load(Ordering::SeqCst) == generation {
                for (index, button) in [0u32, 1].into_iter().enumerate() {
                    let now = unsafe { CGEventSourceButtonState(COMBINED_SESSION_STATE, button) };
                    if now && !down[index] {
                        let (x, y) = cursor();
                        send(x, y);
                    }
                    down[index] = now;
                }
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        });
    }

    pub fn stop_clicks() {
        *SINK.lock().unwrap_or_else(|e| e.into_inner()) = None;
        POLLING.fetch_add(1, Ordering::SeqCst);
        let run_loop = RUN_LOOP.swap(0, Ordering::SeqCst);
        if run_loop != 0 {
            unsafe {
                CFRunLoopStop(run_loop as CFTypeRef);
                CFRelease(run_loop as CFTypeRef);
            }
        }
    }

    pub fn cursor() -> (f64, f64) {
        unsafe {
            let event = Owned(CGEventCreate(std::ptr::null()));
            if event.0.is_null() {
                return (0.0, 0.0);
            }
            let at = CGEventGetLocation(event.0);
            (at.x, at.y)
        }
    }

    pub fn main_display() -> Rect {
        let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
        Rect { x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height }
    }

    pub struct Own;

    /// The frontmost window at a point, front to back. Eavesy's own windows
    /// are skipped, or end the search with `Own` when `skip_own` is false.
    fn owner_at(x: f64, y: f64, skip_own: bool) -> Result<Option<i32>, Own> {
        let own = std::process::id() as i32;
        unsafe {
            let list = Owned(CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0));
            if list.0.is_null() {
                return Ok(None);
            }
            for index in 0..CFArrayGetCount(list.0) {
                let window = CFArrayGetValueAtIndex(list.0, index);
                let mut bounds = CGRect::default();
                let dict = CFDictionaryGetValue(window, kCGWindowBounds);
                if dict.is_null() || !CGRectMakeWithDictionaryRepresentation(dict, &mut bounds) {
                    continue;
                }
                let rect = Rect { x: bounds.origin.x, y: bounds.origin.y, width: bounds.size.width, height: bounds.size.height };
                if !rect.contains(x, y) || number(CFDictionaryGetValue(window, kCGWindowAlpha)).is_some_and(|alpha| alpha <= 0.0) {
                    continue;
                }
                let Some(pid) = number(CFDictionaryGetValue(window, kCGWindowOwnerPID)).map(|pid| pid as i32) else { continue };
                if pid == own {
                    if skip_own {
                        continue;
                    }
                    return Err(Own);
                }
                return Ok(Some(pid));
            }
        }
        Ok(None)
    }

    unsafe fn number(value: CFTypeRef) -> Option<f64> {
        const DOUBLE: isize = 13;
        let mut out = 0f64;
        (!value.is_null() && CFNumberGetValue(value, DOUBLE, &mut out as *mut f64 as *mut c_void)).then_some(out)
    }

    /// What is under a point, in global points. `Err(Own)`: an Eavesy window.
    pub fn target_at(x: f64, y: f64, skip_own: bool) -> Result<Option<Target>, Own> {
        let Some(pid) = owner_at(x, y, skip_own)? else { return Ok(None) };
        let mut place = running_app(pid);
        unsafe {
            if !AXIsProcessTrusted() {
                return Ok(Some(Target { place, ..Target::default() }));
            }
            let app = Owned(AXUIElementCreateApplication(pid));
            if app.0.is_null() {
                return Ok(Some(Target { place, ..Target::default() }));
            }
            AXUIElementSetMessagingTimeout(app.0, 0.25);
            let mut hit: CFTypeRef = std::ptr::null();
            if AXUIElementCopyElementAtPosition(app.0, x as f32, y as f32, &mut hit) != 0 || hit.is_null() {
                return Ok(Some(Target { place, ..Target::default() }));
            }
            let element = control(Owned(hit));
            let described = describe(element.0, &mut place);
            Ok(Some(Target { rect: described.frame, element: Some(described), place }))
        }
    }

    const CONTROLS: &[&str] = &[
        "AXButton", "AXLink", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuButton", "AXPopUpButton",
        "AXTab", "AXDisclosureTriangle", "AXCell", "AXRow", "AXMenuBarItem", "AXComboBox", "AXTextField",
    ];

    /// The text or picture inside a button is the button.
    unsafe fn control(element: Owned) -> Owned {
        let mut current = element;
        for _ in 0..3 {
            let role = text(current.0, "AXRole");
            if !matches!(role.as_deref(), Some("AXStaticText" | "AXImage" | "AXGroup" | "AXUnknown")) {
                return current;
            }
            let Some(parent) = copy(current.0, "AXParent") else { return current };
            if !text(parent.0, "AXRole").is_some_and(|role| CONTROLS.contains(&role.as_str())) {
                return current;
            }
            current = parent;
        }
        current
    }

    unsafe fn copy(element: CFTypeRef, name: &str) -> Option<Owned> {
        let attr = cf_str(name);
        let mut value: CFTypeRef = std::ptr::null();
        (AXUIElementCopyAttributeValue(element, attr.0, &mut value) == 0 && !value.is_null()).then_some(Owned(value))
    }

    unsafe fn text(element: CFTypeRef, name: &str) -> Option<String> {
        let value = copy(element, name)?;
        let text = if CFGetTypeID(value.0) == CFURLGetTypeID() { cf_text(CFURLGetString(value.0), 2000) } else { cf_text(value.0, 2000) };
        text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    }

    unsafe fn flag(element: CFTypeRef, name: &str) -> Option<bool> {
        let value = copy(element, name)?;
        (CFGetTypeID(value.0) == CFBooleanGetTypeID()).then(|| CFBooleanGetValue(value.0))
    }

    unsafe fn strings(element: CFTypeRef, name: &str) -> Vec<String> {
        let Some(value) = copy(element, name) else { return vec![] };
        if CFGetTypeID(value.0) != CFArrayGetTypeID() {
            return vec![];
        }
        (0..CFArrayGetCount(value.0).min(12)).filter_map(|i| cf_text(CFArrayGetValueAtIndex(value.0, i), 80)).collect()
    }

    unsafe fn frame(element: CFTypeRef) -> Option<Rect> {
        let mut origin = CGPoint::default();
        let mut size = CGSize::default();
        let position = copy(element, "AXPosition")?;
        let extent = copy(element, "AXSize")?;
        (AXValueGetValue(position.0, AX_POINT, &mut origin as *mut CGPoint as *mut c_void)
            && AXValueGetValue(extent.0, AX_SIZE, &mut size as *mut CGSize as *mut c_void))
            .then_some(Rect { x: origin.x, y: origin.y, width: size.width, height: size.height })
            .filter(|rect| rect.width > 0.0 && rect.height > 0.0)
    }

    fn short(text: Option<String>) -> Option<String> {
        text.map(|t| one_line(&t)).filter(|t| !t.is_empty())
    }

    unsafe fn label_of(element: CFTypeRef) -> Option<String> {
        short(text(element, "AXTitle"))
            .or_else(|| short(text(element, "AXDescription")))
            .or_else(|| copy(element, "AXTitleUIElement").and_then(|title| short(text(title.0, "AXValue"))))
            .or_else(|| short(text(element, "AXPlaceholderValue")))
    }

    /// The element, and on the way up its labelled groups, the web page and the window.
    unsafe fn describe(element: CFTypeRef, place: &mut Place) -> Element {
        let role = text(element, "AXRole");
        let subrole = text(element, "AXSubrole");
        let secure = [role.as_deref(), subrole.as_deref()].contains(&Some("AXSecureTextField"));
        let value = if secure { None } else { short(text(element, "AXValue")) };
        let mut label = label_of(element);
        if label.is_none() && role.as_deref() == Some("AXStaticText") {
            label = value.clone();
        }
        let mut described = Element {
            kind: short(text(element, "AXRoleDescription")),
            value: value.filter(|v| Some(v) != label.as_ref()),
            label,
            help: short(text(element, "AXHelp")),
            enabled: flag(element, "AXEnabled"),
            dom_id: short(text(element, "AXDOMIdentifier")),
            dom_classes: strings(element, "AXDOMClassList"),
            link: (role.as_deref() == Some("AXLink")).then(|| text(element, "AXURL")).flatten(),
            frame: frame(element),
            role,
            path: vec![],
        };
        let mut path = vec![];
        let mut current = copy(element, "AXParent");
        for _ in 0..40 {
            let Some(node) = current else { break };
            let role = text(node.0, "AXRole");
            match role.as_deref() {
                Some("AXWebArea") => {
                    place.url = place.url.take().or_else(|| text(node.0, "AXURL"));
                    place.page_title = place.page_title.take().or_else(|| label_of(node.0));
                }
                Some("AXWindow") => {
                    place.window = label_of(node.0);
                    place.document = text(node.0, "AXDocument");
                    break;
                }
                Some("AXLink") if described.link.is_none() => described.link = text(node.0, "AXURL"),
                Some("AXGroup" | "AXForm" | "AXSheet" | "AXTabGroup" | "AXList" | "AXTable" | "AXToolbar" | "AXLandmarkMain" | "AXDialog") => {
                    if let Some(label) = label_of(node.0) {
                        if path.len() < 5 && path.last() != Some(&label) {
                            path.push(label);
                        }
                    }
                }
                _ => {}
            }
            current = copy(node.0, "AXParent");
        }
        path.reverse();
        described.path = path;
        described
    }

    fn running_app(pid: i32) -> Place {
        use tauri_nspanel::cocoa::base::{id, nil};
        use tauri_nspanel::objc::{class, msg_send, rc::autoreleasepool, sel, sel_impl};
        unsafe fn string(value: id) -> Option<String> {
            if value == nil {
                return None;
            }
            let bytes: *const std::ffi::c_char = msg_send![value, UTF8String];
            (!bytes.is_null()).then(|| std::ffi::CStr::from_ptr(bytes).to_string_lossy().into_owned())
        }
        autoreleasepool(|| unsafe {
            let app: id = msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
            if app == nil {
                return Place::default();
            }
            Place { app: string(msg_send![app, localizedName]), bundle_id: string(msg_send![app, bundleIdentifier]), ..Place::default() }
        })
    }

    /// The see-through marking panel over the recorded display. The recording
    /// leaves Eavesy's windows out, so nothing drawn on it is in the video.
    pub fn show_marker(app: &AppHandle, display: Rect) {
        let app = app.clone();
        std::thread::spawn(move || {
            let window = match app.get_webview_window("marker") {
                Some(window) => window,
                None => match tauri::WebviewWindowBuilder::new(&app, "marker", tauri::WebviewUrl::App("marker.html".into()))
                    .title("Eavesy Marking")
                    .transparent(true)
                    .decorations(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .shadow(false)
                    .focused(false)
                    .visible(false)
                    .accept_first_mouse(true)
                    .build()
                {
                    Ok(window) => window,
                    Err(error) => {
                        tracing::warn!("could not open the marking panel: {error}");
                        return;
                    }
                },
            };
            let _ = window.set_size(tauri::LogicalSize::new(display.width, display.height));
            let _ = window.set_position(tauri::LogicalPosition::new(display.x, display.y));
            let webview: &tauri::Webview = window.as_ref();
            let _ = webview.set_size(tauri::LogicalSize::new(display.width, display.height));
            let shown = app.clone();
            let _ = app.run_on_main_thread(move || {
                use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, ManagerExt, WebviewWindowExt};
                if super::live().as_ref().and_then(|live| live.tool).is_none() {
                    return;
                }
                let panel = match shown.get_webview_panel("marker") {
                    Ok(panel) => panel,
                    Err(_) => match window.to_panel() {
                        Ok(panel) => {
                            panel.set_style_mask(NONACTIVATING_PANEL);
                            panel.set_level(MARKER_LEVEL);
                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                            );
                            panel.set_released_when_closed(false);
                            panel
                        }
                        Err(_) => {
                            let _ = window.show();
                            return;
                        }
                    },
                };
                panel.order_front_regardless();
            });
        });
    }

    pub fn hide_marker(app: &AppHandle) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = handle.get_webview_panel("marker") {
                panel.order_out(None);
            } else if let Some(window) = handle.get_webview_window("marker") {
                let _ = window.hide();
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{Rect, Target};
    use std::sync::mpsc;
    use tauri::AppHandle;
    pub struct Own;
    pub fn watch_clicks(_sink: mpsc::Sender<(f64, f64, i64)>) {}
    pub fn stop_clicks() {}
    pub fn cursor() -> (f64, f64) {
        (0.0, 0.0)
    }
    pub fn main_display() -> Rect {
        Rect::default()
    }
    pub fn target_at(_x: f64, _y: f64, _skip_own: bool) -> Result<Option<Target>, Own> {
        Ok(None)
    }
    pub fn show_marker(_app: &AppHandle, _display: Rect) {}
    pub fn hide_marker(_app: &AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_with(pending: Vec<Pending>, video: Option<(i64, Rect)>) -> Live {
        Live { session_id: "s".into(), started_at_ms: 1_000, video, pending, tool: None, hover: None, shortcut: false }
    }

    fn click(at_ms: i64, x: f64, y: f64) -> Pending {
        Pending { kind: Kind::Click, mark: None, at_ms, point: Some(Point { x, y }), target: Target::default() }
    }

    #[test]
    fn moments_are_in_video_time_and_display_points_and_numbered_in_order() {
        let display = Rect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        let mut area = click(6_500, 0.0, 0.0);
        area.kind = Kind::Area;
        area.mark = Some(1);
        area.point = None;
        area.target.rect = Some(Rect { x: 1500.0, y: 100.0, width: 200.0, height: 80.0 });
        let settled = settle(&live_with(vec![click(9_000, 1600.0, 300.0), area, click(4_000, 1450.0, 10.0)], Some((5_000, display))));
        let times: Vec<_> = settled.moments.iter().map(|m| (m.number, m.timestamp_ms)).collect();
        assert_eq!(times, vec![(1, 0), (2, 1_500), (3, 4_000)]);
        assert_eq!(settled.moments[2].point, Some(Point { x: 160.0, y: 300.0 }));
        assert_eq!(settled.moments[1].rect, Some(Rect { x: 60.0, y: 100.0, width: 200.0, height: 80.0 }));
        assert_eq!(settled.moments[1].mark, Some(1));
    }

    #[test]
    fn without_a_first_frame_time_moments_count_from_the_recording_start() {
        let settled = settle(&live_with(vec![click(3_500, 10.0, 10.0)], None));
        assert_eq!(settled.moments[0].timestamp_ms, 2_500);
    }

    #[test]
    fn pointer_fallback_and_crop_stay_on_the_recorded_display() {
        let display = Rect { x: -1440.0, y: 100.0, width: 1440.0, height: 900.0 };
        let crop = Rect { x: -1460.0, y: 80.0, width: 96.0, height: 72.0 }.clipped(display).unwrap();
        assert_eq!(crop, Rect { x: -1440.0, y: 100.0, width: 76.0, height: 52.0 });
        assert!(Rect { x: 5.0, y: 5.0, width: 10.0, height: 10.0 }.clipped(display).is_none());
        assert!(pointer_target(10.0, 20.0, display).is_none());
    }

    #[test]
    fn elements_are_summarised_the_way_people_point_at_them() {
        let button = Element { role: Some("AXButton".into()), kind: Some("button".into()), label: Some("Save\n changes".into()), ..Element::default() };
        assert_eq!(button.summary().as_deref(), Some("button “Save changes”"));
        let bare = Element { role: Some("AXGroup".into()), ..Element::default() };
        assert_eq!(bare.summary().as_deref(), Some("group"));
        assert_eq!(Element::default().summary(), None);
    }

    #[test]
    fn the_file_round_trips_and_leaves_out_what_is_unknown() {
        let settled = settle(&live_with(vec![click(2_000, 5.0, 5.0)], None));
        let json = serde_json::to_string(&settled).unwrap();
        assert!(!json.contains("element"));
        assert!(!json.contains("narration"));
        let back: Moments = serde_json::from_str(&json).unwrap();
        assert_eq!(back, settled);
    }
}
