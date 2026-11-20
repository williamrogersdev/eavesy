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

/// Whether this process can tell when `pane` is granted. Screen Recording reads as not granted
/// here until Eavesy relaunches, so that card is never told: it closes when System Settings
/// quits, or when macOS's "Quit & Reopen" restarts Eavesy and closes the card's stdin.
fn grant_is_visible(pane: &str) -> bool {
    pane != "screen"
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    /// The card quit or was replaced: stop watching.
    Stop,
    /// The permission is on: tell the card.
    Granted,
    Wait,
}

/// What the watcher does on one poll. `granted` is only asked when the grant can be seen.
fn next_step(pane: &str, running: bool, granted: impl FnOnce() -> bool) -> Step {
    if !running {
        Step::Stop
    } else if grant_is_visible(pane) && granted() {
        Step::Granted
    } else {
        Step::Wait
    }
}

/// Whether `pane` is on. For Screen Recording, a grant made since Eavesy launched reads as off,
/// so a card can show for it until Eavesy relaunches.
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
    let log = crate::audio::capture_log(app);
    replace_card(None);
    let child = Command::new(bin)
        .args(["--permission-guide", pane, "--wait", &wait.as_secs().to_string(), "--app"])
        .arg(&bundle)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(log)
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
    replace_card(Some(child));
    let pane = pane.to_string();
    // Owns the card's stdin: returning closes it, which quits the card.
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < MAX_WAIT {
            std::thread::sleep(POLL);
            match next_step(&pane, still_running(pid), || granted(&pane)) {
                Step::Stop => return,
                Step::Wait => {}
                Step::Granted => {
                    // The card shows its check, then quits on its own.
                    let _ = writeln!(stdin, "granted");
                    let _ = stdin.flush();
                    std::thread::sleep(Duration::from_secs(2));
                    return;
                }
            }
        }
    });
}

/// Puts `next` in the slot (or empties it) and closes the card it held. The swap happens under
/// the lock, so two calls at once can't orphan a card; the kill happens outside it.
fn replace_card(next: Option<Child>) {
    let old = std::mem::replace(&mut *GUIDE.lock().unwrap_or_else(|e| e.into_inner()), next);
    if let Some(mut old) = old {
        let _ = old.kill();
        let _ = old.wait();
    }
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
    fn a_running_card_is_told_once_its_permission_is_on() {
        assert_eq!(next_step("accessibility", true, || true), Step::Granted);
        assert_eq!(next_step("input_monitoring", true, || false), Step::Wait);
    }

    #[test]
    fn a_card_that_quit_or_was_replaced_stops_the_watch() {
        assert_eq!(next_step("accessibility", false, || true), Step::Stop);
        assert_eq!(next_step("screen", false, || false), Step::Stop);
    }

    #[test]
    fn screen_recording_is_never_polled_since_it_reads_off_until_relaunch() {
        let polled = std::cell::Cell::new(false);
        let step = next_step("screen", true, || {
            polled.set(true);
            true
        });
        assert_eq!(step, Step::Wait);
        assert!(!polled.get());
    }

    #[test]
    fn finds_the_app_bundle_around_the_binary() {
        let exe = Path::new("/Applications/Eavesy.app/Contents/MacOS/eavesy");
        assert_eq!(app_bundle_of(exe), Some(PathBuf::from("/Applications/Eavesy.app")));
        assert_eq!(app_bundle_of(Path::new("/repo/target/debug/eavesy")), None);
    }
}
