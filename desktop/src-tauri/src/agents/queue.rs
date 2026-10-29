//! The sessions waiting on you, one item per session, in the order Eavesy
//! talks about them: approvals, then questions, then finished turns, oldest
//! first within each.

use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Approval,
    Question,
    Finished,
}

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: u64,
    pub session_id: String,
    pub name: String,
    pub kind: Kind,
    /// None until the summary is back.
    pub summary: Option<String>,
    pub suggestion: Option<String>,
    /// Claude's own words, shown under the summary.
    pub message: Option<String>,
    /// The session's hook is waiting for your reply.
    pub held: bool,
    pub spoken: bool,
    /// A reply you dictated, read back and waiting for your "send it".
    pub draft: Option<String>,
    /// You clicked into the reply to type: voice answers leave it alone.
    pub typing: bool,
    /// You said no to what Eavesy offered, so "send it" sends nothing.
    pub declined: bool,
    pub received_at: u64,
    /// Where the session runs, so the card can tell 20 sessions apart.
    pub origin: Origin,
    /// A finished item is already set to leave the card.
    #[serde(skip)]
    pub lingering: bool,
}

/// Where a session runs: its folder (shortened with `~`), branch and app.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Origin {
    pub cwd: Option<String>,
    pub branch: Option<String>,
    /// The app's name, like "iTerm".
    pub app: Option<String>,
    /// Its bundle id, for bringing it to the front; never sent to the card.
    #[serde(skip)]
    pub bundle: Option<String>,
    /// The full folder, for an editor that finds its window by folder.
    #[serde(skip)]
    pub full_cwd: Option<String>,
}

impl Item {
    /// What Eavesy last asked "Send that?" about, until you said no.
    pub fn offered(&self) -> Option<&str> {
        if self.declined {
            return None;
        }
        self.draft.as_deref().or(self.suggestion.as_deref())
    }
}

const MAX_PROMPTS: usize = 200;

#[derive(Debug, Default)]
pub struct Queue {
    items: Vec<Item>,
    next_id: u64,
    /// The last prompt you sent each session, so a summary knows what was asked.
    prompts: HashMap<String, String>,
}

impl Queue {
    /// Adds an item for a session, replacing (and returning) one already there.
    pub fn push(&mut self, session_id: &str, name: String, kind: Kind, message: Option<String>, held: bool, now: u64) -> (u64, Option<Item>) {
        let replaced = self.remove_session(session_id);
        self.next_id += 1;
        let id = self.next_id;
        self.items.push(Item { id, session_id: session_id.to_string(), name, kind, summary: None, suggestion: None, message, held, spoken: false, draft: None, typing: false, declined: false, received_at: now, origin: Origin::default(), lingering: false });
        (id, replaced)
    }

    /// Fills in the summary. A finished turn that needs nothing from you stops
    /// being held. Returns false when the item is gone.
    pub fn resolve(&mut self, id: u64, summary: String, suggestion: Option<String>, needs_you: bool) -> bool {
        let Some(item) = self.items.iter_mut().find(|item| item.id == id) else { return false };
        item.summary = Some(summary);
        if item.kind != Kind::Approval {
            item.kind = if needs_you { Kind::Question } else { Kind::Finished };
            item.suggestion = suggestion.filter(|s| !s.trim().is_empty() && needs_you);
        }
        if item.kind != Kind::Question {
            item.held = false;
        }
        true
    }

    pub fn set_origin(&mut self, id: u64, origin: Origin) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.origin = origin;
        }
    }

    /// Finished items on the card that haven't been set to leave yet. Marks them.
    pub fn start_lingering(&mut self) -> Vec<u64> {
        self.items
            .iter_mut()
            .filter(|item| item.summary.is_some() && item.kind == Kind::Finished && !item.lingering)
            .map(|item| {
                item.lingering = true;
                item.id
            })
            .collect()
    }

    pub fn get(&self, id: u64) -> Option<&Item> {
        self.items.iter().find(|item| item.id == id)
    }

    pub fn mark_spoken(&mut self, id: u64) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.spoken = true;
        }
    }

    /// Not said after all, so it's said next time.
    pub fn unmark_spoken(&mut self, id: u64) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.spoken = false;
        }
    }

    pub fn set_draft(&mut self, id: u64, draft: String) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.draft = Some(draft);
            item.declined = false;
        }
    }

    pub fn decline(&mut self, id: u64) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.declined = true;
        }
    }

    pub fn set_typing(&mut self, id: u64) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.typing = true;
        }
    }

    /// The session stopped waiting. Returns true when the item was held.
    pub fn unhold(&mut self, id: u64) -> bool {
        match self.items.iter_mut().find(|item| item.id == id) {
            Some(item) if item.held => {
                item.held = false;
                true
            }
            _ => false,
        }
    }

    pub fn remove(&mut self, id: u64) -> Option<Item> {
        let at = self.items.iter().position(|item| item.id == id)?;
        Some(self.items.remove(at))
    }

    pub fn remove_session(&mut self, session_id: &str) -> Option<Item> {
        let at = self.items.iter().position(|item| item.session_id == session_id)?;
        Some(self.items.remove(at))
    }

    /// Takes the session's approval off, once the tool it asked about has run.
    pub fn clear_approval(&mut self, session_id: &str) -> Option<Item> {
        let at = self.items.iter().position(|item| item.session_id == session_id && item.kind == Kind::Approval)?;
        Some(self.items.remove(at))
    }

    /// Puts an item behind the others of its kind.
    pub fn later(&mut self, id: u64, now: u64) {
        if let Some(item) = self.items.iter_mut().find(|item| item.id == id) {
            item.received_at = now;
            item.spoken = false;
        }
    }

    /// Ready items in speaking order. Items still being summarized wait.
    pub fn ordered(&self) -> Vec<&Item> {
        let mut ready: Vec<&Item> = self.items.iter().filter(|item| item.summary.is_some()).collect();
        ready.sort_by_key(|item| (item.kind, item.received_at, item.id));
        ready
    }

    pub fn head(&self) -> Option<&Item> {
        self.ordered().into_iter().next()
    }

    pub fn names_in_use(&self) -> Vec<(String, String)> {
        self.items.iter().map(|item| (item.session_id.clone(), item.name.clone())).collect()
    }

    pub fn note_prompt(&mut self, session_id: &str, prompt: String) {
        if self.prompts.len() >= MAX_PROMPTS && !self.prompts.contains_key(session_id) {
            if let Some(key) = self.prompts.keys().next().cloned() {
                self.prompts.remove(&key);
            }
        }
        self.prompts.insert(session_id.to_string(), prompt);
    }

    pub fn prompt(&self, session_id: &str) -> Option<&str> {
        self.prompts.get(session_id).map(String::as_str)
    }
}

