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
/// And no more than this much JSON, under the cloud's 256 KB cap.
const SENT_BYTES: usize = 180 * 1024;
/// Your turns the check (C7) compares an action with: enough for "yes, do that" to carry
/// what "that" was, and never Eavesy's own words.
const CHECKED_TURNS: usize = 3;
/// Messages kept in the thread.
const KEPT_MESSAGES: usize = 200;
const TEXT_CHARS: usize = 4_000;
/// Most of the notes block sent with a turn (the cloud takes 8,000 per block), newest kept.
const NOTE_CHARS: usize = 7_000;
/// Longest request the C7 check takes.
const CHECK_CHARS: usize = 4_000;

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
    /// Stays the same when older turns are dropped, unlike its place in the thread.
    id: u64,
    message: Message,
    at_ms: u64,
    /// Your turns: said or typed (B7).
    spoken: bool,
    /// What happened since the last turn (a card you decided), sent to the model ahead
    /// of your words but never counted as them.
    notes: Vec<String>,
    /// An error shown in Eavesy's place. It's for you, so the model never sees it as
    /// something it said.
    failed: bool,
}

impl Turn {
    /// The message as the model gets it: notes first, in one block, then the turn itself.
    fn for_model(&self) -> Message {
        let notes = self.notes.iter().map(|note| format!("[Eavesy app note: {note}]")).collect::<Vec<_>>().join("\n");
        let notes = newest_chars(&notes, NOTE_CHARS);
        let mut content: Vec<Block> = if notes.is_empty() { Vec::new() } else { vec![Block::Text { text: notes.to_string() }] };
        content.extend(self.message.content.iter().cloned());
        Message { role: self.message.role, content }
    }
}

#[derive(Default)]
pub struct Thread {
    turns: Vec<Turn>,
    next_id: u64,
    busy: bool,
    /// Notes waiting for your next turn.
    notes: Vec<String>,
}

/// What the panel draws: your words, Eavesy's words, and the tools between them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
    pub busy: bool,
    pub turns: Vec<TurnView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TurnView {
    pub id: u64,
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

/// Your words, and nothing that answers a tool call: a window can start there.
fn is_your_words(message: &Message) -> bool {
    message.role == Role::User
        && message.content.iter().any(|block| matches!(block, Block::Text { .. }))
        && !message.content.iter().any(|block| matches!(block, Block::ToolResult { .. }))
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

/// Like `window`, and also no more than `bytes` of JSON, so a long tool result can't
/// make every later request too large.
fn window_within(messages: &[Message], limit: usize, bytes: usize) -> &[Message] {
    let recent = window(messages, limit);
    let mut size = 0;
    let mut start = recent.len();
    while start > 0 {
        size += serde_json::to_string(&recent[start - 1]).map_or(0, |json| json.len());
        if size > bytes {
            break;
        }
        start -= 1;
    }
    window(&recent[start..], usize::MAX)
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
    for turn in &thread.turns {
        let id = turn.id;
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
                turns.push(TurnView { id, who: "eavesy", spoken: turn.spoken, at_ms: turn.at_ms, text: text_of(&turn.message), steps });
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
    record(app, message, spoken, false);
}

fn record(app: &AppHandle, message: Message, spoken: bool, failed: bool) {
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        let notes = if is_your_words(&message) { std::mem::take(&mut thread.notes) } else { Vec::new() };
        let id = thread.next_id;
        thread.next_id += 1;
        thread.turns.push(Turn { id, message, at_ms: super::now_ms(), spoken, notes, failed });
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
    if response.status().is_client_error() {
        tracing::warn!("assistant turn refused: {}", response.status());
        return Err("This conversation got too big for me to send. Press Clear to start fresh.".into());
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
            let messages = sent(&thread.turns);
            let said: Vec<String> = thread.turns.iter().filter(|turn| is_your_words(&turn.message)).map(|turn| text_of(&turn.message)).collect();
            (window_within(&messages, SENT_MESSAGES, SENT_BYTES).to_vec(), said)
        };
        let request = newest_chars(&said_by_you[said_by_you.len().saturating_sub(CHECKED_TURNS)..].join("\n"), CHECK_CHARS).to_string();
        let content = match tauri::async_runtime::block_on(ask(app, &messages)) {
            Ok(content) if !content.is_empty() => content,
            Ok(_) => vec![Block::Text { text: "I don't have anything to add.".into() }],
            Err(error) => {
                record(app, Message { role: Role::Assistant, content: vec![Block::Text { text: error }] }, false, true);
                return;
            }
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
                super::tools::call(app, &name, &input, &requester, &said_by_you, &request)
            };
            results.push(Block::ToolResult { tool_use_id: id, content: result.content, is_error: result.is_error });
        }
        push(app, Message { role: Role::User, content: results }, false);
    }
    push(app, Message { role: Role::Assistant, content: vec![Block::Text { text: "That took more steps than I allow myself. Tell me how you'd like to go on.".into() }] }, false);
}

/// What the model is sent: every turn but the errors shown in Eavesy's place. Dropping
/// one can leave two user messages in a row, so those are joined into one.
fn sent(turns: &[Turn]) -> Vec<Message> {
    let mut messages: Vec<Message> = Vec::new();
    for message in turns.iter().filter(|turn| !turn.failed).map(Turn::for_model) {
        match messages.last_mut() {
            Some(last) if last.role == message.role => last.content.extend(message.content),
            _ => messages.push(message),
        }
    }
    messages
}

/// The end of `text`, at most `max` characters: the check takes 4,000 (checkInput in
/// web/src/server/assistant.ts), and your newest words matter most.
fn newest_chars(text: &str, max: usize) -> &str {
    let count = text.chars().count();
    match text.char_indices().nth(count.saturating_sub(max)) {
        Some((start, _)) if count > max => &text[start..],
        _ => text,
    }
}

pub fn init(app: &AppHandle) {
    app.manage(Mutex::new(Thread::default()));
}

/// Tells the model, with your next message, how a card ended, so it doesn't offer the
/// same thing again.
pub fn note(app: &AppHandle, text: String) {
    let state = app.state::<Mutex<Thread>>();
    let mut thread = state.lock().unwrap();
    if !thread.turns.is_empty() {
        thread.notes.push(text);
    }
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
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || send(&handle, text, spoken.unwrap_or(false))).await.map_err(|error| error.to_string())?
}

