//! The account's projects and a recording's agent-ready transcript, fetched
//! from the cloud when the launcher asks for them.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::front_window::FrontWindow;

use crate::settings;

/// How long the launcher waits for an answer from the account.
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(8);

/// The app's shared HTTP client, with the launcher's shorter wait.
fn client() -> Option<reqwest::Client> {
    crate::sync::http_client().ok()
}

/// The projects to pick from, or `None` when the Mac is not paired or offline.
#[tauri::command]
pub async fn list_projects(app: AppHandle) -> Option<Vec<Value>> {
    let credential = settings::device_credential(&app)?;
    let response = client()?
        .get(crate::base_url::join(&credential.base, "/api/projects"))
        .bearer_auth(credential.token)
        .timeout(ACCOUNT_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: Value = response.json().await.ok()?;
    body.get("items").and_then(Value::as_array).cloned()
}

/// Which account endpoints the panel may call with this Mac's sign-in, and how:
/// the settings it shares with eavesy.com (languages, custom words), projects,
/// saved prompts, the AI apps connected over MCP and the linked calendars
/// (list and disconnect only: connections are made by signing in through the
/// browser, never from this Mac).
fn account_call_allowed(method: &str, path: &str) -> bool {
    match (method, path.strip_prefix("/api/")) {
        ("GET" | "PATCH", Some("me")) => true,
        ("GET" | "POST", Some("projects" | "prompts")) => true,
        // Prompts written from the account's own dictations, for Settings → Prompts.
        ("GET", Some("prompts/suggestions")) => true,
        ("GET" | "DELETE", Some("mcp-tokens" | "calendar-connections")) => true,
        ("PATCH" | "DELETE", Some(rest)) => rest
            .strip_prefix("projects/")
            .or_else(|| rest.strip_prefix("prompts/"))
            .is_some_and(is_plain_id),
        _ => false,
    }
}

/// Whether a call changed something the HUD shows: the account's settings
/// or a project (either may carry the dictation tone its tone row shows, and
/// the HUD reads the account again rather than guess which field changed).
fn reloads_hud(method: &str, path: &str) -> bool {
    method == "PATCH" && (path == "/api/me" || path.starts_with("/api/projects/"))
}

/// Reads or changes an account setting or project on eavesy.com as this Mac,
/// so the panel's Settings edit the same things the website does. The answer
/// is the endpoint's JSON; an error says why it failed.
#[tauri::command]
pub async fn account_call(app: AppHandle, method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    let method = method.to_ascii_uppercase();
    if !account_call_allowed(&method, &path) {
        return Err(format!("{method} {path} is not something the panel can change"));
    }
    let credential = settings::device_credential(&app).ok_or("Sign in to change this")?;
    let client = client().ok_or("Could not reach eavesy.com")?;
    let url = crate::base_url::join(&credential.base, &path);
    let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|error| error.to_string())?;
    let mut request = client.request(verb, url).bearer_auth(credential.token).timeout(ACCOUNT_TIMEOUT);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| "Could not reach eavesy.com".to_string())?;
    let status = response.status();
    let value: Option<Value> = response.json().await.ok();
    if status.is_success() && value.is_none() && method != "DELETE" {
        return Err("eavesy.com sent an answer Eavesy couldn't read".into());
    }
    let value = value.unwrap_or(Value::Null);
    if !status.is_success() {
        let reason = value.get("error").and_then(Value::as_str).unwrap_or("request failed");
        return Err(format!("eavesy.com said {reason} ({})", status.as_u16()));
    }
    if path == "/api/me" && method == "PATCH" {
        crate::vocabulary::refresh(&app);
    }
    // Any change to the account or a project, tone or not: the HUD reads the account again (cheap, rare).
    if reloads_hud(&method, &path) {
        let _ = app.emit_to("hud", "account:changed", ());
    }
    Ok(value)
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
        .get(crate::base_url::join(&credential.base, &format!("/api/sessions/{remote_id}/result")))
        .bearer_auth(credential.token)
        .timeout(ACCOUNT_TIMEOUT)
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

/// Sessions whose project is being read from the app in front, since when.
static RESOLVING: Mutex<Vec<(String, Instant)>> = Mutex::new(Vec::new());
/// The longest the cloud session waits for that.
const RESOLVE_WAIT: Duration = Duration::from_millis(1_500);

