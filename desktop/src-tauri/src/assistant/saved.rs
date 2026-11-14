//! What Eavesy keeps in the local database (docs/plans/macro-awareness.md P): the
//! current conversation, so it survives a restart, and one brief per piece of work.
//!
//! Everything here takes a connection, so it runs against an in-memory database in tests.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::thread::{Message, Turn};

/// The brief of Eavesy's own conversation.
pub const CONVERSATION: &str = "conversation";

fn failed(what: &str) -> impl Fn(rusqlite::Error) -> String + '_ {
    move |error| format!("{what}: {error}")
}

/// The saved conversation: its id, the id its first turn had, and the turns still kept,
/// oldest first. A turn that no longer reads (an older build's shape) ends the list
/// there, so what loads is always a prefix.
pub fn load(conn: &Connection) -> Result<Option<(String, u64, Vec<Turn>)>, String> {
    let newest: Option<String> = conn
        .query_row("SELECT conversation_id FROM assistant_turns ORDER BY at_ms DESC, id DESC LIMIT 1", [], |row| row.get(0))
        .optional()
        .map_err(failed("read the saved conversation"))?;
    let Some(conversation) = newest else { return Ok(None) };
    let mut statement = conn
        .prepare("SELECT id, at_ms, message, spoken, notes, failed, unremembered, position FROM assistant_turns WHERE conversation_id=?1 ORDER BY id")
        .map_err(failed("read the saved conversation"))?;
    let rows = statement
        .query_map([&conversation], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, bool>(3)?, row.get::<_, String>(4)?, row.get::<_, bool>(5)?, row.get::<_, bool>(6)?, row.get::<_, i64>(7)?))
        })
        .map_err(failed("read the saved conversation"))?;
    let mut turns = Vec::new();
    let mut first_turn = 0;
    for row in rows {
        let (id, at_ms, message, spoken, notes, failed, unremembered, position) = row.map_err(self::failed("read the saved conversation"))?;
        let Ok(message) = serde_json::from_str::<Message>(&message) else { break };
        if turns.is_empty() {
            first_turn = (id - position).max(0) as u64;
        }
        let notes = serde_json::from_str(&notes).unwrap_or_default();
        turns.push(Turn { id: id.max(0) as u64, message, at_ms: at_ms.max(0) as u64, spoken, notes, failed, unremembered });
    }
    // Nothing of it reads: there's no conversation to bring back.
    Ok((!turns.is_empty()).then_some((conversation, first_turn, turns)))
}

/// Saves one turn, and drops the turns before `first_kept`: the same ones the thread
/// let go of. `position` is how many turns the conversation had before this one.
pub fn save_turn(conn: &Connection, conversation: &str, turn: &Turn, position: u64, first_kept: u64) -> Result<(), String> {
    let message = serde_json::to_string(&turn.message).map_err(|error| format!("save a turn: {error}"))?;
    let notes = serde_json::to_string(&turn.notes).map_err(|error| format!("save a turn: {error}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO assistant_turns (conversation_id, id, position, at_ms, message, spoken, notes, failed, unremembered)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![conversation, turn.id as i64, position as i64, turn.at_ms as i64, message, turn.spoken, notes, turn.failed, turn.unremembered],
    )
    .map_err(failed("save a turn"))?;
    // Anything from an earlier conversation goes too: only one is ever saved.
    conn.execute("DELETE FROM assistant_turns WHERE conversation_id<>?1 OR id<?2", params![conversation, first_kept as i64])
        .map_err(failed("trim the saved conversation"))?;
    Ok(())
}

pub fn set_spoken(conn: &Connection, conversation: &str, id: u64) -> Result<(), String> {
    conn.execute("UPDATE assistant_turns SET spoken=1 WHERE conversation_id=?1 AND id=?2", params![conversation, id as i64]).map(drop).map_err(failed("save a turn"))
}

pub fn set_unremembered(conn: &Connection, conversation: &str, id: u64) -> Result<(), String> {
    conn.execute("UPDATE assistant_turns SET unremembered=1 WHERE conversation_id=?1 AND id=?2", params![conversation, id as i64]).map(drop).map_err(failed("save a turn"))
}

/// Removes every saved turn: Clear, or going off the record.
pub fn clear_turns(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM assistant_turns", []).map(drop).map_err(failed("clear the saved conversation"))
}

/// How a piece of work stands (macro-awareness.md P1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    InProgress,
    Answered,
    Done,
    Partial,
    Blocked,
    Abandoned,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Status::InProgress => "in_progress",
            Status::Answered => "answered",
            Status::Done => "done",
            Status::Partial => "partial",
            Status::Blocked => "blocked",
            Status::Abandoned => "abandoned",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    pub status: Status,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub text: String,
    /// `stated`, `confirmed` or `assumed`.
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub label: String,
    pub url: String,
}

