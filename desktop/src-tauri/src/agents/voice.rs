//! Answering the reply card by voice (docs/plans/voice-conversation.md, piece
//! 3b step 4). Right after Eavesy reads out a session's question, your next
//! dictation is an answer to the card rather than words for the app you're in.
//!
//! What you said is matched against a small fixed set of commands, whole
//! utterance only; anything else is a new draft that's read back first.
//! Nothing is sent without "send it" (or a click), and approvals never get
//! here: only a Question opens the window.

use std::time::{Duration, Instant};

use super::queue::{Item, Kind};

/// How long after Eavesy stops talking a dictation still answers the card.
pub const ANSWER_WINDOW: Duration = Duration::from_secs(30);
/// A bare "yes" sends only this soon after "Send that?": later, it may be
/// you talking to someone else, so it's read back instead.
pub const YES_WINDOW: Duration = Duration::from_secs(8);

/// A dictation that answers the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Claim {
    pub item: u64,
    /// Started within [`YES_WINDOW`] of a line heard to its end, so its
    /// "Send that?" was heard.
    pub prompt: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// "Send it" and its like.
    Send,
    /// A bare "yes": it sends only in answer to "Send that?".
    Yes,
    No,
    Later,
    Dismiss,
    /// Not a command: the words are your reply.
    Reply,
}

/// What to do with a spoken answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Send(String),
    Later,
    Dismiss,
    /// Nothing is sent; what's on the card stays there.
    Decline,
    /// "Send it" with nothing offered: there's nothing to send.
    NothingToSend,
    /// Put this on the card and read it back, asking to send it.
    ReadBack(String),
}

const SEND: &[&str] = &[
    "send",
    "send it",
    "send that",
    "send this",
    "send it off",
    "send the reply",
    "send the suggestion",
    "go ahead",
    "go ahead and send it",
    "go ahead and send that",
];
/// Only answers "Send that?", so alone they send what was just read out.
const YES: &[&str] = &["yes", "yeah", "yep", "yup", "sure", "ok", "okay", "correct", "sounds good", "thats right", "perfect"];
const NO: &[&str] = &["no", "nope", "cancel", "dont send it", "dont send that", "dont send", "do not send it", "no dont send it", "no dont send that"];
const LATER: &[&str] = &["later", "not now", "ask me later", "remind me later", "come back later", "skip", "skip it", "maybe later"];
const DISMISS: &[&str] = &["dismiss", "dismiss it", "dismiss that", "let it stop", "ignore it", "ignore that", "never mind", "nevermind", "forget it"];
/// Said around a command without changing it.
const LEAD: &[&str] = &["um", "uh", "hmm", "so", "oh", "ah"];
const TAIL: &[&str] = &["please", "thanks", "thank you"];

/// Lowercase words with punctuation gone ("Yes, send that!" → "yes send that").
fn normalize(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| *c != '\'' && *c != '’')
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { ' ' })
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip<'a>(mut text: &'a str, lead: &[&str], tail: &[&str]) -> &'a str {
    loop {
        let before = text;
        for word in lead {
            if let Some(rest) = text.strip_prefix(word).and_then(|rest| rest.strip_prefix(' ')) {
                text = rest;
            }
        }
        for word in tail {
            if let Some(rest) = text.strip_suffix(word).and_then(|rest| rest.strip_suffix(' ')) {
                text = rest;
            }
        }
        if text == before {
            return text;
        }
    }
}

/// Which command the whole of `text` is. Anything with more in it than a
/// command ("send it to staging", "no, put it behind a flag") is a reply.
pub fn parse(text: &str) -> Command {
    let normalized = normalize(text);
    let core = strip(&normalized, LEAD, TAIL);
    let is = |set: &[&str]| set.contains(&core);
    if is(SEND) {
        return Command::Send;
    }
    if is(YES) {
        return Command::Yes;
    }
    // "yes, send that", "okay send it".
    if YES.iter().any(|yes| core.strip_prefix(yes).and_then(|rest| rest.strip_prefix(' ')).is_some_and(|rest| SEND.contains(&rest))) {
        return Command::Send;
    }
    if is(NO) {
        Command::No
    } else if is(LATER) {
        Command::Later
    } else if is(DISMISS) {
        Command::Dismiss
    } else {
        Command::Reply
    }
}

