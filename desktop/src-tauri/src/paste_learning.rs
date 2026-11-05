//! Observe only the original AX text field and only the passage Eavesy pasted.
//! No key logger, global field polling or secure-field reads.
#[cfg(target_os = "macos")]
mod mac {
    use serde_json::json;
    use std::{
        ffi::{c_char, c_void},
        ptr,
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
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
        fn AXUIElementCreateApplication(pid: i32) -> Ref;
        fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
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
    /// Selects `length` units from `start` and waits for the app to report
    /// exactly that range holding `expected`: Chrome applies a selection a
    /// moment after accepting it, so an immediate read returns the old one.
    unsafe fn select_exactly(field: Ref, start: usize, length: usize, expected: &str) -> Result<bool, String> {
        select(field, start, length)?;
        let give_up = std::time::Instant::now() + SELECTION_SETTLES;
        loop {
            let range = selection(field);
            let selected = string(field, "AXSelectedText").map(|s| super::normalize(&s));
            if range == Some((start, length)) && selected.as_deref() == Some(expected) {
                return Ok(true);
            }
            if std::time::Instant::now() >= give_up {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    const SELECTION_SETTLES: Duration = Duration::from_millis(400);
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
        let selected = match unsafe { select_exactly(paste.field.0 as Ref, start, length, &paste.pasted) } {
            Ok(selected) => selected,
            Err(why) => {
                last().get_or_insert(paste);
                return Err(why);
            }
        };
        if !selected {
            // Whatever the app did select must not stay selected: the user's
            // next keystroke would type over it. Put the caret back after
            // the pasted words, and keep them for a later try.
            let _ = unsafe { select(paste.field.0 as Ref, start + length, 0) };
            last().get_or_insert(paste);
            return Err("the app didn't select the pasted words".into());
        }
        crate::commands::paste_text(app, text)
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state: i32) -> Ref;
        fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
        fn CGEventSetFlags(event: Ref, flags: u64);
        fn CGEventKeyboardSetUnicodeString(event: Ref, length: usize, string: *const u16);
        fn CGEventPost(tap: u32, event: Ref);
    }
    /// kVK_Delete: backspace, which deletes the selection.
    const KEY_DELETE: u16 = 51;
    /// The most UTF-16 units one key event carries.
    const UNITS_PER_EVENT: usize = 20;
    /// How long typed words get to show up in the field before typing gives up.
    const TYPED_LANDING: Duration = Duration::from_millis(800);

    /// Presses `key` once, with no modifiers (a held `fn` must not ride
    /// along), carrying `units` as the characters it types when given.
    fn press(key: u16, units: Option<&[u16]>) -> Result<(), String> {
        unsafe {
            let source = CGEventSourceCreate(1);
            let result = (|| {
                for down in [true, false] {
                    let event = CGEventCreateKeyboardEvent(source, key, down);
                    if event.is_null() {
                        return Err("could not create the key press".to_string());
                    }
                    CGEventSetFlags(event, 0);
                    if let Some(units) = units {
                        CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr());
                    }
                    CGEventPost(0, event);
                    CFRelease(event);
                }
                Ok(())
            })();
            if !source.is_null() {
                CFRelease(source);
            }
            result
        }
    }
    /// Types `text` at the caret as key presses: no clipboard involved.
    /// Before every press it checks that `stop` isn't set and `field` still
    /// has the keyboard, and stops otherwise.
    fn type_text(text: &str, stop: &AtomicBool, field: &Target) -> Result<(), String> {
        for chunk in super::utf16_chunks(text, UNITS_PER_EVENT) {
            if stop.load(Ordering::SeqCst) {
                return Err("typing was stopped".into());
            }
            if focus(field) != Some(true) {
                return Err("the field lost the keyboard while typing".into());
            }
            press(0, Some(&chunk))?;
        }
        Ok(())
    }
    /// The selection as (start, length) in UTF-16 units.
    unsafe fn selection(element: Ref) -> Option<(usize, usize)> {
        let value = attribute(element, "AXSelectedTextRange")?;
        let mut range = CFRange { location: 0, length: 0 };
        let ok = AXValueGetValue(value, AX_VALUE_CF_RANGE, (&mut range as *mut CFRange).cast());
        CFRelease(value);
        (ok && range.location >= 0 && range.length >= 0).then_some((range.location as usize, range.length as usize))
    }

    /// The words a dictation has typed into one field while it runs ("Type as
    /// I talk"): the field, the text around them, and the words as they read
    /// there. Typing only goes on while they are still exactly that, the field
    /// has the keyboard and the caret sits right after them.
    pub struct LiveField {
        field: Target,
        prefix: String,
        suffix: String,
        typed: String,
        /// The field's text couldn't be read after keys went in: the typed
        /// words aren't known any more.
        lost: bool,
    }
    /// How long `LiveField::focused` waits for a field to become readable.
    const FIELD_APPEARS: Duration = Duration::from_millis(1500);
    impl LiveField {
        /// The focused field, when it is text Eavesy can read back: words go
        /// in where its caret is, over whatever is selected, as a paste would.
        pub fn focused() -> Option<LiveField> {
            // An app asked to expose its text fields only now (see
            // `expose_text_fields`) takes a moment to build them.
            let give_up = std::time::Instant::now() + FIELD_APPEARS;
            let target = loop {
                if let Some(target) = capture() {
                    break target;
                }
                if std::time::Instant::now() >= give_up {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            let field = target.0 as Ref;
            let value = unsafe { field_text(field) }?;
            let (start, length) = unsafe { selection(field) }?;
            let (prefix, rest) = super::split_utf16(&value, start)?;
            let (_, suffix) = super::split_utf16(rest, length)?;
            let (prefix, suffix) = (prefix.to_string(), suffix.to_string());
            Some(LiveField { field: target, prefix, suffix, typed: String::new(), lost: false })
        }

        /// Whether any words went in, counting ones that may have but
        /// can't be read back.
        pub fn has_typed(&self) -> bool {
            self.lost || !self.typed.is_empty()
        }

        /// Ok(false) while another element has the keyboard; an error once
        /// the typed words were changed or the caret was moved off them.
        fn check(&self) -> Result<bool, String> {
            if focus(&self.field) != Some(true) {
                return Ok(false);
            }
            let field = self.field.0 as Ref;
            let value = unsafe { field_text(field) }.ok_or("the field can't be read")?;
            if super::passage(&value, &self.prefix, &self.suffix).as_deref() != Some(self.typed.as_str()) {
                return Err("the typed words were changed".into());
            }
            let end = super::units(&self.prefix) + super::units(&self.typed);
            if unsafe { selection(field) } != Some((end, 0)) {
                return Err("the caret moved".into());
            }
            Ok(true)
        }

        /// Makes the typed words read `text`: types what's new after them, and
        /// retypes only from where a revised word differs. Ok(false) when the
        /// field doesn't have the keyboard right now (try again later); an
        /// error means stop typing into it. No key is posted once `stop` is
        /// set.
        ///
        /// Focus is checked right before the keys are posted, but macOS has
        /// no way to post a key press to one element only: should focus move
        /// in the instant between, the keys follow it. The next sync then
        /// finds the words changed and stops for good.
        pub fn sync(&mut self, text: &str, stop: &AtomicBool) -> Result<bool, String> {
            let text = super::typeable(text);
            if text == self.typed {
                return Ok(true);
            }
            if !self.check()? {
                return Ok(false);
            }
            let field = self.field.0 as Ref;
            let start = super::units(&self.prefix);
            let keep = super::shared_prefix(&self.typed, &text);
            if keep < self.typed.len() {
                let from = start + super::units(&self.typed[..keep]);
                let length = super::units(&self.typed[keep..]);
                // Both the range and its text: the key press below replaces
                // exactly what is selected, and nothing else may go with it.
                if !unsafe { select_exactly(field, from, length, &self.typed[keep..])? } {
                    // Never leave words selected: the user's next key would replace them.
                    let _ = unsafe { select(field, start + super::units(&self.typed), 0) };
                    return Err("the app didn't select the words to retype".into());
                }
            }
            if self.typed.is_empty() {
                // The previous dictation's paste, which paste learning may
                // still be watching in this field, is as the user left it:
                // end that watch now, so its last reading can't take in the
                // words about to be typed beside it (as `paste_text` does
                // before its ⌘V).
                superseded();
            }
            // Key presses go to whatever has the keyboard: make sure it is
            // still this field right before they are posted.
            if stop.load(Ordering::SeqCst) || focus(&self.field) != Some(true) {
                if keep < self.typed.len() {
                    let _ = unsafe { select(field, start + super::units(&self.typed), 0) };
                }
                return Ok(false);
            }
            let posted = match &text[keep..] {
                // The selection is exactly the words to drop: one delete removes them all.
                "" => press(KEY_DELETE, None),
                insert => type_text(insert, stop, &self.field),
            };
            // From here keys may have landed, all, some or none, whether the
            // posting finished or stopped part way: whatever happens next,
            // the typed words follow what is in the field, so the end can
            // still replace them.
            let landing = std::time::Instant::now() + if posted.is_ok() { TYPED_LANDING } else { Duration::from_millis(150) };
            let mut found = None;
            loop {
                std::thread::sleep(Duration::from_millis(30));
                if let Some(now) = unsafe { field_text(field) }.and_then(|value| super::passage(&value, &self.prefix, &self.suffix)) {
                    if posted.is_ok() && now == text {
                        self.typed = text;
                        return Ok(true);
                    }
                    found = Some(now);
                }
                if std::time::Instant::now() >= landing {
                    break;
                }
            }
            match found {
                Some(found) => self.typed = found,
                // Unreadable now: what's there isn't known, so the end must
                // not replace anything (`finish` copies instead).
                None => self.lost = true,
            }
            Err(posted.err().unwrap_or_else(|| "the app didn't take the typed words".into()))
        }

        /// Selects the typed words, so the next paste or delete replaces
        /// exactly them. It only selects: when it fails, nothing in the field
        /// changed (whatever it did select is put back to a caret).
        pub fn select_typed(&self) -> Result<(), String> {
            if self.lost {
                return Err("the typed words couldn't be read back".into());
            }
            if self.typed.is_empty() {
                return Err("nothing was typed".into());
            }
            if !self.check()? {
                return Err("the field no longer has the keyboard".into());
            }
            let field = self.field.0 as Ref;
            let start = super::units(&self.prefix);
            let length = super::units(&self.typed);
            if !unsafe { select_exactly(field, start, length, &self.typed)? } {
                let _ = unsafe { select(field, start + length, 0) };
                return Err("the app didn't select the typed words".into());
            }
            Ok(())
        }

        /// Deletes the typed words, while they are still exactly as typed.
        pub fn take_back(self) -> Result<(), String> {
            self.select_typed()?;
            press(KEY_DELETE, None)
        }
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
        // Electron apps with a long page (Claude, Slack) can miss the timeout
        // for the focused application: then ask the frontmost app, read from
        // NSWorkspace, as delivery does.
        let application = attribute(root, "AXFocusedApplication").or_else(|| {
            let (pid, _) = crate::app_menu::frontmost()?;
            let application = AXUIElementCreateApplication(pid);
            (!application.is_null()).then_some(application)
        });
        let focused = if let Some(application) = application {
            AXUIElementSetMessagingTimeout(application, 0.25);
            let mut pid = 0;
            if AXUIElementGetPid(application, &mut pid) == 0 {
                crate::dictation::expose_text_fields(application, pid);
            }
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
            // and that has a caret counts (a slider's value is settable too).
            // An empty field may have no text to read until the paste lands.
            let text_role = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(&role.as_str());
            if subrole == "AXSecureTextField" || !(text_role || (settable(field, "AXValue") && caret(field).is_some())) {
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
                // A paste that landed during the read may be in it: keep the reading before.
                if GENERATION.load(Ordering::SeqCst) != generation {
                    break "superseded";
                }
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

    /// Run explicitly with an empty text box focused (a ProseMirror editor in
    /// Chrome reproduces Claude's message box), from a binary with
    /// Accessibility: live typing types, revises, and selects its words.
    #[cfg(test)]
    #[test]
    #[ignore = "requires a focused empty text field and Accessibility"]
    fn live_typing_e2e() {
        assert!(unsafe { AXIsProcessTrusted() }, "needs Accessibility");
        let stop = AtomicBool::new(false);
        let mut live = LiveField::focused().expect("a readable focused field");
        for text in ["Hello", "Hello there friend", "Hello their friends, how", "Hello there friends, how are you?"] {
            assert_eq!(live.sync(text, &stop), Ok(true), "typing {text:?}");
            assert_eq!(live.typed, text);
        }
        live.select_typed().expect("selects the typed words");
        press(KEY_DELETE, None).unwrap();
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
/// The text between `prefix` and `suffix` in `value`. Rich text editors
/// (ProseMirror, as in Claude's message box) read back an empty paragraph as
/// a lone newline and drop it once there is text, or add one back when the
/// text goes: a field's last newline may come and go.
pub fn passage(value: &str, prefix: &str, suffix: &str) -> Option<String> {
    let rest = value.strip_prefix(prefix)?;
    let middle = rest
        .strip_suffix(suffix)
        .or_else(|| rest.strip_suffix(suffix.strip_suffix('\n')?))
        .or_else(|| rest.strip_suffix('\n')?.strip_suffix(suffix))?;
    Some(middle.into())
}
/// Text as live typing puts it in a field: as fields hand it back
/// (`normalize`), on one line. A typed newline is a Return key press, which
/// sends a chat message.
pub fn typeable(text: &str) -> String {
    normalize(text).chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// Bytes `a` and `b` share from the start, ending on a character boundary.
pub fn shared_prefix(a: &str, b: &str) -> usize {
    a.char_indices()
        .zip(b.chars())
        .take_while(|((_, x), y)| x == y)
        .last()
        .map_or(0, |((at, c), _)| at + c.len_utf8())
}

/// Length in UTF-16 units, the way fields count their text.
pub fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `value` split `at` UTF-16 units in, or None when that falls inside a
/// character or past the end.
pub fn split_utf16(value: &str, at: usize) -> Option<(&str, &str)> {
    let mut seen = 0;
    for (index, c) in value.char_indices() {
        if seen == at {
            return Some(value.split_at(index));
        }
        if seen > at {
            return None;
        }
        seen += c.len_utf16();
    }
    (seen == at).then_some((value, ""))
}

/// `text` as UTF-16, in pieces of at most `max` units that never split a
/// surrogate pair.
pub fn utf16_chunks(text: &str, max: usize) -> Vec<Vec<u16>> {
    let mut chunks: Vec<Vec<u16>> = Vec::new();
    let mut buffer = [0u16; 2];
    for c in text.chars() {
        let encoded = c.encode_utf16(&mut buffer);
        match chunks.last_mut() {
            Some(chunk) if chunk.len() + encoded.len() <= max => chunk.extend_from_slice(encoded),
            _ => chunks.push(encoded.to_vec()),
        }
    }
    chunks
}

#[cfg(target_os = "macos")]
pub use mac::{capture, observe, replace, superseded, LiveField};
#[cfg(not(target_os = "macos"))]
pub fn replace(_app: &tauri::AppHandle, _previous: &str, _text: &str) -> Result<(), String> {
    Err("replacing pasted words is only supported on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_field_s_last_newline_may_come_and_go() {
        // An empty ProseMirror field reads "\n"; typed into, it drops it.
        assert_eq!(passage("Hello\u{a0}", "", "\n").as_deref(), Some("Hello\u{a0}"));
        assert_eq!(passage("Hello\n", "", "\n").as_deref(), Some("Hello"));
        assert_eq!(passage("Say Hello there", "Say ", "").as_deref(), Some("Hello there"));
        // Only a last newline is forgiven.
        assert_eq!(passage("Hello", "", "\nmore"), None);
        assert_eq!(passage("Hello\n\n", "", "").as_deref(), Some("Hello\n\n"));
    }

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
        assert_eq!(normalize("a\u{a0}b\u{201c}c\u{201d} \u{2018}d\u{2019}"), "a b\"c\" 'd'");
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

    #[test]
    fn live_typing_text_stays_on_one_line() {
        assert_eq!(typeable("It\u{2019}s fine\nsend it"), "It's fine send it");
    }

    #[test]
    fn retyping_starts_where_the_words_differ() {
        assert_eq!(shared_prefix("ship the deck", "ship the desk today"), 11);
        assert_eq!(shared_prefix("", "hi"), 0);
        assert_eq!(shared_prefix("café au", "café ok"), 6);
        assert_eq!(shared_prefix("same", "same"), 4);
    }

    #[test]
    fn utf16_offsets_split_on_characters_only() {
        assert_eq!(split_utf16("a😀b", 1), Some(("a", "😀b")));
        assert_eq!(split_utf16("a😀b", 3), Some(("a😀", "b")));
        assert_eq!(split_utf16("a😀b", 2), None);
        assert_eq!(split_utf16("ab", 2), Some(("ab", "")));
        assert_eq!(split_utf16("ab", 3), None);
        assert_eq!(units("a😀"), 3);
    }

    #[test]
    fn key_events_never_split_a_surrogate_pair() {
        let chunks = utf16_chunks("abc😀d", 4);
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![3, 3]);
        assert_eq!(String::from_utf16(&chunks.concat()).unwrap(), "abc😀d");
    }
}
