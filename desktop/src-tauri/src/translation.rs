use tauri::AppHandle;

/// Translation uses this Mac's paired account; credentials never enter the webview.
#[tauri::command]
pub async fn translation_request(app: AppHandle, body: serde_json::Value) -> Result<serde_json::Value, String> {
    if body.to_string().len() > 2_600_000 { return Err("Translation input is too large".into()); }
    let credential = crate::settings::device_credential(&app).ok_or("Sign in to translate.")?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|_| "Could not connect to translation service")?;
    let response = client.post(format!("{}/api/translation", credential.base.trim_end_matches('/')))
        .bearer_auth(credential.token).json(&body).send().await.map_err(|_| "Could not connect. Your text is still here; try again.")?;
    let status = response.status();
    // Preserve a recognized source even if the following translation failed.
    if status.is_success() || matches!(status.as_u16(), 400 | 422 | 502) {
        return response.json().await.map_err(|_| "Invalid translation response. Try again.".into());
    }
    Err(match status.as_u16() {
        401 => "Sign in to translate.",
        413 => "Use up to 4,000 characters or 60 seconds of speech.",
        429 => "Too many translations. Try again in a minute.",
        _ => "Translation unavailable. Your text is still here; try again.",
    }.into())
}
