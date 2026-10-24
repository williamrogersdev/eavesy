//! Eavesy's conversation (assistant.md B): the thread, and the loop that sends it to
//! Eavesy's cloud, runs the tools the model asks for through the core, and sends the
//! results back until the model answers in words.
//!
//! The thread lives in memory for now; it's cleared when Eavesy quits.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::policy::Requester;

/// Model steps per message before Eavesy stops and says so.
const MAX_STEPS: usize = 8;
/// Messages sent to the model: the latest ones, starting at something you said.
const SENT_MESSAGES: usize = 40;
/// Messages kept in the thread.
const KEPT_MESSAGES: usize = 200;
const TEXT_CHARS: usize = 4_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text { text: String },
    ToolUse { id: String, name: String, input: serde_json::Value },
    ToolResult { tool_use_id: String, content: String, #[serde(default)] is_error: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Block>,
}

#[derive(Clone, Debug)]
struct Turn {
    message: Message,
    at_ms: u64,
    /// Your turns: said or typed (B7).
    spoken: bool,
}

#[derive(Default)]
pub struct Thread {
    turns: Vec<Turn>,
    busy: bool,
}

/// What the panel draws: your words, Eavesy's words, and the tools between them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
    pub busy: bool,
    pub turns: Vec<TurnView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TurnView {
    pub id: usize,
    /// `you` or `eavesy`.
    pub who: &'static str,
    pub spoken: bool,
    pub at_ms: u64,
    pub text: String,
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Step {
    pub tool: String,
    /// The result's first line, or None while it's running.
    pub line: Option<String>,
    pub ok: bool,
}

fn is_your_words(message: &Message) -> bool {
    message.role == Role::User && message.content.iter().any(|block| matches!(block, Block::Text { .. }))
}

fn text_of(message: &Message) -> String {
    message.content.iter().filter_map(|block| if let Block::Text { text } = block { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n")
}

/// The newest `limit` messages, cut so they start at something you said: the model
/// never gets a tool result without the call it answers.
fn window(messages: &[Message], limit: usize) -> &[Message] {
    let mut start = messages.len().saturating_sub(limit);
    while start < messages.len() && !is_your_words(&messages[start]) {
        start += 1;
    }
    &messages[start..]
}

fn view(thread: &Thread) -> View {
    let mut turns: Vec<TurnView> = Vec::new();
    let mut results = std::collections::HashMap::new();
    for turn in &thread.turns {
        for block in &turn.message.content {
            if let Block::ToolResult { tool_use_id, content, is_error } = block {
                results.insert(tool_use_id.as_str(), (content.lines().next().unwrap_or_default().to_string(), !is_error));
            }
        }
    }
    for (id, turn) in thread.turns.iter().enumerate() {
        match turn.message.role {
            Role::User if is_your_words(&turn.message) => {
                turns.push(TurnView { id, who: "you", spoken: turn.spoken, at_ms: turn.at_ms, text: text_of(&turn.message), steps: Vec::new() });
            }
            Role::User => {}
            Role::Assistant => {
                let steps = turn
                    .message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        Block::ToolUse { id, name, .. } => {
                            let (line, ok) = results.get(id.as_str()).cloned().map_or((None, true), |(line, ok)| (Some(line), ok));
                            Some(Step { tool: name.clone(), line, ok })
                        }
                        _ => None,
                    })
                    .collect();
                turns.push(TurnView { id, who: "eavesy", spoken: false, at_ms: turn.at_ms, text: text_of(&turn.message), steps });
            }
        }
    }
    View { busy: thread.busy, turns }
}

fn emit(app: &AppHandle) {
    let state = app.state::<Mutex<Thread>>();
    let view = view(&state.lock().unwrap());
    let _ = app.emit("assistant:thread", &view);
}

fn push(app: &AppHandle, message: Message, spoken: bool) {
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        thread.turns.push(Turn { message, at_ms: super::now_ms(), spoken });
        if thread.turns.len() > KEPT_MESSAGES {
            let messages: Vec<Message> = thread.turns.iter().map(|turn| turn.message.clone()).collect();
            let keep = window(&messages, KEPT_MESSAGES).len();
            let cut = thread.turns.len() - keep;
            thread.turns.drain(..cut);
        }
    }
    emit(app);
}

#[derive(Serialize)]
struct TurnRequest<'a> {
    messages: &'a [Message],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnResponse {
    content: Vec<Block>,
}

async fn ask(app: &AppHandle, messages: &[Message]) -> Result<Vec<Block>, String> {
    let credential = crate::settings::device_credential(app).ok_or("Sign in to Eavesy to talk to it.")?;
    let client = crate::sync::http_client().map_err(|e| e.to_string())?;
    let response = client
        .post(crate::base_url::join(&credential.base, "/api/assistant/turn"))
        .timeout(Duration::from_secs(60))
        .bearer_auth(credential.token)
        .json(&TurnRequest { messages })
        .send()
        .await
        .map_err(|_| "I can't reach Eavesy's cloud right now.".to_string())?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("That's today's limit for talking to me. It resets at midnight UTC.".into());
    }
    if !response.status().is_success() {
        tracing::warn!("assistant turn unavailable: {}", response.status());
        return Err("I can't reach my model right now. Try again in a moment.".into());
    }
    let body: TurnResponse = response.json().await.map_err(|_| "I got an answer I couldn't read.".to_string())?;
    // Only text and tool calls come back from the model.
    Ok(body.content.into_iter().filter(|block| matches!(block, Block::Text { .. } | Block::ToolUse { .. })).collect())
}

