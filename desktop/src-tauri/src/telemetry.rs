//! Error tracking, product analytics and the app log.
//!
//! Errors and a few product events go to PostHog when the build was given a
//! project key (`EAVESY_POSTHOG_KEY` at compile time); without one nothing
//! leaves the Mac. Events carry an anonymous per-install id, never an
//! account, email or device name. Error reports keep the failing operation
//! and the error text so they are actionable, but the text is scrubbed first.
//! Recording folders are named after meeting titles, so any path under the
//! recordings root, a home directory, `/Volumes` or `/private` collapses to a
//! placeholder (keeping a trailing OS error such as "Permission denied"); only
//! app-owned paths with generated names survive. Tokens, API keys, emails,
//! IPs, query strings and quoted file names are replaced. Audio, transcripts,
//! notes and summaries are never attached.
//!
//! App logs go to a daily-rotating file in `~/Library/Logs/<identifier>`
//! (seven files kept), plus stderr in debug builds.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::Duration;

use regex::{Captures, Regex};
use serde_json::{json, Map, Value};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::prelude::*;

const IDENTIFIER: &str = "com.eavesy.desktop";
pub const LOG_FILE_PREFIX: &str = "eavesy";
const MAX_TEXT: usize = 1_000;
const RECENT_LOG_LINES: usize = 30;
const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";

pub struct Guards {
    _log: Option<WorkerGuard>,
}

pub fn init() -> Guards {
    let log = init_logging();
    start_sender();
    Guards { _log: log }
}

fn posthog_key() -> Option<&'static str> {
    option_env!("EAVESY_POSTHOG_KEY").filter(|key| !key.trim().is_empty())
}

fn posthog_endpoint() -> String {
    let host = option_env!("EAVESY_POSTHOG_HOST")
        .filter(|host| !host.trim().is_empty())
        .unwrap_or(DEFAULT_POSTHOG_HOST);
    format!("{}/i/v0/e/", host.trim_end_matches('/'))
}

type Outgoing = (Value, Option<mpsc::Sender<()>>);

static SENDER: OnceLock<Option<Mutex<mpsc::Sender<Outgoing>>>> = OnceLock::new();

/// One background thread posts events in order; a full or failed send is
/// dropped rather than retried, so telemetry never slows the app down.
fn start_sender() {
    SENDER.get_or_init(|| {
        posthog_key()?;
        let (tx, rx) = mpsc::channel::<Outgoing>();
        std::thread::Builder::new()
            .name("posthog".into())
            .spawn(move || {
                let Ok(client) = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build() else {
                    return;
                };
                let endpoint = posthog_endpoint();
                for (body, done) in rx {
                    let _ = client
                        .post(&endpoint)
                        .header("content-type", "application/json")
                        .body(body.to_string())
                        .send();
                    if let Some(done) = done {
                        let _ = done.send(());
                    }
                }
            })
            .ok()?;
        Some(Mutex::new(tx))
    });
}

/// An anonymous id for this install, kept next to the app's data. It is not
/// tied to the Eavesy account or the Mac's name.
fn install_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let path = dirs::data_dir().map(|dir| dir.join(IDENTIFIER).join("analytics-id"));
        if let Some(existing) = path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .map(|id| id.trim().to_owned())
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            return existing;
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(path) = path {
            let _ = path.parent().map(std::fs::create_dir_all);
            let _ = std::fs::write(path, &id);
        }
        id
    })
}

