//! The desktop app's local SQLite database: the recording upload queue, segment
//! queue, interrupted-capture recovery, and generated-file state.

mod connection;
mod files;
mod recovery;
mod schema;
mod segments;
mod sessions;
#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use connection::with_conn;
pub use connection::{with_open, with_open_mut};
pub use files::*;
pub use recovery::*;
pub use schema::UNAUTHORIZED_MARKER;
pub use segments::*;
pub use sessions::*;

use tauri::{AppHandle, Runtime};

use connection::open;
use schema::{migrate, prune_done_operations, retry_context_rejections, retry_unauthorized_segments};


pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let conn = open(app)?;
    migrate(&conn)?;
    retry_context_rejections(&conn)?;
    retry_unauthorized_segments(&conn)?;
    prune_done_operations(&conn, chrono::Utc::now().timestamp_millis())?;
    drop(conn);
    crate::store::initialize(app)?;
    recover_interrupted(app)
}