/// One message from you, then model steps and tool calls until it answers. Blocking.
fn converse(app: &AppHandle, text: String, spoken: bool) {
    push(app, Message { role: Role::User, content: vec![Block::Text { text: text.clone() }] }, spoken);
    let requester = Requester::You { spoken };
    for step in 0..MAX_STEPS {
        let (messages, said_by_you) = {
            let state = app.state::<Mutex<Thread>>();
            let thread = state.lock().unwrap();
            let messages: Vec<Message> = thread.turns.iter().map(|turn| turn.message.clone()).collect();
            let said: Vec<String> = thread.turns.iter().filter(|turn| is_your_words(&turn.message)).map(|turn| text_of(&turn.message)).collect();
            (window(&messages, SENT_MESSAGES).to_vec(), said)
        };
        let content = match tauri::async_runtime::block_on(ask(app, &messages)) {
            Ok(content) if !content.is_empty() => content,
            Ok(_) => vec![Block::Text { text: "I don't have anything to add.".into() }],
            Err(error) => vec![Block::Text { text: error }],
        };
        let calls: Vec<(String, String, serde_json::Value)> = content
            .iter()
            .filter_map(|block| match block {
                Block::ToolUse { id, name, input } => Some((id.clone(), name.clone(), input.clone())),
                _ => None,
            })
            .collect();
        push(app, Message { role: Role::Assistant, content }, false);
        if calls.is_empty() {
            return;
        }
        let mut results = Vec::new();
        for (id, name, input) in calls {
            // Out of steps: answer the calls without running them, so the thread stays well formed.
            let result = if step + 1 == MAX_STEPS {
                super::tools::ToolResult { content: "Stopped: that took too many steps.".into(), is_error: true }
            } else {
                super::tools::call(app, &name, &input, &requester, &said_by_you, &text)
            };
            results.push(Block::ToolResult { tool_use_id: id, content: result.content, is_error: result.is_error });
        }
        push(app, Message { role: Role::User, content: results }, false);
    }
    push(app, Message { role: Role::Assistant, content: vec![Block::Text { text: "That took more steps than I allow myself. Tell me how you'd like to go on.".into() }] }, false);
}

pub fn init(app: &AppHandle) {
    app.manage(Mutex::new(Thread::default()));
}

#[tauri::command]
pub fn assistant_thread(app: AppHandle, window: WebviewWindow) -> Result<View, String> {
    super::from_ui(&window)?;
    let state = app.state::<Mutex<Thread>>();
    let view = view(&state.lock().unwrap());
    Ok(view)
}

/// Sends what you typed (or said, with `spoken`). Resolves once Eavesy has answered;
/// the thread updates as it goes through `assistant:thread`.
#[tauri::command]
pub async fn assistant_send(app: AppHandle, window: WebviewWindow, text: String, spoken: Option<bool>) -> Result<(), String> {
    super::from_ui(&window)?;
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    if text.chars().count() > TEXT_CHARS {
        return Err("That's longer than Eavesy takes in one message.".into());
    }
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        if thread.busy {
            return Err("Eavesy is still answering.".into());
        }
        thread.busy = true;
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || converse(&handle, text, spoken.unwrap_or(false))).await;
    app.state::<Mutex<Thread>>().lock().unwrap().busy = false;
    emit(&app);
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn assistant_clear(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    super::from_ui(&window)?;
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        if thread.busy {
            return Err("Eavesy is still answering.".into());
        }
        thread.turns.clear();
    }
    emit(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(text: &str) -> Message { Message { role: Role::User, content: vec![Block::Text { text: text.into() }] } }
    fn result(id: &str) -> Message {
        Message { role: Role::User, content: vec![Block::ToolResult { tool_use_id: id.into(), content: "3 sessions\n[...]".into(), is_error: false }] }
    }
    fn call(id: &str) -> Message {
        Message { role: Role::Assistant, content: vec![Block::Text { text: "Looking.".into() }, Block::ToolUse { id: id.into(), name: "agent_sessions".into(), input: serde_json::json!({}) }] }
    }

    #[test]
    fn the_window_starts_at_your_words() {
        let messages = vec![said("a"), call("1"), result("1"), Message { role: Role::Assistant, content: vec![Block::Text { text: "b".into() }] }, said("c")];
        assert_eq!(window(&messages, 10).len(), 5);
        // The last 3 start at a tool result, so it moves on to "c".
        assert_eq!(window(&messages, 3), &messages[4..]);
        assert_eq!(window(&messages, 4).len(), 1);
    }

    #[test]
    fn the_view_hangs_tool_results_on_the_call() {
        let turns = [said("anyone waiting?"), call("t1"), result("t1")].into_iter().map(|message| Turn { message, at_ms: 1, spoken: false }).collect();
        let view = view(&Thread { turns, busy: true });
        assert!(view.busy);
        assert_eq!(view.turns.len(), 2);
        assert_eq!(view.turns[0].who, "you");
        assert_eq!(view.turns[1].steps, vec![Step { tool: "agent_sessions".into(), line: Some("3 sessions".into()), ok: true }]);
    }

    #[test]
    fn blocks_match_the_api_shape() {
        let json = serde_json::to_value(call("t1")).unwrap();
        assert_eq!(json["content"][1], serde_json::json!({"type": "tool_use", "id": "t1", "name": "agent_sessions", "input": {}}));
        let back: Block = serde_json::from_value(serde_json::json!({"type": "tool_result", "tool_use_id": "t1", "content": "x"})).unwrap();
        assert_eq!(back, Block::ToolResult { tool_use_id: "t1".into(), content: "x".into(), is_error: false });
    }
}
