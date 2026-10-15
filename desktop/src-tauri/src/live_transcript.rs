//! The transcript of a recording in progress: on-device caption finals stored
//! as provisional lines, replaced range by range as cloud lines arrive from
//! `/api/sessions/:id/transcript?since=`. The cloud transcript stays the
//! record; this only fills the gap until it gets there.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::captions::Caption;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS live_lines (
  session_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  track TEXT,
  text TEXT NOT NULL,
  provisional INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_lines_session ON live_lines(session_id, start_ms);
CREATE TABLE IF NOT EXISTS live_cursors (
  session_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL
);
";

/// Provisional lines this far (in recording time) behind the newest cloud range
/// were never replaced: the cloud heard nothing there, or that segment failed.
const EXPIRE_BEHIND_MS: i64 = 5 * 60 * 1_000;

/// Caption finals waiting to be stored; past this they are dropped.
const CAPTION_QUEUE: usize = 256;

/// Stores caption finals off the capture engine's stdout reader. That thread
/// must never wait on the database: if it stops reading, the pipe fills, the
/// engine blocks writing events, and capture stalls. So it only `push`es,
/// which never blocks and drops the caption when the queue is full.
pub struct CaptionWriter {
    tx: SyncSender<Caption>,
    dropped: Arc<AtomicUsize>,
}

impl CaptionWriter {
    pub fn spawn(app: AppHandle) -> Self {
        Self::with_store(CAPTION_QUEUE, move |caption: Caption| {
            let session_id = caption.session_id.clone();
            match crate::sqlite::with_open(&app, |conn| record_caption(conn, &caption)) {
                Ok(Ok(())) => {
                    let _ = app.emit("recording:live_transcript", &session_id);
                }
                Ok(Err(error)) | Err(error) => eprintln!("{error}"),
            }
        })
    }

    fn with_store(capacity: usize, mut store: impl FnMut(Caption) + Send + 'static) -> Self {
        let (tx, rx) = sync_channel::<Caption>(capacity);
        std::thread::spawn(move || {
            while let Ok(caption) = rx.recv() {
                store(caption);
            }
        });
        Self { tx, dropped: Arc::new(AtomicUsize::new(0)) }
    }

