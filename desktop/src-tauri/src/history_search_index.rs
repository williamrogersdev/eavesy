//! Trigram candidate sets accelerate substring search; `instr` remains authoritative.
use rusqlite::{Connection, OptionalExtension};

pub(super) fn ready(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(conn
        .query_row(
            "SELECT value='1' FROM history_metadata WHERE key='trigram_v1'",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

pub(super) fn prepare(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    if !ready(&tx)? {
        // SQLite's trigram tokenizer stops at NUL. Indexed exception sets keep
        // those rare rows eligible for the authoritative full-text instr check.
        // External content avoids storing transcript bodies again. detail=none
        // stores document IDs, not positions; MATCH uses individual trigrams.
        tx.execute_batch("CREATE INDEX history_title_nulls ON history_recordings ((instr(title_search,char(0))>0));
            CREATE INDEX history_body_nulls ON history_content ((instr(search_text,char(0))>0));
            CREATE VIRTUAL TABLE history_title_fts USING fts5(title_search,content='history_recordings',content_rowid='rowid',tokenize='trigram case_sensitive 1',detail=none);
            CREATE VIRTUAL TABLE history_body_fts USING fts5(search_text,content='history_content',content_rowid='rowid',tokenize='trigram case_sensitive 1',detail=none);
            INSERT INTO history_title_fts(rowid,title_search) SELECT rowid,title_search FROM history_recordings;
            INSERT INTO history_body_fts(rowid,search_text) SELECT rowid,search_text FROM history_content;
            CREATE TRIGGER history_title_ai AFTER INSERT ON history_recordings BEGIN
              INSERT INTO history_title_fts(rowid,title_search) VALUES(new.rowid,new.title_search); END;
            CREATE TRIGGER history_title_ad AFTER DELETE ON history_recordings BEGIN
              INSERT INTO history_title_fts(history_title_fts,rowid,title_search) VALUES('delete',old.rowid,old.title_search); END;
            CREATE TRIGGER history_title_au AFTER UPDATE OF title_search ON history_recordings WHEN old.title_search IS NOT new.title_search BEGIN
              INSERT INTO history_title_fts(history_title_fts,rowid,title_search) VALUES('delete',old.rowid,old.title_search);
              INSERT INTO history_title_fts(rowid,title_search) VALUES(new.rowid,new.title_search); END;
            CREATE TRIGGER history_body_ai AFTER INSERT ON history_content BEGIN
              INSERT INTO history_body_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
            CREATE TRIGGER history_body_ad AFTER DELETE ON history_content BEGIN
              INSERT INTO history_body_fts(history_body_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text); END;
            CREATE TRIGGER history_body_au AFTER UPDATE OF search_text ON history_content WHEN old.search_text IS NOT new.search_text BEGIN
              INSERT INTO history_body_fts(history_body_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
              INSERT INTO history_body_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
            INSERT INTO history_metadata(key,value) VALUES('trigram_v1','1');")?;
    }
    tx.commit()
}

pub(super) fn candidate(query: &str) -> Option<String> {
    let lower = query.to_lowercase();
    let chars: Vec<_> = lower
        .split_whitespace()
        .filter(|t| !t.contains('\0'))
        .max_by_key(|t| t.chars().count())?
        .chars()
        .collect();
    if chars.len() < 3 {
        return None;
    }
    let windows = chars.len() - 2;
    let mut terms = std::collections::BTreeSet::new();
    // Bound expression size for pasted queries; any subset is a safe superset
    // of exact substring matches, including Unicode and punctuation.
    for i in 0..windows.min(16) {
        let start = if windows <= 16 {
            i
        } else {
            i * (windows - 1) / 15
        };
        let tri: String = chars[start..start + 3].iter().collect();
        terms.insert(format!("\"{}\"", tri.replace('"', "\"\"")));
    }
    Some(terms.into_iter().collect::<Vec<_>>().join(" AND "))
}
