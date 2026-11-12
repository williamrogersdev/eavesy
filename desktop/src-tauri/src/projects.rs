//! The account's projects and a recording's agent-ready transcript, fetched
//! from the cloud when the launcher asks for them.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::front_window::FrontWindow;

use crate::settings;

/// How long the launcher waits for an answer from the account.
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(8);
/// Calls that wait on a model: a merged prompt rewrite can take a while to write.
const MODEL_CALL_TIMEOUT: Duration = Duration::from_secs(45);

fn account_timeout(path: &str) -> Duration {
    if path == "/api/agent-feedback/merge" { MODEL_CALL_TIMEOUT } else { ACCOUNT_TIMEOUT }
}

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
/// browser, never from this Mac), the calendar's meetings, and whether to
/// record each one.
fn account_call_allowed(method: &str, path: &str) -> bool {
    match (method, path.strip_prefix("/api/")) {
        ("GET" | "PATCH", Some("me")) => true,
        ("GET" | "POST", Some("projects" | "prompts")) => true,
        // Prompts written from the account's own dictations, for Settings → Prompts.
        ("GET", Some("prompts/suggestions")) => true,
        // What agents reported over MCP: listed, dismissed, applied to a prompt or merged into one rewrite.
        ("GET" | "PATCH", Some("agent-feedback")) => true,
        ("POST", Some("agent-feedback/apply" | "agent-feedback/merge")) => true,
        ("GET" | "DELETE", Some("mcp-tokens" | "calendar-connections")) => true,
        ("GET", Some("calendar-events")) => true,
        ("PATCH", Some(rest)) if rest.starts_with("calendar-events/") => {
            rest.strip_prefix("calendar-events/").is_some_and(is_plain_id)
        }
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
    let mut request = client.request(verb, url).bearer_auth(credential.token).timeout(account_timeout(&path));
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
    // A meeting's record choice: the watcher and the menu bar's meeting card read the calendar again.
    if method == "PATCH" && path.starts_with("/api/calendar-events/") {
        crate::meeting_watch::calendar_changed();
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

/// The account's meeting for a recording on this Mac, once the first part of
/// it has reached eavesy.com (a few seconds into the recording).
fn remote_meeting(app: &AppHandle, session_id: &str) -> Option<String> {
    crate::sqlite::remote_meeting_id(app, session_id)
        .unwrap_or_else(|error| {
            tracing::warn!("meeting panel: could not read the meeting's account id: {error}");
            None
        })
        .filter(|id| is_plain_id(id))
}

/// The notes written so far for a meeting that is still recording: the
/// cloud rewrites them every few minutes of talk. None until the first are
/// written, or while the meeting hasn't reached the account.
#[tauri::command]
pub async fn meeting_overview(app: AppHandle, session_id: String) -> Result<Option<Value>, String> {
    let Some(credential) = settings::device_credential(&app) else { return Ok(None) };
    let Some(remote_id) = remote_meeting(&app, &session_id) else { return Ok(None) };
    let response = client()
        .ok_or("Could not reach eavesy.com")?
        .get(crate::base_url::join(&credential.base, &format!("/api/sessions/{remote_id}/result")))
        .bearer_auth(credential.token)
        .timeout(ACCOUNT_TIMEOUT)
        .send()
        .await
        .map_err(|_| "Could not reach eavesy.com".to_string())?;
    let status = response.status().as_u16();
    if not_written_yet(status) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("eavesy.com said {status}"));
    }
    let body: Value = response.json().await.map_err(|_| "eavesy.com sent an answer Eavesy couldn't read".to_string())?;
    Ok(overview_from(&body))
}

/// The result endpoint's answers for a meeting it has nothing for yet: the
/// panel asks again later, and that is not an error to show.
fn not_written_yet(status: u16) -> bool {
    matches!(status, 404 | 409)
}

/// The overview the panel shows, from a session's result: the lists arrive
/// as JSON text, and one that can't be read is left empty.
fn overview_from(body: &Value) -> Option<Value> {
    let summary = body.get("summary").filter(|summary| summary.is_object())?;
    let list = |key: &str| -> Value {
        summary.get(key).and_then(Value::as_str).and_then(|text| serde_json::from_str::<Value>(text).ok()).filter(Value::is_array).unwrap_or_else(|| json!([]))
    };
    let tldr = summary.get("tldr").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let overview = json!({
        "title": body.get("title").and_then(Value::as_str).unwrap_or(""),
        "tldr": tldr,
        "decisions": list("decisionsJson"),
        "actionItems": list("actionItemsJson"),
        "openQuestions": list("openQuestionsJson"),
    });
    let empty = tldr.is_empty() && ["decisions", "actionItems", "openQuestions"].iter().all(|key| overview[*key].as_array().is_some_and(Vec::is_empty));
    (!empty).then_some(overview)
}

/// Why a question about a meeting got no answer, in words for the panel.
fn ask_failure(status: u16, reason: &str) -> String {
    match (status, reason) {
        (401, _) => "Sign in to Eavesy to ask about this meeting.".into(),
        (404, _) => "This meeting isn’t in your account.".into(),
        (409, _) => "Nothing has been heard yet. Ask again in a moment.".into(),
        (429, _) => "You’ve asked a lot in a short time. Try again in a minute.".into(),
        _ => "Eavesy couldn’t answer that. Try again?".into(),
    }
}

/// Asks about the meeting being recorded, from its panel: typed, answered
/// from everything said so far. `messages` is the conversation so far, the
/// question last; `heard` is what this Mac heard that the cloud may not have
/// written down yet.
#[tauri::command]
pub async fn ask_meeting(app: AppHandle, session_id: String, messages: Value, heard: Option<String>) -> Result<String, String> {
    let credential = settings::device_credential(&app).ok_or("Sign in to Eavesy to ask about this meeting.")?;
    let remote_id = remote_meeting(&app, &session_id).ok_or("This meeting hasn’t reached your account yet. Ask again in a moment.")?;
    let mut body = json!({ "messages": messages });
    if let Some(heard) = heard.map(|text| tail_chars(text.trim(), MAX_HEARD)).filter(|text| !text.is_empty()) {
        body["heard"] = Value::String(heard);
    }
    let response = client()
        .ok_or("Could not reach eavesy.com")?
        .post(crate::base_url::join(&credential.base, &format!("/api/meetings/{remote_id}/chat")))
        .bearer_auth(credential.token)
        .timeout(MODEL_CALL_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Could not reach eavesy.com".to_string())?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(ask_failure(status.as_u16(), value.get("error").and_then(Value::as_str).unwrap_or("")));
    }
    value.get("reply").and_then(Value::as_str).map(|reply| reply.trim().to_string()).filter(|reply| !reply.is_empty()).ok_or_else(|| ask_failure(502, ""))
}

/// The most the chat endpoint takes of what was just heard (`MAX_HEARD` in
/// web/src/lib/ai/meeting-chat-context.ts).
const MAX_HEARD: usize = 12_000;

/// The end of `text` that fits in `max` UTF-16 units, never splitting a
/// character. The server counts a string's length that way, so an emoji is two.
fn tail_chars(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut start = text.len();
    for (at, c) in text.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        start = at;
    }
    text[start..].to_string()
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
    fn an_overview_reads_the_lists_and_is_none_until_something_is_written() {
        let body = json!({ "title": "Pricing", "summary": { "tldr": " Pricing is agreed. ", "decisionsJson": "[{\"text\":\"Annual plan\"}]", "actionItemsJson": "not json", "openQuestionsJson": "[]" } });
        let overview = overview_from(&body).unwrap();
        assert_eq!(overview["tldr"], "Pricing is agreed.");
        assert_eq!(overview["decisions"][0]["text"], "Annual plan");
        assert_eq!(overview["actionItems"], json!([]));
        assert!(overview_from(&json!({ "summary": null })).is_none());
        assert!(overview_from(&json!({ "summary": { "tldr": "", "decisionsJson": "[]", "actionItemsJson": "[]", "openQuestionsJson": "[]" } })).is_none());
    }

    #[test]
    fn what_was_heard_is_cut_to_its_end_on_a_character() {
        assert_eq!(tail_chars("héllo wörld", 5), "wörld");
        assert_eq!(tail_chars("short", 50), "short");
        // The server counts UTF-16 units: an emoji is two, and is never cut in half.
        assert_eq!(tail_chars("a😀b😀", 2), "😀");
        assert_eq!(tail_chars("a😀b😀", 3), "b😀");
        assert_eq!(tail_chars("a😀b😀", 4), "b😀");
        assert_eq!(tail_chars("a😀b😀", 1), "");
        assert_eq!(tail_chars("", 4), "");
        assert!(not_written_yet(404) && not_written_yet(409));
        assert!(!not_written_yet(401) && !not_written_yet(500) && !not_written_yet(200));
    }

    #[test]
    fn a_failed_question_says_what_to_do() {
        assert!(ask_failure(409, "not_ready").contains("Nothing has been heard yet"));
        assert!(ask_failure(429, "").contains("Try again in a minute"));
        assert!(ask_failure(502, "chat_failed").contains("Try again?"));
    }

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
        assert!(account_call_allowed("GET", "/api/calendar-events"));
        assert!(!account_call_allowed("DELETE", "/api/calendar-events"));
        assert!(!account_call_allowed("GET", "/api/calendar-events/evt_1"));
        assert!(account_call_allowed("PATCH", "/api/calendar-events/evt_01ABC"));
        assert!(!account_call_allowed("DELETE", "/api/calendar-events/evt_01ABC"));
        assert!(!account_call_allowed("PATCH", "/api/calendar-events/../me"));
        assert!(!account_call_allowed("PATCH", "/api/calendar-events"));
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
        assert!(account_call_allowed("GET", "/api/agent-feedback"));
        assert!(account_call_allowed("PATCH", "/api/agent-feedback"));
        assert!(account_call_allowed("POST", "/api/agent-feedback/apply"));
        assert!(account_call_allowed("POST", "/api/agent-feedback/merge"));
        assert!(!account_call_allowed("DELETE", "/api/agent-feedback"));
        assert!(!account_call_allowed("POST", "/api/agent-feedback"));
        assert!(!account_call_allowed("POST", "/api/agent-feedback/../me"));
        assert_eq!(account_timeout("/api/agent-feedback/merge"), MODEL_CALL_TIMEOUT);
        assert_eq!(account_timeout("/api/prompts"), ACCOUNT_TIMEOUT);
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
