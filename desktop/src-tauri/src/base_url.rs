//! The single source of truth for the Eavesy server this app talks to.
//!
//! Resolution order, first match wins:
//! 1. `EAVESY_API_BASE` environment variable (debug builds only).
//! 2. `api_base_url` in `settings.json` (any build) for self-hosters. A device
//!    credential is bound to the server that issued it (see `settings`), so
//!    changing this requires pairing again.
//! 3. `EAVESY_API_BASE` captured at compile time.
//! 4. `https://eavesy.com`.

use std::sync::RwLock;

pub const DEFAULT_BASE: &str = "https://eavesy.com";

static SETTINGS_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

/// Validates a user-supplied base URL and returns it without a trailing slash.
/// Only `https` is accepted, except `http` for loopback hosts used in local dev.
pub fn normalize(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed).map_err(|e| format!("invalid server URL: {e}"))?;
    let host = url.host_str().ok_or("server URL needs a host")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback && cfg!(debug_assertions) => {}
        _ => return Err("server URL must use https".into()),
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("server URL must not include a path".into());
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        return Err("server URL must be a plain origin".into());
    }
    Ok(trimmed.to_string())
}

/// True when `url` is on the same scheme, host and port as `base`.
pub fn same_origin(url: &str, base: &str) -> bool {
    match (reqwest::Url::parse(url), reqwest::Url::parse(base)) {
        (Ok(a), Ok(b)) => a.origin() == b.origin(),
        _ => false,
    }
}

/// Called whenever settings are loaded so every module sees the configured value.
pub fn set_settings_override(value: Option<&str>) {
    let normalized = value.and_then(|v| match normalize(v) {
        Ok(url) => Some(url),
        Err(error) => {
            eprintln!("ignoring api_base_url in settings: {error}");
            None
        }
    });
    if let Ok(mut guard) = SETTINGS_OVERRIDE.write() {
        *guard = normalized;
    }
}

fn resolve(env: Option<String>, settings: Option<String>, compiled: Option<&str>) -> String {
    env.and_then(|v| normalize(&v).ok())
        .or(settings)
        .or_else(|| compiled.and_then(|v| normalize(v).ok()))
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
}

pub fn api_base() -> String {
    let env = if cfg!(debug_assertions) {
        std::env::var("EAVESY_API_BASE").ok()
    } else {
        None
    };
    let settings = SETTINGS_OVERRIDE.read().ok().and_then(|g| g.clone());
    resolve(env, settings, option_env!("EAVESY_API_BASE"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_validates() {
        assert_eq!(normalize("https://eavesy.example.com/").unwrap(), "https://eavesy.example.com");
        assert_eq!(normalize("http://localhost:3000").is_ok(), cfg!(debug_assertions));
        assert!(normalize("http://eavesy.example.com").is_err());
        assert!(normalize("https://example.com/api").is_err());
        assert!(normalize("not a url").is_err());
        assert!(normalize("https://user@example.com").is_err());
    }

    #[test]
    fn verification_links_must_stay_on_the_server() {
        assert!(same_origin("https://eavesy.example.com/connect/mac?c=1", "https://eavesy.example.com"));
        assert!(!same_origin("https://evil.example/connect", "https://eavesy.example.com"));
        assert!(!same_origin("http://eavesy.example.com/x", "https://eavesy.example.com"));
        assert!(!same_origin("javascript:alert(1)", "https://eavesy.example.com"));
    }

    #[test]
    fn resolution_order() {
        let s = Some("https://s.example".to_string());
        assert_eq!(resolve(Some("https://env.example".into()), s.clone(), Some("https://c.example")), "https://env.example");
        assert_eq!(resolve(None, s, Some("https://c.example")), "https://s.example");
        assert_eq!(resolve(None, None, Some("https://c.example")), "https://c.example");
        assert_eq!(resolve(None, None, None), DEFAULT_BASE);
        assert_eq!(resolve(None, None, Some("bad")), DEFAULT_BASE);
    }
}
