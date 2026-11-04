//! "Type as I talk": a dictation's settled words typed into the field the
//! cursor is in while the user is still talking. Only words the accurate
//! recognizer has settled are typed, never the fast preview's guesses, so the
//! text grows rather than flickers; a revised phrase is retyped from where it
//! differs. When the dictation stops, its finished words (fillers dropped,
//! tone applied) replace what was typed in one paste.
//!
//! Typing stops for good the moment the typed words or the caret are not as
//! Eavesy left them: the user is typing there themselves. It pauses while
//! another element has the keyboard. A field Eavesy can't read back (a
//! terminal, some Electron apps) gets no live typing; its dictation pastes
//! at the end as before.

use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::AppHandle;

use crate::captions::{same_phrase, Caption};

#[cfg(target_os = "macos")]
pub use crate::paste_learning::LiveField;

/// Stands in where live typing can't run, so callers need no `cfg`.
#[cfg(not(target_os = "macos"))]
pub struct LiveField;
#[cfg(not(target_os = "macos"))]
impl LiveField {
    fn focused() -> Option<LiveField> {
        None
    }
    pub fn has_typed(&self) -> bool {
        false
    }
    fn sync(&mut self, _text: &str, _stop: &AtomicBool) -> Result<bool, String> {
        Err("live typing is only supported on macOS".into())
    }
    pub fn select_typed(&self) -> Result<(), String> {
        Err("live typing is only supported on macOS".into())
    }
    pub fn take_back(self) -> Result<(), String> {
        Err("live typing is only supported on macOS".into())
    }
}

enum Msg {
    Caption(Caption),
    /// The dictation stopped: hand back the field and what is in it.
    Finish(SyncSender<Option<LiveField>>),
    /// The words go nowhere: take back what was typed, if untouched.
    Cancel,
}

/// Captions waiting for the typist; past this they are dropped (the next
/// one carries the whole text anyway).
const QUEUE: usize = 64;
/// How long a stopping dictation waits for typing under way to finish.
const FINISH_WAIT: Duration = Duration::from_secs(2);
/// A typist with no words or stop this long gives up. Far past any
/// dictation (they are short, and are delivered within
/// `dictation::DELIVER_WINDOW` of stopping), so in practice only one whose
/// recording failed without a disarm idles out.
const IDLE: Duration = Duration::from_secs(3 * 60 * 60);
/// Typists kept at once that haven't typed anything. A dictation still being
/// delivered keeps its field while the next one starts; past this the oldest
/// that typed nothing is let go. One that typed words is only let go by its
/// own finish or cancel, or by idling out.
const KEEP: usize = 4;

/// What a typist and the dictation it types share.
#[derive(Default)]
struct Shared {
    /// Set at stop: no key is posted after this.
    stop: AtomicBool,
    /// Some words went into the field (and may still be there).
    typed: AtomicBool,
}

struct Entry {
    id: String,
    tx: SyncSender<Msg>,
    shared: Arc<Shared>,
}

/// Dictations being typed, oldest first.
static TYPISTS: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

fn typists() -> std::sync::MutexGuard<'static, Vec<Entry>> {
    TYPISTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts typing this dictation as it is heard, when the setting is on.
pub fn start(app: &AppHandle, session_id: &str) {
    if !crate::settings::load(app).type_as_you_talk() {
        return;
    }
    let (tx, rx) = sync_channel(QUEUE);
    let shared = Arc::new(Shared::default());
    register(Entry { id: session_id.to_string(), tx, shared: shared.clone() });
    let session_id = session_id.to_string();
    std::thread::spawn(move || typist(&session_id, rx, &shared));
}

fn register(entry: Entry) {
    let mut typists = typists();
    typists.retain(|other| other.id != entry.id);
    while typists.iter().filter(|other| !other.shared.typed.load(Ordering::SeqCst)).count() >= KEEP {
        let Some(oldest) = typists.iter().position(|other| !other.shared.typed.load(Ordering::SeqCst)) else { break };
        typists.remove(oldest);
    }
    typists.push(entry);
}

/// A caption from the capture engine. Never blocks: the engine's reader
/// calls this, and it must keep reading.
pub fn caption(caption: &Caption) {
    if !caption.is_final || caption.preview || caption.track != "mic" || caption.text.trim().is_empty() {
        return;
    }
    let typists = typists();
    let Some(entry) = typists.iter().find(|entry| entry.id == caption.session_id) else { return };
    if let Err(TrySendError::Full(_)) = entry.tx.try_send(Msg::Caption(caption.clone())) {
        tracing::debug!("live typing is behind; a caption waits for the next");
    }
}

/// What a stopping dictation finds typed for it.
pub enum Typed {
    /// No words were typed: deliver as usual.
    Nothing,
    /// Words were typed into this field: replace them.
    Field(LiveField),
    /// Words went in but can't be replaced (the typist didn't answer in
    /// time, or gave up idling), so what is in the field isn't known:
    /// pasting could double the words. Copy them instead.
    Unknown,
}