/// What `heard` does given `offered`: the reply Eavesy last asked "Send
/// that?" about (a draft read back, else the suggestion), or None once you
/// said no to it. "Send it" sends only what's offered; with nothing offered,
/// a "yes" or "no" is your reply and is read back too. A bare "yes" sends
/// only when `prompt` (see [`Claim`]); otherwise it's read back.
pub fn step(offered: Option<&str>, heard: &str, prompt: bool) -> Step {
    let offered = offered.map(str::trim).filter(|text| !text.is_empty());
    let heard = heard.trim();
    match (parse(heard), offered) {
        (Command::Send, Some(text)) => Step::Send(text.to_string()),
        (Command::Yes, Some(text)) if prompt => Step::Send(text.to_string()),
        // A late "yes": ask again about the same reply.
        (Command::Yes, Some(text)) => Step::ReadBack(text.to_string()),
        (Command::Send, None) => Step::NothingToSend,
        (Command::No, Some(_)) => Step::Decline,
        (Command::Later, _) => Step::Later,
        (Command::Dismiss, _) => Step::Dismiss,
        _ => Step::ReadBack(heard.to_string()),
    }
}

/// How much of a draft is read back; `speak` cuts long lines, and the
/// question at the end must always be heard.
const READ_BACK_CHARS: usize = 300;

/// What Eavesy says back after a new draft.
pub fn read_back(draft: &str) -> String {
    let draft = draft.trim().trim_end_matches('.');
    if draft.chars().count() <= READ_BACK_CHARS {
        return format!("I'll send: {draft}. Send that?");
    }
    let start: String = draft.chars().take(READ_BACK_CHARS).collect();
    format!("I'll send: {start}… and the rest, on the card. Send that?")
}

