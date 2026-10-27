//! Bookkeeping shared by `cloud_pull` and `capture_sync`: a JSON state file in
//! the app data folder, a "failed recently" gate kept in memory, and the walk
//! through a newest-first cloud list.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// A JSON file in the app data folder, read and replaced under one lock.
pub(crate) struct StateFile {
    name: &'static str,
    lock: Mutex<()>,
}

impl StateFile {
    pub(crate) const fn new(name: &'static str) -> Self {
        Self { name, lock: Mutex::new(()) }
    }

    pub(crate) fn path<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map(|dir| dir.join(self.name))
            .map_err(|error| format!("could not resolve app data dir: {error}"))
    }

    pub(crate) fn load<R: Runtime, T: DeserializeOwned + Default>(&self, app: &AppHandle<R>) -> Result<T, String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        read(&self.path(app)?)
    }

    /// Reads the state, applies `change` and writes it back durably.
    pub(crate) fn update<R: Runtime, T: Serialize + DeserializeOwned + Default, O>(
        &self,
        app: &AppHandle<R>,
        change: impl FnOnce(&mut T) -> O,
    ) -> Result<O, String> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let path = self.path(app)?;
        let mut state = read(&path)?;
        let out = change(&mut state);
        let raw = serde_json::to_vec(&state).map_err(|error| error.to_string())?;
        crate::fs_writer::atomic_write(&path, &raw)?;
        Ok(out)
    }
}

/// A file that cannot be decoded is moved aside and sync starts over from
/// defaults: a broken file must never stop sync, or every delete with it.
fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(format!("read {}: {error}", path.display())),
    };
    match serde_json::from_slice(&raw) {
        Ok(state) => Ok(state),
        Err(error) => {
            let aside = path.with_extension(format!("corrupt-{}.json", chrono::Utc::now().timestamp_millis()));
            let moved = std::fs::rename(path, &aside);
            tracing::warn!(
                file = %path.display(),
                moved_aside = moved.is_ok(),
                "sync state could not be read ({error}); starting over from defaults"
            );
            crate::telemetry::capture("sync state reset", &format!("{error}"));
            Ok(T::default())
        }
    }
}

/// Ids that failed lately, left alone for `wait` (in memory only).
pub(crate) struct RetryGate {
    failed: Mutex<BTreeMap<String, Instant>>,
    wait: Duration,
}

impl RetryGate {
    pub(crate) const fn new(wait: Duration) -> Self {
        Self { failed: Mutex::new(BTreeMap::new()), wait }
    }

    pub(crate) fn failed_recently(&self, id: &str) -> bool {
        self.failed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .is_some_and(|at| at.elapsed() < self.wait)
    }

    pub(crate) fn mark(&self, id: &str) {
        let mut failed = self.failed.lock().unwrap_or_else(PoisonError::into_inner);
        failed.retain(|_, at| at.elapsed() < self.wait);
        failed.insert(id.to_string(), Instant::now());
    }

    pub(crate) fn forget(&self, id: &str) {
        self.failed.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }
}

pub(crate) const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

/// When this process started, in epoch milliseconds.
fn launched_at_ms() -> i64 {
    static LAUNCHED: std::sync::LazyLock<i64> = std::sync::LazyLock::new(|| chrono::Utc::now().timestamp_millis());
    *LAUNCHED
}

/// Whether a full walk is due: once per launch, and once a day after that.
pub(crate) fn deep_walk_due(last_finished_ms: Option<i64>, now_ms: i64) -> bool {
    last_finished_ms.is_none_or(|last| last < launched_at_ms() || now_ms - last >= DAY_MS)
}

/// One pass through a cloud list that is ordered newest first and paged by
/// offset. The newest pages are read until one holds nothing new; when a
/// deep walk is due it then carries on from where the last pass stopped, so
/// a long history is read a few pages per pass, and only once a day.
pub(crate) struct ListWalk {
    page: usize,
    pages_left: usize,
    offset: usize,
    deep_due: bool,
    in_deep: bool,
    resume: usize,
    done: bool,
    /// Where the next deep walk starts.
    pub(crate) next_scan_offset: usize,
    /// The end of the list was reached: the whole history has been looked at.
    pub(crate) wrapped: bool,
}

impl ListWalk {
    pub(crate) fn new(scan_offset: usize, deep_due: bool, page: usize, max_pages: usize) -> Self {
        Self {
            page,
            pages_left: max_pages,
            offset: 0,
            deep_due,
            in_deep: false,
            resume: scan_offset.max(page),
            done: max_pages == 0,
            next_scan_offset: scan_offset,
            wrapped: false,
        }
    }