fn event_body(event: &str, properties: Value) -> Value {
    let mut props = match properties {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    props.insert("$lib".into(), "eavesy-desktop".into());
    props.insert("service".into(), "desktop".into());
    props.insert("release".into(), env!("CARGO_PKG_VERSION").into());
    props.insert("$app_version".into(), env!("CARGO_PKG_VERSION").into());
    props.insert(
        "environment".into(),
        (if cfg!(debug_assertions) { "development" } else { "production" }).into(),
    );
    props.insert("$os".into(), "Mac OS X".into());
    props.insert("arch".into(), std::env::consts::ARCH.into());
    props.insert("$process_person_profile".into(), false.into());
    json!({
        "api_key": posthog_key().unwrap_or_default(),
        "event": event,
        "distinct_id": install_id(),
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "properties": props,
    })
}

fn enqueue(event: &str, properties: Value, done: Option<mpsc::Sender<()>>) -> bool {
    let Some(Some(sender)) = SENDER.get() else { return false };
    let Ok(sender) = sender.lock() else { return false };
    sender.send((event_body(event, properties), done)).is_ok()
}

/// A product event. Properties must be fixed categories or counts, never
/// text the user wrote, said or named.
pub fn track(event: &'static str, properties: Value) {
    enqueue(event, properties, None);
}

/// Recent app log lines, scrubbed as they are recorded, sent with each error
/// so a report shows what led up to it.
static RECENT_LOGS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn recent_logs() -> Vec<String> {
    RECENT_LOGS
        .lock()
        .map(|lines| lines.iter().cloned().collect())
        .unwrap_or_default()
}

struct RecentLogs;

#[derive(Default)]
struct LineVisitor {
    message: String,
    fields: String,
}

impl tracing::field::Visit for LineVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            let _ = write!(self.fields, " {}={value:?}", field.name());
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_owned();
        } else {
            let _ = write!(self.fields, " {}={value}", field.name());
        }
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RecentLogs {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let mut line = LineVisitor::default();
        event.record(&mut line);
        let metadata = event.metadata();
        let text = scrub_text(&format!("{} {}: {}{}", metadata.level(), metadata.target(), line.message, line.fields));
        if let Ok(mut lines) = RECENT_LOGS.lock() {
            if lines.len() == RECENT_LOG_LINES {
                lines.pop_front();
            }
            lines.push_back(text);
        }
    }
}

/// `~/Library/Logs/com.eavesy.desktop`, the same folder Tauri's
/// `app_log_dir` resolves to on macOS. Known before the app handle exists.
pub fn log_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/Logs").join(IDENTIFIER))
}

fn init_logging() -> Option<WorkerGuard> {
    let (file_layer, guard) = match log_dir().and_then(|dir| {
        RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix(LOG_FILE_PREFIX)
            .filename_suffix("log")
            .max_log_files(7)
            .build(dir)
            .ok()
    }) {
        Some(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            let layer = tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(writer);
            (Some(layer), Some(guard))
        }
        None => (None, None),
    };
    let stderr_layer = cfg!(debug_assertions)
        .then(|| tracing_subscriber::fmt::layer().with_writer(std::io::stderr));
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::LevelFilter::INFO)
        .with(file_layer)
        .with(stderr_layer)
        .with(RecentLogs)
        .try_init();

    std::panic::set_hook(Box::new(|info| {
        let message = scrub_text(&info.to_string());
        tracing::error!(target: "panic", "{message}");
        let location = info
            .location()
            .map(|location| format!("{}:{}", scrub_text(location.file()), location.line()))
            .unwrap_or_default();
        // The process may be about to abort: wait briefly for the send.
        let (done, sent) = mpsc::channel();
        if enqueue("$exception", panic_properties(&message, &location), Some(done)) {
            let _ = sent.recv_timeout(Duration::from_secs(3));
        }
    }));
    guard
}

