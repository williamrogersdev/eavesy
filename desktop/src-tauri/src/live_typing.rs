//! "Type as I talk": a dictation's words typed into the field the cursor is
//! in while the user is still talking. Settled phrases come every few seconds,
//! too late to keep up with speech, so the live draft the HUD shows (the
//! accurate recognizer's unsettled words, then the fast preview's) is typed
//! too, as soon as two of its updates in a row agree on a word. The text grows
//! rather than flickers: a draft that drops words never takes typed ones back,
//! and a revised or settled phrase is retyped from where it differs. When the
//! dictation stops, its finished words (fillers dropped, tone applied) replace
//! what was typed in one paste.
//!
//! Typing stops for good the moment the typed words or the caret are not as
//! Eavesy left them: the user is typing there themselves. It pauses while
//! another element has the keyboard. A field Eavesy can't read back (a
//! terminal, some Electron apps) gets no live typing; its dictation pastes
//! at the end as before.

use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender};
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

/// How long a stopping dictation waits for typing under way to finish: the
/// most `finish` holds up delivery.
const FINISH_WAIT: Duration = Duration::from_secs(2);
/// How long after a first lookup finds no readable field it is looked for
/// again, at each update, before live typing is off for the dictation.
const FIELD_SEARCH: Duration = Duration::from_secs(5);
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
    /// Unbounded, so a caption, a stop or a cancel is never dropped or
    /// waited on: the typist takes everything queued at once whenever it is
    /// free, and a dictation's captions are few.
    tx: Sender<Msg>,
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
    let (tx, rx) = channel();
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
    // Drafts are typed too, but a final is only ever the accurate
    // recognizer's (the engine never sends a preview final).
    if caption.track != "mic" || caption.text.trim().is_empty() || (caption.preview && caption.is_final) {
        return;
    }
    let typists = typists();
    let Some(entry) = typists.iter().find(|entry| entry.id == caption.session_id) else { return };
    // Fails only once the typist is gone.
    let _ = entry.tx.send(Msg::Caption(caption.clone()));
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
        // Never blocks. The typist takes the words back once it is free.
        let _ = entry.tx.send(Msg::Cancel);
    }
}

fn take(session_id: &str) -> Option<Entry> {
    let mut typists = typists();
    let at = typists.iter().position(|entry| entry.id == session_id)?;
    Some(typists.remove(at))
}

/// Where the typist is with its field.
enum Field {
    /// Not found yet: it is looked for from the draft's first update, in
    /// the app the dictation will paste into. Holds when a lookup first
    /// found no readable field.
    Unknown(Option<std::time::Instant>),
    Typing(LiveField),
    /// Typing stopped for this dictation; the field is kept so the end can
    /// still replace what was typed, should it be untouched after all.
    Stopped(Option<LiveField>),
}

