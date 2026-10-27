//! The second-model check (assistant.md C7): before a tier 2 or 3 action, Eavesy's
//! cloud compares it with your literal words. It fails closed: no sign-in, an error,
//! a timeout or anything unreadable is `Failed`, which is always a card.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::policy::Check;
use super::Action;

#[derive(Serialize)]
struct Request<'a> {
    request: &'a str,
    action: ActionText,
}

#[derive(Serialize)]
struct ActionText {
    tool: &'static str,
    title: String,
    rows: Vec<String>,
}

#[derive(Deserialize)]
struct Response {
    verdict: String,
    reason: Option<String>,
}

/// Blocking: call it off the main thread.
pub fn run(app: &AppHandle, request: &str, action: &dyn Action) -> Check {
    let body = Request {
        request,
        action: ActionText { tool: action.tool(), title: action.title(), rows: action.rows().into_iter().map(|row| row.label).collect() },
    };
    tauri::async_runtime::block_on(ask(app, &body)).unwrap_or(Check::Failed)
}

async fn ask(app: &AppHandle, body: &Request<'_>) -> Option<Check> {
    let credential = crate::settings::device_credential(app)?;
    let client = crate::sync::http_client().ok()?;
    let response = client
        .post(crate::base_url::join(&credential.base, "/api/assistant/check"))
        .timeout(Duration::from_secs(10))
        .bearer_auth(credential.token)
        .json(body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        tracing::warn!("assistant check unavailable: {}", response.status());
        return None;
    }
    let answer: Response = response.json().await.ok()?;
    Some(verdict(answer))
}

fn verdict(answer: Response) -> Check {
    match answer.verdict.as_str() {
        "pass" => Check::Pass,
        "flag" => Check::Flagged(answer.reason.filter(|r| !r.trim().is_empty()).unwrap_or_else(|| "This doesn't quite match what you asked.".into())),
        _ => Check::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_pass_passes() {
        assert_eq!(verdict(Response { verdict: "pass".into(), reason: None }), Check::Pass);
        assert!(matches!(verdict(Response { verdict: "flag".into(), reason: Some(" ".into()) }), Check::Flagged(reason) if !reason.trim().is_empty()));
        assert_eq!(verdict(Response { verdict: "PASS".into(), reason: None }), Check::Failed);
    }
}
