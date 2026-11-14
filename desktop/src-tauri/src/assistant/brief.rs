//! Briefs (docs/plans/macro-awareness.md P): a short written summary of a piece of work,
//! so Eavesy can find it later. For now the only work briefed is Eavesy's own
//! conversation, once it has been quiet for a while and again when you clear it.
//!
//! The cloud writes the brief and keeps nothing; the brief lives in the local database
//! (saved.rs). Briefs follow the Memory switch: with memory off, none are written.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, WebviewWindow};

use super::saved::{self, Brief, Kept, CONVERSATION};
use super::thread::{self, Entry, Snapshot};

/// How long a conversation is quiet before it's briefed.
const QUIET: Duration = Duration::from_secs(120);
/// Lines of the conversation sent at most, and their size in all as JSON: the newest
/// ones. With the previous brief at its largest, the request stays under the cloud's
/// 128 KB cap.
const SENT_ENTRIES: usize = 400;
const SENT_BYTES: usize = 80 * 1024;
/// The largest previous brief sent along. A bigger one (dozens of very long links) is
/// left out, and the brief is written from the entries alone.
const PREVIOUS_BYTES: usize = 32 * 1024;
/// Briefs listed in Settings.
const LISTED: usize = 200;

/// The briefs changed: Settings reads them again.
const EVENT_CHANGED: &str = "assistant:briefs";

pub(super) fn changed(app: &AppHandle) {
    let _ = app.emit(EVENT_CHANGED, ());
}

#[derive(Serialize)]
struct BriefRequest<'a> {
    kind: &'static str,
    entries: &'a [Entry],
    #[serde(skip_serializing_if = "Option::is_none")]
    previous: Option<&'a Brief>,
}

#[derive(Deserialize)]
struct BriefResponse {
    brief: Brief,
}

/// The newest entries that fit, and whether older ones were left out. The newest one
/// always goes, whatever its size: the cloud takes no request without an entry, and one
/// entry is far under the request's limit. thread.rs cuts an entry to `ENTRY_CHARS`
/// characters, and a character is at most six bytes of JSON (a control character,
/// escaped), so one entry is under 25 KB.
fn newest(entries: &[Entry]) -> (&[Entry], bool) {
    let mut size = 0;
    let mut start = entries.len();
    while start > 0 && entries.len() - start < SENT_ENTRIES {
        size += serde_json::to_string(&entries[start - 1]).map_or(usize::MAX / 2, |json| json.len() + 1);
        if size > SENT_BYTES && start < entries.len() {
            break;
        }
        start -= 1;
    }
    (&entries[start..], start > 0)
}

async fn ask(app: &AppHandle, entries: &[Entry], previous: Option<&Brief>) -> Result<Brief, String> {
    let credential = crate::settings::device_credential(app).ok_or("not signed in")?;
    let client = crate::sync::http_client().map_err(|error| error.to_string())?;
    let response = client
        .post(crate::base_url::join(&credential.base, "/api/assistant/brief"))
        .timeout(Duration::from_secs(60))
        .bearer_auth(credential.token)
        .json(&BriefRequest { kind: CONVERSATION, entries, previous })
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the cloud answered {}", response.status()));
    }
    response.json::<BriefResponse>().await.map(|body| body.brief).map_err(|error| error.to_string())
}

/// Writes the brief of the conversation in `snapshot`, unless one already reads that far.
/// Blocking. A failure is logged and the brief already kept stays.
///
/// A try that fails is made again, so this can block for a few minutes. After the last
/// one the brief already kept stays, until the next answer, Clear or restart asks again.
/// The conversation counts as being briefed (thread.rs `briefing`) until this returns,
/// so Forget All reaches it through every try.
fn write(app: &AppHandle, snapshot: Snapshot) {
    for attempt in 1..=TRIES {
        if write_once(app, &snapshot) == Wrote::Settled {
            break;
        }
        if attempt < TRIES {
            std::thread::sleep(RETRY);
        }
    }
    thread::done_briefing(app, &snapshot.conversation);
}