/// A brief as the cloud writes it (`Brief` in web/src/server/assistant.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brief {
    pub title: String,
    pub summary: String,
    pub intent: String,
    pub outcome: Outcome,
    #[serde(default)]
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub facts: Vec<String>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub keywords: Vec<String>,
}

impl Brief {
    /// What word search matches: the title, summary, intent and outcome first, then the
    /// facts, keywords and link labels.
    fn search_text(&self) -> String {
        let mut lines = vec![self.title.as_str(), self.summary.as_str(), self.intent.as_str(), self.outcome.text.as_str()];
        lines.extend(self.decisions.iter().map(|decision| decision.text.as_str()));
        lines.extend(self.facts.iter().map(String::as_str));
        lines.extend(self.keywords.iter().map(String::as_str));
        lines.extend(self.links.iter().map(|link| link.label.as_str()));
        lines.into_iter().filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n")
    }
}

/// A stored brief and what it's the brief of.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Kept {
    pub source_type: String,
    pub source_id: String,
    pub version: u32,
    /// How far into its source it reads: for a conversation, its newest turn's id.
    pub covers: u64,
    /// When its source last changed.
    pub source_updated_ms: u64,
    pub brief: Brief,
}

/// Stores a brief. One that reads less of its source than the brief already kept
/// changes nothing, so a slow answer never replaces a newer one; and nothing is stored
/// for a source you had forgotten. True when stored.
pub fn put_brief(conn: &Connection, source_type: &str, source_id: &str, brief: &Brief, covers: u64, source_updated_ms: u64, now_ms: u64) -> Result<bool, String> {
    let content = serde_json::to_string(brief).map_err(|error| format!("save a brief: {error}"))?;
    let changed = conn
        .execute(
            // One statement, so the check for a forgotten source and the write can't come apart.
            "INSERT INTO briefs (source_type, source_id, version, title, status, content, search_text, covers, source_updated_ms, updated_ms)
             SELECT ?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             WHERE NOT EXISTS (SELECT 1 FROM brief_skips WHERE source_type=?1 AND source_id=?2)
             ON CONFLICT(source_type, source_id) DO UPDATE SET
               version=briefs.version+1, title=excluded.title, status=excluded.status, content=excluded.content,
               search_text=excluded.search_text, covers=excluded.covers, source_updated_ms=excluded.source_updated_ms,
               updated_ms=excluded.updated_ms
             WHERE excluded.covers>=briefs.covers",
            params![source_type, source_id, brief.title, brief.outcome.status.as_str(), content, brief.search_text(), covers as i64, source_updated_ms as i64, now_ms as i64],
        )
        .map_err(failed("save a brief"))?;
    Ok(changed > 0)
}