    /// The offset of the next page to read, or `None` when this pass is done.
    pub(crate) fn next(&self) -> Option<usize> {
        (!self.done).then_some(self.offset)
    }

    /// Whether the pass stopped only because it ran out of pages.
    pub(crate) fn ran_out(&self) -> bool {
        self.pages_left == 0 && !self.wrapped
    }

    /// Records the page at `next()`: how many items it held, whether any was
    /// new to this Mac, and whether the pass has enough to download now.
    pub(crate) fn record(&mut self, len: usize, any_new: bool, enough: bool) {
        self.pages_left = self.pages_left.saturating_sub(1);
        let last = len < self.page;
        if last {
            self.wrapped = true;
            self.next_scan_offset = 0;
            self.done = true;
        } else if self.in_deep {
            // A page this pass did not take everything from is read again next time.
            if enough {
                self.next_scan_offset = self.offset;
                self.done = true;
            } else {
                self.offset += self.page;
                self.next_scan_offset = self.offset;
            }
        } else if enough {
            self.done = true;
        } else if any_new {
            // Newer items may go on past this page.
            self.offset += self.page;
        } else if self.deep_due {
            self.in_deep = true;
            self.offset = self.resume.max(self.offset + self.page);
        } else {
            self.done = true;
        }
        if self.pages_left == 0 {
            self.done = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walk(mut walk: ListWalk, pages: &[(usize, bool, bool)]) -> (Vec<usize>, ListWalk) {
        let mut read = Vec::new();
        for &(len, any_new, enough) in pages {
            let Some(offset) = walk.next() else { break };
            read.push(offset);
            walk.record(len, any_new, enough);
        }
        (read, walk)
    }

    #[test]
    fn a_current_list_reads_only_its_newest_page() {
        let (read, walk) = walk(ListWalk::new(0, false, 50, 20), &[(50, false, false), (50, false, false)]);
        assert_eq!(read, [0]);
        assert!(!walk.wrapped);
    }

    #[test]
    fn new_items_are_followed_past_the_first_page() {
        let (read, _) = walk(ListWalk::new(0, false, 50, 20), &[(50, true, false), (50, true, false), (50, false, false)]);
        assert_eq!(read, [0, 50, 100]);
    }

    #[test]
    fn a_due_deep_walk_resumes_where_the_last_one_stopped_and_wraps() {
        let (read, walk) = walk(ListWalk::new(500, true, 50, 20), &[(50, false, false), (50, false, false), (3, false, false)]);
        assert_eq!(read, [0, 500, 550]);
        assert!(walk.wrapped);
        assert_eq!(walk.next_scan_offset, 0);
    }

    #[test]
    fn a_last_page_that_is_exactly_full_wraps_on_the_empty_page_after_it() {
        // Two full pages, then nothing: the walk can't tell the second page
        // was the last one until the next read comes back empty.
        let (read, walk) = walk(ListWalk::new(50, true, 50, 20), &[(50, false, false), (50, false, false), (0, false, false)]);
        assert_eq!(read, [0, 50, 100]);
        assert!(walk.wrapped);
        assert_eq!(walk.next_scan_offset, 0);
        assert!(walk.next().is_none());
    }

    #[test]
    fn a_page_left_unfinished_is_read_again() {
        let (_, walk) = walk(ListWalk::new(0, true, 50, 20), &[(50, false, false), (50, true, true)]);
        assert_eq!(walk.next_scan_offset, 50);
    }

    #[test]
    fn a_deep_walk_is_due_once_per_launch_and_daily() {
        let now = chrono::Utc::now().timestamp_millis();
        assert!(deep_walk_due(None, now));
        assert!(!deep_walk_due(Some(now), now));
        assert!(deep_walk_due(Some(now), now + DAY_MS));
        assert!(deep_walk_due(Some(launched_at_ms() - 1), now));
    }

    #[test]
    fn a_corrupt_state_file_is_moved_aside_and_starts_from_defaults() {
        let dir = std::env::temp_dir().join(format!("eavesy-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        std::fs::write(&path, b"{ not json").unwrap();
        let state: BTreeMap<String, String> = read(&path).unwrap();
        assert!(state.is_empty());
        assert!(!path.exists(), "the broken file is out of the way");
        let aside = std::fs::read_dir(&dir).unwrap().filter_map(Result::ok).count();
        assert_eq!(aside, 1, "and kept for diagnosis");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
