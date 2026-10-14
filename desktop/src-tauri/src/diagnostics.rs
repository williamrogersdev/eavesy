//! "Copy Diagnostics": a scrubbed support bundle on the clipboard, so a user
//! can paste it into an email or issue without sending us anything directly.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::telemetry::{self, scrub_text, LOG_FILE_PREFIX};

const APP_LOG_LINES: usize = 200;
const CAPTURE_LOG_LINES: usize = 100;
const TAIL_BYTES: u64 = 256 * 1024;

pub fn copy(app: &AppHandle) {
    let report = collect(app);
    let (title, body) = match app.clipboard().write_text(report) {
        Ok(()) => (
            "Diagnostics copied",
            "Paste them into your support email or issue. Paths, tokens and emails are removed.",
        ),
        Err(error) => {
            telemetry::capture("diagnostics.copy", &error.to_string());
            ("Couldn't copy diagnostics", "The clipboard was unavailable. Try again.")
        }
    };
    let _ = app.notification().builder().title(title).body(body).show();
}

fn collect(app: &AppHandle) -> String {
    let app_log = telemetry::log_dir().and_then(|dir| newest_log(&dir));
    let capture_log = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("captures").join("capture.log"));
    format!(
        "Eavesy diagnostics\n\
         App version: {}\n\
         macOS: {} ({})\n\
         Generated: {}\n\
         \n--- App log (last {APP_LOG_LINES} lines) ---\n{}\n\
         \n--- Capture engine log (last {CAPTURE_LOG_LINES} lines) ---\n{}\n",
        app.package_info().version,
        tauri_plugin_os::version(),
        tauri_plugin_os::arch(),
        chrono::Utc::now().to_rfc3339(),
        section(app_log.as_deref(), APP_LOG_LINES),
        section(capture_log.as_deref(), CAPTURE_LOG_LINES),
    )
}

fn section(path: Option<&Path>, lines: usize) -> String {
    match path.map(|path| tail(path, lines)) {
        Some(Ok(text)) if !text.is_empty() => text,
        Some(Ok(_)) => "(empty)".to_owned(),
        Some(Err(error)) => format!("(unavailable: {})", scrub_text(&error.to_string())),
        None => "(no log yet)".to_owned(),
    }
}

/// Daily files are named `eavesy.YYYY-MM-DD.log`, so the name sorts by date.
fn newest_log(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(LOG_FILE_PREFIX) && name.ends_with(".log"))
        })
        .max()
}

fn tail(path: &Path, lines: usize) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(tail_text(&String::from_utf8_lossy(&bytes), lines, start > 0))
}

fn tail_text(text: &str, lines: usize, partial_first_line: bool) -> String {
    let all: Vec<&str> = text.lines().skip(usize::from(partial_first_line)).collect();
    all[all.len().saturating_sub(lines)..]
        .iter()
        .map(|line| scrub_text(line))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::tail_text;

    #[test]
    fn tail_keeps_the_last_lines_scrubbed() {
        let log = "cut-off line\nfirst\nupload failed for dana@example.com\nopened /Users/dana/Eavesy/Board offsite/audio.m4a\n";
        assert_eq!(
            tail_text(log, 2, true),
            "upload failed for [email]\nopened ~/…/audio.m4a"
        );
        assert_eq!(tail_text("a\nb", 10, false), "a\nb");
    }
}