fn panic_properties(message: &str, location: &str) -> Value {
    json!({
        "$exception_list": [{
            "type": "panic",
            "value": message,
            "mechanism": { "handled": false, "synthetic": false },
        }],
        "$exception_fingerprint": format!("desktop:panic:{location}"),
        "recent_logs": recent_logs(),
    })
}

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(https?://[^\s?#'<>]+)[?#][^\s'<>]*", "$1"),
            (r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [token]"),
            (r"\b(?:Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}", "[credential]"),
            (r"\bsk-ant-[A-Za-z0-9_-]{8,}", "[api-key]"),
            (r"\bsk-or-[A-Za-z0-9_-]{8,}", "[api-key]"),
            (r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}", "[api-key]"),
            (r"\bwhsec_[A-Za-z0-9]{8,}", "[api-key]"),
            (r"\bsk-[A-Za-z0-9_-]{20,}", "[api-key]"),
            (r"\beavesy_device_[A-Za-z0-9_-]{8,}", "[token]"),
            (r"\bnt_[0-9a-f]{16,}", "[token]"),
            (r"(?i)\banon_[0-9a-f-]{16,}", "[token]"),
            (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "[jwt]"),
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email]"),
            (r"\b\d{1,3}(?:\.\d{1,3}){3}\b", "[ip]"),
            (r"(?i)\b[0-9a-f]{32,}\b", "[token]"),
            // macOS error text quotes file and folder names (meeting titles).
            (r"“[^”\n]*”", "“…”"),
            (r"‘[^’\n]*’", "‘…’"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
        .collect()
    })
}

/// Recordings-root paths the watcher is using, as given and canonicalized.
static RECORDINGS_ROOTS: RwLock<Vec<String>> = RwLock::new(Vec::new());

pub fn set_recordings_root(root: &Path) {
    let mut roots = vec![root.to_string_lossy().into_owned()];
    if let Ok(canonical) = std::fs::canonicalize(root) {
        roots.push(canonical.to_string_lossy().into_owned());
    }
    roots.retain(|root| root.len() > 1);
    if let Ok(mut current) = RECORDINGS_ROOTS.write() {
        *current = roots;
    }
}

// A path below a user-visible folder may contain spaces, colons and quotes
// (it is named after a meeting), so everything up to the end of the line or
// a closing quote is treated as part of it.
const PATH_REST: &str = r#"[^\n"“”‘’`]*"#;

fn app_path() -> &'static Regex {
    static APP: OnceLock<Regex> = OnceLock::new();
    // App-owned folders have generated names (ids, indexes); keep them.
    APP.get_or_init(|| {
        Regex::new(&format!(
            r"(?:file://)?/Users/[^/\s]+/Library/(?:Application Support|Logs|Caches)/{}((?:/[A-Za-z0-9._-]+)*)",
            regex::escape(IDENTIFIER)
        ))
        .expect("valid pattern")
    })
}

fn user_path() -> &'static Regex {
    static USER: OnceLock<Regex> = OnceLock::new();
    USER.get_or_init(|| {
        Regex::new(&format!(r"(?:file://)?/(Users|Volumes|private)/[^/\s]+{PATH_REST}"))
            .expect("valid pattern")
    })
}

fn os_error_tail() -> &'static Regex {
    static TAIL: OnceLock<Regex> = OnceLock::new();
    TAIL.get_or_init(|| {
        Regex::new(
            r"(?i):\s*((?:Permission denied|No such file or directory|Operation not permitted|File exists|Is a directory|Not a directory|Directory not empty|No space left on device|Read-only file system|Resource busy|Input/output error|Operation timed out|Too many open files|File name too long)(?:\s*\(os error \d+\))?)",
        )
        .expect("valid pattern")
    })
}

/// Replacement for a swallowed path: the placeholder plus any OS error text
/// that was caught up in it, so "why" survives even when "where" does not.
fn collapse(placeholder: &str, swallowed: &str) -> String {
    match os_error_tail().captures_iter(swallowed).last() {
        Some(tail) => format!("{placeholder}: {}", &tail[1]),
        None => placeholder.to_owned(),
    }
}

fn opaque_run() -> &'static Regex {
    static RUN: OnceLock<Regex> = OnceLock::new();
    RUN.get_or_init(|| Regex::new(r"[A-Za-z0-9_-]{40,}").expect("valid pattern"))
}

