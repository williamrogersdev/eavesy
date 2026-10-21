//! Durable, indexed recording history. Bodies are kept out of list queries.
use std::path::Path;
#[path = "history_search_index.rs"]
mod search_index;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredRecording {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    pub duration_sec: i64,
    pub source: String,
    pub status: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub transcript: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub has_video: bool,
    #[serde(default)]
    pub folder_path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RecordingPreview {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    pub duration_sec: i64,
    pub source: String,
    pub status: String,
    pub has_audio: bool,
    pub has_video: bool,
    pub transcript: Option<String>,
    pub transcript_truncated: bool,
    pub revision: i64,
}

#[derive(Debug, Default, Serialize)]
pub struct Counts {
    pub all: usize,
    pub voice: usize,
    pub meetings: usize,
    pub screens: usize,
    pub notes: usize,
}

#[derive(Debug, Serialize)]
pub struct HistoryPage {
    pub items: Vec<RecordingPreview>,
    pub next_offset: Option<usize>,
    pub counts: Counts,
}

pub struct History {
    conn: Connection,
}

fn error(e: impl std::fmt::Display) -> String {
    format!("recording history: {e}")
}

impl History {
    /// Resume only unfinished screen jobs; do not materialize the library's bodies at launch.
    pub fn pending_walkthroughs(&self) -> Result<Vec<String>, String> {
        let mut query = self.conn.prepare("SELECT id FROM history_recordings WHERE has_video = 1 AND source = 'screen' AND status = 'processing'").map_err(error)?;
        let rows = query.query_map([], |row| row.get(0)).map_err(error)?;
        rows.collect::<Result<Vec<String>, _>>().map_err(error)
    }

    pub fn open(path: &Path, legacy: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(error)?;
        }
        let mut conn = Connection::open(path).map_err(error)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(error)?;
        // Match std::fs::File::sync_all on Apple platforms, which uses
        // F_FULLFSYNC. SQLite's synchronous=FULL alone does not enable it.
        // https://www.sqlite.org/pragma.html#pragma_fullfsync
        conn.pragma_update(None, "fullfsync", true).map_err(error)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS history_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history_recordings(
                id TEXT PRIMARY KEY, title TEXT NOT NULL, title_search TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL, duration_sec INTEGER NOT NULL,
                source TEXT NOT NULL, status TEXT NOT NULL, has_audio INTEGER NOT NULL,
                has_video INTEGER NOT NULL, folder_path TEXT, folder_key TEXT,
                category TEXT NOT NULL, preview TEXT, truncated INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1);
            CREATE INDEX IF NOT EXISTS history_order ON history_recordings(started_at_ms DESC, id);
            CREATE INDEX IF NOT EXISTS history_folder ON history_recordings(folder_path);
            CREATE INDEX IF NOT EXISTS history_folder_key ON history_recordings(folder_key);
            CREATE TABLE IF NOT EXISTS history_content(
                id TEXT PRIMARY KEY REFERENCES history_recordings(id) ON DELETE CASCADE,
                summary TEXT, transcript TEXT, notes TEXT, search_text TEXT NOT NULL);",
        )
        .map_err(error)?;
        // Check and import inside one writer transaction. A malformed file never
        // marks the import complete; a retry can safely start again. Keep the
        // original JSON byte-for-byte as the pre-migration backup.
        let tx = conn.transaction().map_err(error)?;
        let imported = tx
            .query_row(
                "SELECT value FROM history_metadata WHERE key='legacy_imported'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error)?;
        if imported.is_none() {
            let rows: Vec<StoredRecording> = match std::fs::read(legacy) {
                Ok(raw) => serde_json::from_slice(&raw).map_err(|e| {
                    format!("recordings registry is malformed and was preserved: {e}")
                })?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
                Err(e) => return Err(error(e)),
            };
            let mut seen = std::collections::HashSet::new();
            for row in rows {
                if !seen.insert(row.id.clone()) {
                    return Err(
                        "recording history: duplicate ID in legacy registry; original preserved"
                            .into(),
                    );
                }
                save(&tx, &row)?;
            }
            tx.execute(
                "INSERT INTO history_metadata VALUES ('legacy_imported','1')",
                [],
            )
            .map_err(error)?;
        }
        tx.commit().map_err(error)?;
        Ok(Self { conn })
    }

