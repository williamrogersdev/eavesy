//! The account's projects and a recording's agent-ready transcript, fetched
//! from the cloud when the launcher asks for them.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::front_window::FrontWindow;

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
    if !is_plain_id(&remote_id) {
        return None;
    }
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

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectTerms {
    pub id: String,
    /// The words that pick this project out of a window title or app name.
    pub terms: Vec<String>,
}

/// The launcher's project choice, mirrored here so a recording started by
/// the dictation hotkey, with the launcher closed, lands in the same project.
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectChoice {
    /// Pick the project from the app in front.
    pub follow: bool,
    pub pinned: Option<String>,
    pub projects: Vec<ProjectTerms>,
}

static CHOICE: Mutex<Option<ProjectChoice>> = Mutex::new(None);

#[tauri::command]
pub fn set_project_choice(choice: ProjectChoice) {
    *CHOICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(choice);
}

/// Reads the app in front off the calling thread and files the session under
/// the project it points at. Does nothing until the launcher has sent a choice.
pub fn assign_in_background(app: &AppHandle, session_id: &str) {
    let Some(choice) = CHOICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() else {
        return;
    };
    if choice.projects.is_empty() || (!choice.follow && choice.pinned.is_none()) {
        return;
    }
    let front = crate::app_menu::frontmost();
    let (app, session_id) = (app.clone(), session_id.to_string());
    std::thread::spawn(move || {
        let front = front.map(|(pid, name)| crate::front_window::read(pid, name));
        if let Some(project_id) = resolve(&choice, front.as_ref()) {
            let _ = crate::sqlite::set_session_project(&app, &session_id, &project_id);
        }
    });
}

fn resolve(choice: &ProjectChoice, front: Option<&FrontWindow>) -> Option<String> {
    if let Some(pinned) = &choice.pinned {
        if choice.projects.iter().any(|project| &project.id == pinned) {
            return Some(pinned.clone());
        }
    } else if !choice.follow {
        return None;
    }
    match_project(&choice.projects, front?).map(str::to_string)
}

/// The project whose term appears as a whole word in the window title or app
/// name; the longest term wins.
fn match_project<'a>(projects: &'a [ProjectTerms], front: &FrontWindow) -> Option<&'a str> {
    let haystacks: Vec<String> = [&front.title, &front.app]
        .into_iter()
        .flatten()
        .map(|text| text.to_lowercase())
        .filter(|text| !text.trim().is_empty())
        .collect();
    let mut best: Option<(&str, usize)> = None;
    for project in projects {
        for term in &project.terms {
            let needle = term.trim().to_lowercase();
            if needle.is_empty() || !haystacks.iter().any(|text| contains_word(text, &needle)) {
                continue;
            }
            if best.is_none_or(|(_, length)| needle.chars().count() > length) {
                best = Some((&project.id, needle.chars().count()));
            }
        }
    }
    best.map(|(id, _)| id)
}

fn contains_word(text: &str, needle: &str) -> bool {
    text.match_indices(needle).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + needle.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// Ids are interpolated into an authenticated URL path: letters, digits, `-` and `_` only.
fn is_plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
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

    #[test]
    fn only_plain_ids_reach_the_cloud_url() {
        assert!(is_plain_id("mtg_01HZX-abc"));
        assert!(!is_plain_id("../devices"));
        assert!(!is_plain_id("a/b"));
        assert!(!is_plain_id("a?b"));
        assert!(!is_plain_id(""));
    }

    fn choice(follow: bool, pinned: Option<&str>) -> ProjectChoice {
        ProjectChoice {
            follow,
            pinned: pinned.map(str::to_string),
            projects: vec![
                ProjectTerms { id: "p_eavesy".into(), terms: vec!["eavesy".into()] },
                ProjectTerms { id: "p_web".into(), terms: vec!["eavesy web".into()] },
                ProjectTerms { id: "p_acme".into(), terms: vec!["acme".into()] },
            ],
        }
    }

    fn front(title: &str) -> FrontWindow {
        FrontWindow { app: Some("Cursor".into()), title: Some(title.into()) }
    }

    #[test]
    fn the_app_in_front_picks_the_project_by_its_longest_whole_word() {
        let follow = choice(true, None);
        assert_eq!(resolve(&follow, Some(&front("summarize.ts — eavesy"))), Some("p_eavesy".into()));
        assert_eq!(resolve(&follow, Some(&front("Eavesy Web: routes"))), Some("p_web".into()));
        assert_eq!(resolve(&follow, Some(&front("eavesyapp — notes"))), None);
        assert_eq!(resolve(&follow, Some(&front("eavesyé — notes"))), None);
        assert_eq!(resolve(&follow, None), None);
    }

    #[test]
    fn a_pinned_project_wins_and_no_project_means_none() {
        assert_eq!(resolve(&choice(false, Some("p_acme")), Some(&front("eavesy"))), Some("p_acme".into()));
        assert_eq!(resolve(&choice(false, Some("p_gone")), Some(&front("eavesy"))), Some("p_eavesy".into()));
        assert_eq!(resolve(&choice(false, None), Some(&front("eavesy"))), None);
    }
}
