use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TranslationInput {
    text: String,
    source: String,
    target: String,
}

impl TranslationInput {
    fn validate(&self) -> Result<(), String> {
        let language = |code: &str| (2..=3).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_lowercase());
        if self.text.trim().is_empty() || self.text.encode_utf16().count() > 4000
            || !(self.source == "auto" || language(&self.source)) || !language(&self.target) {
            return Err("Choose a language and enter up to 4,000 characters.".into());
        }
        Ok(())
    }
}

/// Translation uses this Mac's paired account; credentials never enter the webview.
#[tauri::command]
pub async fn translation_request(app: AppHandle, body: TranslationInput) -> Result<serde_json::Value, String> {
    body.validate()?;
    let credential = crate::settings::device_credential(&app).ok_or("Sign in to translate.")?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120))
        .build().map_err(|_| "Could not connect to translation service")?;
    let response = client.post(format!("{}/api/translation", credential.base.trim_end_matches('/')))
        .bearer_auth(credential.token).json(&body).send().await.map_err(|_| "Could not connect. Your text is still here; try again.")?;
    let status = response.status();
    if status.is_success() || matches!(status.as_u16(), 400 | 422 | 502) {
        return response.json().await.map_err(|_| "Invalid translation response. Try again.".into());
    }
    Err(match status.as_u16() {
        401 => "Sign in to translate.",
        413 => "Use up to 4,000 characters.",
        429 => "Too many translations. Try again in a minute.",
        _ => "Translation unavailable. Your text is still here; try again.",
    }.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_before_attaching_account_credentials() {
        let input = |text: String, source: &str, target: &str| TranslationInput { text, source: source.into(), target: target.into() };
        assert!(input("Hola".into(), "auto", "en").validate().is_ok());
        assert!(input(" ".into(), "auto", "en").validate().is_err());
        assert!(input("x".repeat(4001), "auto", "en").validate().is_err());
        assert!(input("🙂".repeat(2001), "auto", "en").validate().is_err());
        assert!(input("Hello".into(), "english", "en").validate().is_err());
        assert!(input("Hello".into(), "auto", "../en").validate().is_err());
        assert!(serde_json::from_value::<TranslationInput>(serde_json::json!({"text":"Hi","source":"en","target":"es","audio":"extra"})).is_err());
    }
}
