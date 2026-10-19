//! Error reporting and the app log.
//!
//! Errors and panics go to PostHog error tracking as `$exception` events when
//! a project key was compiled in (`EAVESY_POSTHOG_KEY`); without one nothing
//! leaves the Mac. Events keep the failing operation and the error text so a
//! report is actionable, but the text is scrubbed first. Recording folders are
//! named after meeting titles, so any path under the recordings root, a home
//! directory, `/Volumes` or `/private` collapses to a placeholder (keeping a
//! trailing OS error such as "Permission denied"); only app-owned paths with
//! generated names survive. Tokens, API keys, emails, IPs, query strings and
//! quoted file names are replaced. Audio, transcripts, notes and summaries are
//! never attached. Events are anonymous: a random id per launch and no person
//! profile.
//!
//! App logs go to a daily-rotating file in `~/Library/Logs/<identifier>`
//! (seven files kept), plus stderr in debug builds.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock, RwLock};
use std::time::Duration;

use regex::{Captures, Regex};
use serde_json::{json, Value};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::prelude::*;

const IDENTIFIER: &str = "com.eavesy.desktop";
pub const LOG_FILE_PREFIX: &str = "eavesy";
const MAX_TEXT: usize = 1_000;
const MAX_BREADCRUMBS: usize = 50;
const MAX_EVENTS_PER_LAUNCH: usize = 100;
const DEFAULT_POSTHOG_HOST: &str = "https://us.i.posthog.com";
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const PANIC_SEND_TIMEOUT: Duration = Duration::from_secs(3);

static BREADCRUMBS: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static EVENTS_SENT: AtomicUsize = AtomicUsize::new(0);

pub struct Guards {
    _log: Option<WorkerGuard>,
}

pub fn init() -> Guards {
    Guards { _log: init_logging() }
}

fn posthog_key() -> Option<&'static str> {
    option_env!("EAVESY_POSTHOG_KEY").map(str::trim).filter(|key| !key.is_empty())
}

fn posthog_endpoint() -> String {
    let host = option_env!("EAVESY_POSTHOG_HOST")
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or(DEFAULT_POSTHOG_HOST);
    format!("{}/i/v0/e/", host.trim_end_matches('/'))
}

fn launch_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().to_string())
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
        .with(posthog_key().map(|_| BreadcrumbLayer))
        .try_init();

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let detail = scrub_text(&info.to_string());
        tracing::error!(target: "panic", "{detail}");
        let report = Report { kind: "panic", operation: "panic", reason: "panic", detail: &detail, handled: false };
        if let Some(sent) = send(report, PANIC_SEND_TIMEOUT) {
            let _ = sent.recv_timeout(PANIC_SEND_TIMEOUT + Duration::from_millis(500));
        }
        default_hook(info);
    }));
    guard
}

/// Keeps the messages of the last log lines (info and up) to send with the
/// next error. Structured fields are left out; only the message is scrubbed
/// and sent.
struct BreadcrumbLayer;

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for BreadcrumbLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let metadata = event.metadata();
        let mut line = format!("{} {}:", metadata.level(), metadata.target());
        event.record(&mut FieldWriter(&mut line));
        if let Ok(mut crumbs) = BREADCRUMBS.lock() {
            if crumbs.len() == MAX_BREADCRUMBS {
                crumbs.pop_front();
            }
            crumbs.push_back(line);
        }
    }
}

struct FieldWriter<'a>(&'a mut String);

impl tracing::field::Visit for FieldWriter<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.0, " {value:?}");
        }
    }
}

struct Report<'a> {
    kind: &'a str,
    operation: &'a str,
    reason: &'a str,
    detail: &'a str,
    handled: bool,
}

/// The PostHog `$exception` event. Every free-text field is scrubbed here.
fn exception_event(api_key: &str, report: &Report<'_>, breadcrumbs: &[String]) -> Value {
    json!({
        "api_key": api_key,
        "event": "$exception",
        "distinct_id": launch_id(),
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "properties": {
            "$process_person_profile": false,
            "$lib": "eavesy-desktop",
            "$app_version": env!("CARGO_PKG_VERSION"),
            "$os": "macOS",
            "environment": if cfg!(debug_assertions) { "development" } else { "production" },
            "operation": report.operation,
            "reason": report.reason,
            "$exception_fingerprint": format!("desktop:{}:{}", report.operation, report.reason),
            "$exception_list": [{
                "type": report.kind,
                "value": scrub_text(report.detail),
                "mechanism": { "handled": report.handled, "synthetic": false },
            }],
            "breadcrumbs": breadcrumbs.iter().map(|line| scrub_text(line)).collect::<Vec<_>>(),
        },
    })
}

/// Sends on its own thread; the receiver fires once the request finished.
fn send(report: Report<'_>, timeout: Duration) -> Option<mpsc::Receiver<()>> {
    let api_key = posthog_key()?;
    EVENTS_SENT
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |sent| {
            (sent < MAX_EVENTS_PER_LAUNCH).then_some(sent + 1)
        })
        .ok()?;
    let breadcrumbs: Vec<String> = BREADCRUMBS
        .try_lock()
        .map(|crumbs| crumbs.iter().cloned().collect())
        .unwrap_or_default();
    let event = exception_event(api_key, &report, &breadcrumbs);
    let (done, finished) = mpsc::channel();
    std::thread::Builder::new()
        .name("error-report".into())
        .spawn(move || {
            if let Ok(client) = reqwest::blocking::Client::builder()
                .timeout(timeout)
                .build()
            {
                let _ = client.post(posthog_endpoint()).json(&event).send();
            }
            let _ = done.send(());
        })
        .inspect_err(|_| {
            EVENTS_SENT.fetch_sub(1, Ordering::Relaxed);
        })
        .ok()?;
    Some(finished)
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
    send(Report { kind: operation, operation, reason, detail: &detail, handled: true }, SEND_TIMEOUT);
    tracing::error!(operation, reason, "{detail}");
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
    use super::{exception_event, reason, scrub_text, Report};

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
    fn telemetry_keeps_the_error_but_not_user_data() {
        let report = Report {
            kind: "sync.run",
            operation: "sync.run",
            reason: "file_read",
            detail: "upload failed for dana@example.com reading /Users/dana/Eavesy/Secret plans/audio.m4a",
            handled: true,
        };
        let breadcrumbs = ["INFO eavesy::sync: opened /Users/dana/Eavesy/Secret plans/notes.md".to_owned()];
        let event = exception_event("phc_test", &report, &breadcrumbs);

        assert_eq!(event["event"], "$exception");
        let properties = &event["properties"];
        assert_eq!(properties["$process_person_profile"], false);
        assert_eq!(properties["$exception_fingerprint"], "desktop:sync.run:file_read");
        let exception = &properties["$exception_list"][0];
        assert_eq!(exception["type"], "sync.run");
        assert_eq!(exception["value"], "upload failed for [email] reading ~/…");
        assert_eq!(properties["breadcrumbs"][0], "INFO eavesy::sync: opened ~/…");
        let text = event.to_string();
        assert!(!text.contains("Secret plans"));
        assert!(!text.contains("dana@example.com"));
    }
}
