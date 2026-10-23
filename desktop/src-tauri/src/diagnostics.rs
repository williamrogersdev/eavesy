//! "Copy Diagnostics": a scrubbed support bundle on the clipboard, so a user
//! can paste it into an email or issue without sending us anything directly.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::telemetry::{self, scrub_text, LOG_FILE_PREFIX};

const APP_LOG_LINES: usize = 200;
const CAPTURE_LOG_LINES: usize = 100;
const TAIL_BYTES: u64 = 256 * 1024;

pub fn copy(app: &AppHandle) {
    let report = collect(app);
    let (title, body) = match crate::commands::copy_to_clipboard(app, &report) {
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
    // Yesterday's file too, so a bundle copied just after midnight isn't empty.
    let app_logs = telemetry::log_dir().map(|dir| newest_logs(&dir, 2)).unwrap_or_default();
    let capture_log: Vec<PathBuf> = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("captures").join("capture.log"))
        .into_iter()
        .collect();
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
        section(&app_logs, APP_LOG_LINES),
        section(&capture_log, CAPTURE_LOG_LINES),
    )
}

/// Oldest first; each file contributes its tail and the last `lines` win.
fn section(paths: &[PathBuf], lines: usize) -> String {
    if paths.is_empty() {
        return "(no log yet)".to_owned();
    }
    let mut chunks = Vec::new();
    for path in paths {
        match read_tail(path) {
            Ok(chunk) => chunks.push(chunk),
            Err(error) => return format!("(unavailable: {})", scrub_text(&error.to_string())),
        }
    }
    let text = tail_text(&chunks, lines);
    if text.is_empty() { "(empty)".to_owned() } else { text }
}

/// Daily files are named `eavesy.YYYY-MM-DD.log`, so the name sorts by date.
fn newest_logs(dir: &Path, count: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(LOG_FILE_PREFIX) && name.ends_with(".log"))
        })
        .collect();
    logs.sort();
    logs.split_off(logs.len().saturating_sub(count))
}

/// The file's last `TAIL_BYTES`, and whether its first line was cut.
fn read_tail(path: &Path) -> std::io::Result<(String, bool)> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), start > 0))
}

fn tail_text(chunks: &[(String, bool)], lines: usize) -> String {
    let all: Vec<&str> = chunks
        .iter()
        .flat_map(|(text, partial)| text.lines().skip(usize::from(*partial)))
        .collect();
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
            tail_text(&[(log.to_owned(), true)], 2),
            "upload failed for [email]\nopened ~/…"
        );
        assert_eq!(tail_text(&[("a\nb".to_owned(), false)], 10), "a\nb");
    }

    #[test]
    fn tail_spans_yesterday_and_today() {
        let chunks = [
            ("y1\ny2\n".to_owned(), false),
            ("t1\n".to_owned(), false),
        ];
        assert_eq!(tail_text(&chunks, 2), "y2\nt1");
    }

    #[test]
    fn capture_log_folder_names_are_scrubbed() {
        let chunks = [(
            "SwiftAudio: The folder “Board layoffs with Dana” doesn’t exist.\n".to_owned(),
            false,
        )];
        assert_eq!(
            tail_text(&chunks, 5),
            "SwiftAudio: The folder “…” doesn’t exist."
        );
    }
}
