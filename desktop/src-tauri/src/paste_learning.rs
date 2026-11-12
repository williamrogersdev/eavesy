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
        let expected = super::normalize(expected);
        let give_up = std::time::Instant::now() + SELECTION_SETTLES;
        while std::time::Instant::now() < give_up {
            std::thread::sleep(Duration::from_millis(20));
            if selection(field) == Some((start, length))
                && string(field, "AXSelectedText").map(|s| super::normalize(&s)).as_deref() == Some(expected.as_str())
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// `select_exactly`, asked a second time when the first didn't take:
    /// Electron apps with a long page now and then drop a selection they
    /// accepted. Only the selection changes, so asking again is safe.
    unsafe fn select_surely(field: Ref, start: usize, length: usize, expected: &str) -> Result<bool, String> {
        Ok(select_exactly(field, start, length, expected)? || select_exactly(field, start, length, expected)?)
    }
    /// Puts the caret at `at`, waiting for the app to apply it, so a selection
    /// that landed late can't stay for the user's next key to type over.
    unsafe fn put_caret(field: Ref, at: usize) {
        for _ in 0..2 {
            if select_exactly(field, at, 0, "") == Ok(true) {
                return;
            }
        }
        tracing::warn!("the app didn't put the caret back after the words");
    }
    /// How long a selection gets to apply: each read is bounded by the 0.25 s
    /// messaging timeout, so the wait can run that much over.
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
            unsafe { put_caret(paste.field.0 as Ref, start + length) };
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
    /// I talk"): the field, the text around them, the words as they read
    /// there, and what they will read once every key posted has landed.
    ///
    /// The words between `prefix` and `suffix` are the dictation's, whoever
    /// wrote them: when the user fixes some of them, their version stands,
    /// and the words heard afterwards go in after it once they pause. Leaving
    /// the field pauses typing; coming back, the caret goes back after the
    /// words once the user is still.
    pub struct LiveField {
        field: Target,
        /// The app the field is in: a field found again after the user left
        /// must be in it.
        pid: i32,
        prefix: String,
        suffix: String,
        typed: String,
        /// The text that was selected where the words go, which they replace.
        original: String,
        /// What the field reads once the keys posted last have all landed. A
        /// busy app (Claude or Slack with a long page) can take seconds to
        /// take them in: until it reads this, no more keys are posted.
        posted: String,
        /// The field's text couldn't be read after keys went in: the typed
        /// words aren't known any more.
        lost: bool,
        /// Heard words already aimed at the field: the ones the user has
        /// seen and may have fixed.
        consumed: usize,
        /// The user changed the words: their version, and how many heard
        /// words it stands for.
        edit: Option<(String, usize)>,
        /// The words and selection last read, and when the user last changed
        /// either: typing waits until they have been still for `QUIET`.
        seen: Option<(String, Option<(usize, usize)>)>,
        user_at: Option<std::time::Instant>,
        /// Updates in a row whose words to retype the app didn't select.
        refused: u8,
    }
    /// How many updates in a row may fail to select the words to retype
    /// before live typing stops for the dictation.
    const SELECT_TRIES: u8 = 3;
    /// How long `LiveField::focused` waits for a field to become readable.
    const FIELD_APPEARS: Duration = Duration::from_millis(1500);
    /// How long the end waits for keys still landing before replacing the words.
    const LANDED_BY_END: Duration = Duration::from_millis(2500);
    /// How many times the end tries to make the words the finished ones, and
    /// how long after the first try another may still start.
    const FINISH_TRIES: usize = 3;
    const FINISH_BUDGET: Duration = Duration::from_millis(2500);
    /// How long the user's hands are off the field before live typing moves
    /// the caret back after the words and goes on.
    const QUIET: Duration = Duration::from_millis(900);
    unsafe fn pid_of(element: Ref) -> Option<i32> {
        let mut pid = 0;
        (AXUIElementGetPid(element, &mut pid) == 0).then_some(pid)
    }
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
            let pid = unsafe { pid_of(field) }?;
            let value = unsafe { field_text(field) }?;
            let (start, length) = unsafe { selection(field) }?;
            let (prefix, rest) = super::split_utf16(&value, start)?;
            let (selected, suffix) = super::split_utf16(rest, length)?;
            // As `typed_passage` reads the field back. Selected text is
            // where the words go, as a paste would replace it: the first
            // words retype it.
            let (prefix, suffix, selected) = (super::normalize(prefix), super::normalize(suffix), super::normalize(selected));
            Some(LiveField {
                field: target,
                pid,
                prefix,
                suffix,
                typed: selected.clone(),
                posted: selected.clone(),
                original: selected,
                lost: false,
                consumed: 0,
                edit: None,
                seen: None,
                user_at: None,
                refused: 0,
            })
        }

        /// Whether any words went in, counting ones that may have but
        /// can't be read back, or are still on their way, or that the user
        /// has since rewritten or deleted.
        pub fn has_typed(&self) -> bool {
            self.lost || self.edit.is_some() || self.typed != self.original || self.posted != self.original
        }

        /// The app the field is in.
        pub fn pid(&self) -> i32 {
            self.pid
        }

        /// What the words should read for everything heard so far.
        fn aim(&self, heard: &str) -> String {
            match &self.edit {
                Some((base, anchor)) => super::after_edit(base, heard, *anchor),
                None => heard.to_string(),
            }
        }

        /// The finished words when the user has edited them: their version
        /// stands, with the rest of `heard` (tidied by `tidy`) after it.
        /// None when they didn't touch them.
        pub fn keep_edits(&self, heard: &str, tidy: impl Fn(&str) -> String) -> Option<String> {
            let (base, anchor) = self.edit.as_ref()?;
            let tail = super::after_edit("", &super::typeable(heard), *anchor);
            Some(super::after_edit(base, tidy(&tail).trim(), 0))
        }

        /// The focused element, when the field went away and came back as a
        /// new element in the same app (web pages rebuild theirs) still
        /// holding the words: typing follows it there.
        fn refind(&mut self) -> bool {
            let Some(target) = capture() else { return false };
            let element = target.0 as Ref;
            if unsafe { pid_of(element) } != Some(self.pid) {
                return false;
            }
            let found = unsafe { field_text(element) }.and_then(|value| super::typed_passage(&value, &self.prefix, &self.suffix));
            if !found.is_some_and(|found| super::reads_as_typed(&found, &self.typed, &self.posted)) {
                return false;
            }
            tracing::info!("live typing: found the field again");
            self.field = target;
            true
        }

        /// Reads the words back. Ok(false) while another element has the
        /// keyboard, keys posted are still landing, or the user is working
        /// in the field; Ok(true) with the caret right after the words, ready
        /// for more. An error once the text around them is gone. When
        /// `ending`, the user is done: the caret goes back at once.
        fn check(&mut self, ending: bool) -> Result<bool, String> {
            match focus(&self.field) {
                Some(true) => {}
                Some(false) if self.refind() => {}
                _ => return Ok(false),
            }
            let field = self.field.0 as Ref;
            let value = unsafe { field_text(field) }.ok_or("the field can't be read")?;
            let selected = unsafe { selection(field) };
            let found = match super::typed_passage(&value, &self.prefix, &self.suffix) {
                Some(found) => found,
                None => {
                    // The words aren't where the caret was read to be (apps
                    // report it late), or the text around them was edited:
                    // they are still the dictation's where they read whole,
                    // once. A second copy could be the user's own text, and
                    // a caret read late can't be trusted to tell them apart.
                    if let Some((prefix, suffix)) = super::relocated(&value, &self.posted) {
                        tracing::info!("live typing: found the typed words elsewhere in the field");
                        self.prefix = prefix;
                        self.suffix = suffix;
                        self.posted.clone()
                    } else {
                        // The text around them changed (the user typed there,
                        // the app tidied it, the field was sent or cleared):
                        // follow it rather than stop. Whatever now reads where
                        // the words were is taken as the user's version below,
                        // which is only ever added to.
                        let expected = format!("{}{}{}", self.prefix, self.posted, self.suffix);
                        let differs = super::where_it_differs(&value, &expected);
                        match super::followed(&value, &self.prefix, &self.posted, &self.suffix, ending) {
                            None => return Err(format!("the text around the typed words was changed ({differs})")),
                            Some(super::Followed::Words { prefix, found, suffix }) => {
                                tracing::info!("live typing: the text around the typed words changed ({differs}); following it");
                                self.prefix = prefix;
                                self.suffix = suffix;
                                found
                            }
                            // Nothing of the dictation is left to replace or
                            // take back: words heard from now on go in at
                            // the caret. `suffix` is the field's own
                            // placeholder, read back and never typed.
                            Some(super::Followed::Gone { suffix }) => {
                                tracing::info!("live typing: the field was emptied ({differs}); going on at the caret");
                                self.prefix = String::new();
                                self.suffix = suffix;
                                self.typed = String::new();
                                self.posted = String::new();
                                self.original = String::new();
                                self.edit = Some((String::new(), self.consumed));
                                self.user_at = Some(std::time::Instant::now());
                                String::new()
                            }
                        }
                    }
                }
            };
            let now = std::time::Instant::now();
            let changed = self.seen.as_ref() != Some(&(found.clone(), selected));
            self.seen = Some((found.clone(), selected));
            if super::reads_as_typed(&found, &self.typed, &self.posted) {
                self.typed = found;
                self.lost = false;
                if self.typed != self.posted {
                    return Ok(false);
                }
            } else {
                // The user rewrote some of the words: theirs stand, and only
                // words heard from now on are added.
                if self.edit.is_none() {
                    tracing::info!("live typing: the user edited the typed words; keeping their version");
                }
                self.edit = Some((found.clone(), self.consumed));
                self.typed = found.clone();
                self.posted = found;
                self.lost = false;
                self.user_at = Some(now);
                if !ending {
                    return Ok(false);
                }
            }
            let end = super::units(&self.prefix) + super::units(&self.typed);
            if selected == Some((end, 0)) && (ending || self.user_at.is_none_or(|at| at.elapsed() >= QUIET)) {
                return Ok(true);
            }
            if selected != Some((end, 0)) && changed {
                self.user_at = Some(now);
            }
            if !ending && self.user_at.is_some_and(|at| at.elapsed() < QUIET) {
                return Ok(false);
            }
            if selected != Some((end, 0)) {
                if unsafe { select_exactly(field, end, 0, "") } != Ok(true) {
                    return Ok(false);
                }
                self.seen = Some((self.typed.clone(), Some((end, 0))));
            }
            self.user_at = None;
            Ok(true)
        }

        /// Makes the words read what has been heard (`text`), following any
        /// edit the user made: types what's new after them, and retypes only
        /// from where a revised word differs. Ok(false) when the field
        /// doesn't have the keyboard right now, the user is working in it,
        /// or it hasn't taken in the last keys yet (try again later); an
        /// error means stop typing into it. No key is posted once `stop` is
        /// set.
        ///
        /// Focus is checked right before the keys are posted, but macOS has
        /// no way to post a key press to one element only: should focus move
        /// in the instant between, the keys follow it. The next sync then
        /// finds the words changed and takes them as the user's.
        pub fn sync(&mut self, text: &str, stop: &AtomicBool) -> Result<bool, String> {
            let heard = super::typeable(text);
            if self.aim(&heard) == self.typed && self.typed == self.posted && self.user_at.is_none() {
                self.consumed = super::word_count(&heard);
                return Ok(true);
            }
            if !self.check(false)? {
                return Ok(false);
            }
            let text = self.aim(&heard);
            if text == self.typed {
                self.consumed = super::word_count(&heard);
                return Ok(true);
            }
            let field = self.field.0 as Ref;
            let start = super::units(&self.prefix);
            let keep = super::shared_prefix(&self.typed, &text);
            if keep < self.typed.len() {
                let from = start + super::units(&self.typed[..keep]);
                let length = super::units(&self.typed[keep..]);
                // Both the range and its text: the key press below replaces
                // exactly what is selected, and nothing else may go with it.
                if !unsafe { select_surely(field, from, length, &self.typed[keep..])? } {
                    // Never leave words selected: the user's next key would replace them.
                    unsafe { put_caret(field, start + super::units(&self.typed)) };
                    // A busy app drops a selection now and then. No key was
                    // posted, so nothing changed: Ok(false) has the typist
                    // try again with the next words heard (every update
                    // carries all of them), a few times in a row.
                    self.refused += 1;
                    if self.refused >= SELECT_TRIES {
                        return Err("the app didn't select the words to retype".into());
                    }
                    return Ok(false);
                }
            }
            // Only refusals in a row count.
            self.refused = 0;
            if self.typed.is_empty() && self.edit.is_none() {
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
                    unsafe { put_caret(field, start + super::units(&self.typed)) };
                }
                return Ok(false);
            }
            // From here keys may land, all, some or none, now or seconds
            // later: the typed words follow what is in the field, and no more
            // go in until it reads `posted`.
            self.posted = text.clone();
            self.consumed = super::word_count(&heard);
            let posted = match &text[keep..] {
                // The selection is exactly the words to drop: one delete removes them all.
                "" => press(KEY_DELETE, None),
                insert => type_text(insert, stop, &self.field),
            };
            let landing = std::time::Instant::now() + if posted.is_ok() { TYPED_LANDING } else { Duration::from_millis(150) };
            let mut found = None;
            loop {
                std::thread::sleep(Duration::from_millis(30));
                if let Some(now) = unsafe { field_text(field) }.and_then(|value| super::typed_passage(&value, &self.prefix, &self.suffix)) {
                    if now == text {
                        self.typed = text;
                        self.lost = false;
                        let end = start + super::units(&self.typed);
                        self.seen = Some((self.typed.clone(), Some((end, 0))));
                        return Ok(true);
                    }
                    found = Some(now);
                }
                if std::time::Instant::now() >= landing {
                    break;
                }
            }
            match found {
                Some(found) if super::reads_as_typed(&found, &self.typed, &self.posted) => self.typed = found,
                // Anything else is the user's doing (or the app's): the next
                // check takes it as their version.
                Some(_) => {}
                // Unreadable now: what's there isn't known. The end reads the
                // field again before replacing anything (`finish` copies
                // should it still be unreadable).
                None => self.lost = true,
            }
            // Slow to take the keys in: the next update waits for them.
            posted.map(|()| false)
        }

        /// Waits (at most `LANDED_BY_END`) for keys still on their way, and
        /// puts the caret after the words: ready to change them.
        fn settle(&mut self) -> Result<(), String> {
            let give_up = std::time::Instant::now() + LANDED_BY_END;
            loop {
                match self.check(true) {
                    Ok(true) => return Ok(()),
                    Err(why) => return Err(why),
                    Ok(false) if std::time::Instant::now() >= give_up => {
                        // Keys that never arrived: replace what did. The
                        // dictation was polished meanwhile, so these were
                        // posted seconds ago.
                        tracing::info!("live typing: some typed keys never landed; replacing what did");
                        self.posted = self.typed.clone();
                        if !self.check(true)? {
                            return Err("the typed words couldn't be read back".into());
                        }
                        return Ok(());
                    }
                    // Another element has the keyboard for sure: no point waiting.
                    Ok(false) if focus(&self.field) == Some(false) => {
                        return Err("the field no longer has the keyboard".into());
                    }
                    Ok(false) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }

        /// Selects the typed words once keys still on their way have landed,
        /// so the next delete replaces exactly them. When none of them
        /// landed, the caret is left where they would have gone. It only
        /// selects: when it fails, nothing in the field changed.
        pub fn select_typed(&mut self) -> Result<(), String> {
            self.settle()?;
            if self.typed.is_empty() {
                return Ok(());
            }
            let field = self.field.0 as Ref;
            let start = super::units(&self.prefix);
            let length = super::units(&self.typed);
            if !unsafe { select_surely(field, start, length, &self.typed)? } {
                unsafe { put_caret(field, start + length) };
                return Err("the app didn't select the typed words".into());
            }
            Ok(())
        }

        /// Makes the words read the finished `text` by changing only the
        /// words that differ, right to left, each typed in place (a change
        /// with a line break is pasted with `paste`, as a typed one would
        /// be a Return). Nothing is selected wholesale and nothing that
        /// already reads right is touched, so the words don't flash. Ends
        /// with the caret after them. A change that didn't take (a dropped
        /// selection, keys slow to land, focus away for a moment) is tried
        /// again from what the field reads then, within `FINISH_BUDGET`. An
        /// error leaves the words as far as they got, the caret after them.
        pub fn finish(&mut self, text: &str, paste: impl Fn(&str) -> Result<(), String>) -> Result<(), String> {
            let started = std::time::Instant::now();
            let mut tries = 1;
            loop {
                let why = match self.finish_once(text, &paste) {
                    Ok(()) => return Ok(()),
                    Err(why) => why,
                };
                if tries >= FINISH_TRIES || started.elapsed() >= FINISH_BUDGET {
                    return Err(why);
                }
                tracing::info!("live typing: the finished words aren't in yet ({why}); trying again");
                tries += 1;
                self.wait_until_still();
            }
        }

        /// Waits (briefly) until the field reads the same twice in a row:
        /// keys posted for a change that didn't show may still be landing.
        fn wait_until_still(&self) {
            let field = self.field.0 as Ref;
            let give_up = std::time::Instant::now() + TYPED_LANDING;
            let mut last = unsafe { field_text(field) };
            loop {
                std::thread::sleep(Duration::from_millis(120));
                let now = unsafe { field_text(field) };
                if now == last || std::time::Instant::now() >= give_up {
                    return;
                }
                last = now;
            }
        }

        fn finish_once(&mut self, text: &str, paste: &impl Fn(&str) -> Result<(), String>) -> Result<(), String> {
            self.settle()?;
            let text = super::normalize(text);
            let field = self.field.0 as Ref;
            let start = super::units(&self.prefix);
            let old = self.typed.clone();
            let never = AtomicBool::new(false);
            let hunks = super::edit_hunks(&old, &text);
            if !hunks.is_empty() {
                // The previous dictation's paste is as the user left it.
                superseded();
            }
            for (from, to, with) in hunks.into_iter().rev() {
                let at = start + super::units(&old[..from]);
                let replaced = &old[from..to];
                if !unsafe { select_surely(field, at, super::units(replaced), replaced)? } {
                    unsafe { put_caret(field, start + super::units(&self.typed)) };
                    return Err("the app didn't select the words to change".into());
                }
                if focus(&self.field) != Some(true) {
                    return Err("the field lost the keyboard".into());
                }
                // Changes go right to left: everything before this one is still as it was.
                let expected = format!("{}{}{}", &old[..from], with, self.typed.get(to..).unwrap_or(""));
                if with.is_empty() {
                    press(KEY_DELETE, None)?;
                } else if with.chars().any(char::is_control) {
                    paste(&with)?;
                } else {
                    type_text(&with, &never, &self.field)?;
                }
                let landing = std::time::Instant::now() + TYPED_LANDING;
                loop {
                    std::thread::sleep(Duration::from_millis(30));
                    let found = unsafe { field_text(field) }.and_then(|value| super::typed_passage(&value, &self.prefix, &self.suffix));
                    if let Some(found) = found.as_ref().filter(|found| super::without_spacing(found) == super::without_spacing(&expected)) {
                        self.typed = found.clone();
                        self.posted = self.typed.clone();
                        break;
                    }
                    if std::time::Instant::now() >= landing {
                        // Whatever the keys made of the words so far is what
                        // another try starts from.
                        if let Some(found) = found {
                            self.typed = found;
                            self.posted = self.typed.clone();
                        }
                        return Err("the changed words didn't show in the field".into());
                    }
                }
            }
            let end = start + super::units(&self.typed);
            if unsafe { selection(field) } != Some((end, 0)) {
                unsafe { put_caret(field, end) };
            }
            Ok(())
        }

        /// Whether the field shows `text` where the typed words were (as a
        /// paste over them leaves it), within `within`. Spacing is not
        /// compared: rich text fields turn line breaks into paragraphs.
        pub fn shows(&self, text: &str, within: Duration) -> bool {
            let wanted = super::without_spacing(text);
            let give_up = std::time::Instant::now() + within;
            loop {
                let found = unsafe { field_text(self.field.0 as Ref) }
                    .and_then(|value| super::typed_passage(&value, &self.prefix, &self.suffix));
                if found.is_some_and(|found| super::without_spacing(&found) == wanted) {
                    return true;
                }
                if std::time::Instant::now() >= give_up {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        }

        /// Deletes the typed words, while they are still exactly as typed:
        /// words the user rewrote are theirs and stay.
        pub fn take_back(mut self) -> Result<(), String> {
            if self.edit.is_some() {
                return Err("the user edited the words".into());
            }
            self.select_typed()?;
            if self.typed.is_empty() || self.typed == self.original {
                // Nothing typed: a delete would take the user's own text.
                return Ok(());
            }
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

    /// Run explicitly with an empty focused text field, from a binary with
    /// Accessibility: a fix the user types stands, words heard after it go
    /// in after it once they pause, a caret moved away comes back, and the
    /// end changes only what differs.
    #[cfg(test)]
    #[test]
    #[ignore = "requires a focused empty text field and Accessibility"]
    fn live_typing_follows_edits_e2e() {
        assert!(unsafe { AXIsProcessTrusted() }, "needs Accessibility");
        let stop = AtomicBool::new(false);
        let mut live = LiveField::focused().expect("a readable focused field");
        let read = |live: &LiveField| unsafe { field_text(live.field.0 as Ref) }.unwrap_or_default();
        assert_eq!(live.sync("hello there", &stop), Ok(true));
        assert_eq!(read(&live), "hello there");
        // The user fixes a word: backspaces it and types their own.
        for _ in 0.."there".len() {
            press(KEY_DELETE, None).unwrap();
        }
        type_text("world", &AtomicBool::new(false), &live.field).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(read(&live), "hello world");
        assert_eq!(live.sync("hello there how are", &stop), Ok(false), "waits while the user is at it");
        std::thread::sleep(QUIET + Duration::from_millis(200));
        assert_eq!(live.sync("hello there how are", &stop), Ok(true));
        assert_eq!(read(&live), "hello world how are", "their fix stands, new words follow it");
        // The user clicks elsewhere in the words, then keeps talking.
        unsafe { select_exactly(live.field.0 as Ref, 2, 0, "") }.unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(live.sync("hello there how are you", &stop), Ok(false));
        std::thread::sleep(QUIET + Duration::from_millis(200));
        assert_eq!(live.sync("hello there how are you", &stop), Ok(true));
        assert_eq!(read(&live), "hello world how are you");
        let finished = live.keep_edits("hello there how are you doing", |tail| tail.to_string()).expect("edited");
        assert_eq!(finished, "hello world how are you doing");
        let finished = "Hello world, how are you doing?";
        live.finish(finished, |_| Err("no paste expected".into())).expect("finishes in place");
        assert_eq!(read(&live), finished);
        let end = super::units(finished);
        assert_eq!(unsafe { selection(live.field.0 as Ref) }, Some((end, 0)), "caret after the words");
        live.select_typed().unwrap();
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

pub fn passage(value: &str, prefix: &str, suffix: &str) -> Option<String> {
    let middle = value.strip_prefix(prefix)?.strip_suffix(suffix)?;
    Some(middle.into())
}

/// `passage` for live-typed words, whose caret is checked as well. Rich text
/// editors (ProseMirror, as in Claude's message box) read back an empty
/// paragraph as a lone newline and drop it once there is text, or add one
/// back when the text goes: the field's last newline may come and go.
///
/// It reads the field as `normalize` does: Chrome hands spaces back as
/// non-breaking ones and some fields curl quotes, and words typed as plain
/// ones are still the typed words. `prefix` and `suffix` are normalized too.
pub fn typed_passage(value: &str, prefix: &str, suffix: &str) -> Option<String> {
    let value = normalize(value);
    let rest = value.strip_prefix(prefix)?;
    let middle = rest
        .strip_suffix(suffix)
        .or_else(|| rest.strip_suffix(suffix.strip_suffix('\n')?))
        .or_else(|| rest.strip_suffix('\n')?.strip_suffix(suffix))?;
    Some(middle.into())
}

/// Where live-typed `words` read whole in `value` when they aren't between
/// the text they were typed between: the text before and after their only
/// occurrence. None when they aren't there whole, or are there more than
/// once. `normalize` swaps characters one for one, so offsets into what it
/// returns are offsets into the field.
pub fn relocated(value: &str, words: &str) -> Option<(String, String)> {
    if words.trim().is_empty() {
        return None;
    }
    anchors(&normalize(value), words, |_, _| false)
}

/// Where live-typed `words` are in `value` once the text they were typed
/// between (`prefix`, `suffix`) has changed: the text before them, what now
/// reads in their place, and the text after. A change wholly before or
/// wholly after the words leaves them as they were. Otherwise what reads in
/// their place is everything between the unchanged start of `prefix` and the
/// unchanged end of `suffix`.
pub fn reanchored(value: &str, prefix: &str, words: &str, suffix: &str) -> (String, String, String) {
    let value = normalize(value);
    let expected = format!("{prefix}{words}{suffix}");
    let same_start = shared_prefix(&value, &expected);
    let same_end = shared_suffix(&value, &expected).min(value.len() - same_start).min(expected.len() - same_start);
    let tail = words.len() + suffix.len();
    if same_end >= tail {
        let (before, rest) = value.split_at(value.len() - tail);
        return (before.into(), words.into(), rest[words.len()..].into());
    }
    let head = prefix.len() + words.len();
    if same_start >= head {
        return (prefix.into(), words.into(), value[head..].into());
    }
    let keep_start = same_start.min(prefix.len());
    let keep_end = same_end.min(suffix.len()).min(value.len() - keep_start);
    let end = value.len() - keep_end;
    (value[..keep_start].into(), value[keep_start..end].into(), value[end..].into())
}

/// What live typing makes of a field whose text around the typed words changed.
#[derive(Debug, PartialEq)]
pub enum Followed {
    /// The words, or what now reads in their place, between new anchors.
    Words { prefix: String, found: String, suffix: String },
    /// The field holds no text at all any more (sent or cleared). `suffix`
    /// is what an empty field reads as: nothing, or a rich text field's
    /// lone newline.
    Gone { suffix: String },
}

/// Follows live-typed `words` into `value` (see `reanchored`). When
/// `ending`, the finished words are about to replace what is found, so
/// anything but the words themselves is refused (None), unless the field is
/// empty and there is nothing to replace.
pub fn followed(value: &str, prefix: &str, words: &str, suffix: &str, ending: bool) -> Option<Followed> {
    let value = normalize(value);
    if value.trim().is_empty() {
        return Some(Followed::Gone { suffix: value });
    }
    let (prefix, found, suffix) = reanchored(&value, prefix, words, suffix);
    if ending && found != words {
        return None;
    }
    Some(Followed::Words { prefix, found, suffix })
}

/// Where a field's text first parts from what was expected, for the log:
/// UTF-16 offsets and the kind of character on each side there, never the
/// text itself.
pub fn where_it_differs(value: &str, expected: &str) -> String {
    let value = normalize(value);
    let at = shared_prefix(&value, expected);
    let kind = |text: &str| match text[at..].chars().next() {
        None => "the end",
        Some('\n') => "a newline",
        Some(c) if c.is_whitespace() => "a space",
        Some(c) if c.is_alphanumeric() => "a letter",
        Some(c) if c.is_control() => "a control character",
        Some(_) => "punctuation",
    };
    format!(
        "at {} units, of {} in the field and {} expected: the field has {}, expected {}",
        units(&value[..at]),
        units(&value),
        units(expected),
        kind(&value),
        kind(expected)
    )
}

/// Whether `found`, read from a live-typed field, is still Eavesy's own
/// words: as they were (`typed`), or on their way to `posted`, with keys
/// still landing. Anything else is the user (or the app) changing them.
pub fn reads_as_typed(found: &str, typed: &str, posted: &str) -> bool {
    found == typed || (posted.starts_with(found) && found.len() >= shared_prefix(typed, posted))
}

/// `text` as fields hand it back (`normalize`), with no whitespace at all.
pub fn without_spacing(text: &str) -> String {
    normalize(text).chars().filter(|c| !c.is_whitespace()).collect()
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

/// The field text live typing aims for once the user has edited its words:
/// their version (`base`) as they left it, then the words heard after the
/// first `anchor` ones, which hadn't gone in yet when they edited.
pub fn after_edit(base: &str, heard: &str, anchor: usize) -> String {
    let tail = heard.split_whitespace().skip(anchor).collect::<Vec<_>>().join(" ");
    if tail.is_empty() {
        return base.to_string();
    }
    if base.is_empty() || base.ends_with(char::is_whitespace) {
        format!("{base}{tail}")
    } else {
        format!("{base} {tail}")
    }
}

/// Words in `text`, counted as `after_edit` skips them.
pub fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

/// `text` cut into words, each with the whitespace after it (whitespace
/// before the first word is a piece of its own), as byte ranges.
fn word_pieces(text: &str) -> Vec<(usize, usize)> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut in_space = false;
    for (at, c) in text.char_indices() {
        let space = c.is_whitespace();
        if !space && in_space && at > start {
            pieces.push((start, at));
            start = at;
        }
        in_space = space;
    }
    if start < text.len() {
        pieces.push((start, text.len()));
    }
    pieces
}

/// The fewest word-sized changes that turn `old` into `new`, left to right:
/// each the byte range of `old` it replaces and what goes there. Applied
/// right to left, the ranges still to apply are never shifted. Past
/// `MAX_HUNKS` changes, one change from the first to the last.
pub fn edit_hunks(old: &str, new: &str) -> Vec<(usize, usize, String)> {
    const MAX_HUNKS: usize = 8;
    let a = word_pieces(old);
    let b = word_pieces(new);
    let piece = |text: &str, (s, e): (usize, usize)| text[s..e].to_string();
    let a_words: Vec<String> = a.iter().map(|r| piece(old, *r)).collect();
    let b_words: Vec<String> = b.iter().map(|r| piece(new, *r)).collect();
    // Longest common subsequence of pieces, from the end.
    let (n, m) = (a_words.len(), b_words.len());
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a_words[i] == b_words[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let byte_at = |pieces: &[(usize, usize)], index: usize, len: usize| pieces.get(index).map_or(len, |r| r.0);
    let mut hunks = Vec::new();
    let (mut i, mut j) = (0, 0);
    let mut open: Option<(usize, usize)> = None;
    while i < n || j < m {
        if i < n && j < m && a_words[i] == b_words[j] {
            if let Some((oi, oj)) = open.take() {
                hunks.push((byte_at(&a, oi, old.len()), byte_at(&a, i, old.len()), new[byte_at(&b, oj, new.len())..byte_at(&b, j, new.len())].to_string()));
            }
            i += 1;
            j += 1;
            continue;
        }
        open.get_or_insert((i, j));
        if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            j += 1;
        } else {
            i += 1;
        }
    }
    if let Some((oi, oj)) = open {
        hunks.push((byte_at(&a, oi, old.len()), old.len(), new[byte_at(&b, oj, new.len())..].to_string()));
    }
    if hunks.len() > MAX_HUNKS {
        let start = hunks[0].0;
        let end = hunks[hunks.len() - 1].1;
        let kept_after = old.len() - end;
        hunks = vec![(start, end, new[start..new.len() - kept_after].to_string())];
    }
    // Within a change, the letters on either side that stay are left alone.
    hunks
        .into_iter()
        .map(|(start, end, with)| {
            let was = &old[start..end];
            let front = shared_prefix(was, &with);
            let back = shared_suffix(&was[front..], &with[front..]);
            (start + front, end - back, with[front..with.len() - back].to_string())
        })
        .collect()
}

/// Bytes `a` and `b` share at the end, starting on a character boundary.
fn shared_suffix(a: &str, b: &str) -> usize {
    a.chars().rev().zip(b.chars().rev()).take_while(|(x, y)| x == y).map(|(x, _)| x.len_utf8()).sum()
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
    fn a_typed_field_s_last_newline_may_come_and_go() {
        // An empty ProseMirror field reads "\n"; typed into, it drops it.
        assert_eq!(typed_passage("Hello\u{a0}", "", "\n").as_deref(), Some("Hello "));
        assert_eq!(typed_passage("Hello\n", "", "\n").as_deref(), Some("Hello"));
        assert_eq!(typed_passage("Say Hello there", "Say ", "").as_deref(), Some("Hello there"));
        // Only a last newline is forgiven.
        assert_eq!(typed_passage("Hello", "", "\nmore"), None);
        assert_eq!(typed_passage("Hello\n\n", "", "").as_deref(), Some("Hello\n\n"));
    }

    #[test]
    fn typed_words_are_followed_when_the_text_around_them_changes() {
        let own = |(a, b, c): (&str, &str, &str)| (a.to_string(), b.to_string(), c.to_string());
        // Changed before the words only, or after them only: the words stand.
        assert_eq!(reanchored("Hi there, so far tail", "Hello ", "so far", " tail"), own(("Hi there, ", "so far", " tail")));
        assert_eq!(reanchored("Hello so far and more", "Hello ", "so far", " tail"), own(("Hello ", "so far", " and more")));
        // Nothing typed yet, and the user typed before the caret.
        assert_eq!(reanchored("Hello you tail", "Hello ", "", " tail"), own(("Hello you", "", " tail")));
        // Sent or cleared: nothing reads where the words were.
        assert_eq!(reanchored("\n", "Hello ", "so far", ""), own(("", "\n", "")));
        assert_eq!(reanchored("", "Hello ", "so far", " tail"), own(("", "", "")));
        // The words changed along with the text before them: what is between
        // the unchanged ends reads in their place.
        assert_eq!(reanchored("Hello. So fur tail", "Hello ", "so far", " tail"), own(("Hello", ". So fur", " tail")));
        // Never split inside a character.
        assert_eq!(reanchored("né so far", "nà ", "so far", ""), own(("né ", "so far", "")));
        assert_eq!(reanchored("é", "è", "x", ""), own(("", "é", "")));
    }

    #[test]
    fn a_changed_field_is_followed_but_never_overwritten_at_the_end() {
        let words = |prefix: &str, found: &str, suffix: &str| {
            Some(Followed::Words { prefix: prefix.into(), found: found.into(), suffix: suffix.into() })
        };
        // The text around the words changed: followed, during and at the end.
        for ending in [false, true] {
            assert_eq!(followed("Hi so far tail", "Hello ", "so far", " tail", ending), words("Hi ", "so far", " tail"));
        }
        // The words changed too: the user's version while they talk, but
        // nothing the finished words may replace.
        assert_eq!(followed("Hello. So fur tail", "Hello ", "so far", " tail", false), words("Hello", ". So fur", " tail"));
        assert_eq!(followed("Hello. So fur tail", "Hello ", "so far", " tail", true), None);
        // Blanked out between text that is still there: the same.
        assert_eq!(followed("Hi   tail", "Hello ", "so far", " tail", false), words("H", "i  ", " tail"));
        assert_eq!(followed("Hi   tail", "Hello ", "so far", " tail", true), None);
        // An emptied field: go on at the caret, at the end too.
        for ending in [false, true] {
            assert_eq!(followed("", "Hello ", "so far", " tail", ending), Some(Followed::Gone { suffix: String::new() }));
            assert_eq!(followed("\n", "Hello ", "so far", "", ending), Some(Followed::Gone { suffix: "\n".into() }));
        }
        // An empty rich text field's newline is the field's, never typed:
        // words that go in after it read back without it.
        assert_eq!(typed_passage("\n", "", "\n").as_deref(), Some(""));
        assert_eq!(typed_passage("new words", "", "\n").as_deref(), Some("new words"));
        assert_eq!(typed_passage("new words\n", "", "\n").as_deref(), Some("new words"));
    }

    #[test]
    fn typed_words_that_landed_elsewhere_are_found_again() {
        // The caret was read a few characters short of the end: the words
        // went in at the real one.
        let value = "Earlier text, done.\u{a0}Send Sam the deck";
        assert_eq!(typed_passage(value, "Earlier text, ", "done. "), None);
        assert_eq!(relocated(value, "Send Sam the deck"), Some(("Earlier text, done. ".into(), String::new())));
        assert_eq!(units(&normalize(value)), units(value), "offsets into the normalized text are the field's");
        // Text typed before them moved them.
        assert_eq!(relocated("Hi! Send it now", "Send it"), Some(("Hi! ".into(), " now".into())));
        // Two copies: one may be the user's own, so neither is touched.
        assert_eq!(relocated("Send it. Send it", "Send it"), None);
        // Sent, cleared, or keys still landing: not there whole.
        assert_eq!(relocated("\n", "Send it"), None);
        assert_eq!(relocated("Hi! Send", "Send it"), None);
        assert_eq!(relocated("anything", " "), None);
    }

    #[test]
    fn keys_still_landing_read_as_the_typed_words() {
        // A slow app has taken in part of the words: still Eavesy's.
        assert!(reads_as_typed("I believe we", "I believe", "I believe we're in"));
        assert!(reads_as_typed("I believe we're in", "I believe", "I believe we're in"));
        assert!(reads_as_typed("I believe", "I believe", "I believe we're in"));
        // A retype under way: the old tail gone, the new one coming in.
        assert!(reads_as_typed("Send Sam the de", "Send Sam the desk", "Send Sam the deck"));
        assert!(reads_as_typed("Send Sam the dec", "Send Sam the desk", "Send Sam the deck"));
        assert!(!reads_as_typed("Send Sam the", "Send Sam the desk", "Send Sam the deck"));
        // Right after the delete in a retype, only the shared start is left.
        assert!(reads_as_typed("I ", "I believe", "I think"));
        assert!(!reads_as_typed("I", "I believe", "I think"));
        // Shorter than what was already there and agreed on is the user deleting.
        assert!(!reads_as_typed("I", "I believe", "I believe we're"));
        // Words that aren't on their way are the user's.
        assert!(!reads_as_typed("I believe they", "I believe", "I believe we're"));
        assert!(!reads_as_typed("I believe we're in!", "I believe we're in", "I believe we're in"));
    }

    #[test]
    fn typed_words_read_back_as_they_were_typed() {
        // Chrome turns the space before the caret into a non-breaking one,
        // and back once more is typed after it.
        assert_eq!(typed_passage("Hi\u{a0}Hello there", "Hi ", "").as_deref(), Some("Hello there"));
        assert_eq!(typed_passage("I\u{2019}m in", "", "").as_deref(), Some("I'm in"));
        assert_eq!(
            where_it_differs("Hi Hello\n", "Hi Hello."),
            "at 8 units, of 9 in the field and 9 expected: the field has a newline, expected punctuation"
        );
        assert_eq!(
            where_it_differs("Hi", "Hi there"),
            "at 2 units, of 2 in the field and 8 expected: the field has the end, expected a space"
        );
        // Offsets into the field hold after normalizing: one unit for one.
        for c in ['\u{a0}', '\u{202f}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}'] {
            assert_eq!(units(&normalize(&c.to_string())), units(&c.to_string()));
        }
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

    fn apply(old: &str, hunks: &[(usize, usize, String)]) -> String {
        let mut text = old.to_string();
        for (start, end, with) in hunks.iter().rev() {
            text.replace_range(*start..*end, with);
        }
        text
    }

    #[test]
    fn the_end_changes_only_the_words_that_differ() {
        let old = "send sam the deck before friday";
        let new = "Send Sam the deck before Friday.";
        let hunks = edit_hunks(old, new);
        assert_eq!(apply(old, &hunks), new);
        assert_eq!(hunks.len(), 2, "{hunks:?}");
        assert!(edit_hunks(new, new).is_empty(), "the same words change nothing");
        let grown = "Send Sam the deck before Friday. Thanks";
        assert_eq!(edit_hunks(new, grown), vec![(new.len(), new.len(), " Thanks".to_string())], "new words are only added");
        assert_eq!(edit_hunks("send it", "Send it"), vec![(0, 1, "S".to_string())], "a capital retypes one letter");
        assert_eq!(apply(new, &edit_hunks(new, grown)), grown);
        for (old, new) in [
            ("", "Hello there."),
            ("um so hello", "So hello."),
            ("a b c d e f g h i j k l m", "A B C D E F G H I J K L M"),
            ("Hello there", ""),
            ("one two three", "one\ntwo three"),
            ("  leading", "leading"),
        ] {
            let hunks = edit_hunks(old, new);
            assert_eq!(apply(old, &hunks), new, "{old:?} -> {new:?}: {hunks:?}");
            assert!(hunks.len() <= 8);
        }
    }

    #[test]
    fn words_heard_after_an_edit_follow_the_user_s_version() {
        assert_eq!(after_edit("Send Sam the deck", "send sam the desk before friday", 4), "Send Sam the deck before friday");
        assert_eq!(after_edit("Send Sam the deck", "send sam the desk", 4), "Send Sam the deck");
        assert_eq!(after_edit("", "hello there you", 2), "you");
        assert_eq!(after_edit("Hi ", "hi there", 1), "Hi there");
        assert_eq!(word_count("  a b  c "), 3);
    }

    #[test]
    fn key_events_never_split_a_surrogate_pair() {
        let chunks = utf16_chunks("abc😀d", 4);
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), vec![3, 3]);
        assert_eq!(String::from_utf16(&chunks.concat()).unwrap(), "abc😀d");
    }
}
