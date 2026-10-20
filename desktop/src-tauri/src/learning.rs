//! Account-scoped dictionary access and local correction feedback.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

pub fn request(app: &AppHandle, method: &str, body: Option<Value>) -> Result<Value, String> {
    let credential = crate::settings::device_credential(app)
        .ok_or("Pair this Mac with your Eavesy account to learn corrections.")?;
    let base = &credential.base;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
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
        return Err(format!("Dictionary request failed ({})", response.status()));
    }
    response
        .json()
        .map_err(|_| "Invalid dictionary response".to_string())
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
        let recording = crate::store::load_all(&app)
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("Recording not found")?;
        if recording.transcript.as_deref() != Some(original.as_str()) {
            return Err("Transcript changed; reopen it before correcting".into());
        }
        if corrected.trim().is_empty() || corrected.len() > 48_000 {
            return Err("Correction is empty or too long".into());
        }
        // Save feedback first; a failed connection leaves the editor intact for retry.
        let learned = feedback(&app, &original, &corrected)?;
        crate::store::correct_transcript(&app, &id, &original, &corrected)?;
        let _ = app.emit("recordings:updated", ());
        Ok(learned)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn notify(app: &AppHandle, value: Value) {
    let _ = app.emit("dictionary:learning", value);
}
