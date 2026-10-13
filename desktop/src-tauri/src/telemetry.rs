use sentry::protocol::Level;

pub fn init() -> sentry::ClientInitGuard {
    let dsn = option_env!("SENTRY_DSN").unwrap_or("");
    let options = sentry::ClientOptions::default()
        .release(env!("CARGO_PKG_VERSION"))
        .send_default_pii(false)
        .traces_sample_rate(0.0)
        .max_breadcrumbs(0)
        .before_send(|event| Some(sanitize_event(event)));
    sentry::init((dsn, options))
}

fn sanitize_event(mut event: sentry::protocol::Event<'static>) -> sentry::protocol::Event<'static> {
    event.request = None;
    event.user = None;
    event.server_name = None;
    event.extra.clear();
    event.breadcrumbs.values.clear();
    event.message = event
        .message
        .map(|_| "Desktop operation failed".to_owned());
    event.logentry = None;
    for exception in &mut event.exception {
        exception.value = Some("Desktop operation failed".to_owned());
        if let Some(stacktrace) = &mut exception.stacktrace {
            for frame in &mut stacktrace.frames {
                frame.abs_path = None;
                frame.vars.clear();
            }
        }
    }
    event
}

pub fn capture(operation: &'static str, detail: &str) {
    let reason = reason(detail);
    sentry::with_scope(
        |scope| {
            scope.set_tag("operation", operation);
            scope.set_tag("reason", reason);
        },
        || sentry::capture_message("Desktop operation failed", Level::Error),
    );
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

    use super::{reason, sanitize_event};

    #[test]
    fn failure_reasons_are_fixed_categories() {
        assert_eq!(reason("transcribe HTTP 401 Unauthorized"), "http_unauthorized");
        assert_eq!(reason("upload HTTP 503 Service Unavailable"), "http_5xx");
        assert_eq!(reason("request failed: operation timed out"), "timeout");
        assert_eq!(reason("could not open Keychain: denied"), "keychain");
        assert_eq!(reason("Meeting with Dana about 2024 plans"), "other");
    }

    #[test]
    fn telemetry_removes_user_supplied_diagnostics() {
        let mut event = Event::default();
        event.message = Some("secret transcript text".to_owned());
        event.server_name = Some("personal-mac".into());
        event.extra.insert("detail".to_owned(), "secret".into());
        event.breadcrumbs.values.push(Breadcrumb::default());
        event.exception.values.push(Exception {
            value: Some("/Users/person/private recording".to_owned()),
            stacktrace: Some(Stacktrace {
                frames: vec![Frame {
                    abs_path: Some("/Users/person/eavesy.rs".to_owned()),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        });

        let event = sanitize_event(event);
        assert_eq!(event.message.as_deref(), Some("Desktop operation failed"));
        assert!(event.server_name.is_none());
        assert!(event.extra.is_empty());
        assert!(event.breadcrumbs.is_empty());
        assert_eq!(
            event.exception.values[0].value.as_deref(),
            Some("Desktop operation failed")
        );
        assert!(event.exception.values[0]
            .stacktrace
            .as_ref()
            .unwrap()
            .frames[0]
            .abs_path
            .is_none());
    }
}