    /// Queues a final for storing; never blocks. Returns false if it was dropped.
    pub fn push(&self, caption: Caption) -> bool {
        match self.tx.try_send(caption) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                false
            }
        }
    }

    pub fn dropped(&self) -> usize {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// How often a recording's cloud lines are checked for.
const POLL_EVERY: Duration = Duration::from_secs(5);
/// An older server without the route answers 404; ask again much later.
const MISSING_ROUTE_BACKOFF: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveLine {
    pub start_ms: i64,
    pub end_ms: i64,
    pub track: Option<String>,
    pub text: String,
    pub provisional: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudLine {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    #[serde(default)]
    pub speaker_id: Option<String>,
}

/// What the transcript route answered.
#[derive(Debug)]
pub enum Fetched {
    Delta(Delta),
    /// The meeting was deleted or never reached the cloud: stop asking for it.
    MeetingGone,
    /// The server predates the route: ask again much later.
    RouteMissing,
}

/// Reads a 404: the route says `meeting_not_found`; anything else is a server
/// that does not have the route at all.
pub fn not_found(body: &str) -> Fetched {
    #[derive(Deserialize)]
    struct Error {
        error: String,
    }
    match serde_json::from_str::<Error>(body) {
        Ok(error) if error.error == "meeting_not_found" => Fetched::MeetingGone,
        _ => Fetched::RouteMissing,
    }
}

#[derive(Debug, Deserialize)]
pub struct Delta {
    pub cursor: i64,
    #[serde(default)]
    pub ranges: Vec<Range>,
    #[serde(default)]
    pub lines: Vec<CloudLine>,
}

/// Stores a caption final, unless cloud lines already cover that moment.
pub fn record_caption(conn: &Connection, caption: &Caption) -> Result<(), String> {
    if !caption.is_final || caption.text.trim().is_empty() {
        return Ok(());
    }
    let mid = midpoint(caption.start_ms, caption.end_ms);
    conn.execute(
        "INSERT INTO live_lines (session_id, start_ms, end_ms, track, text, provisional)
         SELECT ?1, ?2, ?3, ?4, ?5, 1
         WHERE NOT EXISTS (SELECT 1 FROM live_lines WHERE session_id=?1 AND provisional=0
                           AND start_ms <= ?6 AND end_ms >= ?6)",
        params![caption.session_id, caption.start_ms, caption.end_ms, caption.track, caption.text.trim(), mid],
    )
    .map_err(|e| format!("store live caption: {e}"))?;
    Ok(())
}

/// Replaces everything inside each range with the cloud's lines for it.
/// Cloud lines go if they overlap a range at all (the server sends every line
/// overlapping it); a provisional line goes when its middle falls inside, so a
/// caption straddling the edge of what the cloud has done stays until it's covered.
pub fn apply_delta(conn: &mut Connection, session_id: &str, delta: &Delta) -> Result<bool, String> {
    let tx = conn.transaction().map_err(|e| format!("apply live transcript: {e}"))?;
    for range in &delta.ranges {
        tx.execute(
            "DELETE FROM live_lines WHERE session_id=?1 AND (
               (provisional=0 AND end_ms >= ?2 AND start_ms <= ?3)
               OR (provisional=1 AND (start_ms + end_ms) / 2 BETWEEN ?2 AND ?3))",
            params![session_id, range.from_ms, range.to_ms],
        )
        .map_err(|e| format!("clear live range: {e}"))?;
    }
    if let Some(newest) = delta.ranges.iter().map(|range| range.to_ms).max() {
        tx.execute(
            "DELETE FROM live_lines WHERE session_id=?1 AND provisional=1 AND end_ms < ?2",
            params![session_id, newest - EXPIRE_BEHIND_MS],
        )
        .map_err(|e| format!("expire live captions: {e}"))?;
    }
    let mut seen = HashSet::new();
    for line in &delta.lines {
        if !seen.insert((line.start_ms, line.text.as_str())) {
            continue;
        }
        tx.execute(
            "INSERT INTO live_lines (session_id, start_ms, end_ms, track, text, provisional)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![session_id, line.start_ms, line.end_ms, line.speaker_id, line.text.trim()],
        )
        .map_err(|e| format!("store cloud line: {e}"))?;
    }
    tx.execute(
        "INSERT INTO live_cursors (session_id, cursor) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET cursor=max(cursor, excluded.cursor)",
        params![session_id, delta.cursor],
    )
    .map_err(|e| format!("store live cursor: {e}"))?;
    tx.commit().map_err(|e| format!("apply live transcript: {e}"))?;
    Ok(!delta.ranges.is_empty() || !delta.lines.is_empty())
}

pub fn lines(conn: &Connection, session_id: &str) -> Result<Vec<LiveLine>, String> {
    let mut statement = conn
        .prepare(
            "SELECT start_ms, end_ms, track, text, provisional FROM live_lines
             WHERE session_id=?1 ORDER BY start_ms, provisional, rowid",
        )
        .map_err(|e| format!("read live transcript: {e}"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok(LiveLine {
                start_ms: row.get(0)?,
                end_ms: row.get(1)?,
                track: row.get(2)?,
                text: row.get(3)?,
                provisional: row.get::<_, i64>(4)? != 0,
            })
        })
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| format!("read live transcript: {e}"))?;
    Ok(rows)
}

pub fn cursor(conn: &Connection, session_id: &str) -> i64 {
    conn.query_row("SELECT cursor FROM live_cursors WHERE session_id=?1", params![session_id], |row| row.get(0))
        .unwrap_or(0)
}

/// Once the cloud transcript is final the recording's own transcript replaces this.
pub fn forget(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute_batch("SAVEPOINT forget_live")
        .and_then(|()| conn.execute("DELETE FROM live_lines WHERE session_id=?1", params![session_id]))
        .and_then(|_| conn.execute("DELETE FROM live_cursors WHERE session_id=?1", params![session_id]))
        .and_then(|_| conn.execute_batch("RELEASE forget_live"))
        .map_err(|e| format!("clear live transcript: {e}"))
}

/// Recordings still capturing that the cloud knows about.
fn recording_now(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, remote_meeting_id FROM recording_sessions
             WHERE status='recording' AND remote_meeting_id IS NOT NULL",
        )
        .map_err(|e| format!("list live recordings: {e}"))?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| format!("list live recordings: {e}"))?;
    Ok(rows)
}

fn midpoint(start_ms: i64, end_ms: i64) -> i64 {
    (start_ms + end_ms.max(start_ms)) / 2
}

#[tauri::command]
pub fn live_transcript(app: AppHandle, session_id: String) -> Result<Vec<LiveLine>, String> {
    crate::sqlite::with_open(&app, |conn| lines(conn, &session_id))?
}

