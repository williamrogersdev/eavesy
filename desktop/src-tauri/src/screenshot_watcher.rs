//! On unless turned off: adds new macOS screenshots (⌘⇧3/4/5) to the history. Watches the
//! folder macOS saves them to, non-recursively, and keeps only files macOS
//! marked as screen captures. The original stays where it is; Eavesy copies it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// macOS writes `.Screenshot …` first and renames it; wait for it to settle.
const SETTLE: Duration = Duration::from_millis(600);
/// How often waiting screenshots are looked at again.
const TICK: Duration = Duration::from_millis(300);
/// Give up on a file after this long (not a screen capture, or never finished).
const GIVE_UP: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct ScreenshotWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Where macOS saves screenshots: `defaults read com.apple.screencapture location`,
/// else ~/Desktop. None when neither can be found.
pub fn screenshot_folder() -> Option<PathBuf> {
    let configured = std::process::Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|location| !location.is_empty())
        .map(|location| expand_home(&location));
    configured
        .filter(|path| path.is_dir())
        .or_else(|| dirs::home_dir().map(|home| home.join("Desktop")))
        .filter(|path| path.is_dir())
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ if path == "~" => dirs::home_dir().unwrap_or_else(|| PathBuf::from(path)),
        _ => PathBuf::from(path),
    }
}

/// A file worth looking at: visible, an image, not a temp file.
fn candidate(path: &Path) -> bool {
    let hidden = path.file_name().and_then(|name| name.to_str()).is_none_or(|name| name.starts_with('.'));
    !hidden && matches!(crate::imports::classify(path), Some(crate::imports::Kind::Image))
}

/// macOS tags its screenshots with `kMDItemIsScreenCapture`; other images in
/// the folder (downloads, exports) are left alone.
fn is_screen_capture(path: &Path) -> bool {
    std::process::Command::new("xattr")
        .args(["-p", "com.apple.metadata:kMDItemIsScreenCapture"])
        .arg(path)
        .output()
        .is_ok_and(|output| output.status.success())
}

impl ScreenshotWatcher {
    /// Starts or stops watching to match the setting.
    pub fn apply(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        let mut slot = self.watcher.lock().unwrap_or_else(|error| error.into_inner());
        *slot = None;
        if !enabled {
            return Ok(());
        }
        let folder = screenshot_folder().ok_or("Couldn't find the folder macOS saves screenshots to.")?;
        let (sender, receiver) = mpsc::channel::<PathBuf>();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))) {
                for path in event.paths.into_iter().filter(|path| candidate(path)) {
                    let _ = sender.send(path);
                }
            }
        })
        .map_err(|error| format!("Couldn't watch your screenshots folder: {error}"))?;
        watcher
            .watch(&folder, RecursiveMode::NonRecursive)
            .map_err(|error| format!("Couldn't watch {}: {error}", folder.display()))?;
        *slot = Some(watcher);

        let app = app.clone();
        std::thread::Builder::new()
            .name("eavesy-screenshots".into())
            .spawn(move || run(app, receiver))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

struct Waiting {
    path: PathBuf,
    since: Instant,
    /// Size at the last look; imported once it stops changing.
    size: Option<u64>,
}

/// What to do with a waiting file on this look.
#[derive(Debug, PartialEq)]
enum Verdict {
    Import,
    Wait,
    Drop,
}

fn judge(age: Duration, size_now: Option<u64>, size_before: Option<u64>, tagged: impl FnOnce() -> bool) -> Verdict {
    if age < SETTLE {
        return Verdict::Wait;
    }
    let Some(size) = size_now else { return Verdict::Drop };
    let stable = size > 0 && size_before == Some(size);
    if stable && tagged() {
        Verdict::Import
    } else if age >= GIVE_UP {
        Verdict::Drop
    } else {
        Verdict::Wait
    }
}

