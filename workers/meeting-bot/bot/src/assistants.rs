//! Other software in the call: Claude (Claude Meetings joins Google Meet as a
//! visible participant) and other companies' notetakers. They never leave on
//! their own account, Claude for up to eight hours, so a call left to them and
//! this bot is an empty call. Pure, so it is tested without a browser.

/// Words only a notetaker's display name carries. Matched anywhere in the
/// name, so nothing here may also be (part of) a person's name: no "gong",
/// "fellow" or "fathom", whose bots say "notetaker" in their names anyway.
const NOTETAKER_WORDS: &[&str] =
    &["notetaker", "note taker", "note-taker", "fireflies.ai", "otter.ai", "otterpilot", "read.ai", "tl;dv", "tldv", "meetgeek", "circleback"];

/// Display names only Claude goes by.
const CLAUDE_NAMES: &[&str] = &["claude meetings", "claude ai", "claude by anthropic", "claude (anthropic)"];

/// Claude's most likely tile name (the exact one isn't documented), and also
/// a person's name. It counts as software only on the terms `Empty::IfQuiet` sets.
const AMBIGUOUS: &str = "claude";

/// How long ago speech still marks a clearly named notetaker as a person.
pub const SPOKE_RECENTLY_MS: u64 = 5 * 60 * 1_000;

/// How long a call of this bot and a silent bare "Claude" has to last before
/// it counts as empty. A person of that name who has never said a word and
/// sits alone with a notetaker this long is not holding a meeting.
pub const AMBIGUOUS_GRACE_MS: u64 = 10 * 60 * 1_000;

/// A call that holds this bot and assistants, and nobody else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Empty {
    /// Every other participant is unmistakably a notetaker.
    Now,
    /// One of them is a bare "Claude": empty only once it has stayed like
    /// this for `AMBIGUOUS_GRACE_MS`.
    IfQuiet,
}

fn normal(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Whether a display name is an assistant's rather than a person's.
pub fn is_assistant(name: &str) -> bool {
    let name = normal(name);
    name == AMBIGUOUS || CLAUDE_NAMES.contains(&name.as_str()) || NOTETAKER_WORDS.iter().any(|w| name.contains(w))
}

/// Whether the call holds this bot and assistants, and nobody else.
///
/// Errs towards staying:
/// - every listed participant other than the bot has to be an assistant;
/// - a clearly named notetaker must not have spoken lately, and a bare
///   "Claude" must never have spoken in the call (Claude answers in the chat);
/// - the app's own head count has to agree with the list, since a layout can
///   hide people's tiles (a shared screen, a large call). The list holds each
///   display name once, so two tiles under one name also read as a mismatch.
pub fn only_assistants(participants: &[String], bot_name: &str, count: Option<u64>, spoke_recently: impl Fn(&str) -> bool, spoke_ever: impl Fn(&str) -> bool) -> Option<Empty> {
    let bot = normal(bot_name);
    let others: Vec<&String> = participants.iter().filter(|n| normal(n) != bot).collect();
    if others.is_empty() || count != Some(others.len() as u64 + 1) {
        return None;
    }
    let mut empty = Empty::Now;
    for name in others {
        if normal(name) == AMBIGUOUS {
            if spoke_ever(name) {
                return None;
            }
            empty = Empty::IfQuiet;
        } else if !is_assistant(name) || spoke_recently(name) {
            return None;
        }
    }
    Some(empty)
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
        for name in ["Claude Dupont", "Claudette", "Ana", "Otto", "Ana Gongora", "Sam Fellowes", "Krispin Fathom", "Granola Smith"] {
            assert!(!is_assistant(name), "{name}");
        }
    }

    #[test]
    fn a_call_of_assistants_is_empty() {
        assert_eq!(only_assistants(&list(&[BOT, "Fireflies.ai Notetaker"]), BOT, Some(2), SILENT, SILENT), Some(Empty::Now));
        assert_eq!(only_assistants(&list(&[BOT, "Claude Meetings"]), BOT, Some(2), SILENT, SILENT), Some(Empty::Now));
        // The bot's own tile, however the app spells it, isn't another notetaker.
        assert_eq!(only_assistants(&list(&[" eavesy notetaker", "Claude Meetings"]), BOT, Some(2), SILENT, SILENT), Some(Empty::Now));
    }

    #[test]
    fn a_bare_claude_has_to_stay_quiet() {
        assert_eq!(only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), SILENT, SILENT), Some(Empty::IfQuiet));
        assert_eq!(only_assistants(&list(&[BOT, "Claude", "Fireflies.ai Notetaker"]), BOT, Some(3), SILENT, SILENT), Some(Empty::IfQuiet));
        // A person called Claude who spoke at any time, however long ago.
        assert_eq!(only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), SILENT, |n| n == "Claude"), None);
    }

    #[test]
    fn a_person_keeps_the_call_going() {
        assert_eq!(only_assistants(&list(&[BOT, "Claude", "Ana"]), BOT, Some(3), SILENT, SILENT), None);
        assert_eq!(only_assistants(&list(&[BOT, "Sam Fellowes"]), BOT, Some(2), SILENT, SILENT), None);
        // A notetaker's name on something that talks.
        assert_eq!(only_assistants(&list(&[BOT, "Ana's Notetaker"]), BOT, Some(2), |n| n == "Ana's Notetaker", SILENT), None);
    }

    #[test]
    fn stays_when_the_list_may_be_incomplete() {
        // Tiles hidden by the layout: the app counts more people than it shows.
        assert_eq!(only_assistants(&list(&[BOT, "Claude Meetings"]), BOT, Some(4), SILENT, SILENT), None);
        assert_eq!(only_assistants(&list(&[BOT, "Claude Meetings"]), BOT, None, SILENT, SILENT), None);
        // No tiles read at all says nothing about who is there.
        assert_eq!(only_assistants(&list(&[BOT]), BOT, Some(1), SILENT, SILENT), None);
        assert_eq!(only_assistants(&[], BOT, Some(2), SILENT, SILENT), None);
    }
}