/// Stops typing this dictation and says what was typed for it, once
/// whatever typing was under way has landed.
pub fn finish(session_id: &str) -> Typed {
    let Some(entry) = take(session_id) else { return Typed::Nothing };
    // Before anything else: from here no key is posted, even by a sync
    // already under way, so whatever is decided below holds.
    entry.shared.stop.store(true, Ordering::SeqCst);
    let unknown = || {
        if entry.shared.typed.load(Ordering::SeqCst) {
            tracing::warn!(session_id, "live-typed words can't be replaced; copying instead of pasting");
            Typed::Unknown
        } else {
            Typed::Nothing
        }
    };
    let (reply, answer) = sync_channel(1);
    if entry.tx.send(Msg::Finish(reply)).is_err() {
        // The typist idled out.
        return unknown();
    }
    // A sync under way when the wait runs out posts no further key (each
    // press checks `stop` first), but a press already posted may still
    // land: hence copy, never paste, in that case.
    match answer.recv_timeout(FINISH_WAIT) {
        Ok(Some(field)) if field.has_typed() => Typed::Field(field),
        Ok(_) => Typed::Nothing,
        Err(_) => unknown(),
    }
}

/// This dictation's words won't be delivered into the field (they were for
/// Eavesy, it heard only silence or fillers, or it failed): stop typing them,
/// and take back what was typed while it is still exactly as typed. Words
/// the user has since changed stay. The recording keeps every word.
pub fn cancel(session_id: &str) {
    if let Some(entry) = take(session_id) {
        entry.shared.stop.store(true, Ordering::SeqCst);
        // Never blocks; with a full queue the typist is busy and the words stay.
        let _ = entry.tx.try_send(Msg::Cancel);
    }
}

fn take(session_id: &str) -> Option<Entry> {
    let mut typists = typists();
    let at = typists.iter().position(|entry| entry.id == session_id)?;
    Some(typists.remove(at))
}

/// Where the typist is with its field.
enum Field {
    /// Not looked for yet: it is found at the first words, in the app the
    /// dictation will paste into.
    Unknown,
    Typing(LiveField),
    /// Typing stopped for this dictation; the field is kept so the end can
    /// still replace what was typed, should it be untouched after all.
    Stopped(Option<LiveField>),
}

