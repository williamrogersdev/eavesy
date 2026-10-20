//! Observe only the original AX text field and only the passage Eavesy pasted.
//! No key logger, global field polling or secure-field reads.
#[cfg(target_os = "macos")]
mod mac {
    use serde_json::json;
    use std::{
        ffi::{c_char, c_void},
        ptr,
        sync::atomic::{AtomicU64, Ordering},
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
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: Ref);
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
        // AXUIElement equality is defined by CFEqual, not pointer identity.
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFEqual(a: Ref, b: Ref) -> bool;
        }
        unsafe {
            let focused = focused_element();
            focused.is_some_and(|f| {
                let equal = CFEqual(f, target.0 as Ref);
                CFRelease(f);
                equal
            })
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
            notify(json!({"status":"watching"}));
            let mut baseline = pasted.clone();
            let mut candidate = pasted;
            let mut stable = 0;
            for _ in 0..120 {
                std::thread::sleep(Duration::from_millis(500));
                if GENERATION.load(Ordering::SeqCst) != generation || !still_focused(&target) {
                    break;
                }
                let Some(value) = (unsafe { string(target.0 as Ref, "AXValue") }) else {
                    break;
                };
                let Some(current) = super::passage(&value, &prefix, &suffix) else {
                    break;
                };
                if current == candidate {
                    stable += 1;
                } else {
                    candidate = current;
                    stable = 0;
                }
                if stable < 4
                    || candidate == baseline
                    || candidate.trim().is_empty()
                    || candidate.encode_utf16().count() > 12_000
                {
                    continue;
                }
                match feedback(&baseline, &candidate) {
                    Ok(result) => {
                        baseline = candidate.clone();
                        notify(json!({"status":"saved", "learned":result["learned"]}));
                    }
                    Err(_) => {
                        notify(
                            json!({"status":"failed", "message":"Could not save correction. Use Edit transcript in Eavesy to retry."}),
                        );
                        break;
                    }
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
pub use mac::{capture, observe};

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
