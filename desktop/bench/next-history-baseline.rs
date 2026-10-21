// Frozen production history at desktop-v0.5.4 (3a08f273), excluding tests.
//! Durable, indexed recording history. Bodies are kept out of list queries.
use std::path::Path;

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
        let join = if query.trim().is_empty() {
            ""
        } else {
            " JOIN history_content c USING(id)"
        };
        let sql = format!("SELECT h.id,h.title,h.started_at_ms,h.duration_sec,h.source,h.status,h.has_audio,h.has_video,h.preview,h.truncated,h.revision
            FROM history_recordings h{join} WHERE {predicate} ORDER BY h.started_at_ms DESC,h.id LIMIT ? OFFSET ?");
        values.push(((limit + 1) as i64).into());
        values.push(i64::try_from(offset).map_err(error)?.into());
        let mut stmt = self.conn.prepare(&sql).map_err(error)?;
        let mut items = stmt
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

