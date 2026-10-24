//! Agents without hooks: Claude desktop chat, ChatGPT and any other remote MCP
//! client (docs/plans/voice-conversation.md, piece 2). They call
//! `send_to_human` or `ask_human` on Eavesy's remote MCP, the message waits in
//! the cloud, and this Mac picks it up by polling `/api/agents/inbox` while
//! "Messages from your agents" is on. Each one joins the same queue as Claude
//! Code sessions; an answer you type goes back only to the call that asked.
//!
//! Everything here is the agent's text: it's shown and spoken, never run, and
//! an answer never approves anything.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::queue::Kind;
use super::{now_ms, refresh, with_queue};

/// How often the inbox is asked while messages are on.
const POLL: Duration = Duration::from_secs(3);
const OFF_PAUSE: Duration = Duration::from_secs(5);
const ERROR_PAUSE: Duration = Duration::from_secs(15);
const SIGNED_OUT_PAUSE: Duration = Duration::from_secs(60);
/// Cloud ids already shown, so a retried poll never shows one twice.
const MAX_SEEN: usize = 500;
/// What the card shows of the message; the cloud already caps it at 4,000.
const MAX_SUMMARY: usize = 200;
const SESSION_PREFIX: &str = "remote:";

/// Asks on the card, by queue item: the cloud id the answer goes to.
static ASKS: Mutex<Option<HashMap<u64, String>>> = Mutex::new(None);
static SEEN: Mutex<Option<(HashSet<String>, VecDeque<String>)>> = Mutex::new(None);

fn with_asks<T>(f: impl FnOnce(&mut HashMap<u64, String>) -> T) -> T {
    let mut asks = ASKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(asks.get_or_insert_with(HashMap::new))
}

/// True the first time a cloud id is seen.
fn first_sight(id: &str) -> bool {
    let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (set, order) = seen.get_or_insert_with(Default::default);
    if !set.insert(id.to_string()) {
        return false;
    }
    order.push_back(id.to_string());
    if order.len() > MAX_SEEN {
        if let Some(old) = order.pop_front() {
            set.remove(&old);
        }
    }
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub id: String,
    pub kind: String,
    pub source: String,
    pub text: String,
    pub spoken: Option<String>,
    #[serde(default)]
    pub choices: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Poll {
    items: Vec<Message>,
    /// This Mac's asks still waiting in the cloud.
    waiting: Vec<String>,
}

/// What the queue gets for a message: the name it's said under, what's said,
/// what the card shows under it, and whether it waits for an answer.
#[derive(Debug, PartialEq)]
pub struct Card {
    pub session_id: String,
    pub name: String,
    pub summary: String,
    pub message: String,
    pub ask: bool,
}

pub fn card(message: &Message) -> Card {
    let one_line = |text: &str| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let spoken = message.spoken.as_deref().map(one_line).filter(|s| !s.is_empty());
    let summary = spoken.unwrap_or_else(|| clip(&one_line(&message.text), MAX_SUMMARY));
    let mut body = message.text.trim().to_string();
    if !message.choices.is_empty() {
        body.push_str(&format!("\n\nOptions: {}", message.choices.join(" · ")));
    }
    let name = one_line(&message.source);
    Card {
        session_id: format!("{SESSION_PREFIX}{}", message.id),
        name: if name.is_empty() { "An agent".into() } else { name },
        summary,
        message: body,
        ask: message.kind == "ask",
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>())
}

/// Polls for agent messages for as long as the app runs.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let pause = poll_once(&app).await;
            tokio::time::sleep(pause).await;
        }
    });
}

async fn poll_once(app: &AppHandle) -> Duration {
    if !crate::settings::load(app).agent_messages() {
        return OFF_PAUSE;
    }
    let Some(credential) = crate::settings::device_credential(app) else { return OFF_PAUSE };
    let Ok(client) = crate::sync::http_client() else { return ERROR_PAUSE };
    let response = match client
        .post(crate::base_url::join(&credential.base, "/api/agents/inbox"))
        .timeout(Duration::from_secs(10))
        .bearer_auth(credential.token)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!("agent inbox: {error}");
            return ERROR_PAUSE;
        }
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return SIGNED_OUT_PAUSE;
    }
    if !response.status().is_success() {
        tracing::warn!("agent inbox: {}", response.status());
        return ERROR_PAUSE;
    }
    let Ok(poll) = response.json::<Poll>().await else { return ERROR_PAUSE };
    // Turned off while the request was out: show nothing.
    if !crate::settings::load(app).agent_messages() {
        return OFF_PAUSE;
    }
    let mut changed = false;
    for message in poll.items.iter().filter(|message| first_sight(&message.id)) {
        add(message);
        changed = true;
    }
    let waiting: HashSet<&str> = poll.waiting.iter().map(String::as_str).collect();
    let gone: Vec<u64> = with_asks(|asks| asks.iter().filter(|(_, cloud)| !waiting.contains(cloud.as_str())).map(|(id, _)| *id).collect());
    for id in gone {
        // Timed out, or the agent stopped waiting.
        with_asks(|asks| asks.remove(&id));
        with_queue(|queue| queue.remove(id));
        changed = true;
    }
    if changed {
        refresh(app);
    }
    POLL
}

