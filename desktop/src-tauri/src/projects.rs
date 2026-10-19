//! The account's projects and a recording's agent-ready transcript, fetched
//! from the cloud when the launcher asks for them.

use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::settings;

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder().timeout(Duration::from_secs(8)).build().ok()
}

/// The projects to pick from, or `None` when the Mac is not paired or offline.
#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Option<Vec<Value>> {
    let credential = settings::device_credential(&app)?;
    let response = client()?
        .get(format!("{}/api/projects", credential.base))
        .bearer_auth(credential.token)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("items").and_then(Value::as_array).cloned()
}

/// The transcript cleaned up for an AI agent, once the cloud has made it.
/// `recording_id` is a local session id, or the meeting id of a recording
/// made on another Mac.
#[tauri::command]
pub async fn agent_transcript(app: AppHandle, recording_id: String) -> Option<String> {
    let credential = settings::device_credential(&app)?;
    let remote_id = crate::sqlite::remote_meeting_id(&app, &recording_id)
        .ok()
        .flatten()
        .unwrap_or(recording_id);
    let response = client()?
        .get(format!("{}/api/sessions/{remote_id}/result", credential.base))
        .bearer_auth(credential.token)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    agent_markdown(&body)
}

fn agent_markdown(body: &Value) -> Option<String> {
    let edited = body.get("transcriptOverrideMd").and_then(Value::as_str).filter(|text| !text.trim().is_empty());
    if edited.is_some() {
        return None;
    }
    body.get("agentTranscriptMd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edited_transcript_wins_over_the_cleaned_one() {
        let cleaned = serde_json::json!({ "agentTranscriptMd": " Ship it. ", "transcriptOverrideMd": null });
        assert_eq!(agent_markdown(&cleaned), Some("Ship it.".into()));
        let edited = serde_json::json!({ "agentTranscriptMd": "Ship it.", "transcriptOverrideMd": "# Mine" });
        assert_eq!(agent_markdown(&edited), None);
        assert_eq!(agent_markdown(&serde_json::json!({ "agentTranscriptMd": "  " })), None);
    }
}