/// Your message, then Eavesy's answer to it. Blocking: call it off the main thread.
pub fn send(app: &AppHandle, text: String, spoken: bool) -> Result<(), String> {
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
    // Busy is cleared however the conversation ends, a panic included.
    struct Done<'a>(&'a AppHandle);
    impl Drop for Done<'_> {
        fn drop(&mut self) {
            self.0.state::<Mutex<Thread>>().lock().unwrap_or_else(|e| e.into_inner()).busy = false;
            emit(self.0);
        }
    }
    let _done = Done(app);
    converse(app, text, spoken);
    Ok(())
}

/// Eavesy's newest turn that has words.
pub struct Reply {
    pub id: u64,
    pub text: String,
    /// An error shown in Eavesy's place, not something it said.
    pub failed: bool,
}

pub fn last_reply(app: &AppHandle) -> Option<Reply> {
    let state = app.state::<Mutex<Thread>>();
    let thread = state.lock().unwrap();
    newest_reply(&thread.turns)
}

fn newest_reply(turns: &[Turn]) -> Option<Reply> {
    turns.iter().rev().find_map(|turn| {
        let text = text_of(&turn.message);
        (turn.message.role == Role::Assistant && !text.trim().is_empty()).then_some(Reply { id: turn.id, text, failed: turn.failed })
    })
}

/// Eavesy read this reply out loud (B7).
pub fn mark_spoken(app: &AppHandle, id: u64) {
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        match thread.turns.iter_mut().find(|turn| turn.id == id) {
            Some(turn) if turn.message.role == Role::Assistant => turn.spoken = true,
            _ => return,
        }
    }
    emit(app);
}