/// How one try at a brief ended.
#[derive(Debug, PartialEq, Eq)]
enum Wrote {
    /// Stored, or there was nothing to do: memory is off, a brief already reads this far,
    /// or you forgot the conversation meanwhile.
    Settled,
    /// The cloud or the database didn't answer. Worth another try.
    Failed,
}

/// Tries at one brief, and the wait between them.
const TRIES: usize = 3;
const RETRY: Duration = Duration::from_secs(60);

fn write_once(app: &AppHandle, snapshot: &Snapshot) -> Wrote {
    if !crate::settings::load(app).assistant_memory() {
        return Wrote::Settled;
    }
    let previous = match crate::sqlite::with_open(app, |conn| saved::brief(conn, CONVERSATION, &snapshot.conversation)).and_then(|result| result) {
        Ok(previous) => previous,
        Err(error) => {
            tracing::warn!(%error, "assistant: couldn't read the brief");
            return Wrote::Failed;
        }
    };
    if previous.as_ref().is_some_and(|kept| kept.covers >= snapshot.covers) {
        return Wrote::Settled;
    }
    // Asked again at the start of every try, so a later try doesn't send words you have
    // since marked "Don't remember this", taken off the record or forgotten. A request
    // already on its way can't be called back: the cloud keeps nothing, and its answer is
    // refused below, where the same check runs again before anything is stored.
    match thread::store_brief(app, snapshot, |conn| saved::forgotten(conn, CONVERSATION, &snapshot.conversation).map(|forgotten| !forgotten)) {
        Ok(true) => {}
        Ok(false) => return Wrote::Settled,
        Err(error) => {
            tracing::warn!(%error, "assistant: couldn't read the brief");
            return Wrote::Failed;
        }
    }
    let (entries, cut) = newest(&snapshot.entries);
    // The earlier brief goes along only when the entries aren't the whole conversation.
    let earlier = previous
        .as_ref()
        .map(|kept| &kept.brief)
        .filter(|_| cut || snapshot.partial)
        .filter(|brief| serde_json::to_string(brief).is_ok_and(|json| json.len() <= PREVIOUS_BYTES));
    let brief = match tauri::async_runtime::block_on(ask(app, entries, earlier)) {
        Ok(brief) => brief,
        Err(error) => {
            tracing::warn!(%error, "assistant: the brief wasn't written");
            return Wrote::Failed;
        }
    };
    // Memory may have been switched off while the cloud was writing.
    if !crate::settings::load(app).assistant_memory() {
        return Wrote::Settled;
    }
    // Refused when an exchange it read was marked "Don't remember this" meanwhile
    // (thread.rs), or when you forgot this conversation or took it off the record (saved.rs).
    let stored = thread::store_brief(app, snapshot, |conn| saved::put_brief(conn, CONVERSATION, &snapshot.conversation, &brief, snapshot.covers, snapshot.updated_ms, super::now_ms()));
    match stored {
        Ok(true) => {
            changed(app);
            Wrote::Settled
        }
        Ok(false) => Wrote::Settled,
        Err(error) => {
            tracing::warn!(%error, "assistant: couldn't save the brief");
            Wrote::Failed
        }
    }
}

/// Writes this conversation's brief now, off the calling thread: for Clear, which has
/// already let the conversation go and marked it as being briefed.
pub(super) fn write_soon(app: &AppHandle, snapshot: Snapshot) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write(&app, snapshot);
        // The list changed either way: Clear ended a conversation.
        changed(&app);
    });
}

/// Briefs the conversation once it has been quiet for a while. Called after each answer
/// and after a restart; if something is said in the meantime, that answer's call takes over.
pub(super) fn schedule(app: &AppHandle) {
    // The one wait in progress. A newer answer replaces it, so a run of messages leaves
    // one sleeping task, not one each. A brief already being written isn't stopped by
    // this: that part runs on its own thread.
    static WAITING: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = std::sync::Mutex::new(None);
    let Some(since) = thread::newest(app) else { return };
    let app = app.clone();
    let mut waiting = WAITING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(earlier) = waiting.take() {
        earlier.abort();
    }
    *waiting = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUIET).await;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Some(snapshot) = thread::quiet_snapshot(&app, since) {
                write(&app, snapshot);
            }
        })
        .await;
    }));
}

