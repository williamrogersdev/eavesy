//! Eavesy's conversation (assistant.md B): the thread, and the loop that sends it to
//! Eavesy's cloud, runs the tools the model asks for through the core, and sends the
//! results back until the model answers in words.
//!
//! The thread is saved in the local database as it grows (saved.rs), so it's still
//! there after a restart. Off the record, nothing is saved.

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
/// Longest line of the conversation its brief reads (the cloud takes 8,000 per entry).
pub(super) const ENTRY_CHARS: usize = 4_000;

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

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Turn {
    /// Stays the same when older turns are dropped, unlike its place in the thread.
    pub(super) id: u64,
    pub(super) message: Message,
    pub(super) at_ms: u64,
    /// Your turns: said or typed (B7).
    pub(super) spoken: bool,
    /// What happened since the last turn (a card you decided), sent to the model ahead
    /// of your words but never counted as them.
    pub(super) notes: Vec<String>,
    /// An error shown in Eavesy's place. It's for you, so the model never sees it as
    /// something it said.
    pub(super) failed: bool,
    /// Your turn, marked "Don't remember this" (H3): what it taught was forgotten, and
    /// its words no longer count when a note or rule is checked.
    pub(super) unremembered: bool,
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
    /// Off the record (H3): memory is neither sent nor written until the thread is cleared,
    /// and the conversation is neither saved nor briefed.
    off_record: bool,
    /// Names this conversation in the database and on its brief. Empty until its first
    /// turn; Clear starts a new one.
    conversation: String,
    /// The id of this conversation's first turn: ids keep counting across Clear.
    first_turn: u64,
    /// Conversations whose brief is being written right now, so Forget All reaches a
    /// brief that hasn't been stored yet.
    briefing: Vec<String>,
}

/// What the panel draws: your words, Eavesy's words, and the tools between them.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct View {
    pub busy: bool,
    pub off_record: bool,
    pub turns: Vec<TurnView>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TurnView {
    pub id: u64,
    /// `you` or `eavesy`.
    pub who: &'static str,
    pub spoken: bool,
    /// Your turn, marked "Don't remember this".
    pub unremembered: bool,
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
    /// A note `remember` kept, so the thread can offer Undo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remembered: Option<String>,
    /// Which file it went to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub book: Option<super::memory::Book>,
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

/// Each tool call's result: its first line, and whether it worked.
fn results(turns: &[Turn]) -> std::collections::HashMap<&str, (String, bool)> {
    let mut results = std::collections::HashMap::new();
    for turn in turns {
        for block in &turn.message.content {
            if let Block::ToolResult { tool_use_id, content, is_error } = block {
                results.insert(tool_use_id.as_str(), (content.lines().next().unwrap_or_default().to_string(), !is_error));
            }
        }
    }
    results
}

fn view(thread: &Thread) -> View {
    let mut turns: Vec<TurnView> = Vec::new();
    let results = results(&thread.turns);
    // In an exchange you marked "Don't remember this", its notes are already gone.
    let mut forgotten = false;
    for turn in &thread.turns {
        let id = turn.id;
        match turn.message.role {
            Role::User if is_your_words(&turn.message) => {
                forgotten = turn.unremembered;
                turns.push(TurnView { id, who: "you", spoken: turn.spoken, unremembered: turn.unremembered, at_ms: turn.at_ms, text: text_of(&turn.message), steps: Vec::new() });
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
                            // The note as kept (a duplicate keeps its first spelling), so Undo finds it.
                            let kept = (name == "remember" && ok && !forgotten).then(|| line.as_deref().and_then(remembered_on)).flatten();
                            let (remembered, book) = kept.map_or((None, None), |(note, book)| (Some(note), Some(book)));
                            Some(Step { tool: name.clone(), line, ok, remembered, book })
                        }
                        _ => None,
                    })
                    .collect();
                turns.push(TurnView { id, who: "eavesy", spoken: turn.spoken, unremembered: false, at_ms: turn.at_ms, text: text_of(&turn.message), steps });
            }
        }
    }
    View { busy: thread.busy, off_record: thread.off_record, turns }
}

/// The note and its file from a `remember` result's first line.
fn remembered_on(line: &str) -> Option<(String, super::memory::Book)> {
    use super::memory::{clean, Book};
    match (line.strip_prefix("Remembered about you: "), line.strip_prefix("Remembered: ")) {
        (Some(note), _) => Some((clean(note), Book::You)),
        (None, Some(note)) => Some((clean(note), Book::Setup)),
        _ => None,
    }
}

