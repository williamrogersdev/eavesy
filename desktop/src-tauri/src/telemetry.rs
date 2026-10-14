//! Error reporting and the app log.
//!
//! Sentry events keep the failing operation and the error text so a report is
//! actionable, but the text is scrubbed first: home-directory paths collapse
//! to `~/…/<file>` (recording folders are named after meeting titles), and
//! tokens, API keys, emails and query strings are replaced. Audio,
//! transcripts, notes and summaries are never attached.
//!
//! App logs go to a daily-rotating file in `~/Library/Logs/<identifier>`
//! (seven files kept), plus stderr in debug builds.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use sentry::integrations::tracing::EventFilter;
use sentry::protocol::{Breadcrumb, Event, Level, Value};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::prelude::*;

const IDENTIFIER: &str = "com.eavesy.desktop";
pub const LOG_FILE_PREFIX: &str = "eavesy";
const MAX_TEXT: usize = 1_000;

pub struct Guards {
    _sentry: sentry::ClientInitGuard,
    _log: Option<WorkerGuard>,
}

pub fn init() -> Guards {
    let log = init_logging();
    let dsn = option_env!("SENTRY_DSN").unwrap_or("");
    let options = sentry::ClientOptions::default()
        .release(env!("CARGO_PKG_VERSION"))
        .environment(if cfg!(debug_assertions) { "development" } else { "production" })
        .send_default_pii(false)
        .traces_sample_rate(0.0)
        .max_breadcrumbs(50)
        .before_breadcrumb(|breadcrumb| Some(scrub_breadcrumb(breadcrumb)))
        .before_send(|event| Some(sanitize_event(event)));
    Guards {
        _sentry: sentry::init((dsn, options)),
        _log: log,
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
    // Log lines become breadcrumbs on the next reported error; `capture`
    // sends the error itself, so nothing here creates events.
    let sentry_layer = sentry::integrations::tracing::layer().event_filter(|metadata| {
        match *metadata.level() {
            tracing::Level::ERROR | tracing::Level::WARN | tracing::Level::INFO => {
                EventFilter::Breadcrumb
            }
            _ => EventFilter::Ignore,
        }
    });
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::filter::LevelFilter::INFO)
        .with(file_layer)
        .with(stderr_layer)
        .with(sentry_layer)
        .try_init();

    // The Sentry panic integration chains to this hook, so panics land in the
    // log file as well as in Sentry.
    std::panic::set_hook(Box::new(|info| {
        tracing::error!(target: "panic", "{}", scrub_text(&info.to_string()));
    }));
    guard
}

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(https?://[^\s?#'<>]+)[?#][^\s'<>]*", "$1"),
            (r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [token]"),
            (r"\bsk-ant-[A-Za-z0-9_-]{8,}", "[api-key]"),
            (r"\bsk-or-[A-Za-z0-9_-]{8,}", "[api-key]"),
            (r"\bsk-[A-Za-z0-9_-]{20,}", "[api-key]"),
            (r"\beavesy_device_[A-Za-z0-9_-]{8,}", "[token]"),
            (r"\bnt_[0-9a-f]{16,}", "[token]"),
            (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "[jwt]"),
            (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "[email]"),
            (r"(?i)\b[0-9a-f]{32,}\b", "[token]"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
        .collect()
    })
}

fn home_path() -> &'static Regex {
    static HOME: OnceLock<Regex> = OnceLock::new();
    // Middle folders may contain spaces (they are meeting titles); the final
    // component stops at whitespace so trailing error text survives.
    HOME.get_or_init(|| {
        Regex::new(r#"(?:file://)?/Users/[^/\s"'<>]+(?:(?:/[^/\n\r\t:"'<>]+)*/([^/\s:"'<>]+))?"#)
            .expect("valid pattern")
    })
}

fn opaque_run() -> &'static Regex {
    static RUN: OnceLock<Regex> = OnceLock::new();
    RUN.get_or_init(|| Regex::new(r"[A-Za-z0-9_-]{40,}").expect("valid pattern"))
}

/// Remove user paths, credentials and contact details from free text.
pub fn scrub_text(text: &str) -> String {
    let mut out: Cow<str> = home_path().replace_all(text, |caps: &Captures| match caps.get(1) {
        Some(last) => format!("~/…/{}", last.as_str()),
        None => "~".to_owned(),
    });
    for (pattern, replacement) in patterns() {
        out = Cow::Owned(pattern.replace_all(&out, *replacement).into_owned());
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

fn scrub_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = scrub_text(text),
        Value::Array(items) => items.iter_mut().for_each(scrub_value),
        Value::Object(map) => map.values_mut().for_each(scrub_value),
        _ => {}
    }
}

fn scrub_breadcrumb(mut breadcrumb: Breadcrumb) -> Breadcrumb {
    breadcrumb.message = breadcrumb.message.map(|message| scrub_text(&message));
    breadcrumb.data.values_mut().for_each(scrub_value);
    breadcrumb
}

