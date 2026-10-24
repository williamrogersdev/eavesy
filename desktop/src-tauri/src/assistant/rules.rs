//! Always allow (assistant.md C3, H2, H4): tier 2 and 3 actions you named, scoped to a
//! folder, that run for you without a card.
//!
//! A rule is one of a few kinds fixed here, each tied to rows a real tool can prove, never
//! free text a model would interpret. The rules in force live in the signed policy file
//! (store.rs), so nothing that writes your home folder can add one. `rules.md` is their
//! mirror for you to read and edit: an edit made outside Eavesy, by you or by an agent,
//! waits in the review list until you accept it in Settings, behind a native dialog.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::memory::{read_for_edit, write_text};
use super::Core;

/// Rules read from the file at most; past this, a line is refused.
pub const MAX_RULES: usize = 50;

/// Held across a read-change-write of rules.md.
static WRITING: Mutex<()> = Mutex::new(());

/// What a rule lets Eavesy do. Each is a row kind a tool reports from its own data.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Remove worktrees the cleanup already finds finished: merged, clean and unused.
    RemoveWorktrees,
    /// Stop processes the cleanup proves are leftovers, by the folder they run in.
    StopLeftovers,
}

impl Kind {
    const ALL: [Kind; 2] = [Kind::RemoveWorktrees, Kind::StopLeftovers];

    fn phrase(self) -> &'static str {
        match self {
            Kind::RemoveWorktrees => "Remove finished worktrees under",
            Kind::StopLeftovers => "Stop leftover processes under",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub kind: Kind,
    /// Canonical, and never `/` or your home folder.
    pub under: PathBuf,
}

impl Rule {
    /// A rule for a folder you named. The folder must exist; `~` is your home folder.
    pub fn new(kind: Kind, folder: &str) -> Result<Rule, String> {
        let folder = folder.trim();
        let expanded = expand(folder).ok_or_else(|| format!("{folder} isn't a full path. Start it with / or ~/."))?;
        let under = std::fs::canonicalize(&expanded).ok().filter(|path| path.is_dir()).ok_or_else(|| format!("{folder} isn't a folder on this Mac."))?;
        let home = dirs::home_dir().and_then(|home| std::fs::canonicalize(home).ok());
        if under.parent().is_none() || Some(&under) == home.as_ref() {
            return Err("Name a project folder, not your whole disk or home folder.".into());
        }
        Ok(Rule { kind, under })
    }

