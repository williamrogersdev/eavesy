//! The custom words from the user's account, kept on disk so a capture can
//! hand them to the on-device recognizer without waiting on the network. Each
//! capture refreshes them for the next one.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::settings;

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("vocabulary.json"))
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
        if std::fs::write(&partial, raw).is_ok() && std::fs::rename(&partial, &path).is_err() {
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
        let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build() else {
            return;
        };
        let response = client
            .get(format!("{}/api/devices/me", credential.base))
            .bearer_auth(credential.token)
            .send()
            .await;
        #[derive(serde::Deserialize)]
        struct Body {
            #[serde(default)]
            vocabulary: Vec<String>,
        }
        if let Ok(response) = response {
            if response.status().is_success() {
                if let Ok(body) = response.json::<Body>().await {
                    store(&app, &body.vocabulary);
                }
            }
        }
    });
}

/// One line each, so a word can't break the sidecar's line-per-word argument,
/// and none starting `--`, which the sidecar would read as another flag.
fn clean(words: &[String]) -> Vec<String> {
    words
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
        .take(100)
        .collect()
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
}
