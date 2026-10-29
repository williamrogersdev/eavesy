//! What a Claude Code hook and the app say to each other over the agents
//! socket: one JSON line from the hook, one line back saying whether it holds,
//! and, for a held stop, one more line with the reply or a release.

use serde::{Deserialize, Serialize};

pub const VERSION: u8 = 1;
/// A hook message is a hook's stdin plus a few fields; Claude's final message
/// can be long, so allow a megabyte and cut the text down after parsing.
pub const MAX_LINE: usize = 1024 * 1024;
/// The app keeps the end of Claude's message: that's where its question is.
pub const MAX_MESSAGE_CHARS: usize = 12_000;
pub const MAX_PROMPT_CHARS: usize = 4_000;
/// Your reply to a session; far below `MAX_LINE`, so the hook can always read it.
pub const MAX_REPLY_CHARS: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    /// Claude finished a turn (`Stop`).
    Stop,
    /// Claude needs an approval or is idle (`Notification`).
    Notification,
    /// You sent Claude a prompt (`UserPromptSubmit`).
    Prompt,
    /// A tool finished (`PostToolUse`), so an approval it waited on was given.
    ToolDone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookMessage {
    pub v: u8,
    pub event: Event,
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    /// `last_assistant_message` for a stop, the notification text for a notification.
    #[serde(default)]
    pub message: Option<String>,
    /// The prompt, for a prompt event.
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub notification_type: Option<String>,
    /// Someone is at this session: interactive in a terminal or the desktop
    /// app, not `claude -p` or an SDK run. Only an attended stop is ever held.
    #[serde(default)]
    pub attended: bool,
    /// The desktop app's own id for the session, when it runs there.
    #[serde(default)]
    pub host_session_id: Option<String>,
    /// The app the session runs in (its bundle id, from `__CFBundleIdentifier`
    /// or `TERM_PROGRAM`), so the card can name it and bring it to the front.
    #[serde(default)]
    pub host_app: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Answer {
    /// First line: whether the hook should wait for a reply.
    Ack { hold: bool },
    /// A reply you confirmed: the hook hands it to Claude.
    Reply { text: String },
    /// Stop waiting and let the turn end.
    Release,
}

/// What the hook prints for Claude Code when you replied: Claude keeps going in
/// the same session with your reply as its next input.
pub fn block_output(reply: &str) -> String {
    serde_json::json!({
        "decision": "block",
        "reason": format!("The user replied through Eavesy: {reply}"),
    })
    .to_string()
}

/// Whether the hook reports someone is at the session. Claude Code sets
/// `CLAUDE_CODE_SESSION_ATTENDED` to `0` for `claude -p` and SDK runs and to `1`
/// in the desktop app. Unset counts as attended only from a plain terminal
/// `claude`, whose entrypoint is `cli`.
pub fn attended(session_attended: Option<&str>, entrypoint: Option<&str>) -> bool {
    match session_attended.map(str::trim) {
        Some("1") | Some("true") => true,
        Some(_) => false,
        None => entrypoint.map(str::trim) == Some("cli"),
    }
}

/// The last `max` characters of `text`, on a character boundary.
pub fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max)).collect()
}

/// The first `max` characters of `text`.
pub fn head(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_present_person_counts_as_attended() {
        assert!(attended(Some("1"), Some("claude-desktop")));
        assert!(!attended(Some("0"), Some("claude-desktop")));
        assert!(!attended(Some("0"), Some("cli")));
        assert!(attended(None, Some("cli")));
        assert!(!attended(None, Some("sdk-cli")));
        assert!(!attended(None, None));
    }

    #[test]
    fn a_reply_becomes_a_block_decision() {
        let out: serde_json::Value = serde_json::from_str(&block_output("ship it")).unwrap();
        assert_eq!(out["decision"], "block");
        assert_eq!(out["reason"], "The user replied through Eavesy: ship it");
    }

    #[test]
    fn long_messages_keep_their_end() {
        let text = format!("{}Should I ship it?", "x".repeat(50));
        assert_eq!(tail(&text, 17), "Should I ship it?");
        assert_eq!(tail("héllo", 10), "héllo");
        assert_eq!(head("héllo", 2), "hé");
    }

    #[test]
    fn answers_are_tagged_lines() {
        assert_eq!(serde_json::to_string(&Answer::Ack { hold: true }).unwrap(), r#"{"ack":{"hold":true}}"#);
        assert_eq!(serde_json::to_string(&Answer::Release).unwrap(), r#""release""#);
    }
}