fn sanitize_event(mut event: Event<'static>) -> Event<'static> {
    event.request = None;
    event.user = None;
    event.server_name = None;
    event.extra.values_mut().for_each(scrub_value);
    for breadcrumb in &mut event.breadcrumbs.values {
        *breadcrumb = scrub_breadcrumb(std::mem::take(breadcrumb));
    }
    event.message = event.message.map(|message| scrub_text(&message));
    if let Some(entry) = &mut event.logentry {
        entry.message = scrub_text(&entry.message);
        entry.params.iter_mut().for_each(scrub_value);
    }
    for exception in &mut event.exception {
        exception.value = exception.value.as_deref().map(scrub_text);
        if let Some(stacktrace) = &mut exception.stacktrace {
            for frame in &mut stacktrace.frames {
                frame.abs_path = frame.abs_path.as_deref().map(scrub_text);
                frame.vars.clear();
            }
        }
    }
    event
}

/// Log a failed operation and report it to Sentry. Issues group by operation
/// and reason; the scrubbed detail is the event message.
pub fn capture(operation: &'static str, detail: &str) {
    let reason = reason(detail);
    let detail = scrub_text(detail);
    sentry::with_scope(
        |scope| {
            scope.set_tag("operation", operation);
            scope.set_tag("reason", reason);
            scope.set_fingerprint(Some(&["desktop", operation, reason]));
        },
        || sentry::capture_message(&format!("{operation}: {detail}"), Level::Error),
    );
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
    use sentry::protocol::{Breadcrumb, Event, Exception, Frame, Stacktrace};

    use super::{reason, sanitize_event, scrub_text};

    #[test]
    fn failure_reasons_are_fixed_categories() {
        assert_eq!(reason("transcribe HTTP 401 Unauthorized"), "http_unauthorized");
        assert_eq!(reason("upload HTTP 503 Service Unavailable"), "http_5xx");
        assert_eq!(reason("request failed: operation timed out"), "timeout");
        assert_eq!(reason("could not open Keychain: denied"), "keychain");
        assert_eq!(reason("Meeting with Dana about 2024 plans"), "other");
    }

    #[test]
    fn scrub_text_collapses_home_paths_and_removes_secrets() {
        assert_eq!(
            scrub_text("could not read /Users/dana/Eavesy/2026-10-14 Board layoffs/audio.m4a: No such file"),
            "could not read ~/…/audio.m4a: No such file"
        );
        assert_eq!(scrub_text("home is /Users/dana"), "home is ~");
        assert_eq!(
            scrub_text("HTTP 401 with Bearer eavesy_device_kq2N0dS8mX4bV7cZ1aP9wE3rT6yU5iO0lK8jH2gF4dS"),
            "HTTP 401 with Bearer [token]"
        );
        assert_eq!(
            scrub_text("key sk-ant-api03-Zx9yQ8wV7uT6sR5qP4oN3mL2kJ1iH0gF-abcd for dana@example.com"),
            "key [api-key] for [email]"
        );
        assert_eq!(
            scrub_text("GET https://eavesy.com/api/sessions/01JA2B?token=abc failed"),
            "GET https://eavesy.com/api/sessions/01JA2B failed"
        );
        assert_eq!(scrub_text("segment 3 upload HTTP 503"), "segment 3 upload HTTP 503");
    }

    #[test]
    fn telemetry_keeps_the_error_but_not_user_data() {
        let mut event = Event::default();
        event.message = Some("upload failed for dana@example.com".to_owned());
        event.server_name = Some("personal-mac".into());
        event.extra.insert("detail".to_owned(), "/Users/dana/Eavesy/Secret plans/notes.md".into());
        event.breadcrumbs.values.push(Breadcrumb {
            message: Some("opened /Users/dana/Eavesy/Secret plans/audio.m4a".to_owned()),
            ..Default::default()
        });
        event.exception.values.push(Exception {
            value: Some("called `Result::unwrap()` on /Users/dana/Eavesy/Secret plans/audio.m4a".to_owned()),
            stacktrace: Some(Stacktrace {
                frames: vec![Frame {
                    abs_path: Some("/Users/runner/work/eavesy/desktop/src-tauri/src/sync.rs".to_owned()),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        });

        let event = sanitize_event(event);
        assert_eq!(event.message.as_deref(), Some("upload failed for [email]"));
        assert!(event.server_name.is_none());
        assert_eq!(event.extra["detail"], "~/…/notes.md");
        assert_eq!(
            event.breadcrumbs.values[0].message.as_deref(),
            Some("opened ~/…/audio.m4a")
        );
        let exception = &event.exception.values[0];
        assert_eq!(
            exception.value.as_deref(),
            Some("called `Result::unwrap()` on ~/…/audio.m4a")
        );
        assert_eq!(
            exception.stacktrace.as_ref().unwrap().frames[0].abs_path.as_deref(),
            Some("~/…/sync.rs")
        );
        assert!(!format!("{event:?}").contains("Secret plans"));
    }
}
