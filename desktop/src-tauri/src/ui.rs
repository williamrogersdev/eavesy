//! Bridges code that is generic over the Tauri runtime (so it can run under the
//! mock runtime in tests) to UI helpers that only exist for the real app.

use tauri::{AppHandle, Runtime, Wry};

/// The real app handle, or `None` under the mock runtime used by tests.
pub fn wry<R: Runtime>(app: &AppHandle<R>) -> Option<&AppHandle<Wry>> {
    (app as &dyn std::any::Any).downcast_ref::<AppHandle<Wry>>()
}
