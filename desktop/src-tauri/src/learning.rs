//! Account-scoped dictionary access and local correction feedback.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use std::{collections::VecDeque, sync::Mutex, time::{Duration, Instant}};

struct PendingFeedback { id: String, original: String, corrected: String, saved_at: Instant }
static PENDING: Mutex<VecDeque<PendingFeedback>> = Mutex::new(VecDeque::new());
fn remember_saved(id: &str, original: &str, corrected: &str) {
    let mut pending = PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    pending.retain(|p| p.id != id && p.saved_at.elapsed() < Duration::from_secs(3600));
    while pending.len() >= 32 { pending.pop_front(); }
    pending.push_back(PendingFeedback { id: id.into(), original: original.into(), corrected: corrected.into(), saved_at: Instant::now() });
}
fn matches_saved(id: &str, original: &str, corrected: &str) -> bool {
    PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().any(|p|
        p.id == id && p.original == original && p.corrected == corrected && p.saved_at.elapsed() < Duration::from_secs(3600))
}
fn forget_saved(id: &str, original: &str, corrected: &str) {
    PENDING.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|p|
        p.id != id || p.original != original || p.corrected != corrected);
}

pub fn feedback_failure(error: &str) -> Value {
    let transport = error == "Could not connect to your dictionary";
    let retryable = transport || error.contains("(429") || error.contains("(5");
    let warning = if transport {
        "Transcript saved. Dictionary could not connect. Retry learning when you are online.".to_string()
    } else if error.contains("(401") || error.contains("(403") || error.starts_with("Pair this Mac") {
        "Transcript saved. Sign in again from Settings to update your dictionary.".to_string()
    } else { format!("Transcript saved. Dictionary not updated: {error}") };
    json!({ "learned": 0, "warning": warning, "retryable": retryable })
}


pub fn request(app: &AppHandle, method: &str, body: Option<Value>) -> Result<Value, String> {
    let credential = crate::settings::device_credential(app)
        .ok_or("Pair this Mac with your Eavesy account to learn corrections.")?;
    let base = &credential.base;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let changed = method != "GET";
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client
        .request(method, format!("{base}/api/dictionary"))
        .bearer_auth(&credential.token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req
        .send()
        .map_err(|_| "Could not connect to your dictionary".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        use std::io::Read;
        let mut bytes = Vec::new();
        let body = response.take(4097).read_to_end(&mut bytes).ok()
            .filter(|_| bytes.len() <= 4096)
            .and_then(|_| serde_json::from_slice::<Value>(&bytes).ok());
        let message = body.as_ref().and_then(|b| b.get("error")).and_then(Value::as_str)
            .filter(|s| s.len() < 256).unwrap_or("Could not save your dictionary");
        return Err(format!("{message} ({status})"));
    }
    let value = response.json().map_err(|_| "Invalid dictionary response".to_string())?;
    if changed { crate::vocabulary::refresh(app); }
    Ok(value)
}

pub fn feedback(app: &AppHandle, original: &str, corrected: &str) -> Result<Value, String> {
    request(
        app,
        "POST",
        Some(json!({ "original": original, "corrected": corrected })),
    )
}

#[tauri::command]
pub async fn dictionary_request(
    app: AppHandle,
    method: String,
    body: Option<Value>,
) -> Result<Value, String> {
    if !["GET", "PUT", "DELETE"].contains(&method.as_str()) {
        return Err("Unsupported dictionary operation".into());
    }
    tauri::async_runtime::spawn_blocking(move || request(&app, &method, body))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn correct_recording(
    app: AppHandle,
    id: String,
    original: String,
    corrected: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let recording = crate::store::get(&app, &id)?
            .ok_or("Recording not found")?;
        let current = recording.transcript.as_deref();
        let retry = current == Some(corrected.as_str()) && matches_saved(&id, &original, &corrected);
        if current != Some(original.as_str()) && !retry {
            return Err("Transcript changed; reopen it before correcting".into());
        }
        if corrected.trim().is_empty() || corrected.encode_utf16().count() > 12_000 || original.encode_utf16().count() > 12_000 {
            return Err("Corrections must contain text and be at most 12,000 characters. Edit a shorter passage.".into());
        }
        // Only durable human edits teach the dictionary. A retry is allowed when
        // the exact corrected text is still current, without rewriting the files.
        if current == Some(original.as_str()) {
            crate::store::correct_transcript(&app, &id, &original, &corrected)?;
            remember_saved(&id, &original, &corrected);
            let _ = app.emit("recordings:updated", ());
        }
        Ok(match feedback(&app, &original, &corrected) {
            Ok(value) => { forget_saved(&id, &original, &corrected); value }
            Err(error) => feedback_failure(&error),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn notify(app: &AppHandle, value: Value) {
    let _ = app.emit("dictionary:learning", value);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retries_require_the_exact_pair_committed_by_this_app() {
        let id = uuid::Uuid::new_v4().to_string();
        assert!(!matches_saved(&id, "pool", "pull"));
        remember_saved(&id, "pool", "pull");
        assert!(matches_saved(&id, "pool", "pull"));
        assert!(!matches_saved(&id, "arbitrary source", "pull"));
        remember_saved(&id, "pull", "Pull");
        assert!(!matches_saved(&id, "pool", "pull"));
        forget_saved(&id, "pull", "Pull");
        assert!(!matches_saved(&id, "pull", "Pull"));
    }
    #[test]
    fn connection_auth_and_validation_failures_have_distinct_recovery() {
        assert_eq!(feedback_failure("Could not connect to your dictionary")["retryable"], true);
        let auth = feedback_failure("unauthenticated (401 Unauthorized)");
        assert_eq!(auth["retryable"], false);
        assert!(auth["warning"].as_str().unwrap().contains("Sign in again"));
        let invalid = feedback_failure("invalid_request (400 Bad Request)");
        assert_eq!(invalid["retryable"], false);
        assert!(invalid["warning"].as_str().unwrap().contains("invalid_request"));
    }
}
