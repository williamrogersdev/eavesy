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
            if paste.pasted != previous {
                return Err("the last paste was something else".to_string());
            }
            if !still_focused(&paste.field) {
                return Err("the field no longer has the keyboard".into());
            }
            let value = unsafe { string(paste.field.0 as Ref, "AXValue") }.ok_or("the field can't be read")?;
            if super::passage(&value, &paste.prefix, &paste.suffix).as_deref() != Some(previous) {
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
        if unsafe { string(paste.field.0 as Ref, "AXSelectedText") }.as_deref() != Some(previous) {
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
            if !["AXTextField", "AXTextArea", "AXComboBox"].contains(&role.as_str())
                || subrole == "AXSecureTextField"
            {
                CFRelease(field);
                return None;
            }
            let target = Target(field as usize);
            string(field, "AXValue")?;
            Some(target)
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
    fn observe_with(
        target: Option<Target>,
        pasted: String,
        feedback: impl Fn(&str, &str) -> Result<serde_json::Value, String> + Send + 'static,
        notify: impl Fn(serde_json::Value) + Send + 'static,
    ) -> Option<std::thread::JoinHandle<()>> {
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        *last() = None;
        let Some(target) = target else {
            notify(
                json!({"status":"unsupported", "message":"This field does not expose corrections. Use Edit transcript in Eavesy."}),
            );
            return None;
        };
        Some(std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            let Some(initial) = (unsafe { string(target.0 as Ref, "AXValue") }) else {
                return;
            };
            let Some((prefix, suffix)) = super::anchors(&initial, &pasted) else {
                return;
            };
            if GENERATION.load(Ordering::SeqCst) == generation {
                let field = Target(unsafe { CFRetain(target.0 as Ref) } as usize);
                *last() = Some(LastPaste { field, prefix: prefix.clone(), suffix: suffix.clone(), pasted: pasted.clone() });
            }
            notify(json!({"status":"watching"}));
            // Only the passage as the user leaves it is learned: a word half typed
            // or mistyped and fixed a moment later must never become a rule.
            let read = || unsafe { string(target.0 as Ref, "AXValue") }.and_then(|value| super::passage(&value, &prefix, &suffix));
            let mut previous = pasted.clone();
            let mut last_read = pasted.clone();
            let mut left_field = false;
            for _ in 0..120 {
                std::thread::sleep(Duration::from_millis(500));
                if GENERATION.load(Ordering::SeqCst) != generation {
                    // A new dictation took over the watch: this one's edit is not known to be finished.
                    return;
                }
                // Only another element taking the keyboard means the user left;
                // a lookup that fails keeps watching.
                if focus(&target) == Some(false) {
                    left_field = true;
                    break;
                }
                let Some(current) = read() else {
                    break;
                };
                previous = std::mem::replace(&mut last_read, current);
            }
            let settled = if left_field {
                // The user moved on, so the field can't change under them any more:
                // what it holds now, including a fix typed at the last moment, is final.
                match read() {
                    Some(text) => text,
                    None => return,
                }
            } else if last_read == previous {
                // Still in the field (time ran out, or text around the passage changed):
                // only text that held still across the last two reads.
                last_read
            } else {
                return;
            };
            if settled == pasted || settled.trim().is_empty() || settled.encode_utf16().count() > 12_000 {
                return;
            }
            match feedback(&pasted, &settled) {
                Ok(result) => notify(json!({"status":"saved", "learned":result["learned"], "words":result["words"]})),
                Err(_) => notify(
                    json!({"status":"failed", "message":"Could not save correction. Use Edit transcript in Eavesy to retry."}),
                ),
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

pub fn anchors(value: &str, pasted: &str) -> Option<(String, String)> {
    if pasted.is_empty() {
        return None;
    }
    let mut matches = value.match_indices(pasted);
    let (start, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some((value[..start].into(), value[start + pasted.len()..].into()))
}
pub fn passage(value: &str, prefix: &str, suffix: &str) -> Option<String> {
    let middle = value.strip_prefix(prefix)?.strip_suffix(suffix)?;
    Some(middle.into())
}
#[cfg(target_os = "macos")]
pub use mac::{capture, observe, replace};
#[cfg(not(target_os = "macos"))]
pub fn replace(_app: &tauri::AppHandle, _previous: &str, _text: &str) -> Result<(), String> {
    Err("replacing pasted words is only supported on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolates_only_the_pasted_passage() {
        let (prefix, suffix) = anchors("Existing. pool request. After.", "pool request.").unwrap();
        assert_eq!(
            passage("Existing. pull request. After.", &prefix, &suffix).as_deref(),
            Some("pull request.")
        );
        assert_eq!(
            passage("Changed. pull request. After.", &prefix, &suffix),
            None
        );
        assert_eq!(anchors("same same", "same"), None);
    }
}
