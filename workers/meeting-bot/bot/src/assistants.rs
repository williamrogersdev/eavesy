//! Other software in the call: Claude (Claude Meetings joins Google Meet as a
//! visible participant) and other companies' notetakers. They never leave on
//! their own account, Claude for up to eight hours, so a call left to them and
//! this bot is an empty call. Pure, so it is tested without a browser.

/// Words only a notetaker's display name carries. Matched anywhere in the
/// name, so nothing here may also be (part of) a person's name: no "gong",
/// "fellow" or "fathom", whose bots say "notetaker" in their names anyway.
const NOTETAKER_WORDS: &[&str] =
    &["notetaker", "note taker", "note-taker", "fireflies.ai", "otter.ai", "otterpilot", "read.ai", "tl;dv", "tldv", "meetgeek", "circleback"];

/// Display names only Claude goes by. A tile named just "Claude" is not here:
/// the name Claude Meetings shows isn't documented, and it is a person's name
/// too. Until it has been seen in a real call the bot treats it as a person.
const CLAUDE_NAMES: &[&str] = &["claude meetings", "claude ai", "claude by anthropic", "claude (anthropic)"];

/// A display name as it is compared: the tile and the speaking indicator may
/// differ in case or spacing.
pub fn normal(name: &str) -> String {
    name.trim().to_lowercase()
}

/// Whether a display name is an assistant's rather than a person's.
pub fn is_assistant(name: &str) -> bool {
    let name = normal(name);
    CLAUDE_NAMES.contains(&name.as_str()) || NOTETAKER_WORDS.iter().any(|w| name.contains(w))
}

/// Whether the call holds this bot and assistants, and nobody else.
///
/// Errs towards staying:
/// - every tile other than the bot's has to be an assistant that has never
///   been heard in this call (they write, they don't talk): a quiet person
///   whose name reads like a notetaker's is a person once they have spoken;
/// - the app's own head count has to equal the tiles read plus the bot,
///   since a layout can hide people's tiles (a shared screen, a large call).
///   Tiles are counted as they are, two under one name as two.
pub fn only_assistants(participants: &[String], bot_name: &str, count: Option<u64>, spoke: impl Fn(&str) -> bool) -> bool {
    let bot = normal(bot_name);
    let others: Vec<&String> = participants.iter().filter(|n| normal(n) != bot).collect();
    !others.is_empty() && count == Some(others.len() as u64 + 1) && others.iter().all(|n| is_assistant(n) && !spoke(n))
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
        for name in ["Claude Meetings", " claude ai ", "Fireflies.ai Notetaker", "Ana's Notetaker (Otter.ai)", "read.ai meeting notes", "Fathom Notetaker"] {
            assert!(is_assistant(name), "{name}");
        }
        // A bare "Claude" is a person until its tile name is confirmed.
        for name in ["Claude", "Claude Dupont", "Claudette", "Ana", "Ana Gongora", "Sam Fellowes", "Krispin Fathom", "Granola Smith"] {
            assert!(!is_assistant(name), "{name}");
        }
    }

    #[test]
    fn a_call_of_assistants_is_empty() {
        assert!(only_assistants(&list(&[BOT, "Fireflies.ai Notetaker"]), BOT, Some(2), SILENT));
        assert!(only_assistants(&list(&[BOT, "Claude Meetings", "Fireflies.ai Notetaker"]), BOT, Some(3), SILENT));
        // The bot's own tile, however the app spells it, isn't another notetaker.
        assert!(only_assistants(&list(&[" eavesy notetaker", "Claude Meetings"]), BOT, Some(2), SILENT));
        // Two tiles under one name are two tiles: the head count is of tiles.
        assert!(only_assistants(&list(&[BOT, "Claude Meetings", "claude meetings"]), BOT, Some(3), SILENT));
        assert!(!only_assistants(&list(&[BOT, "Claude Meetings", "claude meetings"]), BOT, Some(2), SILENT));
    }

    #[test]
    fn a_person_keeps_the_call_going() {
        assert!(!only_assistants(&list(&[BOT, "Claude Meetings", "Ana"]), BOT, Some(3), SILENT));
        assert!(!only_assistants(&list(&[BOT, "Claude"]), BOT, Some(2), SILENT));
        // A notetaker's name on something that has talked, however long ago.
        assert!(!only_assistants(&list(&[BOT, "Ana's Notetaker"]), BOT, Some(2), |n| n == "Ana's Notetaker"));
    }

    #[test]
    fn stays_when_the_list_may_be_incomplete() {
        // Tiles hidden by the layout: the app counts more people than it shows.
        assert!(!only_assistants(&list(&[BOT, "Claude Meetings"]), BOT, Some(4), SILENT));
        assert!(!only_assistants(&list(&[BOT, "Claude Meetings"]), BOT, None, SILENT));
        // No tiles read at all says nothing about who is there.
        assert!(!only_assistants(&list(&[BOT]), BOT, Some(1), SILENT));
        assert!(!only_assistants(&[], BOT, Some(2), SILENT));
    }
}