/// Whether a dictation starting `now` answers `head`, the card's front item:
/// it's a question you haven't started typing into, Eavesy's last words were
/// about it, and it's still talking or stopped within [`ANSWER_WINDOW`].
/// `quiet_since` is when it stopped, and whether the line played to its end.
pub fn answers(head: Option<&Item>, last_said: Option<u64>, speaking: bool, quiet_since: Option<(Instant, bool)>, now: Instant) -> Option<Claim> {
    let head = head?;
    if head.kind != Kind::Question || head.typing || last_said != Some(head.id) {
        return None;
    }
    let since = |window: Duration| quiet_since.filter(|(at, _)| now.saturating_duration_since(*at) <= window);
    let recent = speaking || since(ANSWER_WINDOW).is_some();
    let prompt = !speaking && since(YES_WINDOW).is_some_and(|(_, heard)| heard);
    recent.then_some(Claim { item: head.id, prompt })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::queue::Queue;

    #[test]
    fn send_phrases_match_whole_utterances_only() {
        for said in ["Send it.", "yes, send that", "Yes send that!", "okay send it please", "Um, send it", "Yeah.", "go ahead", "Send it, thanks"] {
            assert!(matches!(parse(said), Command::Send | Command::Yes), "{said}");
        }
        assert_eq!(parse("Yeah."), Command::Yes);
        assert_eq!(parse("yes, send that"), Command::Send);
        for said in ["send it to staging", "yes but also fix the tests", "send that and open a PR", "sending it later", "yes please, and run the tests"] {
            assert_eq!(parse(said), Command::Reply, "{said}");
        }
    }

    #[test]
    fn later_dismiss_and_no_are_commands_only_alone() {
        assert_eq!(parse("Later."), Command::Later);
        assert_eq!(parse("not now"), Command::Later);
        assert_eq!(parse("Dismiss"), Command::Dismiss);
        assert_eq!(parse("let it stop"), Command::Dismiss);
        assert_eq!(parse("No."), Command::No);
        assert_eq!(parse("don't send it"), Command::No);
        for said in ["later, also fix the tests", "dismiss the warning and continue", "no, put it behind a flag", "stop the server first", "wait", "stop"] {
            assert_eq!(parse(said), Command::Reply, "{said}");
        }
    }

    #[test]
    fn send_it_sends_what_was_last_offered() {
        assert_eq!(step(Some("No flag."), "send it", true), Step::Send("No flag.".into()));
        assert_eq!(step(Some("Put it behind a flag"), "yes", true), Step::Send("Put it behind a flag".into()));
    }

    #[test]
    fn a_late_bare_yes_is_read_back_but_send_it_still_sends() {
        // Asked again about the same reply, never replaced by the word "sure".
        assert_eq!(step(Some("No flag."), "sure", false), Step::ReadBack("No flag.".into()));
        assert_eq!(step(Some("No flag."), "send it", false), Step::Send("No flag.".into()));
        assert_eq!(step(Some("No flag."), "okay, send it", false), Step::Send("No flag.".into()));
    }

    #[test]
    fn send_it_with_nothing_offered_never_becomes_a_draft() {
        assert_eq!(step(None, "send it", true), Step::NothingToSend);
        assert_eq!(step(Some("   "), "Yes, send that.", true), Step::NothingToSend);
    }

    #[test]
    fn anything_else_is_read_back_and_never_sent() {
        assert_eq!(step(Some("No flag."), "no, put it behind a flag", true), Step::ReadBack("no, put it behind a flag".into()));
        assert_eq!(step(Some("Put it behind a flag"), "actually ship it", true), Step::ReadBack("actually ship it".into()));
        // With nothing offered, "yes" and "no" are the reply itself.
        assert_eq!(step(None, "Yes.", true), Step::ReadBack("Yes.".into()));
        assert_eq!(step(Some("  "), "no", true), Step::ReadBack("no".into()));
    }

    #[test]
    fn no_declines_and_later_and_dismiss_do_what_the_buttons_do() {
        assert_eq!(step(Some("No flag."), "no", true), Step::Decline);
        assert_eq!(step(Some("Flag it"), "cancel", true), Step::Decline);
        assert_eq!(step(Some("No flag."), "later", true), Step::Later);
        assert_eq!(step(None, "dismiss", true), Step::Dismiss);
    }

    #[test]
    fn a_full_conversation_sends_only_after_yes() {
        let Step::ReadBack(draft) = step(Some("No flag. Ship it."), "Put it behind a flag.", true) else { panic!("should read back") };
        assert_eq!(read_back(&draft), "I'll send: Put it behind a flag. Send that?");
        assert_eq!(step(Some(&draft), "no", true), Step::Decline);
        // Once declined nothing is offered: "send it" sends nothing, "yes" is read back.
        assert_eq!(step(None, "send it", true), Step::NothingToSend);
        assert_eq!(step(None, "yes", true), Step::ReadBack("yes".into()));
        assert_eq!(step(Some(&draft), "yes, send that", true), Step::Send("Put it behind a flag.".into()));
    }

    #[test]
    fn a_long_read_back_still_ends_with_the_question() {
        let line = read_back(&"word ".repeat(200));
        assert!(line.ends_with("on the card. Send that?"), "{line}");
        assert!(line.chars().count() < 400);
    }

    fn question(queue: &mut Queue, kind: Kind) -> Item {
        let (id, _) = queue.push("s", "eavesy".into(), Kind::Finished, None, true, 1);
        queue.resolve(id, "wants to know".into(), Some("yes".into()), kind == Kind::Question);
        if kind == Kind::Approval {
            let (id, _) = queue.push("s", "eavesy".into(), Kind::Approval, None, false, 2);
            queue.resolve(id, "needs approval".into(), None, true);
            return queue.get(id).unwrap().clone();
        }
        queue.get(id).unwrap().clone()
    }

    #[test]
    fn only_a_question_just_said_takes_the_dictation() {
        let now = Instant::now();
        let mut queue = Queue::default();
        let item = question(&mut queue, Kind::Question);
        let claim = |prompt| Some(Claim { item: item.id, prompt });
        let heard = Some((now, true));
        // Over the line, "Send that?" wasn't heard yet: only "send it" sends.
        assert_eq!(answers(Some(&item), Some(item.id), true, None, now), claim(false));
        assert_eq!(answers(Some(&item), Some(item.id), false, heard, now + YES_WINDOW), claim(true));
        assert_eq!(answers(Some(&item), Some(item.id), false, Some((now, false)), now), claim(false), "cut off before the question");
        assert_eq!(answers(Some(&item), Some(item.id), false, heard, now + YES_WINDOW + Duration::from_secs(1)), claim(false));
        assert_eq!(answers(Some(&item), Some(item.id), false, heard, now + ANSWER_WINDOW), claim(false));
        assert_eq!(answers(Some(&item), Some(item.id), false, heard, now + ANSWER_WINDOW + Duration::from_secs(1)), None);
        assert_eq!(answers(Some(&item), Some(item.id), false, None, now), None, "never said");
        assert_eq!(answers(Some(&item), Some(item.id + 1), true, None, now), None, "the last words were about another item");
        assert_eq!(answers(None, Some(item.id), true, None, now), None);

        let mut typing = item.clone();
        typing.typing = true;
        assert_eq!(answers(Some(&typing), Some(item.id), true, None, now), None, "you're typing the reply");

        let mut queue = Queue::default();
        let approval = question(&mut queue, Kind::Approval);
        assert_eq!(answers(Some(&approval), Some(approval.id), true, None, now), None, "approvals are never answered by voice");
        let mut queue = Queue::default();
        let finished = question(&mut queue, Kind::Finished);
        assert_eq!(answers(Some(&finished), Some(finished.id), true, None, now), None);
    }
}