/// Polls each recording in progress for cloud lines and swaps them in.
pub async fn run(app: AppHandle, api: crate::sync::Api) {
    let mut route_missing_since: Option<Instant> = None;
    let mut gone: HashSet<String> = HashSet::new();
    loop {
        tokio::time::sleep(POLL_EVERY).await;
        if route_missing_since.is_some_and(|since| since.elapsed() < MISSING_ROUTE_BACKOFF) {
            continue;
        }
        let Some(token) = crate::settings::device_token(&app) else { continue };
        let live = match crate::sqlite::with_open(&app, recording_now) {
            Ok(Ok(live)) => live,
            Ok(Err(error)) | Err(error) => {
                eprintln!("live transcript: {error}");
                continue;
            }
        };
        let live: Vec<_> = live.into_iter().filter(|(id, _)| !gone.contains(id)).collect();
        for (session_id, remote_id) in live {
            let since = crate::sqlite::with_open(&app, |conn| cursor(conn, &session_id)).unwrap_or(0);
            match api.transcript_delta(&token, &remote_id, since).await {
                Ok(Fetched::Delta(delta)) => {
                    let changed = crate::sqlite::with_open_mut(&app, |conn| apply_delta(conn, &session_id, &delta));
                    match changed {
                        Ok(Ok(true)) => {
                            let _ = app.emit("recording:live_transcript", &session_id);
                        }
                        Ok(Ok(false)) => {}
                        Ok(Err(error)) | Err(error) => eprintln!("live transcript: {error}"),
                    }
                }
                Ok(Fetched::MeetingGone) => {
                    gone.insert(session_id);
                }
                Ok(Fetched::RouteMissing) => route_missing_since = Some(Instant::now()),
                Err(error) => eprintln!("live transcript for {session_id}: {error:#}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn caption(text: &str, start_ms: i64, end_ms: i64) -> Caption {
        Caption {
            session_id: "rec".into(),
            track: "mic".into(),
            text: text.into(),
            is_final: true,
            start_ms,
            end_ms,
        }
    }

    fn cloud(start_ms: i64, text: &str) -> CloudLine {
        CloudLine { start_ms, end_ms: start_ms + 2_000, text: text.into(), speaker_id: None }
    }

    fn texts(conn: &Connection) -> Vec<(String, bool)> {
        lines(conn, "rec").unwrap().into_iter().map(|l| (l.text, l.provisional)).collect()
    }

    #[test]
    fn caption_finals_are_kept_as_provisional_lines() {
        let conn = db();
        record_caption(&conn, &caption("hello there", 0, 1_500)).unwrap();
        record_caption(&conn, &Caption { is_final: false, ..caption("partial", 2_000, 2_500) }).unwrap();
        record_caption(&conn, &caption("  ", 3_000, 3_500)).unwrap();
        assert_eq!(texts(&conn), vec![("hello there".into(), true)]);
    }

    #[test]
    fn cloud_lines_replace_the_captions_in_their_range_only() {
        let mut conn = db();
        record_caption(&conn, &caption("first minute", 5_000, 30_000)).unwrap();
        record_caption(&conn, &caption("straddles the edge", 55_000, 85_000)).unwrap();
        record_caption(&conn, &caption("second minute", 90_000, 110_000)).unwrap();
        let changed = apply_delta(
            &mut conn,
            "rec",
            &Delta {
                cursor: 1_000,
                ranges: vec![Range { from_ms: 0, to_ms: 65_000 }],
                lines: vec![cloud(4_000, "First minute."), cloud(40_000, "More.")],
            },
        )
        .unwrap();
        assert!(changed);
        assert_eq!(
            texts(&conn),
            vec![
                ("First minute.".into(), false),
                ("More.".into(), false),
                ("straddles the edge".into(), true),
                ("second minute".into(), true),
            ]
        );
        assert_eq!(cursor(&conn, "rec"), 1_000);
    }

    #[test]
    fn a_repeated_range_replaces_rather_than_duplicates() {
        let mut conn = db();
        let delta = Delta {
            cursor: 2_000,
            ranges: vec![Range { from_ms: 0, to_ms: 65_000 }],
            lines: vec![cloud(4_000, "Once."), cloud(4_000, "Once.")],
        };
        apply_delta(&mut conn, "rec", &delta).unwrap();
        apply_delta(&mut conn, "rec", &Delta { cursor: 1_500, ..delta }).unwrap();
        assert_eq!(texts(&conn), vec![("Once.".into(), false)]);
        assert_eq!(cursor(&conn, "rec"), 2_000, "the cursor never goes back");
    }

    #[test]
    fn an_echo_removed_in_the_cloud_disappears_here_too() {
        let mut conn = db();
        let range = Range { from_ms: 0, to_ms: 65_000 };
        apply_delta(&mut conn, "rec", &Delta { cursor: 1, ranges: vec![range], lines: vec![cloud(1_000, "echo"), cloud(1_200, "Real.")] }).unwrap();
        apply_delta(&mut conn, "rec", &Delta { cursor: 2, ranges: vec![range], lines: vec![cloud(1_200, "Real.")] }).unwrap();
        assert_eq!(texts(&conn), vec![("Real.".into(), false)]);
    }

    #[test]
    fn a_late_caption_does_not_come_back_over_cloud_lines() {
        let mut conn = db();
        apply_delta(&mut conn, "rec", &Delta { cursor: 1, ranges: vec![Range { from_ms: 0, to_ms: 65_000 }], lines: vec![cloud(0, "Cloud.")] }).unwrap();
        record_caption(&conn, &caption("late caption", 500, 1_500)).unwrap();
        assert_eq!(texts(&conn), vec![("Cloud.".into(), false)]);
    }

    #[test]
    fn nothing_new_reports_no_change_and_forget_clears() {
        let mut conn = db();
        assert!(!apply_delta(&mut conn, "rec", &Delta { cursor: 5, ranges: vec![], lines: vec![] }).unwrap());
        record_caption(&conn, &caption("x", 0, 1)).unwrap();
        forget(&conn, "rec").unwrap();
        assert!(texts(&conn).is_empty());
        assert_eq!(cursor(&conn, "rec"), 0);
    }

    #[test]
    fn captions_the_cloud_never_replaced_expire_once_it_is_well_past_them() {
        let mut conn = db();
        record_caption(&conn, &caption("in a failed segment", 10_000, 20_000)).unwrap();
        record_caption(&conn, &caption("recent", 280_000, 290_000)).unwrap();
        let range = |from_ms, to_ms| Range { from_ms, to_ms };
        apply_delta(&mut conn, "rec", &Delta { cursor: 1, ranges: vec![range(60_000, 125_000)], lines: vec![] }).unwrap();
        assert_eq!(texts(&conn).len(), 2, "not far enough past yet");
        apply_delta(&mut conn, "rec", &Delta { cursor: 2, ranges: vec![range(300_000, 365_000)], lines: vec![] }).unwrap();
        assert_eq!(texts(&conn), vec![("recent".into(), true)]);
    }

    #[test]
    fn a_blocked_caption_store_never_blocks_the_reader() {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let stored = Arc::new(AtomicUsize::new(0));
        let counted = stored.clone();
        let writer = CaptionWriter::with_store(4, move |_caption| {
            let _ = wait.recv();
            counted.fetch_add(1, Ordering::SeqCst);
        });
        let started = Instant::now();
        let accepted = (0..1_000).filter(|i| writer.push(caption("x", *i, *i + 1))).count();
        assert!(started.elapsed() < Duration::from_millis(500), "push must not wait on the store");
        assert!(accepted <= 5, "only what fits in the queue (plus the one being stored)");
        assert_eq!(writer.dropped(), 1_000 - accepted);
        drop(release);
    }

    #[test]
    fn a_deleted_meeting_is_told_apart_from_a_missing_route() {
        assert!(matches!(not_found(r#"{"error":"meeting_not_found"}"#), Fetched::MeetingGone));
        assert!(matches!(not_found(r#"{"error":"not_found"}"#), Fetched::RouteMissing));
        assert!(matches!(not_found("<html>Not Found</html>"), Fetched::RouteMissing));
    }

    #[test]
    fn delta_json_from_the_server_decodes() {
        let delta: Delta = serde_json::from_str(
            r#"{"status":"recording","summaryAt":null,"cursor":42,"ranges":[{"fromMs":0,"toMs":65000}],
                "lines":[{"id":"l1","meetingId":"m","startMs":10,"endMs":900,"text":"Hi.","speakerId":"mic","confidence":null}]}"#,
        )
        .unwrap();
        assert_eq!(delta.cursor, 42);
        assert_eq!(delta.ranges, vec![Range { from_ms: 0, to_ms: 65_000 }]);
        assert_eq!(delta.lines[0].speaker_id.as_deref(), Some("mic"));
    }
}