/// One line for several sessions that finished at about the same time:
/// "3 sessions finished: eavesy, docs and repackify."
pub fn finished_together(names: &[&str]) -> String {
    let list = match names {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    format!("{} sessions finished: {list}.", names.len())
}

/// What Eavesy says for the item at the front, with how many others wait.
pub fn speech(item: &Item, others_waiting: usize) -> String {
    let summary = item.summary.as_deref().unwrap_or_default().trim().trim_end_matches('.');
    let mut out = String::new();
    if others_waiting > 0 {
        let total = others_waiting + 1;
        out.push_str(&format!("{total} sessions need you. First, "));
    }
    out.push_str(&format!("{}: {summary}.", item.name));
    if let Some(suggestion) = item.suggestion.as_deref() {
        out.push_str(&format!(" I'd say: {}. Send that?", suggestion.trim().trim_end_matches('.')));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(queue: &mut Queue, session: &str, kind: Kind, needs_you: bool, at: u64) -> u64 {
        let (id, _) = queue.push(session, session.to_string(), kind, None, true, at);
        queue.resolve(id, format!("{session} summary"), Some("yes".into()), needs_you);
        id
    }

    #[test]
    fn approvals_come_first_then_questions_then_finished() {
        let mut queue = Queue::default();
        ready(&mut queue, "done", Kind::Finished, false, 1);
        ready(&mut queue, "late-question", Kind::Finished, true, 5);
        ready(&mut queue, "question", Kind::Finished, true, 2);
        ready(&mut queue, "approval", Kind::Approval, false, 9);
        let order: Vec<&str> = queue.ordered().iter().map(|item| item.session_id.as_str()).collect();
        assert_eq!(order, ["approval", "question", "late-question", "done"]);
    }

    #[test]
    fn only_a_question_stays_held() {
        let mut queue = Queue::default();
        let question = ready(&mut queue, "q", Kind::Finished, true, 1);
        let done = ready(&mut queue, "d", Kind::Finished, false, 2);
        assert!(queue.get(question).unwrap().held);
        assert!(!queue.get(done).unwrap().held);
        assert_eq!(queue.get(done).unwrap().suggestion, None);
    }

    #[test]
    fn a_new_stop_replaces_the_sessions_old_item() {
        let mut queue = Queue::default();
        let first = ready(&mut queue, "s", Kind::Finished, true, 1);
        let (_, replaced) = queue.push("s", "s".into(), Kind::Finished, None, true, 2);
        assert_eq!(replaced.map(|item| item.id), Some(first));
        assert_eq!(queue.ordered().len(), 0, "the new one waits for its summary");
    }

    #[test]
    fn later_moves_an_item_behind_its_kind() {
        let mut queue = Queue::default();
        let a = ready(&mut queue, "a", Kind::Finished, true, 1);
        ready(&mut queue, "b", Kind::Finished, true, 2);
        queue.later(a, 3);
        assert_eq!(queue.head().unwrap().session_id, "b");
    }

    #[test]
    fn speech_names_the_session_and_the_suggestion() {
        let mut queue = Queue::default();
        let id = ready(&mut queue, "eavesy", Kind::Finished, true, 1);
        let item = queue.get(id).unwrap().clone();
        assert_eq!(speech(&item, 0), "eavesy: eavesy summary. I'd say: yes. Send that?");
        assert!(speech(&item, 2).starts_with("3 sessions need you. First, eavesy:"));
    }
}