/// Remove user paths, credentials and contact details from free text.
pub fn scrub_text(text: &str) -> String {
    let mut out = text.to_owned();
    if let Ok(roots) = RECORDINGS_ROOTS.read() {
        for root in roots.iter() {
            let pattern = format!("(?:file://)?{}{PATH_REST}", regex::escape(root));
            if let Ok(pattern) = Regex::new(&pattern) {
                out = pattern
                    .replace_all(&out, |caps: &Captures| collapse("<recordings>/…", &caps[0][root.len()..]))
                    .into_owned();
            }
        }
    }
    out = app_path().replace_all(&out, "<app>$1").into_owned();
    out = user_path()
        .replace_all(&out, |caps: &Captures| {
            let placeholder = match &caps[1] {
                "Users" => "~/…",
                "Volumes" => "/Volumes/…",
                _ => "/private/…",
            };
            collapse(placeholder, &caps[0])
        })
        .into_owned();
    for (pattern, replacement) in patterns() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    let mut out = opaque_run()
        .replace_all(&out, |caps: &Captures| {
            let run = &caps[0];
            let mixed = run.bytes().any(|b| b.is_ascii_digit())
                && run.bytes().any(|b| b.is_ascii_alphabetic());
            if mixed { "[token]".to_owned() } else { run.to_owned() }
        })
        .into_owned();
    if out.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    out
}

/// Log a failed operation and report it to PostHog. Issues group by
/// operation and reason; the scrubbed detail is the exception value.
pub fn capture(operation: &'static str, detail: &str) {
    let reason = reason(detail);
    let detail = scrub_text(detail);
    enqueue("$exception", capture_properties(operation, reason, &detail), None);
    tracing::error!(operation, reason, "{detail}");
}

fn capture_properties(operation: &str, reason: &str, scrubbed_detail: &str) -> Value {
    json!({
        "$exception_list": [{
            "type": operation,
            "value": format!("{operation}: {scrubbed_detail}"),
            "mechanism": { "handled": true, "synthetic": true },
        }],
        "$exception_fingerprint": format!("desktop:{operation}:{reason}"),
        "operation": operation,
        "reason": reason,
        "recent_logs": recent_logs(),
    })
}

fn reason(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();
    let status = lower
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|n| n.parse::<u16>().ok())
        .find(|n| (400..600).contains(n) && lower.contains("http"));
    match status {
        Some(401 | 403) => return "http_unauthorized",
        Some(404) => return "http_not_found",
        Some(409) => return "http_conflict",
        Some(413) => return "http_too_large",
        Some(429) => return "http_rate_limited",
        Some(400..=499) => return "http_4xx",
        Some(500..=599) => return "http_5xx",
        _ => {}
    }
    const PATTERNS: &[(&str, &str)] = &[
        ("timed out", "timeout"),
        ("timeout", "timeout"),
        ("dns", "network"),
        ("connect", "network"),
        ("request failed", "network"),
        ("permission", "permission"),
        ("not authorized", "permission"),
        ("tcc", "permission"),
        ("keychain", "keychain"),
        ("no space", "disk_full"),
        ("no such file", "file_missing"),
        ("not found", "not_found"),
        ("read media", "file_read"),
        ("write", "file_write"),
        ("empty transcript", "empty_transcript"),
        ("bad response", "bad_response"),
        ("sidecar", "capture_engine"),
        ("swiftaudio", "capture_engine"),
        ("screencapturekit", "capture_engine"),
    ];
    PATTERNS
        .iter()
        .find(|(needle, _)| lower.contains(needle))
        .map(|(_, reason)| *reason)
        .unwrap_or("other")
}

#[cfg(test)]
mod tests {
    use super::{capture_properties, event_body, panic_properties, reason, scrub_text};

    #[test]
    fn failure_reasons_are_fixed_categories() {
        assert_eq!(reason("transcribe HTTP 401 Unauthorized"), "http_unauthorized");
        assert_eq!(reason("upload HTTP 503 Service Unavailable"), "http_5xx");
        assert_eq!(reason("request failed: operation timed out"), "timeout");
        assert_eq!(reason("could not open Keychain: denied"), "keychain");
        assert_eq!(reason("Meeting with Dana about 2024 plans"), "other");
    }