    /// The rule in words: its line in rules.md, and what every screen and dialog shows.
    /// Always rendered from the rule, never copied from the file.
    pub fn text(&self) -> String {
        format!("{} {}", self.kind.phrase(), short(&self.under))
    }
}

fn expand(folder: &str) -> Option<PathBuf> {
    let path = match folder.strip_prefix('~') {
        Some("") => dirs::home_dir()?,
        Some(rest) => dirs::home_dir()?.join(rest.strip_prefix('/')?),
        None => PathBuf::from(folder),
    };
    path.is_absolute().then_some(path)
}

/// The path with your home folder as `~`.
fn short(path: &Path) -> String {
    match dirs::home_dir().and_then(|home| path.strip_prefix(home).ok().map(Path::to_path_buf)) {
        Some(rest) if rest.as_os_str().is_empty() => "~".into(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

/// What one row of an action touches, reported by the tool from its own inventory,
/// never from the model's input. `path` none means it can't be placed in a folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub kind: Kind,
    pub path: Option<PathBuf>,
}

/// The rules that together cover every row, or none when any row isn't covered. A rule
/// covers a row of its kind whose real path is inside the rule's folder.
pub fn covering(rules: &[Rule], scopes: &[Scope], rows: usize) -> Option<Vec<Rule>> {
    if scopes.is_empty() || scopes.len() != rows {
        return None;
    }
    let mut used: Vec<Rule> = Vec::new();
    for scope in scopes {
        let path = std::fs::canonicalize(scope.path.as_ref()?).ok()?;
        let rule = rules.iter().find(|rule| rule.kind == scope.kind && inside(&path, &rule.under))?;
        if !used.contains(rule) {
            used.push(rule.clone());
        }
    }
    Some(used)
}

fn inside(path: &Path, root: &Path) -> bool {
    // `starts_with` compares components, so a `..` in the path would slip past it.
    let plain = path.is_absolute() && path.components().all(|part| matches!(part, Component::RootDir | Component::Normal(_)));
    plain && path.starts_with(root)
}

/// A line in rules.md that isn't a rule Eavesy can use. Nothing from it applies.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invalid {
    /// 1-based.
    pub line: usize,
    pub text: String,
    pub reason: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub rules: Vec<Rule>,
    pub invalid: Vec<Invalid>,
}

const SECTION: &str = "always allow";

/// `Some(true)` on the "## Always allow" heading, `Some(false)` on any other heading.
fn heading(line: &str) -> Option<bool> {
    let line = line.trim_start();
    if !line.starts_with('#') {
        return None;
    }
    Some(line.strip_prefix("## ").is_some_and(|name| name.trim().eq_ignore_ascii_case(SECTION)))
}

fn bullet(line: &str) -> Option<&str> {
    let line = line.trim_start();
    line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")).map(str::trim)
}

fn rule_on(item: &str) -> Result<Rule, String> {
    for kind in Kind::ALL {
        let phrase = kind.phrase();
        let Some(rest) = item.get(..phrase.len()).filter(|start| start.eq_ignore_ascii_case(phrase)).map(|_| &item[phrase.len()..]) else { continue };
        if !rest.starts_with(char::is_whitespace) {
            break;
        }
        return Rule::new(kind, rest);
    }
    Err("Eavesy doesn't know this rule. Rules read \"Remove finished worktrees under ~/Developer\" or \"Stop leftover processes under ~/Developer\".".into())
}

/// The rules in the "Always allow" section. Other sections, prose and blank lines are
/// yours and ignored; a bullet that isn't a rule is refused with its line.
pub fn parse(text: &str) -> Parsed {
    let mut parsed = Parsed::default();
    let mut in_section = false;
    for (index, line) in text.lines().enumerate() {
        if let Some(is_section) = heading(line) {
            in_section = is_section;
            continue;
        }
        let Some(item) = bullet(line).filter(|_| in_section) else { continue };
        if item.is_empty() {
            continue;
        }
        let refuse = |reason: String| Invalid { line: index + 1, text: super::memory::clean(item), reason };
        match rule_on(item) {
            Ok(rule) if parsed.rules.contains(&rule) => {}
            Ok(_) if parsed.rules.len() >= MAX_RULES => parsed.invalid.push(refuse(format!("Eavesy keeps {MAX_RULES} rules at most."))),
            Ok(rule) => parsed.rules.push(rule),
            Err(reason) => parsed.invalid.push(refuse(reason)),
        }
    }
    parsed
}

const HEADER: &str = "# Eavesy's rules\n\nWhat Eavesy does for you without a card. Changes made here wait in Settings → Assistant → Rules until you accept them there.\n\n## Always allow\n\n";

pub fn render(rules: &[Rule]) -> String {
    rules.iter().fold(HEADER.to_string(), |text, rule| text + &format!("- {}\n", rule.text()))
}

/// The text with the rule added after the last rule in "Always allow", or in a new
/// section at the end. Every other line stays byte for byte.
fn insert(text: &str, rule: &Rule) -> String {
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
    let mut at = None;
    let mut in_section = false;
    for (index, line) in lines.iter().enumerate() {
        if let Some(is_section) = heading(line) {
            in_section = is_section;
            if in_section {
                at = Some(index + 1);
            }
        } else if in_section && bullet(line).is_some_and(|item| !item.is_empty()) {
            at = Some(index + 1);
        }
    }
    if let Some(last) = lines.last_mut().filter(|last| !last.ends_with('\n')) {
        last.push('\n');
    }
    let line = format!("- {}\n", rule.text());
    match at {
        Some(at) => lines.insert(at, line),
        None => {
            if !lines.is_empty() {
                lines.push("\n".into());
            }
            lines.push(format!("## Always allow\n\n{line}"));
        }
    }
    lines.concat()
}

/// The text without the rule lines in "Always allow" that `drop` picks, by 1-based
/// line number and the bullet's text.
fn remove(text: &str, mut drop: impl FnMut(usize, &str) -> bool) -> String {
    let mut in_section = false;
    let mut kept = String::with_capacity(text.len());
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let bare = line.trim_end_matches(['\n', '\r']);
        if let Some(is_section) = heading(bare) {
            in_section = is_section;
        } else if in_section && bullet(bare).is_some_and(|item| drop(index + 1, item)) {
            continue;
        }
        kept.push_str(line);
    }
    kept
}

/// One thing waiting in the review list. The UI sends it back to accept or discard it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    /// In the file, not in force.
    Add { rule: Rule, text: String },
    /// In force, gone from the file.
    Remove { rule: Rule, text: String },
    Invalid(Invalid),
    /// The file can't be read in full; nothing in it applies until it can.
    Unreadable { reason: String },
}