/// The notes Eavesy kept in this thread, each with its file: after your turn `from` and
/// before your next one, or, with none, from every exchange not already forgotten. Only
/// notes it added count, never one that was already there (memory::Added).
fn taught(turns: &[Turn], from: Option<u64>) -> Vec<(String, super::memory::Book)> {
    let results = results(turns);
    let mut notes: Vec<(String, super::memory::Book)> = Vec::new();
    let mut counting = false;
    for turn in turns {
        if is_your_words(&turn.message) {
            counting = match from {
                Some(id) => turn.id == id,
                None => !turn.unremembered,
            };
            continue;
        }
        if !counting || turn.message.role != Role::Assistant {
            continue;
        }
        for block in &turn.message.content {
            let Block::ToolUse { id, name, .. } = block else { continue };
            let kept = results.get(id.as_str()).filter(|(_, ok)| *ok && name == "remember").and_then(|(line, _)| remembered_on(line));
            if let Some(note) = kept.filter(|note| !notes.contains(note)) {
                notes.push(note);
            }
        }
    }
    notes
}

fn emit(app: &AppHandle) {
    let state = app.state::<Mutex<Thread>>();
    let view = view(&state.lock().unwrap());
    let _ = app.emit("assistant:thread", &view);
}

fn push(app: &AppHandle, message: Message, spoken: bool) {
    record(app, message, spoken, false);
}

/// Runs `write` on the local database. A failure is logged and the conversation goes on:
/// the thread in memory is what you're talking to.
///
/// Call it while holding the thread's lock: what's saved then changes in the same order
/// as the thread does, so a turn can't be written after the conversation went off the
/// record. The order is always thread lock, then database; nothing takes them the other
/// way round.
fn persist(app: &AppHandle, write: impl FnOnce(&rusqlite::Connection) -> Result<(), String>) {
    if let Err(error) = crate::sqlite::with_open(app, write).and_then(|result| result) {
        tracing::warn!(%error, "assistant: couldn't save the conversation");
    }
}

fn record(app: &AppHandle, message: Message, spoken: bool, failed: bool) {
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        let notes = if is_your_words(&message) { std::mem::take(&mut thread.notes) } else { Vec::new() };
        let id = thread.next_id;
        thread.next_id += 1;
        if thread.conversation.is_empty() {
            thread.conversation = uuid::Uuid::new_v4().to_string();
            thread.first_turn = id;
        }
        let turn = Turn { id, message, at_ms: super::now_ms(), spoken, notes, failed, unremembered: false };
        thread.turns.push(turn.clone());
        if thread.turns.len() > KEPT_MESSAGES {
            let messages: Vec<Message> = thread.turns.iter().map(|turn| turn.message.clone()).collect();
            let keep = window(&messages, KEPT_MESSAGES).len();
            let cut = thread.turns.len() - keep;
            thread.turns.drain(..cut);
        }
        if !thread.off_record {
            let first_kept = thread.turns.first().map_or(id, |first| first.id);
            let position = id.saturating_sub(thread.first_turn);
            persist(app, |conn| super::saved::save_turn(conn, &thread.conversation, &turn, position, first_kept));
        }
    }
    emit(app);
}

/// The security checkup's tools (`security_status`, `security_fix`).
const FEATURES: &[&str] = &["security"];

#[derive(Serialize)]
struct TurnRequest<'a> {
    style: super::style::Style,
    /// Your standing instructions from rules.md, as accepted in Settings. Sent off the
    /// record too: they're settings, not memory.
    instructions: &'a [String],
    /// Eavesy's notes (memory.md and about-you.md); the server sends them as data, not
    /// instructions.
    memory: &'a [String],
    about: &'a [String],
    /// Tools this build has beyond the base set, so the server offers them.
    features: &'static [&'static str],
    messages: &'a [Message],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnResponse {
    content: Vec<Block>,
}

async fn ask(app: &AppHandle, style: super::style::Style, instructions: &[String], notes: &super::memory::ForTurn, messages: &[Message]) -> Result<Vec<Block>, String> {
    let credential = crate::settings::device_credential(app).ok_or("Sign in to Eavesy to talk to it.")?;
    let client = crate::sync::http_client().map_err(|e| e.to_string())?;
    let response = client
        .post(crate::base_url::join(&credential.base, "/api/assistant/turn"))
        .timeout(Duration::from_secs(60))
        .bearer_auth(credential.token)
        .json(&TurnRequest { style, instructions, memory: &notes.memory, about: &notes.about, features: FEATURES, messages })
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("assistant turn not sent: {error}");
            "I can't reach Eavesy's cloud right now.".to_string()
        })?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        tracing::warn!("assistant turn rate limited");
        return Err("That's today's limit for talking to me. It resets at midnight UTC.".into());
    }
    if matches!(response.status(), reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN) {
        tracing::warn!("assistant turn refused: {}", response.status());
        return Err("Eavesy couldn't sign you in. Sign in again from Settings → Account.".into());
    }
    if response.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        tracing::warn!("assistant turn refused: {}", response.status());
        return Err("This conversation got too big for me to send. Press Clear to start fresh.".into());
    }
    if response.status().is_client_error() {
        tracing::warn!("assistant turn refused: {}", response.status());
        return Err("Eavesy's cloud turned that message down. Try again in a moment.".into());
    }
    if !response.status().is_success() {
        tracing::warn!("assistant turn unavailable: {}", response.status());
        return Err("I can't reach my model right now. Try again in a moment.".into());
    }
    let body: TurnResponse = response.json().await.map_err(|error| {
        tracing::warn!("assistant turn unreadable: {error}");
        "I got an answer I couldn't read.".to_string()
    })?;
    // Only text and tool calls come back from the model.
    Ok(body.content.into_iter().filter(|block| matches!(block, Block::Text { .. } | Block::ToolUse { .. })).collect())
}

