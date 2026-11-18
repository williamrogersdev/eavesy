//! Voice snippets from the user's account: saying a snippet's phrase in a
//! dictation types its text in place of the phrase. A snippet tagged with a
//! form field is also what Fill field pastes (`form_fill.rs`). Kept on disk
//! (`snippets.json`) beside the vocabulary, refreshed with it, so expansion
//! never waits on the network.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Snippet {
    pub trigger: String,
    pub text: String,
    #[serde(default)]
    pub field: Option<String>,
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("snippets.json"))
}

pub fn cached(app: &AppHandle) -> Vec<Snippet> {
    path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<Vec<Snippet>>(&raw).ok())
        .unwrap_or_default()
}

pub fn store(app: &AppHandle, snippets: &[Snippet]) {
    if snippets == cached(app).as_slice() {
        return;
    }
    let Some(path) = path(app) else { return };
    let Ok(raw) = serde_json::to_string(snippets) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Written aside and renamed over, so a crash never leaves half a list.
    let partial = path.with_extension(format!("json.{}", uuid::Uuid::new_v4()));
    if std::fs::write(&partial, raw).and_then(|()| std::fs::rename(&partial, &path)).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
}

/// The text the snippet tagged with `field` types, if there is one.
pub fn for_field<'a>(snippets: &'a [Snippet], field: &str) -> Option<&'a Snippet> {
    snippets.iter().find(|snippet| snippet.field.as_deref() == Some(field) && !snippet.text.trim().is_empty())
}

fn key(phrase: &str) -> String {
    phrase
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Every snippet phrase in `text` swapped for its text: whole phrases only, any
/// case, with any spacing or a comma between their words (polishing may add
/// one). Commas count as spacing in a phrase, as on the server
/// (`triggerKey`); punctuation around a phrase stays where it was. A phrase joined to a letter, digit, at-sign, slash or dash stays as
/// written. One pass, longest phrase first, so one expansion never feeds
/// another. A dictation that is nothing but the phrase becomes just the
/// snippet's text, without the full stop polishing gave it, so it can go
/// straight into a form field.
pub fn expand(text: &str, snippets: &[Snippet]) -> String {
    let mut known: Vec<(String, &str)> = Vec::new();
    for snippet in snippets {
        let phrase = key(&snippet.trigger);
        // Single words are refused when saved; checked again for older caches.
        if phrase.split(' ').count() >= 2 && !snippet.text.trim().is_empty() && !known.iter().any(|(kept, _)| *kept == phrase) {
            known.push((phrase, snippet.text.as_str()));
        }
    }
    if known.is_empty() {
        return text.to_string();
    }
    let alone = key(text.trim().trim_end_matches(['.', '!', '?', ',', ';', ':']));
    if let Some((_, insert)) = known.iter().find(|(phrase, _)| *phrase == alone) {
        return insert.to_string();
    }
    known.sort_by_key(|(phrase, _)| std::cmp::Reverse(phrase.chars().count()));
    let alternatives: Vec<String> =
        known.iter().map(|(phrase, _)| phrase.split(' ').map(regex::escape).collect::<Vec<_>>().join(r",?\s+")).collect();
    let Ok(pattern) = regex::Regex::new(&format!("(?i)(?:{})", alternatives.join("|"))) else {
        return text.to_string();
    };
    let joined = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || "@/_-".contains(c));
    let mut out = String::with_capacity(text.len());
    let mut end = 0;
    for found in pattern.find_iter(text) {
        let before = text[..found.start()].chars().next_back();
        let after = text[found.end()..].chars().next();
        if joined(before) || joined(after) {
            continue;
        }
        let Some((_, insert)) = known.iter().find(|(phrase, _)| *phrase == key(found.as_str())) else { continue };
        out.push_str(&text[end..found.start()]);
        out.push_str(insert);
        end = found.end();
    }
    out.push_str(&text[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snippet(trigger: &str, text: &str) -> Snippet {
        Snippet { trigger: trigger.into(), text: text.into(), field: None }
    }

    #[test]
    fn a_phrase_in_a_sentence_becomes_its_text() {
        let snippets = [snippet("my email", "me@example.com"), snippet("my booking link", "https://cal.com/me")];
        assert_eq!(expand("Send it to my email, thanks.", &snippets), "Send it to me@example.com, thanks.");
        assert_eq!(expand("Book here: My Booking  Link.", &snippets), "Book here: https://cal.com/me.");
        assert_eq!(expand("Use my, email please", &snippets), "Use me@example.com please");
    }

    #[test]
    fn commas_around_a_phrase_stay_and_a_phrase_with_more_words_is_expanded_in_place() {
        let snippets = [snippet("my email", "me@example.com")];
        assert_eq!(expand("My email, and my phone.", &snippets), "me@example.com, and my phone.");
        assert_eq!(expand("Yes, my email.", &snippets), "Yes, me@example.com.");
        assert_eq!(expand("My email, please.", &snippets), "me@example.com, please.");
        assert_eq!(expand("My email,", &snippets), "me@example.com");
    }

    #[test]
    fn a_dictation_of_only_the_phrase_is_only_the_text() {
        let snippets = [snippet("my address", "1 High Street\nLondon")];
        assert_eq!(expand("My address.", &snippets), "1 High Street\nLondon");
        assert_eq!(expand("  my address  ", &snippets), "1 High Street\nLondon");
    }

    #[test]
    fn the_longest_phrase_wins_and_words_inside_others_stay() {
        let snippets = [snippet("my email", "a@example.com"), snippet("my email signature", "Best,\nMe")];
        assert_eq!(expand("Add my email signature here", &snippets), "Add Best,\nMe here");
        assert_eq!(expand("my emails are full", &snippets), "my emails are full");
        assert_eq!(expand("xmy email", &snippets), "xmy email");
    }

    #[test]
    fn expansions_never_expand_again_and_single_words_never_match() {
        let snippets = [snippet("first thing", "second thing"), snippet("second thing", "third"), snippet("email", "x@y.z")];
        assert_eq!(expand("do the first thing", &snippets), "do the second thing");
        assert_eq!(expand("check email", &snippets), "check email");
        assert_eq!(expand("nothing here", &[]), "nothing here");
    }

    #[test]
    fn a_field_finds_its_snippet() {
        let mut email = snippet("my email", "me@example.com");
        email.field = Some("email".into());
        let snippets = [snippet("my phone", "123"), email];
        assert_eq!(for_field(&snippets, "email").map(|s| s.text.as_str()), Some("me@example.com"));
        assert!(for_field(&snippets, "phone").is_none());
    }
}
