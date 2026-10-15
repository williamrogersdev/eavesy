use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use rusqlite::Connection;
use tauri::{AppHandle, Manager, Runtime};

fn db_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create app data dir: {e}"))?;
    Ok(dir.join("eavesy.sqlite3"))
}

/// One connection per database file for the life of the process, shared behind a
/// mutex. Opening (and re-running the pragmas) on every call cost a file open and
/// several syscalls per query on the sync loop's hot path.
///
/// Never call `open` while holding the guard it returns: the mutex is not reentrant.
pub(super) fn open<R: Runtime>(app: &AppHandle<R>) -> Result<MutexGuard<'static, Connection>, String> {
    static CONNECTIONS: Mutex<Vec<(PathBuf, &'static Mutex<Connection>)>> = Mutex::new(Vec::new());
    let path = db_path(app)?;
    let shared = {
        let mut connections = CONNECTIONS.lock().unwrap_or_else(PoisonError::into_inner);
        match connections.iter().find(|(open_path, _)| *open_path == path) {
            Some((_, shared)) => *shared,
            None => {
                // Leaked deliberately: the app has one database; tests have one per run.
                let shared: &'static Mutex<Connection> = Box::leak(Box::new(Mutex::new(connect(&path)?)));
                connections.push((path, shared));
                shared
            }
        }
    };
    Ok(shared.lock().unwrap_or_else(PoisonError::into_inner))
}

/// Runs `f` on the shared connection.
pub fn with_open<R: Runtime, T>(app: &AppHandle<R>, f: impl FnOnce(&Connection) -> T) -> Result<T, String> {
    Ok(f(&*open(app)?))
}

pub fn with_open_mut<R: Runtime, T>(app: &AppHandle<R>, f: impl FnOnce(&mut Connection) -> T) -> Result<T, String> {
    Ok(f(&mut *open(app)?))
}

fn connect(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("open local database: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("configure local database: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("enable local WAL: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("enable local foreign keys: {e}"))?;
    Ok(conn)
}

/// Direct access to the local database for tests that set up or inspect state.
#[cfg(test)]
pub(crate) fn with_conn<R: Runtime, T>(app: &AppHandle<R>, f: impl FnOnce(&Connection) -> T) -> T {
    f(&*open(app).unwrap())
}
