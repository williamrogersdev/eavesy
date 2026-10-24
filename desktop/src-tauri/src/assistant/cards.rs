//! Pending cards. A card holds the exact action the core will run; the UI only ever
//! sends back `{card_id, accepted_row_ids}`, so nothing it says can change what runs
//! (assistant.md C2). Ids are random, cards expire, and each is used once.

use serde::Serialize;

/// How long a card waits for a click.
pub const CARD_LIFETIME_MS: u64 = 5 * 60 * 1000;
/// More waiting cards than this and the oldest goes, so an agent can't bury the panel.
pub const MAX_PENDING: usize = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Row {
    pub id: String,
    pub label: String,
}

/// What the panel shows. Built by the core from the tool, never from the requester's text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CardView {
    pub id: String,
    /// "Claude Code · eavesy is asking".
    pub requester: String,
    pub tool: String,
    pub title: String,
    pub rows: Vec<Row>,
    /// Warn ink: the check's flag, or why this didn't run on its own.
    pub warning: Option<String>,
    pub expires_ms: u64,
}

struct Pending<A> {
    view: CardView,
    action: A,
}

pub struct Cards<A> {
    pending: Vec<Pending<A>>,
}

impl<A> Default for Cards<A> {
    fn default() -> Self { Cards { pending: Vec::new() } }
}

#[derive(Debug, PartialEq, Eq)]
pub enum TakeError {
    Unknown,
    Expired,
}

impl<A> Cards<A> {
    /// Adds a card and returns what the panel shows, plus any card it pushed out.
    pub fn add(&mut self, now_ms: u64, mut view: CardView, action: A) -> (CardView, Option<CardView>) {
        view.id = uuid::Uuid::new_v4().simple().to_string();
        view.expires_ms = now_ms + CARD_LIFETIME_MS;
        let dropped = (self.pending.len() >= MAX_PENDING).then(|| self.pending.remove(0).view);
        self.pending.push(Pending { view: view.clone(), action });
        (view, dropped)
    }

    /// Cards still waiting, oldest first. Expired ones are removed and returned apart.
    pub fn list(&mut self, now_ms: u64) -> (Vec<CardView>, Vec<CardView>) {
        let (live, expired): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending).into_iter().partition(|card| now_ms < card.view.expires_ms);
        self.pending = live;
        (self.pending.iter().map(|card| card.view.clone()).collect(), expired.into_iter().map(|card| card.view).collect())
    }

    /// Removes the card and hands back its stored action with the accepted rows: only
    /// ids that are on the card, each once, in the card's order. None accepted is a decline.
    pub fn take(&mut self, now_ms: u64, id: &str, accepted: &[String]) -> Result<(CardView, A, Vec<String>), TakeError> {
        let index = self.pending.iter().position(|card| card.view.id == id).ok_or(TakeError::Unknown)?;
        let Pending { view, action } = self.pending.remove(index);
        if now_ms >= view.expires_ms {
            return Err(TakeError::Expired);
        }
        let rows = view.rows.iter().filter(|row| accepted.contains(&row.id)).map(|row| row.id.clone()).collect();
        Ok((view, action, rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(rows: &[&str]) -> CardView {
        CardView {
            id: "chosen-by-caller".into(),
            requester: "You".into(),
            tool: "t".into(),
            title: "Do it".into(),
            rows: rows.iter().map(|id| Row { id: (*id).into(), label: format!("row {id}") }).collect(),
            warning: None,
            expires_ms: u64::MAX,
        }
    }

    #[test]
    fn a_card_runs_only_its_own_rows_once() {
        let mut cards = Cards::default();
        let (shown, _) = cards.add(0, view(&["a", "b", "c"]), "stored");
        assert_ne!(shown.id, "chosen-by-caller");
        assert_eq!(shown.expires_ms, CARD_LIFETIME_MS);
        let accepted = ["c".to_string(), "a".into(), "a".into(), "z".into()];
        let (_, action, rows) = cards.take(1, &shown.id, &accepted).unwrap();
        assert_eq!(action, "stored");
        assert_eq!(rows, ["a", "c"]);
        assert_eq!(cards.take(1, &shown.id, &accepted).unwrap_err(), TakeError::Unknown);
    }

    #[test]
    fn an_expired_card_is_gone() {
        let mut cards = Cards::default();
        let (shown, _) = cards.add(0, view(&["a"]), ());
        assert_eq!(cards.take(CARD_LIFETIME_MS, &shown.id, &["a".into()]).unwrap_err(), TakeError::Expired);
        let (second, _) = cards.add(0, view(&["a"]), ());
        let (live, expired) = cards.list(CARD_LIFETIME_MS);
        assert!(live.is_empty());
        assert_eq!(expired[0].id, second.id);
    }

    #[test]
    fn a_flood_pushes_out_the_oldest() {
        let mut cards = Cards::default();
        let (first, _) = cards.add(0, view(&[]), 0);
        for n in 1..MAX_PENDING {
            assert_eq!(cards.add(0, view(&[]), n).1, None);
        }
        let (_, dropped) = cards.add(0, view(&[]), MAX_PENDING);
        assert_eq!(dropped.unwrap().id, first.id);
        assert_eq!(cards.list(1).0.len(), MAX_PENDING);
    }
}
