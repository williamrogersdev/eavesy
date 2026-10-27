//! Observe only the original AX text field and only the passage Eavesy pasted.
//! No key logger, global field polling or secure-field reads.
#[cfg(target_os = "macos")]
mod mac {
    use serde_json::json;
    use std::{
        ffi::{c_char, c_void},
        ptr,
        sync::{
            atomic::{AtomicU64, Ordering},
            Mutex,
        },
        time::Duration,
    };
    use tauri::AppHandle;
    type Ref = *const c_void;
    const UTF8: u32 = 0x08000100;
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        #[cfg(test)]
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateSystemWide() -> Ref;
        fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
        fn AXUIElementCopyAttributeValue(element: Ref, attr: Ref, value: *mut Ref) -> i32;
        fn AXUIElementSetAttributeValue(element: Ref, attr: Ref, value: Ref) -> i32;
        fn AXValueCreate(kind: u32, value: *const c_void) -> Ref;
        fn AXValueGetValue(value: Ref, kind: u32, out: *mut c_void) -> bool;
        fn AXUIElementIsAttributeSettable(element: Ref, attr: Ref, settable: *mut bool) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: Ref);
        fn CFRetain(value: Ref) -> Ref;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFStringCreateWithCString(allocator: Ref, value: *const c_char, encoding: u32) -> Ref;
        fn CFStringGetLength(value: Ref) -> isize;
        fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> bool;
    }
    unsafe fn attribute(element: Ref, name: &str) -> Option<Ref> {
        let key = std::ffi::CString::new(name).ok()?;
        let key = CFStringCreateWithCString(ptr::null(), key.as_ptr(), UTF8);
        let mut value = ptr::null();
        let result = AXUIElementCopyAttributeValue(element, key, &mut value);
        CFRelease(key);
        (result == 0 && !value.is_null()).then_some(value)
    }
    unsafe fn string(element: Ref, name: &str) -> Option<String> {
        let value = attribute(element, name)?;
        let result = if CFGetTypeID(value) == CFStringGetTypeID()
            && CFStringGetLength(value) <= 48_000
        {
            let mut bytes = vec![0u8; CFStringGetLength(value) as usize * 4 + 1];
            if CFStringGetCString(value, bytes.as_mut_ptr().cast(), bytes.len() as isize, UTF8) {
                let len = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
                String::from_utf8(bytes[..len].to_vec()).ok()
            } else {
                None
            }
        } else {
            None
        };
        CFRelease(value);
        result
    }
    /// A field's text as the passage is matched in it: see `super::normalize`.
    unsafe fn field_text(element: Ref) -> Option<String> {
        string(element, "AXValue").map(|value| super::normalize(&value))
    }
    /// Where the caret is, in UTF-16 units: the end of the selection.
    unsafe fn caret(element: Ref) -> Option<usize> {
        let value = attribute(element, "AXSelectedTextRange")?;
        let mut range = CFRange { location: 0, length: 0 };
        let ok = AXValueGetValue(value, AX_VALUE_CF_RANGE, (&mut range as *mut CFRange).cast());
        CFRelease(value);
        (ok && range.location >= 0 && range.length >= 0).then(|| (range.location + range.length) as usize)
    }
    unsafe fn settable(element: Ref, name: &str) -> bool {
        let Ok(key) = std::ffi::CString::new(name) else { return false };
        let key = CFStringCreateWithCString(ptr::null(), key.as_ptr(), UTF8);
        let mut settable = false;
        let result = AXUIElementIsAttributeSettable(element, key, &mut settable);
        CFRelease(key);
        result == 0 && settable
    }
    pub struct Target(usize);
    /// The passage Eavesy pasted last and the field it went into: what a tone
    /// change replaces, only while it is still there exactly as pasted.
    struct LastPaste {
        field: Target,
        prefix: String,
        suffix: String,
        pasted: String,
    }
    static LAST: Mutex<Option<LastPaste>> = Mutex::new(None);
    fn last() -> std::sync::MutexGuard<'static, Option<LastPaste>> {
        LAST.lock().unwrap_or_else(|error| error.into_inner())
    }
    #[repr(C)]
    struct CFRange {
        location: isize,
        length: isize,
    }
    /// kAXValueCFRangeType
    const AX_VALUE_CF_RANGE: u32 = 4;
    /// Selects `length` UTF-16 units from `start` in `field`.
    unsafe fn select(field: Ref, start: usize, length: usize) -> Result<(), String> {
        let range = CFRange { location: start as isize, length: length as isize };
        let value = AXValueCreate(AX_VALUE_CF_RANGE, (&range as *const CFRange).cast());
        if value.is_null() {
            return Err("could not describe the selection".into());
        }
        let key = std::ffi::CString::new("AXSelectedTextRange").map_err(|e| e.to_string())?;
        let key = CFStringCreateWithCString(ptr::null(), key.as_ptr(), UTF8);
        let result = AXUIElementSetAttributeValue(field, key, value);
        CFRelease(key);
        CFRelease(value);
        if result == 0 { Ok(()) } else { Err(format!("the app refused the selection ({result})")) }
    }
    /// Swaps the passage Eavesy pasted last for `text`, when it is still in its
    /// field exactly as `previous`, that field still has the keyboard, and the
    /// app selects exactly that passage. Otherwise nothing in the app changes.
    pub fn replace(app: &AppHandle, previous: &str, text: &str) -> Result<(), String> {
        let Some(paste) = last().take() else {
            return Err("nothing pasted to replace".into());
        };
        let ready = (|| {
            if paste.pasted != super::normalize(previous) {
                return Err("the last paste was something else".to_string());
            }
            if !still_focused(&paste.field) {
                return Err("the field no longer has the keyboard".into());
            }
            let value = unsafe { field_text(paste.field.0 as Ref) }.ok_or("the field can't be read")?;
            if super::passage(&value, &paste.prefix, &paste.suffix) != Some(paste.pasted.clone()) {
                return Err("the pasted words were changed".into());
            }
            Ok(())
        })();
        if let Err(why) = ready {
            // Untouched: a later try can still replace it.
            last().get_or_insert(paste);
            return Err(why);
        }
        // The old passage is no longer watched: a rewrite is not a correction to learn.
        GENERATION.fetch_add(1, Ordering::SeqCst);
        let start = paste.prefix.encode_utf16().count();
        let length = previous.encode_utf16().count();
        if let Err(why) = unsafe { select(paste.field.0 as Ref, start, length) } {
            last().get_or_insert(paste);
            return Err(why);
        }
        if unsafe { string(paste.field.0 as Ref, "AXSelectedText") }.map(|selected| super::normalize(&selected)) != Some(paste.pasted.clone()) {
            // Whatever the app did select must not stay selected: the user's
            // next keystroke would type over it. Put the caret back after
            // the pasted words, and keep them for a later try.
            let _ = unsafe { select(paste.field.0 as Ref, start + length, 0) };
            last().get_or_insert(paste);
            return Err("the app didn't select the pasted words".into());
        }
        crate::commands::paste_text(app, text)
    }
    impl Drop for Target {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0 as Ref) }
        }
    }
    unsafe fn focused_element() -> Option<Ref> {
        let root = AXUIElementCreateSystemWide();
        // Match the existing dictation AX budget. On the system-wide element this
        // bounds this process's default; app and field elements also get explicit bounds.
        AXUIElementSetMessagingTimeout(root, 0.25);
        // Some hosts cannot resolve the system-wide focused element directly.
        // Query the focused application first, then its focused text field.
        let focused = if let Some(application) = attribute(root, "AXFocusedApplication") {
            AXUIElementSetMessagingTimeout(application, 0.25);
            let field = attribute(application, "AXFocusedUIElement");
            CFRelease(application);
            field
        } else {
            None
        };
        let focused = focused.or_else(|| attribute(root, "AXFocusedUIElement"));
        CFRelease(root);
        focused
    }
    pub fn capture() -> Option<Target> {
        unsafe {
            let field = focused_element()?;
            AXUIElementSetMessagingTimeout(field, 0.25);
            let role = string(field, "AXRole").unwrap_or_default();
            let subrole = string(field, "AXSubrole").unwrap_or_default();
            // Web pages and Electron apps type into editable groups and search
            // fields as often as text fields: any element whose text can be set
            // counts. An empty field may have no text to read until the paste lands.
            let text_role = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(&role.as_str());
            if subrole == "AXSecureTextField" || !(text_role || settable(field, "AXValue")) {
                CFRelease(field);
                return None;
            }
            Some(Target(field as usize))
        }
    }
    fn still_focused(target: &Target) -> bool {
        focus(target) == Some(true)
    }
    /// Whether `target` has the keyboard, or None when the focused element
    /// can't be found right now (an AX timeout), which says nothing either way.
    fn focus(target: &Target) -> Option<bool> {
        // AXUIElement equality is defined by CFEqual, not pointer identity.
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFEqual(a: Ref, b: Ref) -> bool;
        }
        unsafe {
            let focused = focused_element()?;
            let equal = CFEqual(focused, target.0 as Ref);
            CFRelease(focused);
            Some(equal)
        }
    }
    /// A new paste is about to land: the passage watched until now is as the
    /// user left it. Call before pressing ⌘V, so its last read can't take in
    /// the new words.
    pub fn superseded() {
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
    pub fn observe(app: AppHandle, target: Option<Target>, pasted: String) {
        let feedback_app = app.clone();
        observe_with(
            target,
            pasted,
            move |original, corrected| {
                crate::learning::feedback(&feedback_app, original, corrected)
            },
            move |value| crate::learning::notify(&app, value),
        );
    }
    /// How long a paste-landing read keeps trying: slow web views take a moment.
    const LANDING: Duration = Duration::from_secs(2);
    /// How often the passage is read, so its last reading is never far behind the user.
    const POLL: Duration = Duration::from_millis(250);
    /// How long a passage is watched while its field keeps the keyboard.
    const WATCH: Duration = Duration::from_secs(180);
    fn observe_with(
        target: Option<Target>,
        pasted: String,
        feedback: impl Fn(&str, &str) -> Result<serde_json::Value, String> + Send + 'static,
        notify: impl Fn(serde_json::Value) + Send + 'static,
    ) -> Option<std::thread::JoinHandle<()>> {
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        *last() = None;
        let Some(target) = target else {
            tracing::info!("paste learning: the focused element takes no text");
            notify(
                json!({"status":"unsupported", "message":"This field does not expose corrections. Use Edit transcript in Eavesy."}),
            );
            return None;
        };
        let pasted = super::normalize(&pasted);
        Some(std::thread::spawn(move || {
            let field = target.0 as Ref;
            let landing = std::time::Instant::now() + LANDING;
            let mut watch = loop {
                std::thread::sleep(Duration::from_millis(150));
                let value = unsafe { field_text(field) };
                let caret = unsafe { caret(field) };
                // Past the deadline the caret is no longer trusted to sit at the paste's end.
                let late = std::time::Instant::now() >= landing;
                if let Some(watch) = value.as_deref().and_then(|value| super::Watch::start(value, &pasted, if late { None } else { caret })) {
                    break watch;
                }
                if late {
                    tracing::info!(readable = value.is_some(), "paste learning: the pasted words weren't found in the field");
                    return;
                }
            };
            if GENERATION.load(Ordering::SeqCst) == generation {
                let field = Target(unsafe { CFRetain(field) } as usize);
                let (prefix, suffix) = watch.anchors();
                *last() = Some(LastPaste { field, prefix, suffix, pasted: pasted.clone() });
            }
            notify(json!({"status":"watching"}));
            // Read often, and learn from the passage as last read once the user is
            // done with it: they left the field, sent or cleared it, dictated
            // again, or time ran out. Sending is the surest sign the words are final.
            let deadline = std::time::Instant::now() + WATCH;
            let ended = loop {
                std::thread::sleep(POLL);
                if GENERATION.load(Ordering::SeqCst) != generation {
                    break "superseded";
                }
                // Only another element taking the keyboard means the user left;
                // a lookup that fails keeps watching.
                if focus(&target) == Some(false) {
                    // What it holds now, including a fix typed at the last moment, is final.
                    if let Some(value) = unsafe { field_text(field) } {
                        watch.follow(&value, None);
                    }
                    break "left";
                }
                let Some(value) = (unsafe { field_text(field) }) else {
                    break "unreadable";
                };
                if !watch.follow(&value, unsafe { caret(field) }) {
                    break "gone";
                }
                if std::time::Instant::now() >= deadline {
                    break "timed_out";
                }
            };
            let settled = watch.last;
            let changed = settled != pasted;
            tracing::info!(ended, changed, "paste learning: done watching");
            if !changed || settled.trim().is_empty() || settled.encode_utf16().count() > 12_000 {
                return;
            }
            match feedback(&pasted, &settled) {
                Ok(result) => {
                    tracing::info!(learned = result["learned"].as_u64().unwrap_or(0), "paste learning: correction sent");
                    notify(json!({"status":"saved", "learned":result["learned"], "words":result["words"]}))
                }
                Err(error) => {
                    tracing::warn!("paste learning: correction not saved ({error})");
                    notify(
                        json!({"status":"failed", "message":"Could not save correction. Use Edit transcript in Eavesy to retry."}),
                    )
                }
            }
        }))
    }

    /// Run explicitly with a disposable focused TextEdit document and the local test API.
    #[cfg(test)]
    #[test]
    #[ignore = "requires a focused scratch TextEdit field, Accessibility, and the local dictionary harness"]
    fn native_external_correction_e2e() {
        assert!(
            unsafe { AXIsProcessTrusted() },
            "The native test binary needs macOS Accessibility permission"
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(180);
        let target = loop {
            if let Some(target) = capture() {
                if unsafe { string(target.0 as Ref, "AXValue") }.as_deref()
                    == Some("Existing. Open a pool request. After.")
                {
                    break target;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Focus the exact scratch TextEdit fixture before running this test"
            );
            std::thread::sleep(Duration::from_millis(250));
        };
        let base = std::env::var("EAVESY_NATIVE_TEST_BASE").expect("local test base");
        assert!(base.starts_with("http://localhost:"));
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::env::var("EAVESY_NATIVE_TEST_CLIENT").expect("test client file"),
            )
            .unwrap(),
        )
        .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = observe_with(
            Some(target),
            "Open a pool request.".into(),
            move |original, corrected| {
                assert_eq!(original, "Open a pool request.");
                assert_eq!(corrected, "Open a pull request.");
                let response = reqwest::blocking::Client::new()
                    .post(format!("{base}/api/dictionary"))
                    .bearer_auth(config["token"].as_str().unwrap())
                    .json(&json!({"original":original,"corrected":corrected}))
                    .send()
                    .map_err(|e| e.to_string())?
                    .error_for_status()
                    .map_err(|e| e.to_string())?;
                let value: serde_json::Value = response.json().map_err(|e| e.to_string())?;
                tx.send(value.clone()).unwrap();
                Ok(value)
            },
            |status| {
                if status["status"] == "watching" {
                    println!("OBSERVER_READY: correct pool to pull in TextEdit");
                }
            },
        )
        .unwrap();
        let result = rx.recv_timeout(Duration::from_secs(120));
        GENERATION.fetch_add(1, Ordering::SeqCst);
        handle.join().unwrap();
        assert!(
            result.expect("No correction observed")["learned"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
}

/// Text as fields hand it back after a paste: web views turn spaces into
/// non-breaking ones and many apps curl quotes as they go in. Each swap keeps
/// one UTF-16 unit for one, so offsets in the field still line up.
pub fn normalize(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\u{a0}' | '\u{202f}' => ' ',
            '\u{2018}' | '\u{2019}' => '\'',
            '\u{201c}' | '\u{201d}' => '"',
            c => c,
        })
        .collect()
}

/// The pasted passage followed through its field's text as the user edits it.
pub struct Watch {
    prefix: String,
    suffix: String,
    /// The passage as last read.
    pub last: String,
}

impl Watch {
    /// Finds the words just pasted. With the caret known, only where it sits
    /// right after them: an earlier copy of the same words is never them.
    pub fn start(value: &str, pasted: &str, caret: Option<usize>) -> Option<Watch> {
        let (prefix, suffix) = anchors(value, pasted, |_, end| caret.is_none_or(|caret| caret == end))?;
        let end = prefix.encode_utf16().count() + pasted.encode_utf16().count();
        caret.is_none_or(|caret| caret == end).then(|| Watch { prefix, suffix, last: pasted.to_string() })
    }

    pub fn anchors(&self) -> (String, String) {
        (self.prefix.clone(), self.suffix.clone())
    }

    /// Follows the passage into the field's current text. False once it can't
    /// be found: the field was sent or cleared, or rewritten around it.
    pub fn follow(&mut self, value: &str, caret: Option<usize>) -> bool {
        // An empty field still splits around empty anchors: that is the
        // passage gone, not the user deleting it word by word.
        let found = passage(value, &self.prefix, &self.suffix).filter(|found| !found.trim().is_empty());
        if let Some(found) = found {
            self.last = found;
            return true;
        }
        // Text typed before or after it moved the anchors: find it as last read,
        // where the caret is when it appears more than once.
        let Some((prefix, suffix)) = anchors(value, &self.last, |start, end| caret.is_some_and(|caret| (start..=end).contains(&caret))) else {
            return false;
        };
        self.prefix = prefix;
        self.suffix = suffix;
        true
    }
}

/// The text before and after `pasted` in `value`: its only occurrence, or
/// the only one `near` picks by its UTF-16 span.
fn anchors(value: &str, pasted: &str, near: impl Fn(usize, usize) -> bool) -> Option<(String, String)> {
    if pasted.is_empty() {
        return None;
    }
    let found: Vec<usize> = value.match_indices(pasted).map(|(start, _)| start).collect();
    let span = |start: usize| {
        let from = value[..start].encode_utf16().count();
        (from, from + pasted.encode_utf16().count())
    };
    let picked: Vec<usize> = found.iter().copied().filter(|&start| { let (from, to) = span(start); near(from, to) }).collect();
    let start = match (found.as_slice(), picked.as_slice()) {
        (_, [only]) => *only,
        ([only], []) => *only,
        _ => return None,
    };
    Some((value[..start].into(), value[start + pasted.len()..].into()))
}
pub fn passage(value: &str, prefix: &str, suffix: &str) -> Option<String> {
    let middle = value.strip_prefix(prefix)?.strip_suffix(suffix)?;
    Some(middle.into())
}
#[cfg(target_os = "macos")]
pub use mac::{capture, observe, replace, superseded};
#[cfg(not(target_os = "macos"))]
pub fn replace(_app: &tauri::AppHandle, _previous: &str, _text: &str) -> Result<(), String> {
    Err("replacing pasted words is only supported on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolates_only_the_pasted_passage() {
        let mut watch = Watch::start("Existing. pool request. After.", "pool request.", None).unwrap();
        assert!(watch.follow("Existing. pull request. After.", None));
        assert_eq!(watch.last, "pull request.");
        assert!(Watch::start("same same", "same", None).is_none());
    }

    #[test]
    fn web_view_spaces_and_curled_quotes_still_match() {
        let value = normalize("Hi\u{a0}there, it\u{2019}s Repackify");
        assert!(Watch::start(&value, &normalize("there, it's Repackify"), None).is_some());
        assert_eq!(normalize("a\u{a0}b\u{201c}c\u{201d}").encode_utf16().count(), "a\u{a0}b\u{201c}c\u{201d}".encode_utf16().count());
    }

    #[test]
    fn the_caret_picks_the_copy_just_pasted() {
        let watch = Watch::start("Thanks. Thanks.", "Thanks.", Some(15)).unwrap();
        assert_eq!(watch.anchors(), ("Thanks. ".to_string(), String::new()));
        // Not landed yet: the only copy sits before the caret's end.
        assert!(Watch::start("Thanks. More", "Thanks.", Some(12)).is_none());
    }

    #[test]
    fn a_sent_or_cleared_field_keeps_the_last_reading() {
        let mut watch = Watch::start("Ship it to repack if I", "Ship it to repack if I", None).unwrap();
        assert!(watch.follow("Ship it to Repackify", None));
        assert!(!watch.follow("", None));
        assert!(!watch.follow("\n", None));
        assert_eq!(watch.last, "Ship it to Repackify");
    }

    #[test]
    fn typing_around_the_passage_keeps_following_it() {
        let mut watch = Watch::start("Note: send to pack if I. Bye", "send to pack if I.", None).unwrap();
        assert!(watch.follow("Quick note: send to pack if I. Bye", None));
        assert!(watch.follow("Quick note: send to Repackify. Bye", None));
        assert_eq!(watch.last, "send to Repackify.");
        assert!(watch.follow("Quick note: send to Repackify. Bye now", None));
        assert!(watch.follow("Quick note: send to Repackify today. Bye now", None));
        assert_eq!(watch.last, "send to Repackify today.");
    }

    #[test]
    fn a_rewritten_field_ends_the_watch() {
        let mut watch = Watch::start("Hello there. Bye", "there.", None).unwrap();
        assert!(!watch.follow("Something else entirely", None));
        assert_eq!(watch.last, "there.");
    }
}