/// The briefs Eavesy keeps, newest first.
#[tauri::command(async)]
pub fn assistant_briefs(app: AppHandle, window: WebviewWindow) -> Result<Vec<Kept>, String> {
    super::from_ui(&window)?;
    crate::sqlite::with_open(&app, |conn| saved::briefs(conn, LISTED)).and_then(|result| result)
}

/// Forgets one brief. Its source isn't briefed again.
#[tauri::command(async)]
pub fn assistant_forget_brief(app: AppHandle, window: WebviewWindow, source_type: String, source_id: String) -> Result<(), String> {
    super::from_ui(&window)?;
    let forgot = crate::sqlite::with_open(&app, |conn| saved::forget_brief(conn, &source_type, &source_id)).and_then(|result| result)?;
    if forgot {
        super::log("You", "assistant.forget_brief", &source_type, "ran", None);
    }
    changed(&app);
    Ok(())
}

/// Forgets every brief, the open conversation's included: it isn't briefed again either.
#[tauri::command(async)]
pub fn assistant_forget_briefs(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    super::from_ui(&window)?;
    let forgot = thread::forget_briefs(&app)?;
    super::log("You", "assistant.forget_brief", &format!("all {forgot}"), "ran", None);
    changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str) -> Entry { Entry { role: "you", text: text.into() } }

    #[test]
    fn the_newest_entries_are_sent_and_the_cut_is_known() {
        let few = vec![entry("a"), entry("b")];
        assert_eq!(newest(&few), (&few[..], false));
        let many: Vec<Entry> = (0..SENT_ENTRIES + 5).map(|i| entry(&i.to_string())).collect();
        let (sent, cut) = newest(&many);
        assert_eq!((sent.len(), cut, sent.last().unwrap().text.as_str()), (SENT_ENTRIES, true, "404"));
        let big = vec![entry(&"x".repeat(SENT_BYTES)), entry("last")];
        let (sent, cut) = newest(&big);
        assert_eq!((sent.len(), cut, sent[0].text.as_str()), (1, true, "last"));
        // The newest entry goes even when it alone is over the size: never an empty request.
        let huge = vec![entry("older"), entry(&"x".repeat(SENT_BYTES * 2))];
        let (sent, cut) = newest(&huge);
        assert_eq!((sent.len(), cut), (1, true));
        // The longest entry thread.rs makes, at its largest as JSON, fits many times over.
        let longest = serde_json::to_string(&entry(&"\u{1}".repeat(thread::ENTRY_CHARS))).unwrap();
        assert!(longest.len() < 25 * 1024 && 25 * 1024 * 3 < SENT_BYTES, "{}", longest.len());
        // Counted as the JSON that's sent: a newline is two bytes there.
        let escaped: Vec<Entry> = (0..10).map(|_| entry(&"\n".repeat(SENT_BYTES / 16))).collect();
        assert_eq!(newest(&escaped).0.len(), 7);
    }

    #[test]
    fn the_request_matches_the_cloud_shape() {
        let entries = [entry("hello")];
        let json = serde_json::to_value(BriefRequest { kind: CONVERSATION, entries: &entries, previous: None }).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "conversation", "entries": [{ "role": "you", "text": "hello" }] }));
        let brief: BriefResponse = serde_json::from_value(serde_json::json!({ "brief": {
            "title": "T", "summary": "S", "intent": "I", "outcome": { "status": "in_progress", "text": "O" },
            "decisions": [{ "text": "D", "kind": "stated" }], "facts": [], "links": [], "keywords": ["k"],
        } })).unwrap();
        assert_eq!(brief.brief.outcome.status, saved::Status::InProgress);
    }
}
