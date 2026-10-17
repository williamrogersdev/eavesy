//! Opt-in: adds new macOS screenshots (⌘⇧3/4/5) to the history. Watches the
//! folder macOS saves them to, non-recursively, and keeps only files macOS
//! marked as screen captures. The original stays where it is; Eavesy copies it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

/// macOS writes `.Screenshot …` first and renames it; wait for it to settle.
const SETTLE: Duration = Duration::from_millis(600);

#[derive(Default)]
pub struct ScreenshotWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Where macOS saves screenshots: `defaults read com.apple.screencapture location`,
/// else ~/Desktop.
pub fn screenshot_folder() -> PathBuf {
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
        .unwrap_or_else(|| PathBuf::from("/"))
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
        let folder = screenshot_folder();
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

/// Debounces events and imports each screenshot once (by its original path).
/// Ends when the watcher (and with it the sender) is dropped.
fn run(app: AppHandle, receiver: mpsc::Receiver<PathBuf>) {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut pending: Vec<PathBuf> = Vec::new();
    loop {
        match receiver.recv_timeout(SETTLE) {
            Ok(path) => {
                if !seen.contains(&path) && !pending.contains(&path) {
                    pending.push(path);
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let mut added = false;
        for path in pending.drain(..) {
            if !path.is_file() || !is_screen_capture(&path) {
                continue;
            }
            seen.insert(path.clone());
            match crate::imports::import_path(&app, &path, true) {
                Ok(_) => added = true,
                Err(error) => crate::telemetry::capture("screenshots.import", &error),
            }
        }
        if added {
            let _ = app.emit("recordings:updated", ());
        }
    }
}

pub fn start(app: &AppHandle) {
    let enabled = crate::settings::load(app).auto_import_screenshots;
    if let Err(error) = app.state::<ScreenshotWatcher>().apply(app, enabled) {
        crate::telemetry::capture("screenshots.watch", &error);
    }
}

#[tauri::command]
pub fn get_screenshot_folder() -> String {
    let folder = screenshot_folder();
    match dirs::home_dir().and_then(|home| folder.strip_prefix(&home).ok().map(Path::to_path_buf)) {
        Some(rest) => format!("~/{}", rest.display()),
        None => folder.display().to_string(),
    }
}

#[tauri::command]
pub fn set_auto_import_screenshots(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut config = crate::settings::load(&app);
    config.auto_import_screenshots = enabled;
    crate::settings::save(&app, &config)?;
    app.state::<ScreenshotWatcher>().apply(&app, enabled)
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
    fn home_relative_locations_expand() {
        if let Some(home) = dirs::home_dir() {
            assert_eq!(expand_home("~/Pictures/Shots"), home.join("Pictures/Shots"));
        }
        assert_eq!(expand_home("/Volumes/Shots"), PathBuf::from("/Volumes/Shots"));
    }
}