    #[test]
    fn meeting_titles_in_paths_never_survive() {
        // Titles with spaces, colons and apostrophes, under home and custom roots.
        let cases = [
            (
                "could not read /Users/dana/Eavesy/Recordings/2026-10-14 Board layoffs with Dana: Q3/audio.m4a: Permission denied (os error 13)",
                "could not read ~/…: Permission denied (os error 13)",
            ),
            (
                "could not create /Users/dana/Eavesy/Recordings/Dana's 1:1 – comp review/notes.md",
                "could not create ~/…",
            ),
            (
                "recording at /Volumes/Archive/Meetings/Acquisition of Initech/summary.md: No such file or directory (os error 2)",
                "recording at <recordings>/…: No such file or directory (os error 2)",
            ),
            (
                "file:///private/var/folders/xy/Board offsite.m4a missing",
                "/private/…",
            ),
            ("home is /Users/dana", "home is ~/…"),
            (
                "The file “Board layoffs with Dana” couldn’t be opened.",
                "The file “…” couldn’t be opened.",
            ),
        ];
        super::set_recordings_root(std::path::Path::new("/Volumes/Archive/Meetings"));
        for (input, expected) in cases {
            assert_eq!(scrub_text(input), expected, "input: {input}");
        }
    }

    #[test]
    fn app_owned_paths_keep_their_generated_names() {
        assert_eq!(
            scrub_text("segment write failed: /Users/dana/Library/Application Support/com.eavesy.desktop/captures/9f1c/segments/3.m4a"),
            "segment write failed: <app>/captures/9f1c/segments/3.m4a"
        );
    }

    #[test]
    fn scrub_text_removes_credentials_and_contact_details() {
        let cases = [
            (
                "HTTP 401 with Bearer eavesy_device_kq2N0dS8mX4bV7cZ1aP9wE3rT6yU5iO0lK8jH2gF4dS",
                "HTTP 401 with Bearer [token]",
            ),
            (
                "key sk-ant-api03-Zx9yQ8wV7uT6sR5qP4oN3mL2kJ1iH0gF-abcd for dana@example.com",
                "key [api-key] for [email]",
            ),
            ("stripe sk_live_51Hxyzabcdefgh and whsec_abcdefgh1234", "stripe [api-key] and [api-key]"),
            ("restricted rk_test_abcdefgh123", "restricted [api-key]"),
            ("anon_6f9619ff-8b86-d011-b42d-00cf4fc964ff from 203.0.113.9", "[token] from [ip]"),
            (
                "GET https://eavesy.com/api/sessions/01JA2B?token=abc failed",
                "GET https://eavesy.com/api/sessions/01JA2B failed",
            ),
            ("segment 3 upload HTTP 503", "segment 3 upload HTTP 503"),
        ];
        for (input, expected) in cases {
            assert_eq!(scrub_text(input), expected, "input: {input}");
        }
    }

    #[test]
    fn error_reports_keep_the_operation_but_not_user_data() {
        let detail = scrub_text("upload failed for dana@example.com at /Users/dana/Eavesy/Secret plans/audio.m4a");
        let body = event_body("$exception", capture_properties("sync.run", "other", &detail));
        let exception = &body["properties"]["$exception_list"][0];
        assert_eq!(exception["type"], "sync.run");
        assert_eq!(exception["value"], "sync.run: upload failed for [email] at ~/…");
        assert_eq!(body["properties"]["$exception_fingerprint"], "desktop:sync.run:other");
        assert_eq!(body["properties"]["$process_person_profile"], false);
        assert!(uuid::Uuid::parse_str(body["distinct_id"].as_str().unwrap()).is_ok());
        let serialized = body.to_string();
        assert!(!serialized.contains("Secret plans"));
        assert!(!serialized.contains("dana"));
    }

    #[test]
    fn panics_are_unhandled_and_grouped_by_location() {
        let properties = panic_properties("panicked at src/sync.rs:12:5: boom", "src/sync.rs:12");
        assert_eq!(properties["$exception_list"][0]["mechanism"]["handled"], false);
        assert_eq!(properties["$exception_fingerprint"], "desktop:panic:src/sync.rs:12");
    }
}