fn typist(session_id: &str, rx: Receiver<Msg>, shared: &Shared) {
    let mut heard = Heard::default();
    let mut field = Field::Unknown(None);
    let mut pace = Pace::default();
    loop {
        let msg = match rx.recv_timeout(IDLE) {
            Ok(msg) => msg,
            // A dictation this quiet can no longer be delivered (IDLE is
            // past `dictation::DELIVER_WINDOW`): let its field go. Its
            // words stay in it, and `finish` copies rather than pastes.
            Err(RecvTimeoutError::Timeout) => return pace.report(session_id),
            // Replaced or cancelled: whatever was typed stays as it is.
            Err(RecvTimeoutError::Disconnected) => return pace.report(session_id),
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
            pace.report(session_id);
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
        let text = heard.text();
        // Only updates that type count: finding the field is timed apart.
        let typing = matches!(field, Field::Typing(_)) && !text.is_empty();
        let began = std::time::Instant::now();
        field = type_into(session_id, field, &text, shared);
        if typing && matches!(field, Field::Typing(_)) {
            pace.add(began.elapsed());
        }
    }
}

/// How long typing into the field took, for the log: a typist slower than
/// the words come in falls behind the speech.
#[derive(Default)]
struct Pace {
    updates: u32,
    total: Duration,
    slowest: Duration,
}

impl Pace {
    fn add(&mut self, took: Duration) {
        self.updates += 1;
        self.total += took;
        self.slowest = self.slowest.max(took);
    }

    fn report(&self, session_id: &str) {
        if self.updates > 0 {
            tracing::info!(
                session_id,
                updates = self.updates,
                average_ms = (self.total / self.updates).as_millis() as u64,
                slowest_ms = self.slowest.as_millis() as u64,
                "live typing pace"
            );
        }
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
        Field::Unknown(missed) => {
            match crate::dictation::live_typing_target(session_id) {
                // Not in front yet: look again at the next words.
                Ok(false) => return Field::Unknown(missed),
                Err(why) => {
                    tracing::info!(session_id, "live typing off for this dictation: {why}");
                    return Field::Stopped(None);
                }
                Ok(true) => {}
            }
            match LiveField::focused() {
                Some(live) => live,
                // A field an app is still exposing, or focus passing through:
                // look again at the next update, for a while.
                None if missed.is_none_or(|at| at.elapsed() < FIELD_SEARCH) => {
                    return Field::Unknown(missed.or_else(|| Some(std::time::Instant::now())));
                }
                None => {
                    tracing::info!(session_id, "live typing off for this dictation: the field can't be read back");
                    return Field::Stopped(None);
                }
            }
        }
    };
    // The field is found at the draft's first update, before any of its
    // words are agreed on, so that finding it doesn't hold up the first ones.
    if text.is_empty() {
        return Field::Typing(live);
    }
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

/// What a dictation has heard so far, as `CaptionLog` keeps it: a final for
/// the same phrase replaces the earlier one and the draft under it.
#[derive(Default)]
struct Heard {
    finals: Vec<Caption>,
    drafts: Vec<Draft>,
}

/// A phrase not settled yet, as the live draft last read, and the words of it
/// that are typed.
struct Draft {
    caption: Caption,
    words: Vec<String>,
}

impl Heard {
    fn add(&mut self, caption: Caption) {
        if caption.is_final {
            // The engine starts each draft where the settled words end, so one
            // starting earlier is this phrase's, even when unlike it.
            self.drafts.retain(|draft| draft.caption.start_ms >= caption.end_ms && !same_phrase(&draft.caption, &caption));
            self.finals.retain(|previous| !same_phrase(previous, &caption));
            self.finals.push(caption);
            return;
        }
        // A late update for a phrase that has settled since.
        let settled = self.finals.iter().map(|c| c.end_ms).max().unwrap_or(i64::MIN);
        if caption.start_ms < settled || self.finals.iter().any(|final_| same_phrase(final_, &caption)) {
            return;
        }
        let earlier = self.drafts.iter().position(|draft| same_phrase(&draft.caption, &caption));
        let words = match earlier.map(|at| self.drafts.remove(at)) {
            // Words two updates in a row agree on: one still being said
            // changes from one to the next.
            Some(draft) => {
                let agreed: Vec<String> = draft
                    .caption
                    .text
                    .split_whitespace()
                    .zip(caption.text.split_whitespace())
                    .take_while(|(a, b)| a == b)
                    .map(|(a, _)| a.to_string())
                    .collect();
                // A draft that drops words for an update never takes typed
                // ones back; its final, or a longer revision, will.
                if agreed.len() >= draft.words.len() { agreed } else { draft.words }
            }
            None => Vec::new(),
        };
        self.drafts.retain(|draft| !same_phrase(&draft.caption, &caption));
        self.drafts.push(Draft { caption, words });
    }

    fn text(&self) -> String {
        let finals = self.finals.iter().map(|c| (c.start_ms, c.end_ms, c.text.trim().to_string()));
        let drafts = self.drafts.iter().map(|d| (d.caption.start_ms, d.caption.end_ms, d.words.join(" ")));
        let mut phrases: Vec<(i64, i64, String)> = finals.chain(drafts).collect();
        phrases.sort_by_key(|(start, end, _)| (*start, *end));
        phrases.into_iter().map(|(_, _, text)| text).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
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

    fn draft(start_ms: i64, end_ms: i64, text: &str) -> Caption {
        Caption { is_final: false, ..final_(start_ms, end_ms, text) }
    }

    #[test]
    fn draft_words_are_typed_once_two_updates_agree() {
        let mut heard = Heard::default();
        heard.add(draft(0, 1_000, "Send"));
        assert_eq!(heard.text(), "", "one update says nothing yet");
        heard.add(draft(0, 2_000, "Send Sam the"));
        assert_eq!(heard.text(), "Send");
        heard.add(draft(0, 3_000, "Send Sam the desk before"));
        assert_eq!(heard.text(), "Send Sam the");
        // A word revised in the draft is retyped once updates agree on it.
        heard.add(draft(0, 3_500, "Send Sam the deck before"));
        assert_eq!(heard.text(), "Send Sam the");
        heard.add(draft(0, 4_000, "Send Sam the deck before Friday"));
        assert_eq!(heard.text(), "Send Sam the deck before");
    }

    #[test]
    fn a_draft_that_drops_words_keeps_the_typed_ones() {
        let mut heard = Heard::default();
        heard.add(draft(0, 1_000, "Okay so the posters"));
        heard.add(draft(0, 2_000, "Okay so the posters look"));
        assert_eq!(heard.text(), "Okay so the posters");
        heard.add(draft(0, 2_500, "Okay so"));
        assert_eq!(heard.text(), "Okay so the posters");
    }

    #[test]
    fn a_final_replaces_its_draft_and_the_next_draft_follows_it() {
        let mut heard = Heard::default();
        heard.add(draft(0, 1_000, "Send Sam the desk"));
        heard.add(draft(0, 2_000, "Send Sam the desk"));
        heard.add(final_(0, 1_900, "Send Sam the deck."));
        assert_eq!(heard.text(), "Send Sam the deck.");
        // A late update for the settled phrase changes nothing.
        heard.add(draft(0, 2_000, "Send Sam the desk"));
        assert_eq!(heard.text(), "Send Sam the deck.");
        // One unlike it but under its audio is its draft all the same.
        heard.add(draft(1_500, 2_500, "Sam the desk and"));
        heard.add(draft(1_500, 2_600, "Sam the desk and"));
        heard.add(final_(1_500, 1_950, "Tomorrow."));
        assert_eq!(heard.text(), "Send Sam the deck. Tomorrow.");
        heard.add(draft(2_000, 3_000, "Before Friday"));
        heard.add(draft(2_000, 3_500, "Before Friday please"));
        assert_eq!(heard.text(), "Send Sam the deck. Tomorrow. Before Friday");
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
    fn only_mic_words_for_the_current_dictation_are_queued() {
        let (tx, rx) = channel();
        // Marked typed so another test's registering can't evict it.
        let shared = Arc::new(Shared::default());
        shared.typed.store(true, Ordering::SeqCst);
        typists().push(Entry { id: "s".into(), tx, shared });
        let mut other = final_(0, 500, "hi");
        other.session_id = "other".into();
        caption(&other);
        let mut theirs = final_(0, 500, "hi");
        theirs.track = "system".into();
        caption(&theirs);
        caption(&final_(0, 500, "  "));
        let mut preview = draft(0, 500, "hi there");
        preview.preview = true;
        caption(&preview);
        let mut preview_final = final_(0, 500, "hi there you");
        preview_final.preview = true;
        caption(&preview_final);
        caption(&final_(0, 500, "hello"));
        assert!(matches!(rx.try_recv(), Ok(Msg::Caption(c)) if c.text == "hi there"));
        assert!(matches!(rx.try_recv(), Ok(Msg::Caption(c)) if c.text == "hello"));
        assert!(rx.try_recv().is_err());
        cancel("someone else");
        assert!(typists().iter().any(|entry| entry.id == "s"), "another dictation's cancel leaves this one");
        cancel("s");
        assert!(!typists().iter().any(|entry| entry.id == "s"));
    }

    fn entry(id: &str, typed: bool) -> (Entry, Receiver<Msg>) {
        let (tx, rx) = channel();
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