/// Whether this session's project is still being worked out: the cloud
/// session waits a moment for it, since there is no changing it afterwards.
pub fn resolving(session_id: &str) -> bool {
    let mut resolving = RESOLVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    resolving.retain(|(_, since)| since.elapsed() < RESOLVE_WAIT);
    resolving.iter().any(|(id, _)| id == session_id)
}

fn finish_resolving(session_id: &str) {
    RESOLVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|(id, _)| id != session_id);
}

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
    RESOLVING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push((session_id.to_string(), Instant::now()));
    let front = crate::app_menu::frontmost();
    let (app, session_id) = (app.clone(), session_id.to_string());
    std::thread::spawn(move || {
        let front = front.map(|(pid, name)| crate::front_window::read(pid, name));
        if let Some(project_id) = resolve(&choice, front.as_ref()) {
            if let Err(error) = crate::sqlite::set_session_project(&app, &session_id, &project_id) {
                tracing::warn!("could not file the recording under its project: {error}");
            }
        }
        finish_resolving(&session_id);
        crate::sync::wake();
    });
}

/// The project the app in front points at right now, by the launcher's choice:
/// what a dictation is being typed into, so its project's tone applies.
pub fn current_project() -> Option<String> {
    let choice = CHOICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()?;
    if choice.projects.is_empty() || (!choice.follow && choice.pinned.is_none()) {
        return None;
    }
    let front = crate::app_menu::frontmost().map(|(pid, name)| crate::front_window::read(pid, name));
    resolve(&choice, front.as_ref())
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
        !before.is_some_and(|c| c.is_ascii_alphanumeric()) && !after.is_some_and(|c| c.is_ascii_alphanumeric())
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
    fn the_panel_reaches_only_settings_and_projects() {
        assert!(account_call_allowed("GET", "/api/me"));
        assert!(account_call_allowed("PATCH", "/api/me"));
        assert!(account_call_allowed("POST", "/api/projects"));
        assert!(account_call_allowed("PATCH", "/api/projects/abc-123"));
        assert!(!account_call_allowed("DELETE", "/api/me"));
        assert!(account_call_allowed("GET", "/api/calendar-connections"));
        assert!(account_call_allowed("DELETE", "/api/calendar-connections"));
        assert!(!account_call_allowed("POST", "/api/calendar-connections"));
        assert!(reloads_hud("PATCH", "/api/me"));
        assert!(reloads_hud("PATCH", "/api/projects/proj_1"));
        assert!(!reloads_hud("GET", "/api/me"));
        assert!(!reloads_hud("PATCH", "/api/prompts/prompt_1"));
        assert!(!reloads_hud("POST", "/api/projects"));
        assert!(!account_call_allowed("GET", "/api/account/export"));
        assert!(!account_call_allowed("PATCH", "/api/projects/../me"));
        assert!(!account_call_allowed("DELETE", "/api/projects/"));
        assert!(account_call_allowed("GET", "/api/prompts"));
        assert!(account_call_allowed("GET", "/api/prompts/suggestions"));
        assert!(!account_call_allowed("POST", "/api/prompts/suggestions"));
        assert!(account_call_allowed("GET", "/api/mcp-tokens"));
        assert!(account_call_allowed("DELETE", "/api/mcp-tokens"));
        assert!(!account_call_allowed("POST", "/api/mcp-tokens"));
        assert!(!account_call_allowed("DELETE", "/api/mcp-tokens/abc"));
        assert!(account_call_allowed("POST", "/api/prompts"));
        assert!(account_call_allowed("PATCH", "/api/prompts/prm_01ABC"));
        assert!(account_call_allowed("DELETE", "/api/prompts/prm_01ABC"));
        assert!(!account_call_allowed("DELETE", "/api/prompts"));
        assert!(!account_call_allowed("PATCH", "/api/prompts/../me"));
    }

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
        assert_eq!(resolve(&follow, None), None);
    }

    #[test]
    fn a_pinned_project_wins_and_no_project_means_none() {
        assert_eq!(resolve(&choice(false, Some("p_acme")), Some(&front("eavesy"))), Some("p_acme".into()));
        assert_eq!(resolve(&choice(false, Some("p_gone")), Some(&front("eavesy"))), Some("p_eavesy".into()));
        assert_eq!(resolve(&choice(false, None), Some(&front("eavesy"))), None);
    }
}
