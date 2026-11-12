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
/// a person's name. See `only_assistants` for what it takes to count.
const AMBIGUOUS: &str = "claude";

/// How long ago speech still marks a participant as a person. Not the whole
/// call: a person called Claude may have spoken and left, with Claude still there.
pub const SPOKE_RECENTLY_MS: u64 = 5 * 60 * 1_000;

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
/// - every listed participant other than the bot has to be an assistant that
///   hasn't spoken lately (Claude answers in the chat);
/// - a bare "Claude" counts only once `people_seen`, that is after people were
///   in the call and left. Before anyone has come, a silent "Claude" may be
///   the person waiting for the others;
/// - the app's own head count has to agree with the list, since a layout can
///   hide people's tiles (a shared screen, a large call).
pub fn only_assistants(participants: &[String], bot_name: &str, count: Option<u64>, people_seen: bool, spoke_recently: impl Fn(&str) -> bool) -> bool {
    let bot = normal(bot_name);
    let others: Vec<&String> = participants.iter().filter(|n| normal(n) != bot).collect();
    !others.is_empty()
        && count == Some(others.len() as u64 + 1)
        && others.iter().all(|n| is_assistant(n) && !spoke_recently(n) && (people_seen || normal(n) != AMBIGUOUS))
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
        assert!(only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), true, SILENT));
        assert!(only_assistants(&list(&[BOT, "Claude", "Fireflies.ai Notetaker"]), BOT, Some(3), true, SILENT));
        assert!(only_assistants(&list(&[BOT, "Fireflies.ai Notetaker"]), BOT, Some(2), false, SILENT));
        // The bot's own tile, however the app spells it, isn't another notetaker.
        assert!(only_assistants(&list(&[" eavesy notetaker", "Claude Meetings"]), BOT, Some(2), false, SILENT));
    }

    #[test]
    fn a_person_keeps_the_call_going() {
        assert!(!only_assistants(&list(&[BOT, "Claude", "Ana"]), BOT, Some(3), true, SILENT));
        // A person called Claude talks; the assistant writes.
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), true, |n| n == "Claude"));
        // Nobody has come yet: a silent "Claude" may be the person waiting.
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), false, SILENT));
    }

    #[test]
    fn stays_when_the_list_may_be_incomplete() {
        // Tiles hidden by the layout: the app counts more people than it shows.
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, Some(4), true, SILENT));
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, None, true, SILENT));
        // No tiles read at all says nothing about who is there.
        assert!(!only_assistants(&list(&[BOT]), BOT, Some(1), true, SILENT));
        assert!(!only_assistants(&[], BOT, Some(2), true, SILENT));
    }
}