/// Says one of Eavesy's replies again (B3).
#[tauri::command]
pub fn assistant_repeat(app: AppHandle, window: WebviewWindow, id: u64) -> Result<(), String> {
    super::from_ui(&window)?;
    let text = {
        let state = app.state::<Mutex<Thread>>();
        let thread = state.lock().unwrap();
        match thread.turns.iter().find(|turn| turn.id == id) {
            Some(turn) if turn.message.role == Role::Assistant && !turn.failed => text_of(&turn.message),
            _ => return Err("That reply is gone.".into()),
        }
    };
    super::voice::say(&app, Some(id), &text)
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
        thread.notes.clear();
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
        let turns = [said("anyone waiting?"), call("t1"), result("t1")].into_iter().map(|message| Turn { id: 0, message, at_ms: 1, spoken: false, notes: Vec::new(), failed: false }).collect();
        let view = view(&Thread { turns, next_id: 3, busy: true, notes: Vec::new() });
        assert!(view.busy);
        assert_eq!(view.turns.len(), 2);
        assert_eq!(view.turns[0].who, "you");
        assert_eq!(view.turns[1].steps, vec![Step { tool: "agent_sessions".into(), line: Some("3 sessions".into()), ok: true }]);
    }

    #[test]
    fn a_big_result_drops_older_turns_but_keeps_the_pairing() {
        let big = Message { role: Role::User, content: vec![Block::ToolResult { tool_use_id: "1".into(), content: "x".repeat(5_000), is_error: false }] };
        let messages = vec![said("a"), call("1"), big, said("b"), call("2"), result("2")];
        let sent = window_within(&messages, 40, 2_000);
        assert_eq!(sent, &messages[3..]);
        // Nothing fits: nothing is sent rather than a broken thread.
        assert!(window_within(&messages, 40, 10).is_empty());
    }

    #[test]
    fn the_check_gets_your_newest_words() {
        let long = format!("{}{}", "a".repeat(5_000), "é".repeat(10));
        let cut = newest_chars(&long, CHECK_CHARS);
        assert_eq!(cut.chars().count(), CHECK_CHARS);
        assert!(cut.ends_with("é"));
        assert_eq!(newest_chars("short", CHECK_CHARS), "short");
    }

    #[test]
    fn errors_are_not_sent_to_the_model() {
        let error = Message { role: Role::Assistant, content: vec![Block::Text { text: "I can't reach my model right now.".into() }] };
        let turns = vec![
            Turn { id: 1, message: said("anyone waiting?"), at_ms: 1, spoken: false, notes: Vec::new(), failed: false },
            Turn { id: 2, message: error, at_ms: 2, spoken: false, notes: Vec::new(), failed: true },
            Turn { id: 3, message: said("try again"), at_ms: 3, spoken: false, notes: Vec::new(), failed: false },
        ];
        let messages = sent(&turns);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, Role::User);
        assert_eq!(messages[0].content.len(), 2);
    }

    #[test]
    fn an_error_is_the_newest_reply_but_says_so() {
        let error = Message { role: Role::Assistant, content: vec![Block::Text { text: "I can't reach my model right now.".into() }] };
        let turns = vec![
            Turn { id: 1, message: said("anyone waiting?"), at_ms: 1, spoken: false, notes: Vec::new(), failed: false },
            Turn { id: 2, message: error, at_ms: 2, spoken: false, notes: Vec::new(), failed: true },
        ];
        let reply = newest_reply(&turns).unwrap();
        assert_eq!((reply.id, reply.failed), (2, true));
        assert!(newest_reply(&turns[..1]).is_none());
    }

    #[test]
    fn notes_go_to_the_model_but_are_not_your_words() {
        let turn = Turn { id: 0, message: said("and the other one?"), at_ms: 1, spoken: false, notes: vec!["card accepted: 2 of 2 done".into(), "card declined".into()], failed: false };
        let sent = turn.for_model();
        // However many notes, they take one block, so a message stays within the block cap.
        assert_eq!(sent.content.len(), 2);
        assert_eq!(text_of(&turn.message), "and the other one?");
    }

    #[test]
    fn blocks_match_the_api_shape() {
        let json = serde_json::to_value(call("t1")).unwrap();
        assert_eq!(json["content"][1], serde_json::json!({"type": "tool_use", "id": "t1", "name": "agent_sessions", "input": {}}));
        let back: Block = serde_json::from_value(serde_json::json!({"type": "tool_result", "tool_use_id": "t1", "content": "x"})).unwrap();
        assert_eq!(back, Block::ToolResult { tool_use_id: "t1".into(), content: "x".into(), is_error: false });
    }
}
