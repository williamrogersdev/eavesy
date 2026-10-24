//! The Activity log (assistant.md C6): one line per thing Eavesy did or was asked to
//! do, in `~/Eavesy/assistant/log/YYYY-MM-DD.jsonl`. Summaries only: who asked, what,
//! how it was decided and how it went. Never a message body, never a secret.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub at_ms: u64,
    /// "You", "Claude Code · eavesy", "Monitor: …".
    pub requester: String,
    /// The tool's fixed name, e.g. `machine.clean`.
    pub tool: String,
    /// One line naming what it touched.
    pub summary: String,
    /// `ran`, `card`, `accepted`, `declined`, `expired`, `refused`, `read_back`.
    pub decision: String,
    /// How it went, once it ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

pub fn dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Eavesy").join("assistant").join("log"))
}

/// Appends one line to that day's file (local date), creating it owner-only.
pub fn append(dir: &Path, entry: &Entry) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(dir).map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    let day = chrono::DateTime::from_timestamp_millis(entry.at_ms as i64)
        .map(|at| at.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "unknown".into());
    let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = dir.join(format!("{day}.jsonl"));
    let mut out = options.open(&file).map_err(|e| format!("couldn't open {}: {e}", file.display()))?;
    // One write per line, so lines from two threads never interleave.
    out.write_all(line.as_bytes()).map_err(|e| format!("couldn't write {}: {e}", file.display()))
}

/// The most recent `limit` entries, newest first, across the last few days' files.
pub fn recent(dir: &Path, limit: usize) -> Vec<Entry> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<PathBuf> =
        read.filter_map(|entry| entry.ok().map(|entry| entry.path())).filter(|path| path.extension().is_some_and(|ext| ext == "jsonl")).collect();
    files.sort();
    let mut entries = Vec::new();
    for file in files.iter().rev() {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        entries.extend(text.lines().rev().filter_map(|line| serde_json::from_str::<Entry>(line).ok()));
        if entries.len() >= limit {
            break;
        }
    }
    entries.truncate(limit);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at_ms: u64, tool: &str) -> Entry {
        Entry { at_ms, requester: "You".into(), tool: tool.into(), summary: "2 worktrees".into(), decision: "ran".into(), outcome: None }
    }

    #[test]
    fn lines_come_back_newest_first_across_days() {
        let dir = std::env::temp_dir().join(format!("eavesy-activity-{}", uuid::Uuid::new_v4()));
        let day = 86_400_000;
        append(&dir, &entry(1_700_000_000_000, "a")).unwrap();
        append(&dir, &entry(1_700_000_000_000 + 2 * day, "b")).unwrap();
        append(&dir, &entry(1_700_000_000_000 + 2 * day + 1, "c")).unwrap();
        let tools: Vec<String> = recent(&dir, 10).into_iter().map(|e| e.tool).collect();
        assert_eq!(tools, ["c", "b", "a"]);
        assert_eq!(recent(&dir, 2).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
