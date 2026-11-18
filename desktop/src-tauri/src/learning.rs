//! Account-scoped dictionary access and local correction feedback.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub fn request(app: &AppHandle, method: &str, body: Option<Value>) -> Result<Value, String> {
    account_request(app, "/api/dictionary", method, body, "Could not save your dictionary")
}

/// An account-scoped list the Settings window edits (the dictionary, the
/// snippets). A change refreshes the cached words and snippets dictation uses.
fn account_request(app: &AppHandle, path: &str, method: &str, body: Option<Value>, failed: &str) -> Result<Value, String> {
    let credential = crate::settings::device_credential(app)
        .ok_or("Pair this Mac with your Eavesy account first.")?;
    let base = &credential.base;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let changed = method != "GET";
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client
        .request(method, format!("{base}{path}"))
        .bearer_auth(&credential.token);
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req
        .send()
        .map_err(|_| format!("{failed}: Eavesy couldn’t be reached."))?;
    if !response.status().is_success() {
        let status = response.status();
        use std::io::Read;
        let mut bytes = Vec::new();
        let body = response
            .take(4097)
            .read_to_end(&mut bytes)
            .ok()
            .filter(|_| bytes.len() <= 4096)
            .and_then(|_| serde_json::from_slice::<Value>(&bytes).ok());
        let message = body
            .as_ref()
            .and_then(|b| b.get("message").or_else(|| b.get("error")))
            .and_then(Value::as_str)
            .filter(|s| s.len() < 256)
            .unwrap_or(failed);
        return Err(format!("{message} ({status})"));
    }
    let value = response
        .json()
        .map_err(|_| format!("{failed}: the answer couldn’t be read."))?;
    if changed {
        crate::vocabulary::refresh(app);
    }
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
pub async fn snippets_request(app: AppHandle, method: String, body: Option<Value>) -> Result<Value, String> {
    if !["GET", "PUT", "DELETE"].contains(&method.as_str()) {
        return Err("Unsupported snippets operation".into());
    }
    tauri::async_runtime::spawn_blocking(move || account_request(&app, "/api/snippets", &method, body, "Could not save your snippets"))
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
        let walkthrough_guard = if recording.has_video && recording.source == "screen" { Some(crate::walkthrough::correction_guard(&id)?) } else { None };
        let current = recording.transcript.as_deref();
        if current != Some(original.as_str()) && current != Some(corrected.as_str()) {
            return Err("Transcript changed; reopen it before correcting".into());
        }
        if corrected.trim().is_empty() || corrected.encode_utf16().count() > 12_000 || original.encode_utf16().count() > 12_000 {
            return Err("Corrections must contain text and be at most 12,000 characters. Edit a shorter passage.".into());
        }
        // Only durable human edits teach the dictionary. A retry is allowed when
        // the exact corrected text is still current, without rewriting the files.
        if current == Some(original.as_str()) {
            crate::store::correct_transcript(&app, &id, &original, &corrected)?;
            let _ = app.emit("recordings:updated", ());
        }
        let context_warning = if recording.has_video && recording.source == "screen" {
            crate::walkthrough::update_correction(&app, &id, &corrected).err()
        } else { None };
        drop(walkthrough_guard);
        let mut response = feedback(&app, &original, &corrected).unwrap_or_else(|_| json!({
            "learned": 0,
            "warning": "Transcript saved. Dictionary could not connect. Retry learning when you are online."
        }));
        if let Some(error) = context_warning {
            tracing::warn!("Could not synchronize corrected walkthrough: {error}");
            let previous = response["warning"].as_str().unwrap_or("");
            let message = "Transcript saved, but walkthrough context needs preparation/retry.";
            response["warning"] = json!(if previous.is_empty() { message.into() } else { format!("{previous} {message}") });
        }
        Ok(response)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn notify(app: &AppHandle, value: Value) {
    let _ = app.emit("dictionary:learning", value);
}