/// One message from you, then model steps and tool calls until it answers. Blocking.
fn converse(app: &AppHandle, text: String, spoken: bool) {
    push(app, Message { role: Role::User, content: vec![Block::Text { text: text.clone() }] }, spoken);
    let requester = Requester::You { spoken };
    // Read once: every step of one answer talks the same way.
    let style = crate::settings::load(app).assistant_style.unwrap_or_default();
    let instructions = super::rules::instructions(app);
    for step in 0..MAX_STEPS {
        // Read each step, so a note kept a step ago is in the next one. Off the record,
        // none go.
        let notes = if off_record(app) { super::memory::ForTurn::default() } else { super::memory::for_turn(app) };
        let (messages, said_by_you, asked) = {
            let state = app.state::<Mutex<Thread>>();
            let thread = state.lock().unwrap();
            let messages = sent(&thread.turns);
            let yours: Vec<&Turn> = thread.turns.iter().filter(|turn| is_your_words(&turn.message)).collect();
            (window_within(&messages, SENT_MESSAGES, SENT_BYTES).to_vec(), yours.iter().map(|turn| text_of(&turn.message)).collect::<Vec<_>>(), asked_for_notes(&yours))
        };
        let request = newest_chars(&said_by_you[said_by_you.len().saturating_sub(CHECKED_TURNS)..].join("\n"), CHECK_CHARS).to_string();
        let content = match tauri::async_runtime::block_on(ask(app, style, &instructions, &notes, &messages)) {
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
                super::tools::call(app, &name, &input, &requester, &said_by_you, super::tools::Words { request: &request, asked: &asked })
            };
            results.push(Block::ToolResult { tool_use_id: id, content: result.content, is_error: result.is_error });
        }
        push(app, Message { role: Role::User, content: results }, false);
    }
    push(app, Message { role: Role::Assistant, content: vec![Block::Text { text: "That took more steps than I allow myself. Tell me how you'd like to go on.".into() }] }, false);
}

/// Your newest turns as the check sees them for a note or a rule: the same turns as for
/// anything else, less those you marked "Don't remember this".
fn asked_for_notes(yours: &[&Turn]) -> String {
    let recent = &yours[yours.len().saturating_sub(CHECKED_TURNS)..];
    let words: Vec<String> = recent.iter().filter(|turn| !turn.unremembered).map(|turn| text_of(&turn.message)).collect();
    newest_chars(&words.join("\n"), CHECK_CHARS).to_string()
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

/// What a tool call gets for an answer when Eavesy quit before it finished.
const QUIT: &str = "Stopped: Eavesy quit before this finished.";

/// The answers a restored thread still owes: when Eavesy quit between a tool call and its
/// result, the model must not get the call without one.
fn unanswered(turns: &[Turn]) -> Option<Message> {
    let last = turns.last().filter(|turn| turn.message.role == Role::Assistant)?;
    let results: Vec<Block> = last
        .message
        .content
        .iter()
        .filter_map(|block| match block {
            Block::ToolUse { id, .. } => Some(Block::ToolResult { tool_use_id: id.clone(), content: QUIT.into(), is_error: true }),
            _ => None,
        })
        .collect();
    (!results.is_empty()).then_some(Message { role: Role::User, content: results })
}

/// Brings the saved conversation back. Called once from setup, after the database is open.
pub fn restore(app: &AppHandle) {
    let (conversation, first_turn, turns) = match crate::sqlite::with_open(app, super::saved::load).and_then(|result| result) {
        Ok(Some(saved)) if !saved.2.is_empty() => saved,
        Ok(_) => return,
        Err(error) => {
            tracing::warn!(%error, "assistant: couldn't read the saved conversation");
            return;
        }
    };
    let owed = unanswered(&turns);
    {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        // Something was said before the database opened: that conversation stands.
        if !thread.turns.is_empty() {
            return;
        }
        thread.next_id = turns.last().map_or(0, |turn| turn.id + 1);
        thread.turns = turns;
        thread.conversation = conversation;
        thread.first_turn = first_turn;
    }
    if let Some(message) = owed {
        push(app, message, false);
    }
    super::brief::schedule(app);
}

/// One line of the conversation as the brief reads it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Entry {
    /// `you`, `eavesy` or `tool`.
    pub(super) role: &'static str,
    pub(super) text: String,
}

