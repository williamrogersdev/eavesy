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
use std::sync::Mutex;
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
    pub fn typed(&self) -> &str {
        ""
    }
    fn sync(&mut self, _text: &str) -> Result<bool, String> {
        Err("live typing is only supported on macOS".into())
    }
    pub fn finish(self, _app: &AppHandle, _text: &str) -> Result<(), String> {
        Err("live typing is only supported on macOS".into())
    }
}

enum Msg {
    Caption(Caption),
    /// The dictation stopped: hand back the field and what is in it.
    Finish(SyncSender<Option<LiveField>>),
}

/// Captions waiting for the typist; past this they are dropped (the next
/// one carries the whole text anyway).
const QUEUE: usize = 64;
/// How long a stopping dictation waits for typing under way to finish.
const FINISH_WAIT: Duration = Duration::from_secs(2);
/// Dictations whose typists are kept at once. A dictation still being
/// delivered keeps its field while the next one starts; past this the oldest
/// is let go (one that failed before it was delivered or disarmed).
const KEEP: usize = 4;

/// Dictations being typed, oldest first: id and the typist's queue.
static TYPISTS: Mutex<Vec<(String, SyncSender<Msg>)>> = Mutex::new(Vec::new());

fn typists() -> std::sync::MutexGuard<'static, Vec<(String, SyncSender<Msg>)>> {
    TYPISTS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts typing this dictation as it is heard, when the setting is on.
pub fn start(app: &AppHandle, session_id: &str) {
    if !crate::settings::load(app).type_as_you_talk() {
        return;
    }
    let (tx, rx) = sync_channel(QUEUE);
    {
        let mut typists = typists();
        typists.retain(|(id, _)| id != session_id);
        while typists.len() >= KEEP {
            typists.remove(0);
        }
        typists.push((session_id.to_string(), tx));
    }
    let session_id = session_id.to_string();
    std::thread::spawn(move || typist(&session_id, rx));
}

/// A caption from the capture engine. Never blocks: the engine's reader
/// calls this, and it must keep reading.
pub fn caption(caption: &Caption) {
    if !caption.is_final || caption.preview || caption.track != "mic" || caption.text.trim().is_empty() {
        return;
    }
    let typists = typists();
    let Some((_, tx)) = typists.iter().find(|(id, _)| *id == caption.session_id) else { return };
    if let Err(TrySendError::Full(_)) = tx.try_send(Msg::Caption(caption.clone())) {
        tracing::debug!("live typing is behind; a caption waits for the next");
    }
}

/// Stops typing this dictation and hands back the field its words went
/// into, once whatever typing was under way has landed. None when nothing
/// was typed for it.
pub fn finish(session_id: &str) -> Option<LiveField> {
    let tx = take(session_id)?;
    let (reply, answer) = sync_channel(1);
    tx.send(Msg::Finish(reply)).ok()?;
    answer.recv_timeout(FINISH_WAIT).ok().flatten().filter(|field| !field.typed().is_empty())
}

/// This dictation's words go nowhere near a field: stop typing them.
pub fn cancel(session_id: &str) {
    take(session_id);
}

fn take(session_id: &str) -> Option<SyncSender<Msg>> {
    let mut typists = typists();
    let at = typists.iter().position(|(id, _)| id == session_id)?;
    Some(typists.remove(at).1)
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

fn typist(session_id: &str, rx: Receiver<Msg>) {
    let mut heard = Heard::default();
    let mut field = Field::Unknown;
    loop {
        let msg = match rx.recv_timeout(Duration::from_secs(600)) {
            Ok(msg) => msg,
            Err(RecvTimeoutError::Timeout) => continue,
            // Replaced or cancelled: whatever was typed stays as it is.
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let mut finishing = None;
        match msg {
            Msg::Caption(caption) => heard.add(caption),
            Msg::Finish(reply) => finishing = Some(reply),
        }
        // Everything already queued is typed in one go.
        while finishing.is_none() {
            match rx.try_recv() {
                Ok(Msg::Caption(caption)) => heard.add(caption),
                Ok(Msg::Finish(reply)) => finishing = Some(reply),
                Err(_) => break,
            }
        }
        if let Some(reply) = finishing {
            let _ = reply.send(match field {
                Field::Typing(field) | Field::Stopped(Some(field)) => Some(field),
                _ => None,
            });
            return;
        }
        field = type_into(session_id, field, &heard.text());
    }
}

fn type_into(session_id: &str, field: Field, text: &str) -> Field {
    let mut live = match field {
        Field::Stopped(_) => return field,
        Field::Typing(live) => live,
        Field::Unknown => {
            match crate::dictation::live_typing_target(session_id) {
                // Not in front yet (or for Eavesy itself): look again at the next words.
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
    match live.sync(text) {
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
        typists().push(("s".into(), tx));
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
        assert!(typists().iter().any(|(id, _)| id == "s"), "another dictation's cancel leaves this one");
        cancel("s");
        assert!(!typists().iter().any(|(id, _)| id == "s"));
    }
}