/// How the file differs from the rules in force.
pub fn review(text: &str, accepted: &[Rule]) -> Vec<Change> {
    let parsed = parse(text);
    let added = parsed.rules.iter().filter(|rule| !accepted.contains(rule)).map(|rule| Change::Add { rule: rule.clone(), text: rule.text() });
    let removed = accepted.iter().filter(|rule| !parsed.rules.contains(rule)).map(|rule| Change::Remove { rule: rule.clone(), text: rule.text() });
    added.chain(removed).chain(parsed.invalid.into_iter().map(Change::Invalid)).collect()
}

pub fn path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Eavesy").join("assistant").join("rules.md"))
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    WRITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The file's text, written from the rules in force when it's missing: a missing file
/// is a file to make, not "remove every rule".
fn text_or_render(file: &Path, accepted: &[Rule]) -> Result<String, String> {
    if file.exists() { read_for_edit(file) } else { Ok(render(accepted)) }
}

/// Writes the file from the rules in force if it isn't there yet.
pub fn ensure(file: &Path, accepted: &[Rule]) -> Result<(), String> {
    let _guard = lock();
    if file.exists() { Ok(()) } else { write_text(file, &render(accepted)) }
}

pub fn pending(file: &Path, accepted: &[Rule]) -> Vec<Change> {
    match text_or_render(file, accepted) {
        Ok(text) => review(&text, accepted),
        Err(reason) => vec![Change::Unreadable { reason }],
    }
}

/// Adds the rule's line unless the file already has it. True when it wrote.
pub fn append(file: &Path, rule: &Rule, accepted: &[Rule]) -> Result<bool, String> {
    let _guard = lock();
    let text = text_or_render(file, accepted)?;
    if parse(&text).rules.contains(rule) {
        return Ok(false);
    }
    write_text(file, &insert(&text, rule))?;
    Ok(true)
}

/// Takes out every line for this rule; none is fine.
pub fn drop_rule(file: &Path, rule: &Rule) -> Result<(), String> {
    let _guard = lock();
    if !file.exists() {
        return Ok(());
    }
    let text = read_for_edit(file)?;
    let left = remove(&text, |_, item| rule_on(item).as_ref() == Ok(rule));
    if left == text { Ok(()) } else { write_text(file, &left) }
}

/// Takes out one refused line, if it still says what the review list showed.
fn drop_line(file: &Path, line: usize, shown: &str) -> Result<(), String> {
    let _guard = lock();
    let text = read_for_edit(file)?;
    let left = remove(&text, |at, item| at == line && super::memory::clean(item) == shown);
    if left == text { Err("That line changed. Look again.".into()) } else { write_text(file, &left) }
}

fn accepted(app: &AppHandle) -> Vec<Rule> {
    app.state::<Core>().policy.lock().unwrap().rules.clone()
}

#[derive(Serialize)]
pub struct RuleView {
    pub rule: Rule,
    pub text: String,
}

#[derive(Serialize)]
pub struct RulesView {
    pub rules: Vec<RuleView>,
    pub pending: Vec<Change>,
    pub path: Option<String>,
}

fn view(app: &AppHandle) -> RulesView {
    let rules = accepted(app);
    let file = path();
    if let Some(file) = &file {
        if let Err(error) = ensure(file, &rules) {
            tracing::warn!(%error, "assistant: couldn't write rules.md");
        }
    }
    RulesView {
        pending: file.as_deref().map(|file| pending(file, &rules)).unwrap_or_default(),
        rules: rules.into_iter().map(|rule| RuleView { text: rule.text(), rule }).collect(),
        path: file.map(|file| file.display().to_string()),
    }
}

/// Settings and the panel listen for this to look again.
const EVENT_CHANGED: &str = "assistant:rules";

fn changed(app: &AppHandle) -> RulesView {
    let _ = app.emit(EVENT_CHANGED, ());
    view(app)
}