/// The conversation at one moment, for its brief.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub(super) conversation: String,
    /// The newest turn's id and time.
    pub(super) covers: u64,
    pub(super) updated_ms: u64,
    pub(super) entries: Vec<Entry>,
    /// Older turns are gone from the thread, so the entries aren't all of it.
    pub(super) partial: bool,
}

/// The start of `text`, at most `max` characters.
fn first_chars(text: &str, max: usize) -> &str {
    text.char_indices().nth(max).map_or(text, |(end, _)| &text[..end])
}

/// What was said and done, oldest first: your words, Eavesy's, and a line per tool call
/// with the first line of its result. Errors shown in Eavesy's place are left out, and so
/// is an exchange you marked "Don't remember this".
fn entries(turns: &[Turn]) -> Vec<Entry> {
    let results = results(turns);
    let mut entries = Vec::new();
    let mut forgotten = false;
    for turn in turns.iter().filter(|turn| !turn.failed) {
        if is_your_words(&turn.message) {
            forgotten = turn.unremembered;
        }
        if forgotten {
            continue;
        }
        let text = text_of(&turn.message);
        let text = first_chars(text.trim(), ENTRY_CHARS);
        match turn.message.role {
            Role::User if is_your_words(&turn.message) && !text.is_empty() => entries.push(Entry { role: "you", text: text.to_string() }),
            Role::User => {}
            Role::Assistant => {
                if !text.is_empty() {
                    entries.push(Entry { role: "eavesy", text: text.to_string() });
                }
                for block in &turn.message.content {
                    let Block::ToolUse { id, name, .. } = block else { continue };
                    let line = match results.get(id.as_str()) {
                        Some((line, true)) => format!("{name}: {line}"),
                        Some((line, false)) => format!("{name} failed: {line}"),
                        None => name.clone(),
                    };
                    entries.push(Entry { role: "tool", text: first_chars(&line, ENTRY_CHARS).to_string() });
                }
            }
        }
    }
    entries
}

/// The conversation as its brief would read it now, when it may have one: something was
/// said, on the record. With `settled`, only when Eavesy isn't answering and the newest
/// turn is still that one.
fn snapshot_of(thread: &Thread, settled: Option<u64>) -> Option<Snapshot> {
    let last = thread.turns.last()?;
    if thread.off_record || thread.conversation.is_empty() {
        return None;
    }
    if settled.is_some_and(|id| thread.busy || last.id != id) {
        return None;
    }
    let entries = entries(&thread.turns);
    if !entries.iter().any(|entry| entry.role == "you") {
        return None;
    }
    Some(Snapshot { conversation: thread.conversation.clone(), covers: last.id, updated_ms: last.at_ms, entries, partial: thread.turns.first().is_some_and(|turn| turn.id != thread.first_turn) })
}

/// The conversation for its brief, if it has been quiet since turn `since`. The caller
/// writes the brief and then calls `done_briefing`.
pub(super) fn quiet_snapshot(app: &AppHandle, since: u64) -> Option<Snapshot> {
    let state = app.state::<Mutex<Thread>>();
    let mut thread = state.lock().unwrap();
    let snapshot = snapshot_of(&thread, Some(since))?;
    thread.briefing.push(snapshot.conversation.clone());
    Some(snapshot)
}

/// The brief of `conversation` is no longer being written, whether or not one was
/// stored. This only takes it off the list Forget All reads; it doesn't mark anything
/// as done, so the next answer, Clear or restart asks for a brief again.
pub(super) fn done_briefing(app: &AppHandle, conversation: &str) {
    let state = app.state::<Mutex<Thread>>();
    let mut thread = state.lock().unwrap();
    if let Some(at) = thread.briefing.iter().position(|id| id == conversation) {
        thread.briefing.swap_remove(at);
    }
}

/// Stores a brief written from `snapshot`, unless the thread no longer agrees with it.
/// The check and the write happen under the thread's lock, so "Don't remember this"
/// lands either before the check or after the brief is in, where it removes it.
///
/// `store` runs only while the snapshot still stands, with the thread locked, so it is
/// also how brief.rs asks "may this still be sent?" before each request.
pub(super) fn store_brief(app: &AppHandle, snapshot: &Snapshot, store: impl FnOnce(&rusqlite::Connection) -> Result<bool, String>) -> Result<bool, String> {
    let state = app.state::<Mutex<Thread>>();
    let thread = state.lock().unwrap();
    if !stands_in(&thread, snapshot) {
        return Ok(false);
    }
    crate::sqlite::with_open(app, store).and_then(|result| result)
}