fn kept(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<Kept>> {
    let content: String = row.get(5)?;
    // A brief an older build wrote in another shape is skipped, not an error.
    let Ok(brief) = serde_json::from_str::<Brief>(&content) else { return Ok(None) };
    Ok(Some(Kept {
        source_type: row.get(0)?,
        source_id: row.get(1)?,
        version: row.get::<_, i64>(2)?.max(0) as u32,
        covers: row.get::<_, i64>(3)?.max(0) as u64,
        source_updated_ms: row.get::<_, i64>(4)?.max(0) as u64,
        brief,
    }))
}

const KEPT_COLUMNS: &str = "source_type, source_id, version, covers, source_updated_ms, content";

pub fn brief(conn: &Connection, source_type: &str, source_id: &str) -> Result<Option<Kept>, String> {
    conn.query_row(&format!("SELECT {KEPT_COLUMNS} FROM briefs WHERE source_type=?1 AND source_id=?2"), params![source_type, source_id], kept)
        .optional()
        .map(Option::flatten)
        .map_err(failed("read a brief"))
}

/// The newest `limit` briefs that read, by when their source last changed.
pub fn briefs(conn: &Connection, limit: usize) -> Result<Vec<Kept>, String> {
    let mut statement = conn
        .prepare(&format!("SELECT {KEPT_COLUMNS} FROM briefs ORDER BY source_updated_ms DESC, source_id"))
        .map_err(failed("read the briefs"))?;
    let rows = statement.query_map([], kept).map_err(failed("read the briefs"))?;
    let mut briefs = Vec::new();
    // The limit counts briefs that read, so one in an older shape doesn't hide a newer one.
    for row in rows {
        if briefs.len() == limit {
            break;
        }
        briefs.extend(row.map_err(failed("read the briefs"))?);
    }
    Ok(briefs)
}

/// Removes a source's brief and keeps one from being written for it again: an answer
/// already on its way, or the next time the source goes quiet. True when there was one
/// to remove.
pub fn forget_brief(conn: &Connection, source_type: &str, source_id: &str) -> Result<bool, String> {
    conn.execute("INSERT OR IGNORE INTO brief_skips (source_type, source_id) VALUES (?1, ?2)", params![source_type, source_id]).map_err(failed("forget a brief"))?;
    conn.execute("DELETE FROM briefs WHERE source_type=?1 AND source_id=?2", params![source_type, source_id]).map(|n| n > 0).map_err(failed("forget a brief"))
}

/// Removes a source's brief so the next one is written from scratch. Unlike
/// `forget_brief`, the source may be briefed again.
pub fn drop_brief(conn: &Connection, source_type: &str, source_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM briefs WHERE source_type=?1 AND source_id=?2", params![source_type, source_id]).map(drop).map_err(failed("drop a brief"))
}

/// Forgets every brief, and each of `open` (sources of `source_type` that are still open
/// or being briefed) as `forget_brief` does. How many stored briefs went.
pub fn forget_briefs(conn: &Connection, source_type: &str, open: &[&str]) -> Result<usize, String> {
    for source_id in open {
        conn.execute("INSERT OR IGNORE INTO brief_skips (source_type, source_id) VALUES (?1, ?2)", params![source_type, source_id]).map_err(failed("forget the briefs"))?;
    }
    conn.execute("INSERT OR IGNORE INTO brief_skips (source_type, source_id) SELECT source_type, source_id FROM briefs", []).map_err(failed("forget the briefs"))?;
    conn.execute("DELETE FROM briefs", []).map_err(failed("forget the briefs"))
}

#[cfg(test)]
mod tests {
    use super::super::thread::{Block, Role};
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../schema.sql")).unwrap();
        conn
    }

    fn turn(id: u64, role: Role, text: &str) -> Turn {
        Turn { id, message: Message { role, content: vec![Block::Text { text: text.into() }] }, at_ms: 100 + id, spoken: false, notes: vec!["a card ran".into()], failed: false, unremembered: false }
    }

    fn a_brief(title: &str) -> Brief {
        Brief {
            title: title.into(),
            summary: "Looked at why the HUD sticks.".into(),
            intent: "Fix the HUD".into(),
            outcome: Outcome { status: Status::InProgress, text: "Cause found.".into() },
            decisions: vec![Decision { text: "Start with phase sync".into(), kind: "stated".into() }],
            facts: vec!["hud.rs owns the phase".into()],
            links: vec![Link { label: "The issue".into(), url: "https://example.com/7".into() }],
            keywords: vec!["hud".into()],
        }
    }

    #[test]
    fn a_conversation_comes_back_as_it_was_saved() {
        let conn = db();
        assert_eq!(load(&conn).unwrap(), None);
        save_turn(&conn, "c1", &turn(0, Role::User, "hello"), 0, 0).unwrap();
        save_turn(&conn, "c1", &turn(1, Role::Assistant, "hi"), 1, 0).unwrap();
        set_spoken(&conn, "c1", 1).unwrap();
        set_unremembered(&conn, "c1", 0).unwrap();
        let (id, first_turn, turns) = load(&conn).unwrap().unwrap();
        assert_eq!((id.as_str(), first_turn), ("c1", 0));
        assert_eq!(turns.len(), 2);
        assert!(turns[0].unremembered && !turns[0].spoken);
        assert!(turns[1].spoken);
        assert_eq!(turns[0].notes, vec!["a card ran".to_string()]);
        assert_eq!(turns[1].message, turn(1, Role::Assistant, "hi").message);
    }

    #[test]
    fn saving_drops_what_the_thread_dropped_and_any_older_conversation() {
        let conn = db();
        // A conversation that began at turn 7, after a Clear.
        for id in 7..11 {
            save_turn(&conn, "old", &turn(id, Role::User, "x"), id - 7, 7).unwrap();
        }
        save_turn(&conn, "old", &turn(11, Role::User, "x"), 4, 10).unwrap();
        let (_, first_turn, turns) = load(&conn).unwrap().unwrap();
        assert_eq!(turns.iter().map(|turn| turn.id).collect::<Vec<_>>(), vec![10, 11]);
        assert_eq!(first_turn, 7, "it still knows where it began, so the brief knows turns are missing");
        save_turn(&conn, "new", &turn(12, Role::User, "fresh"), 0, 12).unwrap();
        let (id, first_turn, turns) = load(&conn).unwrap().unwrap();
        assert_eq!((id.as_str(), first_turn, turns.len()), ("new", 12, 1));
        clear_turns(&conn).unwrap();
        assert_eq!(load(&conn).unwrap(), None);
    }

    #[test]
    fn a_turn_that_no_longer_reads_ends_the_conversation_there() {
        let conn = db();
        save_turn(&conn, "c1", &turn(0, Role::User, "hello"), 0, 0).unwrap();
        save_turn(&conn, "c1", &turn(1, Role::Assistant, "hi"), 1, 0).unwrap();
        save_turn(&conn, "c1", &turn(2, Role::User, "more"), 2, 0).unwrap();
        conn.execute("UPDATE assistant_turns SET message='{\"role\":\"robot\"}' WHERE id=1", []).unwrap();
        assert_eq!(load(&conn).unwrap().unwrap().2.len(), 1);
        conn.execute("UPDATE assistant_turns SET message='{\"role\":\"robot\"}' WHERE id=0", []).unwrap();
        assert_eq!(load(&conn).unwrap(), None, "nothing reads, so there is nothing to restore");
    }

    #[test]
    fn a_brief_is_replaced_only_by_one_that_reads_as_far() {
        let conn = db();
        assert!(put_brief(&conn, CONVERSATION, "c1", &a_brief("First"), 4, 1_000, 1).unwrap());
        assert!(put_brief(&conn, CONVERSATION, "c1", &a_brief("Second"), 9, 2_000, 2).unwrap());
        // A slow answer about turn 4 arrives after the one about turn 9.
        assert!(!put_brief(&conn, CONVERSATION, "c1", &a_brief("Late"), 4, 1_000, 3).unwrap());
        let kept = brief(&conn, CONVERSATION, "c1").unwrap().unwrap();
        assert_eq!((kept.brief.title.as_str(), kept.version, kept.covers, kept.source_updated_ms), ("Second", 2, 9, 2_000));
        let text: String = conn.query_row("SELECT search_text FROM briefs", [], |row| row.get(0)).unwrap();
        assert!(text.starts_with("Second\nLooked at why the HUD sticks."));
        assert!(text.contains("hud.rs owns the phase") && text.contains("The issue"));
        assert_eq!(conn.query_row("SELECT status FROM briefs", [], |row| row.get::<_, String>(0)).unwrap(), "in_progress");
    }

    #[test]
    fn briefs_list_newest_first_and_can_be_forgotten() {
        let conn = db();
        put_brief(&conn, CONVERSATION, "c1", &a_brief("Older"), 1, 1_000, 1).unwrap();
        put_brief(&conn, CONVERSATION, "c2", &a_brief("Newer"), 1, 2_000, 1).unwrap();
        conn.execute("INSERT INTO briefs (source_type, source_id, title, status, content, search_text, source_updated_ms, updated_ms) VALUES ('conversation','c3','x','done','{}','x',3000,1)", []).unwrap();
        let titles: Vec<String> = briefs(&conn, 10).unwrap().into_iter().map(|kept| kept.brief.title).collect();
        assert_eq!(titles, vec!["Newer", "Older"]);
        let newest: Vec<String> = briefs(&conn, 1).unwrap().into_iter().map(|kept| kept.brief.title).collect();
        assert_eq!(newest, vec!["Newer"], "the unreadable one is newest, and doesn't count toward the limit");
        assert!(forget_brief(&conn, CONVERSATION, "c1").unwrap());
        assert!(!forget_brief(&conn, CONVERSATION, "c1").unwrap());
        assert_eq!(forget_briefs(&conn, CONVERSATION, &["open"]).unwrap(), 2);
    }

    #[test]
    fn a_forgotten_source_is_never_briefed_again() {
        let conn = db();
        put_brief(&conn, CONVERSATION, "c1", &a_brief("Kept"), 1, 1_000, 1).unwrap();
        forget_brief(&conn, CONVERSATION, "c1").unwrap();
        // The answer that was on its way when you forgot it.
        assert!(!put_brief(&conn, CONVERSATION, "c1", &a_brief("Late"), 5, 2_000, 2).unwrap());
        // Forgotten before it was ever briefed, and forgotten with everything else.
        forget_brief(&conn, CONVERSATION, "c2").unwrap();
        assert!(!put_brief(&conn, CONVERSATION, "c2", &a_brief("Never"), 1, 1_000, 1).unwrap());
        put_brief(&conn, CONVERSATION, "c3", &a_brief("Third"), 1, 1_000, 1).unwrap();
        // "open" is still being talked in; "cleared" was cleared and its brief is on its way.
        forget_briefs(&conn, CONVERSATION, &["open", "cleared"]).unwrap();
        assert!(!put_brief(&conn, CONVERSATION, "c3", &a_brief("Again"), 9, 3_000, 3).unwrap());
        assert!(!put_brief(&conn, CONVERSATION, "open", &a_brief("Open"), 1, 1_000, 1).unwrap());
        assert!(!put_brief(&conn, CONVERSATION, "cleared", &a_brief("Late"), 1, 1_000, 1).unwrap());
        assert!(briefs(&conn, 10).unwrap().is_empty());
        assert!(put_brief(&conn, CONVERSATION, "c4", &a_brief("Other"), 1, 1_000, 1).unwrap());
        // Dropped, not forgotten: the next brief is stored, even one that reads less far.
        drop_brief(&conn, CONVERSATION, "c4").unwrap();
        assert!(put_brief(&conn, CONVERSATION, "c4", &a_brief("Rewritten"), 0, 500, 2).unwrap());
    }
}