fn add(message: &Message) {
    let card = card(message);
    let id = with_queue(|queue| {
        let (id, _) = queue.push(&card.session_id, card.name.clone(), Kind::Finished, Some(card.message.clone()), card.ask, now_ms());
        // An ask is a question for you whatever its words; no summary model reads it.
        queue.resolve(id, card.summary.clone(), None, card.ask);
        id
    });
    if card.ask {
        with_asks(|asks| asks.insert(id, message.id.clone()));
    }
}

/// Whether the queue item came from a remote agent.
pub fn is_remote(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Outcome<'a> {
    Answered { text: &'a str },
    Dismissed,
}

async fn resolve(app: &AppHandle, cloud_id: &str, outcome: Outcome<'_>) -> Result<(), String> {
    let credential = crate::settings::device_credential(app).ok_or("Connect this Mac to your Eavesy account first.")?;
    let client = crate::sync::http_client().map_err(|error| error.to_string())?;
    let response = client
        .post(crate::base_url::join(&credential.base, &format!("/api/agents/inbox/{cloud_id}")))
        .timeout(Duration::from_secs(10))
        .bearer_auth(credential.token)
        .json(&outcome)
        .send()
        .await
        .map_err(|_| "Couldn't reach Eavesy. Try again.".to_string())?;
    match response.status() {
        status if status.is_success() => Ok(()),
        reqwest::StatusCode::CONFLICT => Err("That agent stopped waiting for an answer.".into()),
        status => Err(format!("Couldn't send that answer ({status}).")),
    }
}

/// You dismissed a remote item: an ask tells its agent so, without waiting.
pub fn dismissed(app: &AppHandle, id: u64) {
    let Some(cloud_id) = with_asks(|asks| asks.remove(&id)) else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = resolve(&app, &cloud_id, Outcome::Dismissed).await {
            tracing::debug!("agent inbox: dismiss: {error}");
        }
    });
}

/// Drops every remote item, telling waiting agents you dismissed them.
pub fn clear(app: &AppHandle) {
    let ids: Vec<u64> = with_queue(|queue| queue.ordered().into_iter().filter(|item| is_remote(&item.session_id)).map(|item| item.id).collect());
    for id in ids {
        dismissed(app, id);
        with_queue(|queue| queue.remove(id));
    }
}

/// Sends what you typed to the agent that asked. The card keeps it if that fails.
#[tauri::command]
pub async fn agents_answer(app: AppHandle, id: u64, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Write an answer first.".into());
    }
    if text.chars().count() > super::protocol::MAX_REPLY_CHARS {
        return Err(format!("That answer is too long. Keep it under {} characters.", super::protocol::MAX_REPLY_CHARS));
    }
    let cloud_id = with_asks(|asks| asks.get(&id).cloned()).ok_or("That agent stopped waiting for an answer.")?;
    let result = resolve(&app, &cloud_id, Outcome::Answered { text: &text }).await;
    if matches!(&result, Err(error) if !error.contains("stopped waiting")) {
        return result;
    }
    with_asks(|asks| asks.remove(&id));
    with_queue(|queue| queue.remove(id));
    super::speak::stop();
    refresh(&app);
    result
}

#[tauri::command]
pub fn set_agent_messages(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::settings::update(&app, |config| config.agent_messages = Some(enabled))?;
    if !enabled {
        clear(&app);
        super::speak::stop();
        refresh(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: &str) -> Message {
        Message {
            id: "c1".into(),
            kind: kind.into(),
            source: "Chat\nGPT".into(),
            text: "  The report is ready.\nIt has three parts.  ".into(),
            spoken: None,
            choices: vec![],
        }
    }

    #[test]
    fn an_ask_waits_for_you_and_names_its_source() {
        let mut ask = message("ask");
        ask.spoken = Some("Ship\nit?".into());
        ask.choices = vec!["yes".into(), "no".into()];
        let card = card(&ask);
        assert_eq!(card.session_id, "remote:c1");
        assert!(is_remote(&card.session_id));
        assert_eq!(card.name, "Chat GPT");
        assert_eq!(card.summary, "Ship it?");
        assert_eq!(card.message, "The report is ready.\nIt has three parts.\n\nOptions: yes · no");
        assert!(card.ask);
    }

    #[test]
    fn a_message_without_spoken_says_its_text() {
        let card = card(&message("send"));
        assert_eq!(card.summary, "The report is ready. It has three parts.");
        assert!(!card.ask);
        let mut long = message("send");
        long.text = "x".repeat(500);
        assert_eq!(super::card(&long).summary.chars().count(), MAX_SUMMARY);
    }

    #[test]
    fn a_remote_ask_stays_a_held_question_in_the_queue() {
        let mut queue = super::super::queue::Queue::default();
        let card = card(&message("ask"));
        let (id, _) = queue.push(&card.session_id, card.name.clone(), Kind::Finished, Some(card.message.clone()), card.ask, 1);
        queue.resolve(id, card.summary.clone(), None, card.ask);
        let item = queue.get(id).unwrap();
        assert_eq!(item.kind, Kind::Question);
        assert!(item.held);
        // A Claude Code session with the same name doesn't replace it.
        queue.push("c1", "Chat GPT".into(), Kind::Finished, None, false, 2);
        assert!(queue.get(id).is_some());
    }

    #[test]
    fn each_cloud_id_is_shown_once() {
        assert!(first_sight("seen-once"));
        assert!(!first_sight("seen-once"));
    }
}