/// Forgets every brief: the stored ones, the open conversation's, and any still being
/// written. How many stored ones went.
pub(super) fn forget_briefs(app: &AppHandle) -> Result<usize, String> {
    let state = app.state::<Mutex<Thread>>();
    let thread = state.lock().unwrap();
    let open: Vec<&str> = thread.briefing.iter().map(String::as_str).chain((!thread.conversation.is_empty()).then_some(thread.conversation.as_str())).collect();
    crate::sqlite::with_open(app, |conn| super::saved::forget_briefs(conn, super::saved::CONVERSATION, &open)).and_then(|result| result)
}

/// Whether a brief written from `snapshot` is still true to the thread: false once an
/// exchange it read was marked "Don't remember this" while the brief was being written.
/// A conversation that has since been cleared has nothing left to disagree with.
fn stands_in(thread: &Thread, snapshot: &Snapshot) -> bool {
    thread.conversation != snapshot.conversation || entries(&thread.turns).starts_with(&snapshot.entries)
}

/// The newest turn's id.
pub(super) fn newest(app: &AppHandle) -> Option<u64> {
    app.state::<Mutex<Thread>>().lock().unwrap().turns.last().map(|turn| turn.id)
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
    {
        let _done = Done(app);
        converse(app, text, spoken);
    }
    super::brief::schedule(app);
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
        if !thread.off_record {
            persist(app, |conn| super::saved::set_spoken(conn, &thread.conversation, id));
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

pub fn off_record(app: &AppHandle) -> bool {
    app.state::<Mutex<Thread>>().lock().unwrap().off_record
}

/// Takes this conversation off the record. It stays off until it's cleared, so nothing
/// said off the record is ever sent with memory or kept; before you've said anything,
/// you can change your mind.
#[tauri::command]
pub fn set_assistant_off_record(app: AppHandle, window: WebviewWindow, on: bool) -> Result<(), String> {
    super::from_ui(&window)?;
    let went_off = {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        if !on && thread.off_record && !thread.turns.is_empty() {
            return Err("Clear the conversation to go back on the record.".into());
        }
        let going_off = on && !thread.off_record;
        thread.off_record = on;
        if going_off {
            // What was saved of it goes, and so does its brief: the whole conversation
            // is off the record, not only what comes next.
            let conversation = std::mem::take(&mut thread.conversation);
            persist(&app, |conn| {
                super::saved::clear_turns(conn)?;
                if !conversation.is_empty() {
                    super::saved::forget_brief(conn, super::saved::CONVERSATION, &conversation)?;
                }
                Ok(())
            });
        }
        going_off
    };
    if went_off {
        super::brief::changed(&app);
    }
    emit(&app);
    Ok(())
}

/// What Clear says when the notes it would forget changed while you were deciding.
const CHANGED: &str = "The conversation changed. Look again.";

/// A note this conversation taught Eavesy, still in its file.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Taught {
    pub note: String,
    pub book: super::memory::Book,
}

/// Of `notes`, the ones still in their files: a note merged or removed since is gone.
fn still_kept(notes: Vec<(String, super::memory::Book)>) -> Vec<Taught> {
    use super::memory::{kept, Book};
    let (setup, about) = (kept(Book::Setup), kept(Book::You));
    notes
        .into_iter()
        .filter(|(note, book)| match book { Book::Setup => &setup, Book::You => &about }.iter().any(|kept| kept.eq_ignore_ascii_case(note)))
        .map(|(note, book)| Taught { note, book })
        .collect()
}

/// What Clear would offer to forget.
#[tauri::command(async)]
pub fn assistant_taught(app: AppHandle, window: WebviewWindow) -> Result<Vec<Taught>, String> {
    super::from_ui(&window)?;
    let notes = taught(&app.state::<Mutex<Thread>>().lock().unwrap().turns, None);
    Ok(still_kept(notes))
}

/// Forgets these notes, each in its own file. How many went, and how many were already
/// gone (merged or removed since).
fn forget_taught(notes: &[(String, super::memory::Book)]) -> (usize, usize) {
    let mut forgot = 0;
    for (note, book) in notes {
        match book.path().map(|file| super::memory::forget(&file, note)) {
            Some(Ok(true)) => {
                forgot += 1;
                super::log("You", "assistant.forget", note, "ran", Some("with its conversation".into()));
            }
            Some(Err(error)) => tracing::warn!(%error, "assistant: couldn't forget a note"),
            _ => {}
        }
    }
    (forgot, notes.len() - forgot)
}

fn forgot_line(forgot: usize, gone: usize) -> String {
    let notes = |n: usize| if n == 1 { "1 note".to_string() } else { format!("{n} notes") };
    match (forgot, gone) {
        (0, 0) => "Nothing from that was kept.".into(),
        (n, 0) => format!("Forgot {}.", notes(n)),
        (0, _) => "Its notes were already merged or removed. Settings shows what's kept.".into(),
        (n, g) => format!("Forgot {}. {} had already been merged or removed; Settings shows what's kept.", notes(n), notes(g)),
    }
}

/// "Don't remember this" on one of your turns (H3): forgets the notes Eavesy kept while
/// answering it, and leaves its words out when a later note or rule is checked. Not
/// while Eavesy is answering, so nothing can be kept from it after this.
#[tauri::command(async)]
pub fn assistant_dont_remember(app: AppHandle, window: WebviewWindow, id: u64) -> Result<String, String> {
    super::from_ui(&window)?;
    let notes = {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        if thread.busy {
            return Err("Eavesy is still answering.".into());
        }
        let turn = thread.turns.iter_mut().find(|turn| turn.id == id && is_your_words(&turn.message)).ok_or("That message is gone.")?;
        if turn.unremembered {
            return Ok(forgot_line(0, 0));
        }
        turn.unremembered = true;
        let saved = !thread.off_record;
        if saved {
            // Its brief may say what you just asked Eavesy not to remember: it goes, and
            // is written again without that exchange once the conversation is quiet.
            persist(&app, |conn| {
                super::saved::set_unremembered(conn, &thread.conversation, id)?;
                super::saved::drop_brief(conn, super::saved::CONVERSATION, &thread.conversation)
            });
        }
        (taught(&thread.turns, Some(id)), saved)
    };
    let (notes, saved) = notes;
    if saved {
        super::brief::changed(&app);
        super::brief::schedule(&app);
    }
    let (forgot, gone) = forget_taught(&notes);
    emit(&app);
    Ok(forgot_line(forgot, gone))
}

/// Clears the conversation. Its brief stays, written now if what was said since the last
/// one would change it. With `forget`, the brief goes, and so do the notes it taught
/// Eavesy, worked out here from the thread, never taken from the UI. `expected` is how many you were shown:
/// if that changed since, nothing is cleared, so you never forget notes you didn't see.
#[tauri::command(async)]
pub fn assistant_clear(app: AppHandle, window: WebviewWindow, forget: Option<bool>, expected: Option<usize>) -> Result<String, String> {
    super::from_ui(&window)?;
    let notes = {
        let state = app.state::<Mutex<Thread>>();
        let mut thread = state.lock().unwrap();
        if thread.busy {
            return Err("Eavesy is still answering.".into());
        }
        let notes = if forget == Some(true) { taught(&thread.turns, None) } else { Vec::new() };
        if forget == Some(true) && expected.is_some_and(|shown| still_kept(notes.clone()).len() != shown) {
            return Err(CHANGED.into());
        }
        let last_words = if forget == Some(true) { None } else { snapshot_of(&thread, None) };
        if let Some(snapshot) = &last_words {
            thread.briefing.push(snapshot.conversation.clone());
        }
        let conversation = std::mem::take(&mut thread.conversation);
        thread.turns.clear();
        thread.notes.clear();
        // A new conversation is on the record again.
        thread.off_record = false;
        persist(&app, |conn| {
            super::saved::clear_turns(conn)?;
            if forget == Some(true) && !conversation.is_empty() {
                super::saved::forget_brief(conn, super::saved::CONVERSATION, &conversation)?;
            }
            Ok(())
        });
        (notes, last_words)
    };
    let (notes, last_words) = notes;
    match last_words {
        Some(snapshot) => super::brief::write_soon(&app, snapshot),
        None => super::brief::changed(&app),
    }
    emit(&app);
    if notes.is_empty() {
        return Ok(String::new());
    }
    let (forgot, gone) = forget_taught(&notes);
    Ok(forgot_line(forgot, gone))
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
        let turns = [said("anyone waiting?"), call("t1"), result("t1")].into_iter().map(|message| Turn { id: 0, message, at_ms: 1, spoken: false, notes: Vec::new(), failed: false, unremembered: false }).collect();
        let view = view(&Thread { turns, next_id: 3, busy: true, notes: Vec::new(), off_record: false, ..Thread::default() });
        assert!(view.busy);
        assert_eq!(view.turns.len(), 2);
        assert_eq!(view.turns[0].who, "you");
        assert_eq!(view.turns[1].steps, vec![Step { tool: "agent_sessions".into(), line: Some("3 sessions".into()), ok: true, remembered: None, book: None }]);
    }

    #[test]
    fn a_kept_note_offers_undo_with_the_note_as_kept() {
        let remember = Message { role: Role::Assistant, content: vec![Block::ToolUse { id: "r".into(), name: "remember".into(), input: serde_json::json!({ "note": "prefers bun" }) }] };
        let kept = Message { role: Role::User, content: vec![Block::ToolResult { tool_use_id: "r".into(), content: "Remembered: Prefers Bun".into(), is_error: false }] };
        let refused = Message { role: Role::Assistant, content: vec![Block::ToolUse { id: "s".into(), name: "remember".into(), input: serde_json::json!({ "note": "x" }) }] };
        let no = Message { role: Role::User, content: vec![Block::ToolResult { tool_use_id: "s".into(), content: "I only keep notes you ask me to keep.".into(), is_error: true }] };
        let turns = [said("remember I use bun"), remember, kept, refused, no].into_iter().map(|message| Turn { id: 0, message, at_ms: 1, spoken: false, notes: Vec::new(), failed: false, unremembered: false }).collect();
        let view = view(&Thread { turns, next_id: 5, busy: false, notes: Vec::new(), off_record: false, ..Thread::default() });
        assert_eq!(view.turns[1].steps[0].remembered.as_deref(), Some("Prefers Bun"));
        assert_eq!(view.turns[1].steps[0].book, Some(super::super::memory::Book::Setup));
        assert_eq!(view.turns[2].steps[0].remembered, None);
        assert_eq!(remembered_on("Remembered about you: Lives in Leeds"), Some(("Lives in Leeds".into(), super::super::memory::Book::You)));
        assert_eq!(remembered_on("Couldn't remember that: full"), None);
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
            Turn { id: 1, message: said("anyone waiting?"), at_ms: 1, spoken: false, notes: Vec::new(), failed: false, unremembered: false },
            Turn { id: 2, message: error, at_ms: 2, spoken: false, notes: Vec::new(), failed: true, unremembered: false },
            Turn { id: 3, message: said("try again"), at_ms: 3, spoken: false, notes: Vec::new(), failed: false, unremembered: false },
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
            Turn { id: 1, message: said("anyone waiting?"), at_ms: 1, spoken: false, notes: Vec::new(), failed: false, unremembered: false },
            Turn { id: 2, message: error, at_ms: 2, spoken: false, notes: Vec::new(), failed: true, unremembered: false },
        ];
        let reply = newest_reply(&turns).unwrap();
        assert_eq!((reply.id, reply.failed), (2, true));
        assert!(newest_reply(&turns[..1]).is_none());
    }

    #[test]
    fn notes_go_to_the_model_but_are_not_your_words() {
        let turn = Turn { id: 0, message: said("and the other one?"), at_ms: 1, spoken: false, notes: vec!["card accepted: 2 of 2 done".into(), "card declined".into()], failed: false, unremembered: false };
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

    fn turn(id: u64, message: Message) -> Turn { Turn { id, message, at_ms: 1, spoken: false, notes: Vec::new(), failed: false, unremembered: false } }

    /// Eavesy calling `remember`, and its result's first line.
    fn kept(id: &str, line: &str) -> [Message; 2] {
        [
            Message { role: Role::Assistant, content: vec![Block::ToolUse { id: id.into(), name: "remember".into(), input: serde_json::json!({ "note": "x" }) }] },
            Message { role: Role::User, content: vec![Block::ToolResult { tool_use_id: id.into(), content: line.into(), is_error: false }] },
        ]
    }

    fn conversation() -> Vec<Turn> {
        use std::iter::once;
        let messages: Vec<Message> = once(said("I use bun"))
            .chain(kept("a", "Remembered: Uses bun"))
            .chain(kept("b", "Already remembered: Prefers tea"))
            .chain(once(said("I live in Leeds")))
            .chain(kept("c", "Remembered about you: Lives in Leeds"))
            .chain(once(said("thanks")))
            .collect();
        messages.into_iter().enumerate().map(|(id, message)| turn(id as u64, message)).collect()
    }

    #[test]
    fn a_conversation_taught_only_the_notes_it_added() {
        use super::super::memory::Book;
        let turns = conversation();
        // "Already remembered" was there before: never this conversation's to forget.
        assert_eq!(taught(&turns, None), vec![("Uses bun".to_string(), Book::Setup), ("Lives in Leeds".to_string(), Book::You)]);
        // From one turn: only what was kept answering it.
        assert_eq!(taught(&turns, Some(0)), vec![("Uses bun".to_string(), Book::Setup)]);
        assert_eq!(taught(&turns, Some(5)), vec![("Lives in Leeds".to_string(), Book::You)]);
        assert!(taught(&turns, Some(9)).is_empty());
        // A failed remember taught nothing.
        let mut failed = conversation();
        if let Block::ToolResult { is_error, .. } = &mut failed[2].message.content[0] {
            *is_error = true;
        }
        assert_eq!(taught(&failed, Some(0)), vec![]);
    }

    #[test]
    fn dont_remember_hides_undo_and_leaves_its_words_out_of_the_note_check() {
        let mut turns = conversation();
        turns[0].unremembered = true;
        // Already forgotten: Clear doesn't count it again.
        assert_eq!(taught(&turns, None).len(), 1);
        let view = view(&Thread { turns, next_id: 9, busy: false, notes: Vec::new(), off_record: false, ..Thread::default() });
        assert!(view.turns[0].unremembered);
        assert_eq!(view.turns[1].steps[0].remembered, None);
        assert_eq!(view.turns[4].steps[0].remembered.as_deref(), Some("Lives in Leeds"));
        let mut turns = conversation();
        turns[5].unremembered = true;
        let yours: Vec<&Turn> = turns.iter().filter(|turn| is_your_words(&turn.message)).collect();
        assert_eq!(asked_for_notes(&yours), "I use bun\nthanks");
    }

    #[test]
    fn a_call_cut_off_by_quitting_gets_an_answer() {
        let [call, result] = kept("t1", "Remembered: Uses bun");
        let turns = vec![turn(0, said("remember I use bun")), turn(1, call)];
        let owed = unanswered(&turns).unwrap();
        assert_eq!(owed.content, vec![Block::ToolResult { tool_use_id: "t1".into(), content: QUIT.into(), is_error: true }]);
        let mut answered = turns.clone();
        answered.push(turn(2, result));
        assert_eq!(unanswered(&answered), None);
        assert_eq!(unanswered(&[turn(0, said("hello"))]), None);
        assert_eq!(unanswered(&[]), None);
    }

    #[test]
    fn the_brief_reads_words_and_tool_lines_but_no_errors() {
        let [call, result] = kept("t1", "Remembered: Uses bun");
        let mut error = turn(3, Message { role: Role::Assistant, content: vec![Block::Text { text: "I can't reach Eavesy's cloud right now.".into() }] });
        error.failed = true;
        let turns = vec![turn(0, said("remember I use bun")), turn(1, call), turn(2, result), error];
        let lines: Vec<(&str, String)> = entries(&turns).into_iter().map(|entry| (entry.role, entry.text)).collect();
        assert_eq!(lines, vec![("you", "remember I use bun".to_string()), ("tool", "remember: Remembered: Uses bun".to_string())]);
        let mut unremembered = turns.clone();
        unremembered[0].unremembered = true;
        unremembered.push(turn(4, said("what time is it")));
        assert_eq!(entries(&unremembered), vec![Entry { role: "you", text: "what time is it".into() }]);
        assert_eq!(first_chars("héllo", 2), "hé");
        assert_eq!(first_chars("hi", 5), "hi");
    }

    #[test]
    fn a_conversation_is_briefed_only_on_the_record_and_once_quiet() {
        let mut thread = Thread { turns: vec![turn(4, said("hello")), turn(5, Message { role: Role::Assistant, content: vec![Block::Text { text: "hi".into() }] })], conversation: "c1".into(), ..Thread::default() };
        let snapshot = snapshot_of(&thread, Some(5)).unwrap();
        assert_eq!((snapshot.conversation.as_str(), snapshot.covers, snapshot.entries.len()), ("c1", 5, 2));
        assert!(snapshot.partial, "turns before 4 are gone");
        thread.first_turn = 4;
        assert!(!snapshot_of(&thread, Some(5)).unwrap().partial, "it began at 4, after a Clear");
        assert_eq!(snapshot_of(&thread, Some(3)), None, "something was said since");
        thread.busy = true;
        assert_eq!(snapshot_of(&thread, Some(5)), None);
        assert!(snapshot_of(&thread, None).is_some(), "Clear takes it as it stands");
        thread.busy = false;
        thread.off_record = true;
        assert_eq!(snapshot_of(&thread, None), None);
        assert_eq!(snapshot_of(&Thread::default(), None), None);
    }

    #[test]
    fn a_brief_of_words_since_unremembered_does_not_stand() {
        let reply = |text: &str| Message { role: Role::Assistant, content: vec![Block::Text { text: text.into() }] };
        let mut thread = Thread { turns: vec![turn(0, said("my door code is 1234")), turn(1, reply("Noted."))], conversation: "c1".into(), ..Thread::default() };
        let snapshot = snapshot_of(&thread, None).unwrap();
        thread.turns.push(turn(2, said("thanks")));
        assert!(stands_in(&thread, &snapshot), "more was said, nothing was taken back");
        thread.turns[0].unremembered = true;
        assert!(!stands_in(&thread, &snapshot));
        thread.conversation = "c2".into();
        assert!(stands_in(&thread, &snapshot), "cleared: the brief is all that's left of it");
    }

    #[test]
    fn the_forget_line_says_what_happened() {
        assert_eq!(forgot_line(0, 0), "Nothing from that was kept.");
        assert_eq!(forgot_line(1, 0), "Forgot 1 note.");
        assert_eq!(forgot_line(2, 1), "Forgot 2 notes. 1 note had already been merged or removed; Settings shows what's kept.");
        assert!(forgot_line(0, 2).starts_with("Its notes were already"));
    }
}
