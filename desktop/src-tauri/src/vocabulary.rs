//! The custom words and transcription language from the user's account, kept
//! on disk so a capture can hand them to the on-device recognizer without
//! waiting on the network. Each capture refreshes them for the next one.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::settings;

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("vocabulary.json"))
}

fn language_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("language.txt"))
}

/// The account's transcription language: a cloud code like `es`, or `auto`.
pub fn cached_language(app: &AppHandle) -> Option<String> {
    language_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| clean_language(&raw))
}

fn store_language(app: &AppHandle, language: Option<&str>) {
    let Some(path) = language_path(app) else { return };
    let Some(language) = language.and_then(clean_language) else {
        let _ = std::fs::remove_file(path);
        return;
    };
    if cached_language(app).as_deref() == Some(language.as_str()) {
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let partial = path.with_extension(format!("txt.{}", uuid::Uuid::new_v4()));
    if std::fs::write(&partial, language).and_then(|()| std::fs::rename(&partial, &path)).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
}

/// A language code the sidecar can take as `--language`: letters and a dash.
pub fn clean_language(raw: &str) -> Option<String> {
    let code = raw.trim().to_ascii_lowercase();
    let valid = !code.is_empty()
        && code.len() <= 12
        && code.starts_with(|c: char| c.is_ascii_alphabetic())
        && code.chars().all(|c| c.is_ascii_alphabetic() || c == '-');
    valid.then_some(code)
}

pub fn cached(app: &AppHandle) -> Vec<String> {
    path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(|words| clean(&words))
        .unwrap_or_default()
}

pub fn store(app: &AppHandle, words: &[String]) {
    let words = clean(words);
    if words == cached(app) {
        return;
    }
    if let (Some(path), Ok(raw)) = (path(app), serde_json::to_string(&words)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Written aside and renamed over, so a crash or a second refresh never
        // leaves a half-written list that reads back as none.
        let partial = path.with_extension(format!("json.{}", uuid::Uuid::new_v4()));
        if std::fs::write(&partial, raw).and_then(|()| std::fs::rename(&partial, &path)).is_err() {
            let _ = std::fs::remove_file(&partial);
        }
    }
}

/// The sidecar's `--vocabulary` value: one word or phrase per line.
pub fn sidecar_arg(words: &[String]) -> Option<String> {
    let words = clean(words);
    (!words.is_empty()).then(|| words.join("\n"))
}

/// Fetches the account's words in the background and caches them.
pub fn refresh(app: &AppHandle) {
    let Some(credential) = settings::device_credential(app) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(client) = crate::sync::http_client() else {
            return;
        };
        let response = client
            .get(crate::base_url::join(&credential.base, "/api/devices/me"))
            .timeout(std::time::Duration::from_secs(8))
            .bearer_auth(credential.token)
            .send()
            .await;
        #[derive(serde::Deserialize)]
        struct Body {
            #[serde(default)]
            vocabulary: Vec<String>,
            #[serde(default)]
            language: Option<String>,
        }
        if let Ok(response) = response {
            if response.status().is_success() {
                if let Ok(body) = response.json::<Body>().await {
                    store(&app, &body.vocabulary);
                    store_language(&app, body.language.as_deref());
                }
            }
        }
    });
}

/// One line each, so a word can't break the sidecar's line-per-word argument,
/// and none starting `--`, which the sidecar would read as another flag. The
/// recognizer takes 100, so it gets the newest: words are stored oldest first.
fn clean(words: &[String]) -> Vec<String> {
    let words: Vec<String> = words
        .iter()
        .map(|word| word.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|word| {
            let mut word = word.as_str();
            while let Some(rest) = word.strip_prefix("--") {
                word = rest;
            }
            word.trim().to_string()
        })
        .filter(|word| !word.is_empty())
        .collect();
    let skip = words.len().saturating_sub(100);
    words.into_iter().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_reach_the_sidecar_one_per_line() {
        let words: Vec<String> =
            ["Eavesy", " Priya\nRaman ", "", "--mode", "-ish"].iter().map(|word| word.to_string()).collect();
        assert_eq!(sidecar_arg(&words).as_deref(), Some("Eavesy\nPriya Raman\nmode\n-ish"));
        assert_eq!(sidecar_arg(&[]), None);
    }

    #[test]
    fn the_newest_hundred_words_reach_the_sidecar() {
        let words: Vec<String> = (0..140).map(|i| format!("w{i}")).collect();
        let kept = clean(&words);
        assert_eq!(kept.len(), 100);
        assert_eq!(kept.first().map(String::as_str), Some("w40"));
        assert_eq!(kept.last().map(String::as_str), Some("w139"));
    }

    #[test]
    fn only_plain_language_codes_reach_the_sidecar() {
        assert_eq!(clean_language(" ES\n").as_deref(), Some("es"));
        assert_eq!(clean_language("auto").as_deref(), Some("auto"));
        assert_eq!(clean_language("zh-hant").as_deref(), Some("zh-hant"));
        assert_eq!(clean_language("--mode"), None);
        assert_eq!(clean_language("e s"), None);
        assert_eq!(clean_language(""), None);
    }
}
