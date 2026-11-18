//! Fill field: one shortcut pastes the user's saved value into the form field
//! the cursor is in. The field's label, placeholder and identifiers say what
//! it asks for (`kind_of`); the snippet tagged with that kind is pasted. The
//! field's own text is never read, and password fields are skipped.
//! The kinds match `SNIPPET_FIELDS` in `web/src/lib/snippets/index.ts`.

// Off macOS the shortcut only explains itself, so the pasting half goes unused there.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use tauri::AppHandle;

/// Each kind with the words that name it, most specific first: "email
/// address" is an email, "company name" a company, before "address" or
/// "name" alone are considered. A word matches whole, so "username" is no
/// name and "tel" isn't found in "hotel".
const KINDS: &[(&str, &str, &[&str])] = &[
    ("email", "email", &["email", "e mail", "mail"]),
    ("postcode", "postcode", &["postcode", "post code", "postal code", "postal", "zip", "zip code", "zipcode", "postalcode"]),
    ("city", "city", &["city", "town", "locality"]),
    ("country", "country", &["country"]),
    ("phone", "phone number", &["phone", "telephone", "tel", "mobile", "cell", "phone number"]),
    ("website", "website", &["website", "web site", "url", "homepage", "home page"]),
    ("company", "company", &["company", "organization", "organisation", "business", "employer", "company name"]),
    ("job_title", "job title", &["job title", "jobtitle", "job", "position"]),
    ("first_name", "first name", &["first name", "firstname", "given name", "forename", "fname"]),
    ("last_name", "last name", &["last name", "lastname", "surname", "family name", "lname"]),
    ("address", "street address", &["street", "street address", "address", "address line", "address1", "address 1", "line1"]),
    ("name", "name", &["full name", "fullname", "your name", "name"]),
];

/// Names that aren't the person's: "name" in these is no full name.
const NOT_A_PERSON: &[&str] = &["user", "username", "file", "display", "screen", "project", "repo", "repository", "team", "workspace", "channel", "event", "nick", "nickname", "domain", "account", "product", "card", "cardholder", "pet", "middle"];

/// Lowercase words, with camelCase, dashes, underscores and punctuation split
/// apart: "billingAddress_line1" reads "billing address line1".
fn words(hint: &str) -> Vec<String> {
    let mut spaced = String::with_capacity(hint.len() + 8);
    let mut previous: Option<char> = None;
    for c in hint.chars() {
        if c.is_uppercase() && previous.is_some_and(|p| p.is_lowercase()) {
            spaced.push(' ');
        }
        spaced.push(if c.is_alphanumeric() { c } else { ' ' });
        previous = Some(c);
    }
    spaced.to_lowercase().split_whitespace().map(str::to_string).collect()
}

fn contains_phrase(words: &[String], phrase: &str) -> bool {
    let wanted: Vec<&str> = phrase.split(' ').collect();
    words.windows(wanted.len()).any(|window| window.iter().zip(&wanted).all(|(word, want)| word == want))
}

/// What a field asks for, from what it says about itself. Hints come in the
/// order the app gave them (label first); the first that names a kind decides.
pub fn kind_of(hints: &[String]) -> Option<&'static str> {
    hints.iter().find_map(|hint| {
        let words = words(hint);
        KINDS.iter().find_map(|(kind, _, names)| {
            let named = names.iter().any(|name| contains_phrase(&words, name));
            let someone_else = *kind == "name" && words.iter().any(|word| NOT_A_PERSON.contains(&word.as_str()));
            (named && !someone_else).then_some(*kind)
        })
    })
}

/// The kind as Settings writes it, for what Eavesy tells the user.
fn label(kind: &str) -> &'static str {
    KINDS.iter().find(|(key, _, _)| *key == kind).map_or("value", |(_, label, _)| label)
}

