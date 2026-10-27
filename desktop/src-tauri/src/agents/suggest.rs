//! Turns Claude's last message into something to say and a reply to suggest,
//! through Eavesy's cloud (`/api/agents/reply-suggestion`). Without a sign-in
//! or a connection, a plain summary from the message itself.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::protocol::Event;

#[derive(Debug, Clone, PartialEq)]
pub struct Suggestion {
    pub summary: String,
    pub needs_you: bool,
    pub reply: Option<String>,
}

#[derive(Serialize)]
struct Request<'a> {
    kind: &'a str,
    session: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt: Option<&'a str>,
    message: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    summary: String,
    needs_you: bool,
    suggested_reply: Option<String>,
}

pub async fn suggest(app: &AppHandle, event: Event, session: &str, prompt: Option<&str>, message: &str) -> Suggestion {
    match ask_cloud(app, event, session, prompt, message).await {
        Some(suggestion) => suggestion,
        None => fallback(event, message),
    }
}

async fn ask_cloud(app: &AppHandle, event: Event, session: &str, prompt: Option<&str>, message: &str) -> Option<Suggestion> {
    let credential = crate::settings::device_credential(app)?;
    let client = crate::sync::http_client().ok()?;
    let kind = if event == Event::Notification { "notification" } else { "stop" };
    let response = client
        .post(crate::base_url::join(&credential.base, "/api/agents/reply-suggestion"))
        .timeout(Duration::from_secs(8))
        .bearer_auth(credential.token)
        .json(&Request { kind, session, prompt, message })
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        tracing::warn!("reply suggestion unavailable: {}", response.status());
        return None;
    }
    let body: Response = response.json().await.ok()?;
    let summary = body.summary.trim().to_string();
    if summary.is_empty() {
        return None;
    }
    let reply = body.suggested_reply.map(|r| r.trim().to_string()).filter(|r| !r.is_empty() && event != Event::Notification);
    Some(Suggestion { summary, needs_you: body.needs_you, reply })
}

/// Claude's question if it asked one, else its first sentence. No suggestion.
pub fn fallback(event: Event, message: &str) -> Suggestion {
    let text = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if event == Event::Notification {
        let summary = if text.is_empty() { "needs you".to_string() } else { clip(&text) };
        return Suggestion { summary, needs_you: true, reply: None };
    }
    let sentences: Vec<&str> = text.split_inclusive(['.', '?', '!']).map(str::trim).filter(|s| !s.is_empty()).collect();
    let question = sentences.iter().rev().find(|s| s.ends_with('?'));
    let summary = match (question, sentences.first()) {
        (Some(question), _) => format!("asks: {}", clip(question)),
        (None, Some(first)) => format!("finished: {}", clip(first)),
        (None, None) => "finished".to_string(),
    };
    Suggestion { summary, needs_you: question.is_some(), reply: None }
}

fn clip(text: &str) -> String {
    let clipped: String = text.chars().take(200).collect();
    if clipped.len() < text.len() { format!("{clipped}…") } else { clipped }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_finds_claudes_question() {
        let s = fallback(Event::Stop, "I fixed the HUD. Tests pass.\n\nShould I open a PR?");
        assert_eq!(s.summary, "asks: Should I open a PR?");
        assert!(s.needs_you);
        assert_eq!(s.reply, None);
    }

    #[test]
    fn the_fallback_without_a_question_reports_what_finished() {
        let s = fallback(Event::Stop, "Merged the fix. Deploy is green.");
        assert_eq!(s.summary, "finished: Merged the fix.");
        assert!(!s.needs_you);
        assert_eq!(fallback(Event::Stop, "").summary, "finished");
    }

    #[test]
    fn a_notification_needs_you() {
        let s = fallback(Event::Notification, "Claude needs your permission to use Bash");
        assert!(s.needs_you);
        assert_eq!(s.summary, "Claude needs your permission to use Bash");
    }
}