/// Imports each screenshot once (by its original path), after it has settled:
/// its size stopped changing and macOS tagged it as a screen capture (which
/// can lag the file). Files are looked at every TICK even while events keep
/// arriving. Ends when the watcher (and with it the sender) is dropped.
fn run(app: AppHandle, receiver: mpsc::Receiver<PathBuf>) {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut waiting: Vec<Waiting> = Vec::new();
    let mut last_look = Instant::now();
    loop {
        match receiver.recv_timeout(TICK) {
            Ok(path) => {
                if !seen.contains(&path) && !waiting.iter().any(|item| item.path == path) {
                    waiting.push(Waiting { path, since: Instant::now(), size: None });
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        if waiting.is_empty() || last_look.elapsed() < TICK {
            continue;
        }
        last_look = Instant::now();
        let mut added = false;
        waiting.retain_mut(|item| {
            let size_now = std::fs::metadata(&item.path).ok().filter(|meta| meta.is_file()).map(|meta| meta.len());
            let verdict = judge(item.since.elapsed(), size_now, item.size, || is_screen_capture(&item.path));
            item.size = size_now;
            match verdict {
                Verdict::Wait => true,
                Verdict::Drop => false,
                Verdict::Import => {
                    seen.insert(item.path.clone());
                    match crate::imports::import_path(&app, &item.path, true) {
                        Ok(_) => added = true,
                        Err(error) => crate::telemetry::capture("screenshots.import", &error),
                    }
                    false
                }
            }
        });
        if added {
            let _ = app.emit("recordings:updated", ());
        }
    }
}

pub fn start(app: &AppHandle) {
    let enabled = crate::settings::load(app).add_screenshots();
    if let Err(error) = app.state::<ScreenshotWatcher>().apply(app, enabled) {
        crate::telemetry::capture("screenshots.watch", &error);
    }
}

#[tauri::command]
pub fn get_screenshot_folder() -> Option<String> {
    let folder = screenshot_folder()?;
    Some(match dirs::home_dir().and_then(|home| folder.strip_prefix(&home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => folder.display().to_string(),
    })
}

#[tauri::command]
pub fn set_auto_import_screenshots(app: AppHandle, enabled: bool) -> Result<(), String> {
    // Start (or stop) first, so the saved setting never claims a watcher that failed.
    let watcher = app.state::<ScreenshotWatcher>();
    watcher.apply(&app, enabled)?;
    if let Err(error) = crate::settings::update(&app, |config| config.add_screenshots = Some(enabled)) {
        let _ = watcher.apply(&app, !enabled);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_files_and_non_images_are_ignored() {
        assert!(candidate(Path::new("/Users/a/Desktop/Screenshot 2026-10-17 at 9.41.12.png")));
        assert!(!candidate(Path::new("/Users/a/Desktop/.Screenshot 2026-10-17 at 9.41.12.png")));
        assert!(!candidate(Path::new("/Users/a/Desktop/Screen Recording 2026.mov")));
        assert!(!candidate(Path::new("/Users/a/Desktop/notes.txt")));
    }

    #[test]
    fn screenshots_wait_until_settled_tagged_and_finished() {
        let late = SETTLE + TICK;
        assert_eq!(judge(Duration::from_millis(100), Some(10), Some(10), || true), Verdict::Wait);
        assert_eq!(judge(late, Some(10), Some(10), || true), Verdict::Import);
        // Still being written, or not tagged yet: look again.
        assert_eq!(judge(late, Some(20), Some(10), || true), Verdict::Wait);
        assert_eq!(judge(late, Some(10), Some(10), || false), Verdict::Wait);
        // Gone, or never became a screen capture.
        assert_eq!(judge(late, None, Some(10), || true), Verdict::Drop);
        assert_eq!(judge(GIVE_UP, Some(10), Some(10), || false), Verdict::Drop);
    }

    #[test]
    fn home_relative_locations_expand() {
        if let Some(home) = dirs::home_dir() {
            assert_eq!(expand_home("~/Pictures/Shots"), home.join("Pictures/Shots"));
        }
        assert_eq!(expand_home("/Volumes/Shots"), PathBuf::from("/Volumes/Shots"));
    }
}
