//! Fill field: one shortcut pastes the user's saved value into the form field
//! the cursor is in. The field's label, placeholder and identifiers say what
//! it asks for (`kind_of`); the snippet tagged with that kind is pasted. The
//! field's own text is never read, and password fields are skipped.
//! The kinds match `SNIPPET_FIELDS` in `web/src/lib/snippets/index.ts`.

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
    Failed(String),
}

/// Runs off the shortcut's thread: the front app's accessibility tree can be slow.
pub fn fill(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = fill_now(&app);
        let (event, kind) = match &outcome {
            Outcome::Filled(kind) => ("filled", Some(*kind)),
            Outcome::NoField => ("no_field", None),
            Outcome::Unknown => ("unknown_field", None),
            Outcome::NothingSaved(kind) => ("nothing_saved", Some(*kind)),
            Outcome::Failed(_) => ("paste_failed", None),
        };
        crate::telemetry::track("form_fill", serde_json::json!({ "outcome": event, "kind": kind }));
        let notice = match outcome {
            Outcome::Filled(_) => None,
            Outcome::NoField if !crate::dictation::accessibility_trusted() => {
                Some(("Fill field needs Accessibility".to_string(), "Allow Eavesy in System Settings → Privacy & Security → Accessibility, then try again.".to_string()))
            }
            Outcome::NoField => Some(("Nothing to fill".to_string(), "Click into a text field first. Password fields are never filled.".to_string())),
            Outcome::Unknown => Some(("Eavesy couldn’t tell what this field asks for".to_string(), "Say the snippet’s phrase while you dictate instead.".to_string())),
            Outcome::NothingSaved(kind) => Some((
                format!("No {} saved", label(kind)),
                format!("Add a snippet in Eavesy Settings → Dictionary and set it to fill {}.", label(kind)),
            )),
            Outcome::Failed(why) => Some(("Couldn’t fill the field".to_string(), why)),
        };
        if let Some((title, body)) = notice {
            crate::commands::show_notice(app, title, body);
        }
    });
}

fn fill_now(app: &AppHandle) -> Outcome {
    #[cfg(target_os = "macos")]
    let hints = crate::paste_learning::field_hints();
    #[cfg(not(target_os = "macos"))]
    let hints: Option<Vec<String>> = None;
    let Some(hints) = hints else { return Outcome::NoField };
    let Some(kind) = kind_of(&hints) else { return Outcome::Unknown };
    let snippets = crate::snippets::cached(app);
    let Some(snippet) = crate::snippets::for_field(&snippets, kind) else { return Outcome::NothingSaved(kind) };
    match crate::commands::paste_text_quietly(app, &snippet.text) {
        Ok(()) => Outcome::Filled(kind),
        Err(why) => Outcome::Failed(why),
    }
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
        assert_eq!(kind(&["Name", "you@example.com"]), Some("name"));
        assert_eq!(kind(&["field_17", "Phone"]), Some("phone"));
    }
}