    pub fn prepare_search(&mut self) -> Result<(), String> {
        search_index::prepare(&mut self.conn).map_err(error)
    }

    pub fn prepare_search_while(
        &mut self,
        cancelled: impl Fn() -> bool + Send + Sync + std::panic::RefUnwindSafe + 'static,
    ) -> Result<bool, String> {
        if cancelled() {
            return Ok(false);
        }
        let cancelled = std::sync::Arc::new(cancelled);
        let check = cancelled.clone();
        self.conn.progress_handler(100, Some(move || check()));
        let result = self.prepare_search();
        self.conn.progress_handler(0, None::<fn() -> bool>);
        match result {
            Err(_) if cancelled() => Ok(false),
            other => other.map(|()| true),
        }
    }

    pub fn rollback_uncommitted(&self) -> Result<(), String> {
        self.conn.progress_handler(0, None::<fn() -> bool>);
        if !self.conn.is_autocommit() {
            self.conn.execute_batch("ROLLBACK").map_err(error)?;
        }
        Ok(())
    }

    pub fn import_complete(&self) -> Result<bool, String> {
        let exists:bool=self.conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_metadata')",[],|r|r.get(0)).map_err(error)?;
        if !exists {
            return Ok(false);
        }
        Ok(self
            .conn
            .query_row(
                "SELECT value='1' FROM history_metadata WHERE key='legacy_imported'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?
            .unwrap_or(false))
    }

    pub fn read_only(path: &Path) -> Result<Self, String> {
        let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(error)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(error)?;
        Ok(Self { conn })
    }

    pub fn page_while(
        &self,
        offset: usize,
        limit: usize,
        query: &str,
        category: &str,
        cancelled: impl Fn() -> bool + Send + std::panic::RefUnwindSafe + 'static,
    ) -> Result<HistoryPage, String> {
        if cancelled() {
            return Err("History search superseded".into());
        }
        self.conn.progress_handler(100, Some(cancelled));
        let result = self.page(offset, limit, query, category);
        self.conn.progress_handler(0, None::<fn() -> bool>);
        result
    }

    pub fn get(&self, id: &str) -> Result<Option<StoredRecording>, String> {
        self.conn
            .query_row(
                "SELECT h.id,h.title,h.started_at_ms,h.duration_sec,h.source,h.status,
            c.summary,c.transcript,c.notes,h.has_audio,h.has_video,h.folder_path
            FROM history_recordings h JOIN history_content c USING(id) WHERE h.id=?1",
                [id],
                recording,
            )
            .optional()
            .map_err(error)
    }

    pub fn revision(&self, id: &str) -> Result<Option<i64>, String> {
        self.conn
            .query_row(
                "SELECT revision FROM history_recordings WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)
    }

    pub fn put(&mut self, row: &StoredRecording) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(error)?;
        save(&tx, row)?;
        tx.commit().map_err(error)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM history_recordings WHERE id=?1", [id])
            .map_err(error)?;
        Ok(())
    }

    pub fn locations(&self) -> Result<Vec<(String, Option<String>)>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id,folder_path FROM history_recordings ORDER BY started_at_ms DESC,id")
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(error)
    }

    pub fn folders(&self) -> Result<Vec<(String, String)>, String> {
        let mut stmt = self.conn.prepare("SELECT id,folder_path FROM history_recordings WHERE folder_path IS NOT NULL ORDER BY started_at_ms DESC,id").map_err(error)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(error)
    }

