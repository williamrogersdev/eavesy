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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Send,
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
const NO: &[&str] = &["no", "nope", "cancel", "dont send it", "dont send that", "dont send", "do not send it", "wait", "stop", "no dont send it", "no dont send that"];
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
    if is(SEND) || is(YES) {
        return Command::Send;
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

/// What `heard` does to an item showing `draft` (a reply read back to you)
/// or else `suggestion`. "Send it" sends only what was last offered; with
/// nothing offered, a "yes" or "no" is your reply and is read back too.
pub fn step(suggestion: Option<&str>, draft: Option<&str>, heard: &str) -> Step {
    let offered = draft.or(suggestion).map(str::trim).filter(|text| !text.is_empty());
    let heard = heard.trim();
    match (parse(heard), offered) {
        (Command::Send, Some(text)) => Step::Send(text.to_string()),
        (Command::No, Some(_)) => Step::Decline,
        (Command::Later, _) => Step::Later,
        (Command::Dismiss, _) => Step::Dismiss,
        _ => Step::ReadBack(heard.to_string()),
    }
}

/// What Eavesy says back after a new draft.
pub fn read_back(draft: &str) -> String {
    format!("I'll send: {}. Send that?", draft.trim().trim_end_matches('.'))
}

/// Whether a dictation starting `now` answers `head`, the card's front item:
/// it's a question you haven't started typing into, Eavesy's last words were
/// about it, and it's still talking or stopped within [`ANSWER_WINDOW`].
/// Returns the item it answers.
pub fn answers(head: Option<&Item>, last_said: Option<u64>, speaking: bool, quiet_since: Option<Instant>, now: Instant) -> Option<u64> {
    let head = head?;
    if head.kind != Kind::Question || head.typing || last_said != Some(head.id) {
        return None;
    }
    let recent = speaking || quiet_since.is_some_and(|at| now.saturating_duration_since(at) <= ANSWER_WINDOW);
    recent.then_some(head.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::queue::Queue;

    #[test]
    fn send_phrases_match_whole_utterances_only() {
        for said in ["Send it.", "yes, send that", "Yes send that!", "okay send it please", "Um, send it", "Yeah.", "go ahead", "Send it, thanks"] {
            assert_eq!(parse(said), Command::Send, "{said}");
        }
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
        for said in ["later, also fix the tests", "dismiss the warning and continue", "no, put it behind a flag", "stop the server first"] {
            assert_eq!(parse(said), Command::Reply, "{said}");
        }
    }

    #[test]
    fn send_it_sends_what_was_last_offered() {
        assert_eq!(step(Some("No flag."), None, "send it"), Step::Send("No flag.".into()));
        // A draft read back wins over the suggestion it replaced.
        assert_eq!(step(Some("No flag."), Some("Put it behind a flag"), "yes"), Step::Send("Put it behind a flag".into()));
    }

    #[test]
    fn anything_else_is_read_back_and_never_sent() {
        assert_eq!(step(Some("No flag."), None, "no, put it behind a flag"), Step::ReadBack("no, put it behind a flag".into()));
        assert_eq!(step(Some("No flag."), Some("Put it behind a flag"), "actually ship it"), Step::ReadBack("actually ship it".into()));
        // With nothing offered, "yes" and "no" are the reply itself.
        assert_eq!(step(None, None, "Yes."), Step::ReadBack("Yes.".into()));
        assert_eq!(step(None, Some("  "), "no"), Step::ReadBack("no".into()));
    }

    #[test]
    fn no_declines_and_later_and_dismiss_do_what_the_buttons_do() {
        assert_eq!(step(Some("No flag."), None, "no"), Step::Decline);
        assert_eq!(step(Some("No flag."), Some("Flag it"), "cancel"), Step::Decline);
        assert_eq!(step(Some("No flag."), None, "later"), Step::Later);
        assert_eq!(step(None, None, "dismiss"), Step::Dismiss);
    }

    #[test]
    fn a_full_conversation_sends_only_after_yes() {
        let suggestion = Some("No flag. Ship it.");
        let Step::ReadBack(draft) = step(suggestion, None, "Put it behind a flag.") else { panic!("should read back") };
        assert_eq!(read_back(&draft), "I'll send: Put it behind a flag. Send that?");
        assert_eq!(step(suggestion, Some(&draft), "no"), Step::Decline);
        assert_eq!(step(suggestion, Some(&draft), "yes, send that"), Step::Send("Put it behind a flag.".into()));
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
        assert_eq!(answers(Some(&item), Some(item.id), true, None, now), Some(item.id));
        assert_eq!(answers(Some(&item), Some(item.id), false, Some(now), now + ANSWER_WINDOW), Some(item.id));
        assert_eq!(answers(Some(&item), Some(item.id), false, Some(now), now + ANSWER_WINDOW + Duration::from_secs(1)), None);
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
