//! Who may do what without a click (docs/plans/assistant.md C and C8).
//!
//! `decide` is the one place that turns an action into "run", "read it back",
//! "show a card" or "refuse". Everything it reads is fixed in code (a tool's
//! tier and reversibility), decided by the channel a request arrived on (who
//! asked), or loaded from the signed policy file (the mode). Nothing a model,
//! an agent or a web page writes reaches it.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How much an action can change, fixed per tool in code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Reads, never changes anything.
    Look,
    /// Small, reversible, stays inside Eavesy or opens something.
    Do,
    /// Sends your words somewhere.
    Say,
    /// Changes or removes something outside Eavesy, or grants power.
    Click,
    /// Never offered.
    Never,
}

/// Who asked, from the channel the request came in on, never from what the request says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Requester {
    /// You, in Eavesy's own UI or conversation. `spoken` when it came by voice.
    You { spoken: bool },
    /// A same-user agent on the local socket, identified by its peer pid.
    LocalAgent { name: String, folder: Option<PathBuf> },
    /// An agent through the cloud MCP and the Mac link.
    Remote { name: String },
    /// One of Eavesy's monitors. Monitors only propose (D3).
    Monitor { name: String },
}

impl Requester {
    /// How a card names who's asking (N3).
    pub fn label(&self) -> String {
        match self {
            Requester::You { .. } => "You".into(),
            Requester::LocalAgent { name, folder } => match folder.as_deref().and_then(Path::file_name) {
                Some(folder) => format!("{name} · {}", folder.to_string_lossy()),
                None => name.clone(),
            },
            Requester::Remote { name } => format!("{name} (remote)"),
            Requester::Monitor { name } => format!("Monitor: {name}"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Ask,
    Auto,
    Bypass,
}

/// The mode in force right now: an expired Bypass, or a policy file that failed its
/// signature check, already folded back to Ask by the caller.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Effective {
    pub mode: Mode,
    /// Agents working inside these folders are treated as you (C8, "Trust local agents").
    pub trusted_folders: Vec<PathBuf>,
}

/// Facts about the proposed action. All of them come from the tool's code, not the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    pub tier: Tier,
    /// The tool can put things back (Undo).
    pub undoable: bool,
    /// On Auto's safe list (C8): undoable and local.
    pub safe_listed: bool,
    /// Can't be taken back: revoke a key, push, post publicly.
    pub irreversible: bool,
    /// Adds a connection or changes Eavesy's rules.
    pub grants_power: bool,
    /// The tool may be asked for by a remote agent at all (N4).
    pub remote_allowed: bool,
    /// How many things it touches (rows on its card).
    pub items: usize,
}

/// The second-model check's answer (C7).
/// Built by the check itself, which arrives with the conversation (build step 5).
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Check {
    /// Not run: Look and Do don't need it.
    NotRun,
    Pass,
    /// It doesn't match what was asked; the reason goes on the card in warn ink.
    Flagged(String),
    /// Errored, timed out or offline. Fails closed.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Run it now and say what happened.
    Run,
    /// Run it now, with Undo held for `undo_for`.
    RunWithUndo { undo_for: Duration },
    /// Tier 2 in Ask: read it back and wait for "yes" or a click.
    ReadBack,
    /// Show a card; only a click runs it.
    Card { warning: Option<String> },
    Refuse(&'static str),
}

pub const UNDO_FOR: Duration = Duration::from_secs(10);
pub const UNDO_FOR_BYPASS: Duration = Duration::from_secs(60);
/// One action touching more than this many things always gets a card.
pub const MAX_UNATTENDED_ITEMS: usize = 20;

pub fn decide(facts: &Facts, requester: &Requester, policy: &Effective, check: &Check, breaker: &Breaker) -> Decision {
    if facts.tier == Tier::Never {
        return Decision::Refuse("Eavesy never does this.");
    }
    if matches!(requester, Requester::Remote { .. }) && !facts.remote_allowed {
        return Decision::Refuse("Remote agents can't ask for this.");
    }
    let undo_for = if policy.mode == Mode::Bypass { UNDO_FOR_BYPASS } else { UNDO_FOR };
    match facts.tier {
        Tier::Look => return Decision::Run,
        Tier::Do => {
            return match requester {
                Requester::You { .. } | Requester::LocalAgent { .. } => Decision::RunWithUndo { undo_for },
                Requester::Remote { .. } | Requester::Monitor { .. } => Decision::Card { warning: None },
            };
        }
        Tier::Say | Tier::Click => {}
        Tier::Never => unreachable!(),
    }

    // Tier 2 and 3 from here. A check that flagged or failed is a card in every mode.
    match check {
        Check::Flagged(reason) => return Decision::Card { warning: Some(reason.clone()) },
        Check::Failed | Check::NotRun => {
            return Decision::Card { warning: Some("Eavesy couldn't double-check this, so it's asking.".into()) };
        }
        Check::Pass => {}
    }

    // Remote agents and monitors always get a card; agents do unless you trust their folder.
    let acts_as_you = match requester {
        Requester::You { .. } => true,
        Requester::LocalAgent { folder, .. } => policy.mode != Mode::Ask && is_trusted(folder.as_deref(), &policy.trusted_folders),
        Requester::Remote { .. } | Requester::Monitor { .. } => false,
    };
    if !acts_as_you {
        return Decision::Card { warning: None };
    }
    let spoken = matches!(requester, Requester::You { spoken: true });

    let unattended_ok = facts.items <= MAX_UNATTENDED_ITEMS && !breaker.tripped();
    match (policy.mode, facts.tier) {
        (Mode::Ask, Tier::Say) => Decision::ReadBack,
        (Mode::Ask, _) => Decision::Card { warning: None },
        (Mode::Auto, Tier::Say) if unattended_ok => Decision::Run,
        (Mode::Auto, _) if unattended_ok && auto_may_run(facts) => {
            if facts.undoable { Decision::RunWithUndo { undo_for } } else { Decision::Run }
        }
        (Mode::Bypass, _) if unattended_ok => {
            if facts.undoable { Decision::RunWithUndo { undo_for } } else { Decision::Run }
        }
        // Voice can open a card but never press it; nothing changes that here.
        _ if spoken => Decision::Card { warning: None },
        _ => Decision::Card { warning: breaker.tripped().then(|| "That's a lot at once, so Eavesy is asking.".to_string()) },
    }
}

/// Auto runs tier 3 only when it can be undone or is on the safe list, and never when it
/// can't be taken back or hands out power.
fn auto_may_run(facts: &Facts) -> bool {
    (facts.undoable || facts.safe_listed) && !facts.irreversible && !facts.grants_power
}

fn is_trusted(folder: Option<&Path>, trusted: &[PathBuf]) -> bool {
    let Some(folder) = folder else { return false };
    // `starts_with` compares components, so `/r/eavesy/../evil` would pass it.
    let plain = folder.is_absolute() && folder.components().all(|part| matches!(part, std::path::Component::RootDir | std::path::Component::Normal(_)));
    plain && trusted.iter().any(|root| folder.starts_with(root))
}

/// Trips when unattended tier 2 and 3 actions come too fast, so a runaway loop
/// drops back to cards while you aren't clicking.
#[derive(Debug)]
pub struct Breaker {
    window: Duration,
    limit: usize,
    runs: VecDeque<Instant>,
}

impl Default for Breaker {
    fn default() -> Self { Breaker::new(Duration::from_secs(60), 5) }
}

impl Breaker {
    pub fn new(window: Duration, limit: usize) -> Self { Breaker { window, limit, runs: VecDeque::new() } }

    pub fn tripped(&self) -> bool { self.tripped_at(Instant::now()) }

    fn tripped_at(&self, now: Instant) -> bool {
        self.runs.iter().filter(|at| now.duration_since(**at) < self.window).count() >= self.limit
    }

    /// Records one tier 2 or 3 action that ran without a click.
    pub fn record(&mut self) { self.record_at(Instant::now()) }

    fn record_at(&mut self, now: Instant) {
        while self.runs.front().is_some_and(|at| now.duration_since(*at) >= self.window) {
            self.runs.pop_front();
        }
        self.runs.push_back(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(tier: Tier) -> Facts {
        Facts { tier, undoable: false, safe_listed: false, irreversible: false, grants_power: false, remote_allowed: false, items: 1 }
    }

    fn you() -> Requester { Requester::You { spoken: false } }
    fn agent(folder: &str) -> Requester { Requester::LocalAgent { name: "Claude Code".into(), folder: Some(folder.into()) } }
    fn remote() -> Requester { Requester::Remote { name: "cloud".into() } }
    fn monitor() -> Requester { Requester::Monitor { name: "leftovers".into() } }
    fn mode(mode: Mode) -> Effective { Effective { mode, trusted_folders: vec!["/Users/w/Developer/eavesy".into()] } }

    const TIERS: [Tier; 5] = [Tier::Look, Tier::Do, Tier::Say, Tier::Click, Tier::Never];
    const MODES: [Mode; 3] = [Mode::Ask, Mode::Auto, Mode::Bypass];

    fn requesters() -> Vec<Requester> {
        vec![you(), Requester::You { spoken: true }, agent("/Users/w/Developer/eavesy/web"), agent("/tmp/x"), remote(), monitor()]
    }

    fn checks() -> Vec<Check> { vec![Check::NotRun, Check::Pass, Check::Flagged("no".into()), Check::Failed] }

    /// Every combination of the inputs, for the invariants below.
    fn every_case(mut assert: impl FnMut(&Facts, &Requester, &Effective, &Check, bool, Decision)) {
        for tier in TIERS {
            for bits in 0..32u8 {
                let facts = Facts {
                    tier,
                    undoable: bits & 1 != 0,
                    safe_listed: bits & 2 != 0,
                    irreversible: bits & 4 != 0,
                    grants_power: bits & 8 != 0,
                    remote_allowed: bits & 16 != 0,
                    items: 1,
                };
                for requester in requesters() {
                    for m in MODES {
                        for check in checks() {
                            for tripped in [false, true] {
                                let mut breaker = Breaker::new(Duration::from_secs(60), 1);
                                if tripped { breaker.record(); }
                                let policy = mode(m);
                                let decision = decide(&facts, &requester, &policy, &check, &breaker);
                                assert(&facts, &requester, &policy, &check, tripped, decision);
                            }
                        }
                    }
                }
            }
        }
    }

    fn runs(decision: &Decision) -> bool { matches!(decision, Decision::Run | Decision::RunWithUndo { .. }) }

    #[test]
    fn never_always_refuses() {
        every_case(|facts, _, _, _, _, decision| {
            if facts.tier == Tier::Never { assert!(matches!(decision, Decision::Refuse(_))); }
        });
    }

    #[test]
    fn remote_never_runs_anything_but_a_look() {
        every_case(|facts, requester, _, _, _, decision| {
            if matches!(requester, Requester::Remote { .. }) && facts.tier != Tier::Look {
                assert!(matches!(decision, Decision::Card { .. } | Decision::Refuse(_)), "{facts:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn monitors_only_propose() {
        every_case(|facts, requester, _, _, _, decision| {
            if matches!(requester, Requester::Monitor { .. }) && facts.tier != Tier::Look {
                assert!(!runs(&decision), "{facts:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn a_flagged_or_failed_check_is_always_a_card() {
        every_case(|facts, _, _, check, _, decision| {
            if matches!(facts.tier, Tier::Say | Tier::Click) && !matches!(check, Check::Pass) {
                assert!(matches!(decision, Decision::Card { .. } | Decision::Refuse(_)), "{facts:?} {check:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn ask_never_runs_tier_2_or_3_without_you() {
        every_case(|facts, _, policy, _, _, decision| {
            if policy.mode == Mode::Ask && matches!(facts.tier, Tier::Say | Tier::Click) {
                assert!(!runs(&decision), "{facts:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn untrusted_agents_never_run_tier_2_or_3() {
        every_case(|facts, requester, _, _, _, decision| {
            if requester == &agent("/tmp/x") && matches!(facts.tier, Tier::Say | Tier::Click) {
                assert!(!runs(&decision), "{facts:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn auto_never_runs_what_cant_be_taken_back_or_grants_power() {
        every_case(|facts, _, policy, _, _, decision| {
            if policy.mode == Mode::Auto && facts.tier == Tier::Click && (facts.irreversible || facts.grants_power) {
                assert!(!runs(&decision), "{facts:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn a_tripped_breaker_stops_unattended_tier_2_and_3() {
        every_case(|facts, _, _, _, tripped, decision| {
            if tripped && matches!(facts.tier, Tier::Say | Tier::Click) {
                assert!(!runs(&decision), "{facts:?} → {decision:?}");
            }
        });
    }

    #[test]
    fn the_common_paths() {
        let pass = Check::Pass;
        let quiet = Breaker::default();
        // Remote agents reach only tools that opt in (N4), reading included.
        assert!(matches!(decide(&facts(Tier::Look), &remote(), &mode(Mode::Ask), &Check::NotRun, &quiet), Decision::Refuse(_)));
        let open_to_remote = Facts { remote_allowed: true, ..facts(Tier::Look) };
        assert_eq!(decide(&open_to_remote, &remote(), &mode(Mode::Ask), &Check::NotRun, &quiet), Decision::Run);
        assert_eq!(decide(&facts(Tier::Do), &you(), &mode(Mode::Ask), &Check::NotRun, &quiet), Decision::RunWithUndo { undo_for: UNDO_FOR });
        assert_eq!(decide(&facts(Tier::Say), &you(), &mode(Mode::Ask), &pass, &quiet), Decision::ReadBack);
        assert_eq!(decide(&facts(Tier::Click), &you(), &mode(Mode::Ask), &pass, &quiet), Decision::Card { warning: None });
        assert_eq!(decide(&facts(Tier::Say), &you(), &mode(Mode::Auto), &pass, &quiet), Decision::Run);
        let trash = Facts { undoable: true, safe_listed: true, ..facts(Tier::Click) };
        assert_eq!(decide(&trash, &you(), &mode(Mode::Auto), &pass, &quiet), Decision::RunWithUndo { undo_for: UNDO_FOR });
        let revoke = Facts { irreversible: true, ..facts(Tier::Click) };
        assert_eq!(decide(&revoke, &you(), &mode(Mode::Auto), &pass, &quiet), Decision::Card { warning: None });
        assert_eq!(decide(&revoke, &you(), &mode(Mode::Bypass), &pass, &quiet), Decision::Run);
        assert_eq!(decide(&trash, &you(), &mode(Mode::Bypass), &pass, &quiet), Decision::RunWithUndo { undo_for: UNDO_FOR_BYPASS });
        let trusted = agent("/Users/w/Developer/eavesy/web");
        assert_eq!(decide(&trash, &trusted, &mode(Mode::Bypass), &pass, &quiet), Decision::RunWithUndo { undo_for: UNDO_FOR_BYPASS });
        assert_eq!(decide(&trash, &trusted, &mode(Mode::Ask), &pass, &quiet), Decision::Card { warning: None });
        let many = Facts { items: MAX_UNATTENDED_ITEMS + 1, ..trash };
        assert!(matches!(decide(&many, &you(), &mode(Mode::Bypass), &pass, &quiet), Decision::Card { .. }));
    }

    #[test]
    fn a_folder_is_trusted_only_inside_a_trusted_root() {
        let roots = vec![PathBuf::from("/Users/w/Developer/eavesy")];
        assert!(is_trusted(Some(Path::new("/Users/w/Developer/eavesy/web")), &roots));
        assert!(!is_trusted(Some(Path::new("/Users/w/Developer/eavesy-evil")), &roots));
        assert!(!is_trusted(Some(Path::new("/Users/w/Developer/eavesy/../secrets")), &roots));
        assert!(!is_trusted(Some(Path::new("Developer/eavesy")), &roots));
        assert!(!is_trusted(None, &roots));
    }

    #[test]
    fn the_breaker_forgets_old_runs() {
        let mut breaker = Breaker::new(Duration::from_secs(60), 2);
        let start = Instant::now();
        breaker.record_at(start);
        breaker.record_at(start + Duration::from_secs(1));
        assert!(breaker.tripped_at(start + Duration::from_secs(2)));
        assert!(!breaker.tripped_at(start + Duration::from_secs(62)));
    }

    #[test]
    fn cards_name_who_is_asking() {
        assert_eq!(agent("/Users/w/Developer/eavesy").label(), "Claude Code · eavesy");
        assert_eq!(remote().label(), "cloud (remote)");
    }
}