    pub fn by_folder(&self, folder: &Path) -> Result<Option<StoredRecording>, String> {
        let key = canonical_key(folder);
        let id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM history_recordings
            WHERE folder_path=?1 OR folder_key=?2 ORDER BY started_at_ms DESC,id LIMIT 1",
                params![folder.to_string_lossy(), key],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        let id = match id {
            Some(id) => Some(id),
            None => {
                // A case-only rename can change canonical spelling while the
                // saved path remains valid on a case-insensitive volume. Keep
                // the indexed normal path, and refresh only a missed alias.
                let found = self
                    .folders()?
                    .into_iter()
                    .find(|(_, known)| canonical_key(Path::new(known)) == key)
                    .map(|(id, _)| id);
                if let Some(id) = &found {
                    self.conn
                        .execute(
                            "UPDATE history_recordings SET folder_key=?2 WHERE id=?1",
                            params![id, key],
                        )
                        .map_err(error)?;
                }
                found
            }
        };
        id.map(|id| self.get(&id)).transpose().map(Option::flatten)
    }

    pub fn ids(&self) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM history_recordings")
            .map_err(error)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(error)
    }

    pub fn page(
        &self,
        offset: usize,
        limit: usize,
        query: &str,
        category: &str,
    ) -> Result<HistoryPage, String> {
        let limit = limit.clamp(1, 100);
        let mut predicate = "1=1".to_string();
        let mut values: Vec<rusqlite::types::Value> = Vec::new();
        if category != "all" {
            if !["voice", "meetings", "screens", "notes"].contains(&category) {
                return Err("Unknown history filter".into());
            }
            predicate.push_str(" AND h.category=?");
            values.push(category.to_string().into());
        }
        // Same inclusion rule as launcher score(): a title/body substring, or
        // every whitespace-separated token somewhere in title + body.
        for token in query.to_lowercase().split_whitespace() {
            predicate.push_str(" AND (instr(h.title_search,?)>0 OR instr(c.search_text,?)>0)");
            values.push(token.to_string().into());
            values.push(token.to_string().into());
        }
        let candidate = search_index::candidate(query);
        let indexed = candidate.is_some() && search_index::ready(&self.conn).map_err(error)?;
        // Common searches usually fill the first page immediately. Probe only a
        // bounded recent prefix so those never pay to enumerate all FTS hits.
        let mut probe = None;
        if indexed && offset.saturating_add(limit) < 256 {
            let prefix = offset + limit + 1;
            let bounded = format!("{predicate} AND h.rowid IN (SELECT rowid FROM history_recordings ORDER BY started_at_ms DESC,id LIMIT {prefix})");
            let rows = self.query_items(offset, limit, query, &bounded, values.clone())?;
            if rows.len() > limit {
                probe = Some(rows);
            }
        }
        let mut items = if let Some(rows) = probe {
            rows
        } else {
            if indexed {
                let candidate = candidate.unwrap();
                predicate.push_str(" AND h.id IN (
                    SELECT id FROM history_recordings WHERE rowid IN (SELECT rowid FROM history_title_fts WHERE history_title_fts MATCH ? UNION SELECT rowid FROM history_recordings WHERE (instr(title_search,char(0))>0)=1)
                    UNION SELECT id FROM history_content WHERE rowid IN (SELECT rowid FROM history_body_fts WHERE history_body_fts MATCH ? UNION SELECT rowid FROM history_content WHERE (instr(search_text,char(0))>0)=1))");
                values.push(candidate.clone().into());
                values.push(candidate.into());
            }
            self.query_items(offset, limit, query, &predicate, values)?
        };
        let next_offset = (items.len() > limit).then_some(offset + limit);
        items.truncate(limit);
        let mut counts = Counts::default();
        let mut stmt = self
            .conn
            .prepare("SELECT category,count(*) FROM history_recordings GROUP BY category")
            .map_err(error)?;
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, usize>(1)?)))
            .map_err(error)?
        {
            let (category, count) = row.map_err(error)?;
            counts.all += count;
            match category.as_str() {
                "meetings" => counts.meetings = count,
                "screens" => counts.screens = count,
                "notes" => counts.notes = count,
                _ => counts.voice = count,
            }
        }
        Ok(HistoryPage {
            items,
            next_offset,
            counts,
        })
    }
    fn query_items(
        &self,
        offset: usize,
        limit: usize,
        query: &str,
        predicate: &str,
        mut values: Vec<rusqlite::types::Value>,
    ) -> Result<Vec<RecordingPreview>, String> {
        let join = if query.trim().is_empty() {
            ""
        } else {
            " JOIN history_content c USING(id)"
        };
        let sql=format!("SELECT h.id,h.title,h.started_at_ms,h.duration_sec,h.source,h.status,h.has_audio,h.has_video,h.preview,h.truncated,h.revision
            FROM history_recordings h INDEXED BY history_order{join} WHERE {predicate} ORDER BY h.started_at_ms DESC,h.id LIMIT ? OFFSET ?");
        values.push(((limit + 1) as i64).into());
        values.push(i64::try_from(offset).map_err(error)?.into());
        let mut stmt = self.conn.prepare(&sql).map_err(error)?;
        let rows = stmt
            .query_map(params_from_iter(values), |r| {
                Ok(RecordingPreview {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    started_at_ms: r.get(2)?,
                    duration_sec: r.get(3)?,
                    source: r.get(4)?,
                    status: r.get(5)?,
                    has_audio: r.get(6)?,
                    has_video: r.get(7)?,
                    transcript: r.get(8)?,
                    transcript_truncated: r.get(9)?,
                    revision: r.get(10)?,
                })
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        Ok(rows)
    }
}

fn recording(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRecording> {
    Ok(StoredRecording {
        id: r.get(0)?,
        title: r.get(1)?,
        started_at_ms: r.get(2)?,
        duration_sec: r.get(3)?,
        source: r.get(4)?,
        status: r.get(5)?,
        summary: r.get(6)?,
        transcript: r.get(7)?,
        notes: r.get(8)?,
        has_audio: r.get(9)?,
        has_video: r.get(10)?,
        folder_path: r.get(11)?,
    })
}

fn canonical_key(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn plain_transcript(text: &str) -> String {
    use std::sync::LazyLock;
    static HEADER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\A# [^\n]*\n+(?:## Transcript\n+)?").unwrap());
    static SPEAKER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?m)^\*\*\[\d{2}:\d{2}:\d{2}\] ([^\n]*?):\*\* ").unwrap()
    });
    static TIME: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?m)^\[\d{2}:\d{2}:\d{2}\] ").unwrap());
    TIME.replace_all(&SPEAKER.replace_all(&HEADER.replace(text, ""), "$1: "), "")
        .trim()
        .to_string()
}