#[tauri::command(async)]
pub fn assistant_rules(app: AppHandle, window: WebviewWindow) -> Result<RulesView, String> {
    super::from_ui(&window)?;
    Ok(view(&app))
}

fn confirm_rule(app: &AppHandle, rule: &Rule) -> bool {
    let message = format!(
        "When you ask, Eavesy will {} without a card, in every mode. It still checks each one right before it goes, and still asks when the double-check flags it, when it's more than 20 at once, or when you ask by voice in Ask.",
        lowercase_first(&rule.text())
    );
    super::confirm(app, "Always allow this?", &message, "Always Allow")
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

/// Adds a rule you named in Settings, after a native dialog a script can't click.
#[tauri::command]
pub async fn add_assistant_rule(app: AppHandle, window: WebviewWindow, kind: Kind, folder: String) -> Result<RulesView, String> {
    super::from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let rule = Rule::new(kind, &folder)?;
        let core = app.state::<Core>();
        if core.policy.lock().unwrap().rules.contains(&rule) {
            return Ok(view(&app));
        }
        if core.policy.lock().unwrap().rules.len() >= MAX_RULES {
            return Err(format!("Eavesy keeps {MAX_RULES} rules at most. Remove one first."));
        }
        if !confirm_rule(&app, &rule) {
            return Err("cancelled".into());
        }
        let before = accepted(&app);
        super::update(&core, |policy| {
            if !policy.rules.contains(&rule) {
                policy.rules.push(rule.clone());
            }
        })?;
        mirror(path().map(|file| append(&file, &rule, &before).map(drop)));
        super::log("You", "assistant.rule", &rule.text(), "ran", Some("added".into()));
        Ok(changed(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Removing a rule only takes power away, so it needs no dialog.
#[tauri::command]
pub async fn remove_assistant_rule(app: AppHandle, window: WebviewWindow, rule: Rule) -> Result<RulesView, String> {
    super::from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        super::update(&app.state::<Core>(), |policy| policy.rules.retain(|kept| kept != &rule))?;
        mirror(path().map(|file| drop_rule(&file, &rule)));
        super::log("You", "assistant.rule", &rule.text(), "ran", Some("removed".into()));
        Ok(changed(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The file only mirrors the rules in force, so failing to write it is a warning.
fn mirror(result: Option<Result<(), String>>) {
    if let Some(Err(error)) = result {
        tracing::warn!(%error, "assistant: couldn't update rules.md");
    }
}

/// Accepts a change from the review list, if it's still waiting right now. Adding a
/// rule asks in a native dialog worded from the parsed rule.
#[tauri::command]
pub async fn accept_assistant_rule_change(app: AppHandle, window: WebviewWindow, change: Change) -> Result<RulesView, String> {
    super::from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = path().ok_or("No home folder.")?;
        let core = app.state::<Core>();
        let still_waiting = |change: &Change| pending(&file, &accepted(&app)).iter().any(|waiting| same_change(waiting, change));
        if !still_waiting(&change) {
            return Err("That change isn't waiting any more. Look again.".into());
        }
        match &change {
            Change::Add { rule, .. } => {
                if accepted(&app).len() >= MAX_RULES {
                    return Err(format!("Eavesy keeps {MAX_RULES} rules at most. Remove one first."));
                }
                if !confirm_rule(&app, rule) {
                    return Err("cancelled".into());
                }
                // Looked at again: the file may have changed while the dialog was up.
                if !still_waiting(&change) {
                    return Err("rules.md changed while you were deciding. Look again.".into());
                }
                super::update(&core, |policy| {
                    if !policy.rules.contains(rule) {
                        policy.rules.push(rule.clone());
                    }
                })?;
                super::log("You", "assistant.rule", &rule.text(), "ran", Some("accepted from rules.md".into()));
            }
            Change::Remove { rule, .. } => {
                super::update(&core, |policy| policy.rules.retain(|kept| kept != rule))?;
                super::log("You", "assistant.rule", &rule.text(), "ran", Some("removed, as in rules.md".into()));
            }
            Change::Invalid(_) | Change::Unreadable { .. } => return Err("Fix that line in rules.md, or discard it.".into()),
        }
        Ok(changed(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Puts the file back the way the rules in force have it, for this one change.
#[tauri::command]
pub async fn discard_assistant_rule_change(app: AppHandle, window: WebviewWindow, change: Change) -> Result<RulesView, String> {
    super::from_ui(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = path().ok_or("No home folder.")?;
        match &change {
            Change::Add { rule, .. } => drop_rule(&file, rule)?,
            Change::Remove { rule, .. } => {
                // Only a rule still in force goes back in the file.
                if accepted(&app).contains(rule) {
                    append(&file, rule, &accepted(&app))?;
                }
            }
            Change::Invalid(invalid) => drop_line(&file, invalid.line, &invalid.text)?,
            Change::Unreadable { .. } => return Err("Fix rules.md in your editor.".into()),
        }
        Ok(changed(&app))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn same_change(a: &Change, b: &Change) -> bool {
    match (a, b) {
        (Change::Add { rule: x, .. }, Change::Add { rule: y, .. }) | (Change::Remove { rule: x, .. }, Change::Remove { rule: y, .. }) => x == y,
        _ => false,
    }
}

/// Opens rules.md in your default editor, writing it first so there's something to open.
#[tauri::command(async)]
#[allow(deprecated)]
pub fn open_assistant_rules(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    super::from_ui(&window)?;
    let file = path().ok_or("No home folder.")?;
    ensure(&file, &accepted(&app))?;
    app.shell().open(file.display().to_string(), None).map_err(|e| format!("Couldn't open it: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary folder standing in for a project, canonical so it compares.
    fn project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eavesy-rules-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("repo").join("wt")).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn rule(kind: Kind, under: &Path) -> Rule { Rule::new(kind, &under.to_string_lossy()).unwrap() }

    #[test]
    fn a_rule_names_a_real_project_folder() {
        let dir = project();
        assert_eq!(rule(Kind::RemoveWorktrees, &dir).under, dir);
        assert!(Rule::new(Kind::RemoveWorktrees, "/").is_err());
        assert!(Rule::new(Kind::RemoveWorktrees, "~").is_err());
        assert!(Rule::new(Kind::RemoveWorktrees, "~/").is_err());
        assert!(Rule::new(Kind::RemoveWorktrees, "relative/path").is_err());
        assert!(Rule::new(Kind::RemoveWorktrees, &dir.join("missing").to_string_lossy()).is_err());
        // A `..` resolves to the real folder it names.
        let up = rule(Kind::StopLeftovers, &dir.join("repo").join(".."));
        assert_eq!(up.under, dir);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn every_row_must_be_covered_by_a_rule_of_its_kind() {
        let dir = project();
        let (repo, wt) = (dir.join("repo"), dir.join("repo").join("wt"));
        let rules = vec![rule(Kind::RemoveWorktrees, &repo)];
        let worktree = Scope { kind: Kind::RemoveWorktrees, path: Some(wt.clone()) };
        let process = Scope { kind: Kind::StopLeftovers, path: Some(wt.clone()) };
        assert_eq!(covering(&rules, std::slice::from_ref(&worktree), 1), Some(rules.clone()));
        // The other kind, an uncovered row, a row without a folder, or a row count that
        // doesn't match is a card.
        assert_eq!(covering(&rules, std::slice::from_ref(&process), 1), None);
        assert_eq!(covering(&rules, &[worktree.clone(), process], 2), None);
        assert_eq!(covering(&rules, &[Scope { kind: Kind::RemoveWorktrees, path: None }], 1), None);
        assert_eq!(covering(&rules, std::slice::from_ref(&worktree), 2), None);
        assert_eq!(covering(&rules, &[], 0), None);
        // Outside the folder, or only a sibling with the same prefix.
        std::fs::create_dir_all(dir.join("repo-evil")).unwrap();
        assert_eq!(covering(&rules, &[Scope { kind: Kind::RemoveWorktrees, path: Some(dir.join("repo-evil")) }], 1), None);
        assert_eq!(covering(&rules, &[Scope { kind: Kind::RemoveWorktrees, path: Some(wt.join("..").join("..").join("repo-evil")) }], 1), None);
        // A path that doesn't exist can't be placed.
        assert_eq!(covering(&rules, &[Scope { kind: Kind::RemoveWorktrees, path: Some(repo.join("gone")) }], 1), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_file_round_trips_and_refuses_lines_it_cant_use() {
        let dir = project();
        let rules = vec![rule(Kind::RemoveWorktrees, &dir), rule(Kind::StopLeftovers, &dir.join("repo"))];
        assert_eq!(parse(&render(&rules)), Parsed { rules: rules.clone(), invalid: vec![] });
        let text = format!(
            "# Mine\n\n- not in the section\n\n## Always allow\n\nSome words.\n- remove FINISHED worktrees under {d}\n- Delete everything under {d}\n- Stop leftover processes under {d}/missing\n-   \n## Instructions\n\n- Remove finished worktrees under /\n",
            d = dir.display()
        );
        let parsed = parse(&text);
        assert_eq!(parsed.rules, vec![rule(Kind::RemoveWorktrees, &dir)]);
        assert_eq!(parsed.invalid.iter().map(|invalid| invalid.line).collect::<Vec<_>>(), [9, 10]);
        assert!(parsed.invalid[1].reason.contains("isn't a folder"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn review_lists_additions_removals_and_refused_lines() {
        let dir = project();
        let (a, b) = (rule(Kind::RemoveWorktrees, &dir), rule(Kind::StopLeftovers, &dir));
        let text = format!("## Always allow\n- {}\n- nonsense\n", a.text());
        let changes = review(&text, std::slice::from_ref(&b));
        assert_eq!(changes.len(), 3);
        assert!(matches!(&changes[0], Change::Add { rule, .. } if rule == &a));
        assert!(matches!(&changes[1], Change::Remove { rule, .. } if rule == &b));
        assert!(matches!(&changes[2], Change::Invalid(Invalid { line: 3, .. })));
        assert!(review(&render(std::slice::from_ref(&a)), &[a]).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn edits_leave_your_own_lines_alone() {
        let dir = project();
        let file = dir.join("rules.md");
        let (a, b) = (rule(Kind::RemoveWorktrees, &dir), rule(Kind::StopLeftovers, &dir));
        // Missing: written from the rules in force, so nothing shows as removed.
        assert!(pending(&file, std::slice::from_ref(&a)).is_empty());
        let mine = format!("# Mine\n\nWords.\n\n## Always allow\n\n- {}\n\n## Later\n\nMore words.", a.text());
        std::fs::write(&file, &mine).unwrap();
        assert!(append(&file, &b, &[]).unwrap());
        assert!(!append(&file, &b, &[]).unwrap());
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, format!("# Mine\n\nWords.\n\n## Always allow\n\n- {}\n- {}\n\n## Later\n\nMore words.\n", a.text(), b.text()));
        drop_rule(&file, &a).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("# Mine\n\nWords.\n\n## Always allow\n\n- {}\n\n## Later\n\nMore words.\n", b.text()));
        // No section yet: one is added at the end.
        std::fs::write(&file, "# Mine\n").unwrap();
        append(&file, &a, &[]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("# Mine\n\n## Always allow\n\n- {}\n", a.text()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_refused_line_is_dropped_only_while_it_says_the_same() {
        let dir = project();
        let file = dir.join("rules.md");
        std::fs::write(&file, "## Always allow\n- nonsense\n- other\n").unwrap();
        assert!(drop_line(&file, 2, "changed").is_err());
        drop_line(&file, 2, "nonsense").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "## Always allow\n- other\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unreadable_file_is_one_pending_change() {
        let dir = project();
        let file = dir.join("rules.md");
        std::fs::write(&file, b"## Always allow\n\xff\n").unwrap();
        assert!(matches!(pending(&file, &[]).as_slice(), [Change::Unreadable { .. }]));
        assert!(append(&file, &rule(Kind::RemoveWorktrees, &dir), &[]).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"## Always allow\n\xff\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_change_crosses_to_the_ui_and_back() {
        let dir = project();
        let change = Change::Add { rule: rule(Kind::RemoveWorktrees, &dir), text: "x".into() };
        let json = serde_json::to_value(&change).unwrap();
        assert_eq!(json["kind"], "add");
        assert_eq!(json["rule"]["kind"], "remove_worktrees");
        assert_eq!(serde_json::from_value::<Change>(json).unwrap(), change);
        let invalid = serde_json::to_value(Change::Invalid(Invalid { line: 2, text: "t".into(), reason: "r".into() })).unwrap();
        assert_eq!(invalid, serde_json::json!({"kind": "invalid", "line": 2, "text": "t", "reason": "r"}));
        let _ = std::fs::remove_dir_all(dir);
    }
}