fn typist(session_id: &str, rx: Receiver<Msg>, shared: &Shared) {
    let mut heard = Heard::default();
    let mut field = Field::Unknown;
    loop {
        let msg = match rx.recv_timeout(IDLE) {
            Ok(msg) => msg,
            // A dictation this quiet can no longer be delivered (IDLE is
            // past `dictation::DELIVER_WINDOW`): let its field go. Its
            // words stay in it, and `finish` copies rather than pastes.
            Err(RecvTimeoutError::Timeout) => return,
            // Replaced or cancelled: whatever was typed stays as it is.
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut ending = None;
        match msg {
            Msg::Caption(caption) => heard.add(caption),
            end => ending = Some(end),
        }
        // Everything already queued is typed in one go.
        while ending.is_none() {
            match rx.try_recv() {
                Ok(Msg::Caption(caption)) => heard.add(caption),
                Ok(end) => ending = Some(end),
                Err(_) => break,
            }
        }
        if let Some(end) = ending {
            let live = match field {
                Field::Typing(live) | Field::Stopped(Some(live)) => Some(live),
                _ => None,
            };
            match end {
                Msg::Finish(reply) => {
                    let _ = reply.send(live);
                }
                _ => {
                    if let Some(Err(why)) = live.filter(LiveField::has_typed).map(LiveField::take_back) {
                        tracing::info!(session_id, "live-typed words left in place: {why}");
                    }
                }
            }
            return;
        }
        field = type_into(session_id, field, &heard.text(), shared);
    }
}

fn type_into(session_id: &str, field: Field, text: &str, shared: &Shared) -> Field {
    if matches!(field, Field::Stopped(_)) {
        return field;
    }
    // Claimed for Eavesy or a Claude Code answer since the last words: those
    // never go into an app, so stop (what was typed stays, as said).
    if let Some(why) = crate::dictation::words_go_elsewhere(session_id) {
        tracing::info!(session_id, "live typing off for this dictation: {why}");
        return match field {
            Field::Typing(live) => Field::Stopped(Some(live)),
            _ => Field::Stopped(None),
        };
    }
    let mut live = match field {
        Field::Stopped(_) => unreachable!("returned above"),
        Field::Typing(live) => live,
        Field::Unknown => {
            match crate::dictation::live_typing_target(session_id) {
                // Not in front yet: look again at the next words.
                Ok(false) => return Field::Unknown,
                Err(why) => {
                    tracing::info!(session_id, "live typing off for this dictation: {why}");
                    return Field::Stopped(None);
                }
                Ok(true) => {}
            }
            match LiveField::focused() {
                Some(live) => live,
                None => {
                    tracing::info!(session_id, "live typing off for this dictation: the field can't be read back");
                    return Field::Stopped(None);
                }
            }
        }
    };
    // Before any key can be posted: a finish that times out must know the
    // field may hold words.
    shared.typed.store(true, Ordering::SeqCst);
    match live.sync(text, &shared.stop) {
        Ok(_) => Field::Typing(live),
        Err(why) => {
            tracing::info!(session_id, "live typing stopped: {why}");
            Field::Stopped(Some(live))
        }
    }
}

/// The settled phrases of a dictation, as `CaptionLog` keeps its finals: a
/// final for the same phrase replaces the earlier one.
#[derive(Default)]
struct Heard {
    finals: Vec<Caption>,
}

impl Heard {
    fn add(&mut self, caption: Caption) {
        self.finals.retain(|previous| !same_phrase(previous, &caption));
        self.finals.push(caption);
    }

    fn text(&self) -> String {
        let mut finals: Vec<&Caption> = self.finals.iter().collect();
        finals.sort_by_key(|c| (c.start_ms, c.end_ms));
        finals.iter().map(|c| c.text.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn final_(start_ms: i64, end_ms: i64, text: &str) -> Caption {
        Caption {
            session_id: "s".into(),
            track: "mic".into(),
            text: text.into(),
            is_final: true,
            start_ms,
            end_ms,
            preview: false,
        }
    }

    #[test]
    fn settled_phrases_join_in_spoken_order() {
        let mut heard = Heard::default();
        heard.add(final_(2_000, 3_000, "before Friday."));
        heard.add(final_(0, 1_900, "Send Sam the deck"));
        assert_eq!(heard.text(), "Send Sam the deck before Friday.");
    }

    #[test]
    fn a_revised_final_replaces_its_phrase() {
        let mut heard = Heard::default();
        heard.add(final_(0, 1_900, "Send Sam the desk"));
        heard.add(final_(0, 1_950, "Send Sam the deck"));
        assert_eq!(heard.text(), "Send Sam the deck");
    }

    #[test]
    fn only_settled_mic_words_for_the_current_dictation_are_queued() {
        let (tx, rx) = sync_channel(QUEUE);
        // Marked typed so another test's registering can't evict it.
        let shared = Arc::new(Shared::default());
        shared.typed.store(true, Ordering::SeqCst);
        typists().push(Entry { id: "s".into(), tx, shared });
        let mut preview = final_(0, 500, "hi");
        preview.preview = true;
        caption(&preview);
        let mut partial = final_(0, 500, "hi");
        partial.is_final = false;
        caption(&partial);
        let mut other = final_(0, 500, "hi");
        other.session_id = "other".into();
        caption(&other);
        caption(&final_(0, 500, "hello"));
        assert!(matches!(rx.try_recv(), Ok(Msg::Caption(c)) if c.text == "hello"));
        assert!(rx.try_recv().is_err());
        cancel("someone else");
        assert!(typists().iter().any(|entry| entry.id == "s"), "another dictation's cancel leaves this one");
        cancel("s");
        assert!(!typists().iter().any(|entry| entry.id == "s"));
    }

    fn entry(id: &str, typed: bool) -> (Entry, Receiver<Msg>) {
        let (tx, rx) = sync_channel(1);
        let shared = Arc::new(Shared::default());
        shared.typed.store(typed, Ordering::SeqCst);
        (Entry { id: id.into(), tx, shared }, rx)
    }

    #[test]
    fn a_typist_that_typed_is_never_evicted_and_never_reads_as_nothing() {
        let mut keep = Vec::new();
        let (typed, rx) = entry("evict-typed", true);
        keep.push(rx);
        register(typed);
        for n in 0..KEEP + 2 {
            let (quiet, rx) = entry(&format!("evict-quiet-{n}"), false);
            keep.push(rx);
            register(quiet);
        }
        assert!(typists().iter().any(|entry| entry.id == "evict-typed"));
        assert!(!typists().iter().any(|entry| entry.id == "evict-quiet-0"), "the oldest quiet one goes");
        // Its typist is gone (it idled out): the words may be in the field.
        drop(keep.remove(0));
        assert!(matches!(finish("evict-typed"), Typed::Unknown));
        // One that typed nothing and is gone delivers as usual.
        let last = format!("evict-quiet-{}", KEEP + 1);
        drop(keep.pop());
        assert!(matches!(finish(&last), Typed::Nothing));
        for n in 0..KEEP + 2 {
            cancel(&format!("evict-quiet-{n}"));
        }
    }

    #[test]
    fn finish_stops_typing_before_it_decides() {
        let (typed, _rx) = entry("stop-first", true);
        let shared = typed.shared.clone();
        register(typed);
        // Nobody answers: the typist is mid-sync. It must post no more keys.
        assert!(matches!(finish("stop-first"), Typed::Unknown));
        assert!(shared.stop.load(Ordering::SeqCst));
    }

    #[test]
    fn a_typist_idles_out_only_after_dictations_can_no_longer_be_delivered() {
        assert!(IDLE >= crate::dictation::DELIVER_WINDOW);
    }
}