fn save(conn: &Connection, row: &StoredRecording) -> Result<(), String> {
    let text = row.transcript.as_deref().unwrap_or_default();
    let plain = plain_transcript(text);
    let preview: String = plain.chars().take(2048).collect();
    let category = match row.source.as_str() {
        "mixed" | "both" | "system" | "desktop" => "meetings",
        "screen" | "screenshot" | "image" => "screens",
        "note" => "notes",
        "upload" | "import" if row.has_video => "screens",
        _ => "voice",
    };
    let key = row.folder_path.as_deref().map(Path::new).map(canonical_key);
    conn.execute("INSERT INTO history_recordings(id,title,title_search,started_at_ms,duration_sec,source,status,has_audio,has_video,folder_path,folder_key,category,preview,truncated)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,title_search=excluded.title_search,started_at_ms=excluded.started_at_ms,duration_sec=excluded.duration_sec,source=excluded.source,status=excluded.status,has_audio=excluded.has_audio,has_video=excluded.has_video,folder_path=excluded.folder_path,folder_key=excluded.folder_key,category=excluded.category,preview=excluded.preview,truncated=excluded.truncated,revision=revision+1",
        params![row.id,row.title,row.title.to_lowercase(),row.started_at_ms,row.duration_sec,row.source,row.status,row.has_audio,row.has_video,row.folder_path,key,category,row.transcript.as_ref().map(|_|preview.as_str()),preview.len()<plain.len()]).map_err(error)?;
    let search = format!("{} {}", plain, row.summary.as_deref().unwrap_or_default()).to_lowercase();
    conn.execute("INSERT INTO history_content(id,summary,transcript,notes,search_text) VALUES (?1,?2,?3,?4,?5)
        ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,transcript=excluded.transcript,notes=excluded.notes,search_text=excluded.search_text
        WHERE summary IS NOT excluded.summary OR transcript IS NOT excluded.transcript OR notes IS NOT excluded.notes OR search_text IS NOT excluded.search_text",
        params![row.id,row.summary,row.transcript,row.notes,search]).map_err(error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("eavesy-history-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }
        fn open(&self) -> Result<History, String> {
            History::open(
                &self.root.join("history.sqlite3"),
                &self.root.join("recordings.json"),
            )
        }
        fn legacy(&self) -> std::path::PathBuf {
            self.root.join("recordings.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn row(id: &str) -> StoredRecording {
        StoredRecording {
            id: id.into(),
            title: id.into(),
            started_at_ms: 1,
            duration_sec: 3600,
            source: "mixed".into(),
            status: "complete".into(),
            summary: Some("Decisions: ship it.".into()),
            transcript: Some(format!(
                "# Title\n\n## Transcript\n\n{} Straße CAFÉ tailword",
                "synthetic words ".repeat(1000)
            )),
            notes: Some("My notes".into()),
            has_audio: true,
            has_video: false,
            folder_path: None,
        }
    }

    #[test]
    fn recovery_only_selects_unfinished_screen_videos() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        for (id, source, status, video) in [
            ("pending", "screen", "processing", true),
            ("finished", "screen", "complete", true),
            ("voice", "mic", "processing", true),
            ("no-video", "screen", "processing", false),
        ] {
            let mut recording = row(id);
            recording.source = source.into();
            recording.status = status.into();
            recording.has_video = video;
            history.put(&recording).unwrap();
        }
        assert_eq!(history.pending_walkthroughs().unwrap(), vec!["pending"]);
    }

    #[test]
    fn every_connection_keeps_full_durability_for_wal_and_checkpoints() {
        let fixture = Fixture::new();
        for _ in 0..2 {
            let history = fixture.open().unwrap();
            assert_eq!(
                history
                    .conn
                    .pragma_query_value(None, "synchronous", |row| row.get::<_, i64>(0))
                    .unwrap(),
                2
            );
            assert_eq!(
                history
                    .conn
                    .pragma_query_value(None, "fullfsync", |row| row.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                history
                    .conn
                    .pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                    .unwrap(),
                "wal"
            );
        }
    }

    #[test]
    fn migration_is_lossless_atomic_once_and_preserves_original() {
        let fixture = Fixture::new();
        let original = vec![row("a"), row("b")];
        let bytes = serde_json::to_vec_pretty(&original).unwrap();
        std::fs::write(fixture.legacy(), &bytes).unwrap();
        let mut history = fixture.open().unwrap();
        assert_eq!(history.get("a").unwrap(), Some(original[0].clone()));
        history.remove("a").unwrap();
        let mut updated = original[1].clone();
        updated.title = "Changed".into();
        history.put(&updated).unwrap();
        drop(history);
        let reopened = fixture.open().unwrap();
        assert!(reopened.get("a").unwrap().is_none());
        assert_eq!(reopened.get("b").unwrap(), Some(updated));
        assert_eq!(std::fs::read(fixture.legacy()).unwrap(), bytes);
    }
    #[test]
    fn malformed_or_duplicate_legacy_never_partially_imports() {
        for bytes in [
            b"not json".to_vec(),
            serde_json::to_vec(&[row("same"), row("same")]).unwrap(),
        ] {
            let fixture = Fixture::new();
            std::fs::write(fixture.legacy(), &bytes).unwrap();
            assert!(fixture.open().is_err());
            assert_eq!(std::fs::read(fixture.legacy()).unwrap(), bytes);
            let conn = Connection::open(fixture.root.join("history.sqlite3")).unwrap();
            assert_eq!(
                conn.query_row("SELECT count(*) FROM history_recordings", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
            drop(conn);
            std::fs::write(
                fixture.legacy(),
                serde_json::to_vec(&[row("repaired")]).unwrap(),
            )
            .unwrap();
            assert!(fixture.open().unwrap().get("repaired").unwrap().is_some());
        }
    }
    #[test]
    fn failed_content_write_rolls_back_metadata_and_revision() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        let original = row("a");
        history.put(&original).unwrap();
        history.prepare_search().unwrap();
        let revision = history.revision("a").unwrap();
        history.conn.execute_batch("CREATE TRIGGER fail_body BEFORE UPDATE ON history_content BEGIN SELECT RAISE(ABORT,'test disk failure'); END;").unwrap();
        let mut changed = original.clone();
        changed.title = "Changed".into();
        changed.transcript = Some("new".into());
        assert!(history.put(&changed).is_err());
        assert_eq!(history.get("a").unwrap(), Some(original));
        assert_eq!(history.revision("a").unwrap(), revision);
    }
    #[test]
    fn paging_is_bounded_stable_and_searches_unloaded_full_unicode_bodies() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        for i in 0..105 {
            history.put(&row(&format!("{i:03}"))).unwrap();
        }
        history.prepare_search().unwrap();
        let page = history.page(0, 1000, "", "all").unwrap();
        assert_eq!(page.items.len(), 100);
        assert_eq!(page.next_offset, Some(100));
        assert_eq!(page.counts.all, 105);
        assert_eq!(page.counts.meetings, 105);
        assert_eq!(page.items[0].id, "000");
        assert!(page
            .items
            .iter()
            .all(|r| r.transcript.as_ref().unwrap().chars().count() == 2048
                && r.transcript_truncated));
        let last = history.page(100, 100, "", "all").unwrap();
        assert_eq!(last.items.len(), 5);
        assert_eq!(last.next_offset, None);
        assert_eq!(last.items[0].id, "100");
        let found = history
            .page(0, 50, "104 café TAILWORD", "meetings")
            .unwrap();
        assert_eq!(found.items.len(), 1);
        assert_eq!(found.items[0].id, "104");
        assert_eq!(history.page(0, 50, "ship", "all").unwrap().items.len(), 50);
        let searched_second = history.page(50, 50, "ship", "meetings").unwrap();
        assert_eq!(searched_second.items.len(), 50);
        assert_eq!(searched_second.items[0].id, "050");
        assert_eq!(searched_second.next_offset, Some(100));
        assert_eq!(
            history
                .page(100, 50, "ship", "meetings")
                .unwrap()
                .items
                .len(),
            5
        );

        assert_eq!(history.page(0, 50, "", "notes").unwrap().items.len(), 0);
        assert!(history
            .get("104")
            .unwrap()
            .unwrap()
            .transcript
            .unwrap()
            .ends_with("tailword"));
    }
    #[test]
    fn changing_one_record_preserves_others_and_updates_preview_search_and_categories() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        let other = row("other");
        history.put(&other).unwrap();
        let mut changed = row("a");
        history.put(&changed).unwrap();
        changed.source = "note".into();
        changed.transcript = Some("New local edit".into());
        history.put(&changed).unwrap();
        assert_eq!(history.get("other").unwrap(), Some(other));
        assert_eq!(
            history.page(0, 50, "local", "notes").unwrap().items[0]
                .transcript
                .as_deref(),
            Some("New local edit")
        );
        assert_eq!(
            history.page(0, 50, "tailword", "all").unwrap().items.len(),
            1
        );
        drop(history);
        assert_eq!(fixture.open().unwrap().get("a").unwrap(), Some(changed));
    }
    #[test]
    fn preview_truncation_uses_plain_text_and_unicode_boundaries() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        for (text, truncated) in [
            (
                "# Title\n\n## Transcript\n\n[00:00:01] hello".to_string(),
                false,
            ),
            ("é".repeat(2048), false),
            ("é".repeat(2049), true),
        ] {
            let mut recording = row("a");
            recording.transcript = Some(text.clone());
            history.put(&recording).unwrap();
            let page = history.page(0, 50, "", "all").unwrap();
            assert_eq!(page.items[0].transcript_truncated, truncated);
            assert_eq!(
                page.items[0].transcript.as_deref(),
                Some(
                    plain_transcript(&text)
                        .chars()
                        .take(2048)
                        .collect::<String>()
                        .as_str()
                )
            );
            assert_eq!(
                history.get("a").unwrap().unwrap().transcript.as_deref(),
                Some(text.as_str())
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn case_only_folder_rename_refreshes_a_stale_canonical_index() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        let original = fixture.root.join("Meeting");
        let renamed = fixture.root.join("MEETING");
        std::fs::create_dir_all(&original).unwrap();
        let mut recording = row("a");
        recording.folder_path = Some(original.to_string_lossy().into_owned());
        history.put(&recording).unwrap();
        std::fs::rename(&original, &renamed).unwrap();
        if !original.is_dir() {
            return;
        } // Case-sensitive volumes use normal manifest relocation.
        assert_eq!(
            history.by_folder(&renamed).unwrap(),
            Some(recording.clone())
        );
        assert_eq!(history.by_folder(&renamed).unwrap(), Some(recording));
    }

    #[test]
    fn folder_index_handles_canonical_aliases_and_relocation() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        let folder = fixture.root.join("meeting");
        std::fs::create_dir_all(&folder).unwrap();
        let mut recording = row("a");
        recording.folder_path = Some(folder.to_string_lossy().into());
        history.put(&recording).unwrap();
        assert_eq!(
            history.by_folder(&folder.join(".")).unwrap(),
            Some(recording.clone())
        );
        let moved = fixture.root.join("moved");
        std::fs::rename(&folder, &moved).unwrap();
        recording.folder_path = Some(moved.to_string_lossy().into());
        history.put(&recording).unwrap();
        assert!(history.by_folder(&folder).unwrap().is_none());
        assert_eq!(history.by_folder(&moved).unwrap(), Some(recording));
    }

    #[test]
    fn trigram_candidates_preserve_exact_substrings_unicode_and_mutations() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        let mut original = row("indexed");
        original.title = "Quoted \"Alpha\" 東京会議".into();
        original.transcript = Some(
            "**[00:00:00] Person:** Café Straße İSTANBUL 🐈🐕🐇 東京会議 foo-bar alpha\0omega"
                .into(),
        );
        original.summary = Some("summary-only UNIQUE".into());
        history.put(&original).unwrap();
        history.put(&row("other")).unwrap();
        assert_eq!(history.page(0, 50, "omega", "all").unwrap().items.len(), 1);
        assert_eq!(history.page(0, 50, "unique", "all").unwrap().items.len(), 1);

        let queries = [
            "",
            "a",
            "東京",
            "東京会議",
            "café",
            "straße",
            "İSTANBUL",
            "🐈🐕🐇",
            "foo-bar",
            "\"alpha\"",
            "alpha\0omega",
            "omega",
            "unique",
            "summary-only",
            "unique quoted",
            "nomatch",
            "bar foo",
            "a veryveryveryveryveryveryverylongquery",
        ];
        let before: Vec<_> = queries
            .iter()
            .map(|q| serde_json::to_value(history.page(0, 50, q, "all").unwrap()).unwrap())
            .collect();
        history.prepare_search().unwrap();
        history.prepare_search().unwrap();
        for (query, expected) in queries.iter().zip(before) {
            assert_eq!(
                serde_json::to_value(history.page(0, 50, query, "all").unwrap()).unwrap(),
                expected,
                "query {query:?}"
            );
        }
        original.title = "new-title".into();
        original.transcript = Some("brand-new transcript".into());
        original.summary = None;
        history.put(&original).unwrap();
        assert!(history
            .page(0, 50, "unique", "all")
            .unwrap()
            .items
            .is_empty());
        assert_eq!(
            history.page(0, 50, "brand-new", "all").unwrap().items[0].id,
            "indexed"
        );
        history.remove("indexed").unwrap();
        assert!(history
            .page(0, 50, "brand-new", "all")
            .unwrap()
            .items
            .is_empty());
        history
            .conn
            .execute(
                "INSERT INTO history_body_fts(history_body_fts,rank) VALUES('integrity-check',1)",
                [],
            )
            .unwrap();
        history
            .conn
            .execute(
                "INSERT INTO history_title_fts(history_title_fts,rank) VALUES('integrity-check',1)",
                [],
            )
            .unwrap();
        drop(history);
        let reopened = fixture.open().unwrap();
        assert!(search_index::ready(&reopened.conn).unwrap());
    }

    #[test]
    fn searches_can_be_interrupted_without_holding_the_history_writer() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        for i in 0..20 {
            history.put(&row(&i.to_string())).unwrap();
        }
        let reader = History::read_only(&fixture.root.join("history.sqlite3")).unwrap();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let check = calls.clone();
        let result = reader.page_while(0, 50, "x", "all", move || {
            check.fetch_add(1, std::sync::atomic::Ordering::Relaxed) > 0
        });
        assert!(result.is_err());
        assert!(calls.load(std::sync::atomic::Ordering::Relaxed) > 1);
        history.put(&row("writer-still-works")).unwrap();
        assert_eq!(reader.page(0, 50, "", "all").unwrap().counts.all, 21);
    }

    #[test]
    fn failed_index_build_is_atomic_retryable_and_keeps_history_available() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        history.put(&row("safe")).unwrap();
        history.conn.execute_batch("CREATE TRIGGER fail_index BEFORE INSERT ON history_metadata WHEN new.key='trigram_v1' BEGIN SELECT RAISE(ABORT,'test full disk'); END;").unwrap();
        assert!(history.prepare_search().is_err());
        assert!(!search_index::ready(&history.conn).unwrap());
        let tables: i64 = history
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='history_body_fts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
        assert_eq!(history.page(0, 50, "safe", "all").unwrap().items.len(), 1);
        history
            .conn
            .execute_batch("DROP TRIGGER fail_index")
            .unwrap();
        history.prepare_search().unwrap();
        assert_eq!(history.page(0, 50, "safe", "all").unwrap().items.len(), 1);
    }

    #[test]
    fn interrupted_index_build_rolls_back_and_can_be_retried() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        for i in 0..100 {
            history.put(&row(&format!("preserved-{i}"))).unwrap();
        }
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let check = calls.clone();
        assert!(!history
            .prepare_search_while(
                move || check.fetch_add(1, std::sync::atomic::Ordering::Relaxed) > 0
            )
            .unwrap());
        assert!(calls.load(std::sync::atomic::Ordering::Relaxed) > 1);
        assert!(!search_index::ready(&history.conn).unwrap());
        assert_eq!(
            history.page(0, 50, "preserved", "all").unwrap().items.len(),
            50
        );
        history.prepare_search().unwrap();
        assert_eq!(
            history.page(0, 50, "preserved", "all").unwrap().items.len(),
            50
        );
    }

    #[test]
    fn long_unicode_substrings_and_null_queries_remain_exact_after_indexing() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        let token: String = (0..80)
            .map(|i| char::from_u32(0x4e00 + i).unwrap())
            .collect();
        let nul = format!("begin{}end", char::from(0));
        let mut r = row("long");
        r.transcript = Some(token.clone());
        history.put(&r).unwrap();
        let mut with_null = row("null");
        with_null.transcript = Some(nul.clone());
        history.put(&with_null).unwrap();
        history.prepare_search().unwrap();
        assert_eq!(history.page(0, 50, &token, "all").unwrap().items.len(), 1);
        assert_eq!(history.page(0, 50, &nul, "all").unwrap().items.len(), 1);
        let mut wrong: Vec<_> = token.chars().collect();
        wrong[39] = '🦀';
        assert!(history
            .page(0, 50, &wrong.into_iter().collect::<String>(), "all")
            .unwrap()
            .items
            .is_empty());
    }

    #[test]
    fn panic_recovery_rolls_back_uncommitted_changes_before_reopening() {
        let fixture = Fixture::new();
        let mut history = fixture.open().unwrap();
        history.put(&row("safe")).unwrap();
        history
            .conn
            .execute_batch("BEGIN; UPDATE history_recordings SET title='uncommitted'")
            .unwrap();
        history.rollback_uncommitted().unwrap();
        drop(history);
        let reopened = fixture.open().unwrap();
        assert_eq!(reopened.get("safe").unwrap().unwrap().title, "safe");
    }
}
