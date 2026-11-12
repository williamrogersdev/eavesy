//! Other software in the call: Claude (Claude Meetings joins Google Meet as a
//! visible participant) and other companies' notetakers. They never leave on
//! their own account, Claude for up to eight hours, so a call left to them and
//! this bot is an empty call. Pure, so it is tested without a browser.

/// Names that are a notetaker wherever they appear in a display name.
const NOTETAKER_WORDS: &[&str] = &[
    "notetaker",
    "note taker",
    "note-taker",
    "fireflies",
    "otter.ai",
    "otterpilot",
    "read.ai",
    "fathom",
    "tl;dv",
    "tldv",
    "meetgeek",
    "circleback",
    "granola",
    "gong",
    "avoma",
    "fellow",
    "sembly",
    "krisp",
];

/// Display names Claude may go by. Its exact tile name isn't documented, and
/// Claude is also a person's name: `only_assistants` therefore never counts a
/// participant who has been seen speaking (Claude answers in the chat).
const CLAUDE_NAMES: &[&str] = &["claude", "claude meetings", "claude ai", "claude by anthropic", "claude (anthropic)"];

fn normal(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Whether a display name is an assistant's rather than a person's.
pub fn is_assistant(name: &str) -> bool {
    let name = normal(name);
    CLAUDE_NAMES.contains(&name.as_str()) || NOTETAKER_WORDS.iter().any(|w| name.contains(w))
}

/// Whether the call holds this bot and assistants, and nobody else.
///
/// Errs towards staying: every listed participant other than the bot has to be
/// an assistant that has never spoken, and the app's own head count has to
/// agree with the list, since a layout can hide people's tiles (a shared
/// screen, a large call).
pub fn only_assistants(participants: &[String], bot_name: &str, count: Option<u64>, has_spoken: impl Fn(&str) -> bool) -> bool {
    let mut others: Vec<String> = participants.iter().filter(|n| n.as_str() != bot_name).map(|n| normal(n)).collect();
    others.sort();
    others.dedup();
    !others.is_empty()
        && count == Some(others.len() as u64 + 1)
        && participants.iter().filter(|n| n.as_str() != bot_name).all(|n| is_assistant(n) && !has_spoken(n))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT: &str = "Eavesy Notetaker";
    fn list(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }
    const SILENT: fn(&str) -> bool = |_| false;

    #[test]
    fn knows_claude_and_other_notetakers() {
        for name in ["Claude", " claude ", "Claude Meetings", "Fireflies.ai Notetaker", "Ana's Notetaker (Otter.ai)", "read.ai meeting notes", "Fathom Notetaker"] {
            assert!(is_assistant(name), "{name}");
        }
        for name in ["Claude Dupont", "Claudette", "Ana", "Otto", "Gordon"] {
            assert!(!is_assistant(name), "{name}");
        }
    }

    #[test]
    fn a_call_of_assistants_is_empty() {
        assert!(only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), SILENT));
        assert!(only_assistants(&list(&[BOT, "Claude", "Fireflies.ai Notetaker"]), BOT, Some(3), SILENT));
    }

    #[test]
    fn a_person_keeps_the_call_going() {
        assert!(!only_assistants(&list(&[BOT, "Claude", "Ana"]), BOT, Some(3), SILENT));
        // A person called Claude talks; the assistant writes.
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), |n| n == "Claude"));
    }

    #[test]
    fn stays_when_the_list_may_be_incomplete() {
        // Tiles hidden by the layout: the app counts more people than it shows.
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, Some(4), SILENT));
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, None, SILENT));
        // No tiles read at all says nothing about who is there.
        assert!(!only_assistants(&list(&[BOT]), BOT, Some(1), SILENT));
        assert!(!only_assistants(&[], BOT, Some(2), SILENT));
    }
}