/// What happened when Fill field was pressed.
#[derive(Debug, PartialEq)]
enum Outcome {
    Filled(&'static str),
    NoField,
    Unknown,
    NothingSaved(&'static str),
    /// The field lost the keyboard before the value went in: nothing was pasted.
    FocusMoved,
    Failed(String),
}

impl Outcome {
    fn event(&self) -> (&'static str, Option<&'static str>) {
        match self {
            Outcome::Filled(kind) => ("filled", Some(*kind)),
            Outcome::NoField => ("no_field", None),
            Outcome::Unknown => ("unknown_field", None),
            Outcome::NothingSaved(kind) => ("nothing_saved", Some(*kind)),
            Outcome::FocusMoved => ("focus_moved", None),
            Outcome::Failed(_) => ("paste_failed", None),
        }
    }

    /// What Eavesy tells the user, as (title, body); nothing once filled.
    fn notice(self, on_mac: bool, accessibility: bool) -> Option<(String, String)> {
        let say = |title: &str, body: &str| Some((title.to_string(), body.to_string()));
        match self {
            Outcome::Filled(_) => None,
            Outcome::NoField if !on_mac => say("Fill field works on macOS only", "Say the snippet’s phrase while you dictate instead."),
            Outcome::NoField if !accessibility => say("Fill field needs Accessibility", "Allow Eavesy in System Settings → Privacy & Security → Accessibility, then try again."),
            Outcome::NoField => say("Nothing to fill", "Click into a text field first. Password fields are never filled."),
            Outcome::Unknown => say("Eavesy couldn’t tell what this field asks for", "Say the snippet’s phrase while you dictate instead."),
            Outcome::NothingSaved(kind) => Some((
                format!("No {} saved", label(kind)),
                format!("Add a snippet in Eavesy Settings → Dictionary and set it to fill {}.", label(kind)),
            )),
            Outcome::FocusMoved => say("Nothing was filled", "The field changed before Eavesy could fill it. Click into it and try again."),
            Outcome::Failed(why) => Some(("Couldn’t fill the field".to_string(), why)),
        }
    }
}

/// The value for a field described by `hints`, or why there is none.
fn choose<'a>(hints: Option<&[String]>, snippets: &'a [crate::snippets::Snippet]) -> Result<(&'static str, &'a str), Outcome> {
    let hints = hints.ok_or(Outcome::NoField)?;
    let kind = kind_of(hints).ok_or(Outcome::Unknown)?;
    let snippet = crate::snippets::for_field(snippets, kind).ok_or(Outcome::NothingSaved(kind))?;
    Ok((kind, snippet.text.as_str()))
}

/// Runs off the shortcut's thread: the front app's accessibility tree can be slow.
pub fn fill(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = fill_now(&app);
        let (event, kind) = outcome.event();
        crate::telemetry::track("form_fill", serde_json::json!({ "outcome": event, "kind": kind }));
        if let Some((title, body)) = outcome.notice(cfg!(target_os = "macos"), crate::dictation::accessibility_trusted()) {
            crate::commands::show_notice(app, title, body);
        }
    });
}

#[cfg(target_os = "macos")]
fn fill_now(app: &AppHandle) -> Outcome {
    let found = crate::paste_learning::field_hints();
    let snippets = crate::snippets::cached(app);
    let (kind, text) = match choose(found.as_ref().map(|(_, hints)| hints.as_slice()), &snippets) {
        Ok(chosen) => chosen,
        Err(outcome) => return outcome,
    };
    // A personal value goes only into the field it was chosen for.
    let Some((field, _)) = &found else { return Outcome::NoField };
    if !crate::paste_learning::still_focused(field) {
        return Outcome::FocusMoved;
    }
    match crate::commands::paste_text_quietly(app, text) {
        Ok(()) => Outcome::Filled(kind),
        Err(why) => Outcome::Failed(why),
    }
}

