//! The "drag Eavesy here" card that floats beside System Settings while a Privacy & Security
//! list that takes apps by drag (Accessibility, Screen Recording, Input Monitoring) is open.
//! The capture sidecar draws it (`--permission-guide`, see `PermissionGuide.swift`); this module
//! launches it, and tells it once the permission is on so it can show a check and close.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;

static GUIDE: Mutex<Option<Child>> = Mutex::new(None);

const POLL: Duration = Duration::from_millis(500);
const MAX_WAIT: Duration = Duration::from_secs(15 * 60);

/// The panes the card helps with: their lists take an app dragged in from Finder.
pub fn guided(pane: &str) -> bool {
    matches!(pane, "accessibility" | "screen" | "input_monitoring")
}

/// Screen Recording reads as not granted in this process until Eavesy relaunches, so for that
/// pane the card never hears `granted`: it closes when System Settings closes, or when macOS's
/// "Quit & Reopen" restarts Eavesy and closes the card's stdin.
fn granted(pane: &str) -> bool {
    match pane {
        "accessibility" => crate::permissions::accessibility_granted(),
        "input_monitoring" => crate::permissions::input_monitoring_status().granted(),
        "screen" => crate::permissions::screen_recording_granted(),
        _ => true,
    }
}

/// The `.app` bundle holding `exe`, if Eavesy runs from one (not under `cargo run`).
fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|dir| dir.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// How long the card waits for System Settings when Eavesy opened it itself.
const OPENED_WAIT: Duration = Duration::from_secs(30);
/// How long it waits after a macOS prompt whose "Open System Settings" button opens it.
const PROMPTED_WAIT: Duration = Duration::from_secs(120);

/// Shows the card for `pane` once Eavesy has opened its System Settings list.
pub fn show(app: &AppHandle, pane: &str) {
    show_within(app, pane, OPENED_WAIT);
}

/// Shows the card for `pane` if the macOS prompt just shown sends the person to System Settings.
pub fn show_after_prompt(app: &AppHandle, pane: &str) {
    show_within(app, pane, PROMPTED_WAIT);
}

/// Shows the card for `pane`, replacing any card already up, once a System Settings window
/// appears within `wait`. Does nothing when the pane takes no drag, the permission is already
/// on, or Eavesy isn't running from an app bundle.
fn show_within(app: &AppHandle, pane: &str, wait: Duration) {
    if !cfg!(target_os = "macos") || !guided(pane) || granted(pane) {
        return;
    }
    let Some(bundle) = std::env::current_exe().ok().as_deref().and_then(app_bundle_of) else { return };
    let Ok(bin) = crate::audio::capture_bin(app) else { return };
    // Hold the slot while the old card is replaced, so two calls at once can't orphan one.
    let mut slot = GUIDE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut old) = slot.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let child = Command::new(bin)
        .args(["--permission-guide", pane, "--wait", &wait.as_secs().to_string(), "--app"])
        .arg(&bundle)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(crate::audio::capture_log(app))
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!("permission guide failed to start: {error}");
            return;
        }
    };
    let Some(mut stdin) = child.stdin.take() else { return };
    let pid = child.id();
    *slot = Some(child);
    drop(slot);
    let pane = pane.to_string();
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < MAX_WAIT {
            std::thread::sleep(POLL);
            if !still_running(pid) {
                return;
            }
            if granted(&pane) {
                // The card shows its check, then quits; it also quits when stdin closes here.
                let _ = writeln!(stdin, "granted");
                let _ = stdin.flush();
                std::thread::sleep(Duration::from_secs(2));
                return;
            }
        }
    });
}

/// Whether the card with this pid is still the current one and running. Reaps it if it quit.
fn still_running(pid: u32) -> bool {
    let mut guide = GUIDE.lock().unwrap_or_else(|e| e.into_inner());
    match guide.as_mut() {
        Some(child) if child.id() == pid => match child.try_wait() {
            Ok(None) => true,
            _ => {
                *guide = None;
                false
            }
        },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_drag_lists_get_the_card() {
        assert!(guided("accessibility"));
        assert!(guided("screen"));
        assert!(guided("input_monitoring"));
        assert!(!guided("microphone"));
        assert!(!guided("notifications"));
    }

    #[test]
    fn finds_the_app_bundle_around_the_binary() {
        let exe = Path::new("/Applications/Eavesy.app/Contents/MacOS/eavesy");
        assert_eq!(app_bundle_of(exe), Some(PathBuf::from("/Applications/Eavesy.app")));
        assert_eq!(app_bundle_of(Path::new("/repo/target/debug/eavesy")), None);
    }
}