#[cfg(not(target_os = "macos"))]
fn fill_now(_app: &AppHandle) -> Outcome {
    Outcome::NoField
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(hints: &[&str]) -> Option<&'static str> {
        kind_of(&hints.iter().map(|hint| hint.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn labels_name_their_kind() {
        assert_eq!(kind(&["Email address"]), Some("email"));
        assert_eq!(kind(&["E-mail"]), Some("email"));
        assert_eq!(kind(&["Work email *"]), Some("email"));
        assert_eq!(kind(&["Company name"]), Some("company"));
        assert_eq!(kind(&["Street address"]), Some("address"));
        assert_eq!(kind(&["First name"]), Some("first_name"));
        assert_eq!(kind(&["Surname"]), Some("last_name"));
        assert_eq!(kind(&["Full name"]), Some("name"));
        assert_eq!(kind(&["Mobile number"]), Some("phone"));
        assert_eq!(kind(&["ZIP / Postal code"]), Some("postcode"));
        assert_eq!(kind(&["Job title"]), Some("job_title"));
        assert_eq!(kind(&["Your website"]), Some("website"));
    }

    #[test]
    fn identifiers_are_read_as_words() {
        assert_eq!(kind(&["billingAddress_line1"]), Some("address"));
        assert_eq!(kind(&["input-firstName"]), Some("first_name"));
        assert_eq!(kind(&["user_email"]), Some("email"));
        assert_eq!(kind(&["postalCode"]), Some("postcode"));
    }

    #[test]
    fn other_names_and_lookalike_words_are_not_the_person() {
        assert_eq!(kind(&["Username"]), None);
        assert_eq!(kind(&["Project name"]), None);
        assert_eq!(kind(&["Display name"]), None);
        assert_eq!(kind(&["Hotel"]), None);
        assert_eq!(kind(&["Search"]), None);
        assert_eq!(kind(&[]), None);
    }

    #[test]
    fn the_label_decides_before_the_placeholder() {
        assert_eq!(kind(&["Email", "Phone"]), Some("email"));
        assert_eq!(kind(&["Phone", "Email"]), Some("phone"));
        assert_eq!(kind(&["Postcode", "Email"]), Some("postcode"));
        assert_eq!(kind(&["field_17", "Phone"]), Some("phone"));
    }

    fn snippet(text: &str, field: Option<&str>) -> crate::snippets::Snippet {
        crate::snippets::Snippet { trigger: "my thing".into(), text: text.into(), field: field.map(str::to_string) }
    }

    #[test]
    fn a_field_gets_its_saved_value_or_a_reason() {
        let saved = [snippet("me@example.com", Some("email")), snippet("hello", None)];
        let hints = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        assert_eq!(choose(Some(&hints(&["Email"])), &saved), Ok(("email", "me@example.com")));
        assert_eq!(choose(Some(&hints(&["Phone"])), &saved), Err(Outcome::NothingSaved("phone")));
        assert_eq!(choose(Some(&hints(&["Search"])), &saved), Err(Outcome::Unknown));
        assert_eq!(choose(None, &saved), Err(Outcome::NoField));
    }

    #[test]
    fn every_outcome_but_a_fill_says_why() {
        assert_eq!(Outcome::Filled("email").notice(true, true), None);
        assert_eq!(Outcome::NoField.notice(false, false).unwrap().0, "Fill field works on macOS only");
        assert_eq!(Outcome::NoField.notice(true, false).unwrap().0, "Fill field needs Accessibility");
        assert_eq!(Outcome::NoField.notice(true, true).unwrap().0, "Nothing to fill");
        assert_eq!(Outcome::NothingSaved("phone").notice(true, true).unwrap().0, "No phone number saved");
        assert_eq!(Outcome::FocusMoved.notice(true, true).unwrap().0, "Nothing was filled");
        assert_eq!(Outcome::FocusMoved.event(), ("focus_moved", None));
    }

    #[test]
    fn the_kinds_match_the_ones_settings_offers() {
        // web/src/lib/snippets/index.ts is the list Settings tags snippets with.
        let web = include_str!("../../../web/src/lib/snippets/index.ts");
        let start = web.find("SNIPPET_FIELDS = [").expect("the web list");
        let end = start + web[start..].find("] as const").expect("its end");
        let offered: Vec<&str> = web[start..end].split("key: '").skip(1).filter_map(|rest| rest.split('\'').next()).collect();
        let ours: Vec<&str> = KINDS.iter().map(|(key, _, _)| *key).collect();
        let (mut offered_sorted, mut ours_sorted) = (offered.clone(), ours.clone());
        offered_sorted.sort_unstable();
        ours_sorted.sort_unstable();
        assert_eq!(offered_sorted, ours_sorted);
    }
}
