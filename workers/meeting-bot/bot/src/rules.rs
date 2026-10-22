//! When the bot gives up, leaves, or stays. Pure: fed observations and the
//! time, so every rule is unit-tested without a browser.

use std::time::Duration;

use crate::platform::{Observation, Phase};

#[derive(Clone, Copy)]
pub struct Limits {
    /// To reach the join screen, and from there the lobby or the call.
    pub join: Duration,
    pub lobby: Duration,
    /// Alone in the call before anyone else has been seen.
    pub nobody_joined: Duration,
    /// Alone again after others were there.
    pub everyone_left: Duration,
    pub max_call: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            join: Duration::from_secs(120),
            lobby: Duration::from_secs(15 * 60),
            nobody_joined: Duration::from_secs(15 * 60),
            everyone_left: Duration::from_secs(60),
            max_call: Duration::from_secs(4 * 60 * 60),
        }
    }
}

/// Why the bot stopped, in the status sub-codes Eavesy shows to people.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    CallEnded,
    Removed,
    NotAdmitted,
    LobbyTimeout,
    NobodyJoined,
    EveryoneLeft,
    MaxDuration,
    SignInRequired,
    NotFound,
    JoinFailed,
    LeftOnRequest,
}

impl Exit {
    pub fn sub_code(self) -> &'static str {
        match self {
            Exit::CallEnded => "call_ended_by_host",
            Exit::Removed => "bot_removed",
            Exit::NotAdmitted => "bot_kicked_from_waiting_room",
            Exit::LobbyTimeout => "timeout_exceeded_waiting_room",
            Exit::NobodyJoined => "timeout_exceeded_noone_joined",
            Exit::EveryoneLeft => "timeout_exceeded_everyone_left",
            Exit::MaxDuration => "timeout_exceeded_max_duration",
            Exit::SignInRequired => "sign_in_required",
            Exit::NotFound => "meeting_not_found",
            Exit::JoinFailed => "join_failed",
            Exit::LeftOnRequest => "bot_left_on_request",
        }
    }

    /// Whether the bot has to click Leave itself (it is still in the call or lobby).
    pub fn must_leave(self) -> bool {
        matches!(self, Exit::LobbyTimeout | Exit::NobodyJoined | Exit::EveryoneLeft | Exit::MaxDuration | Exit::LeftOnRequest)
    }
}

pub enum Step {
    Stay,
    /// The phase changed to this.
    Entered(Phase),
    Exit(Exit),
}

pub struct Rules {
    limits: Limits,
    phase: Phase,
    since: Duration,
    call_started: Option<Duration>,
    /// When the bot started its way into the call (or came back out of the
    /// lobby): a page flapping between loading and the join screen doesn't
    /// restart the clock.
    joining_since: Option<Duration>,
    alone_since: Option<Duration>,
    seen_others: bool,
}

impl Rules {
    pub fn new(limits: Limits) -> Self {
        Self { limits, phase: Phase::Loading, since: Duration::ZERO, call_started: None, joining_since: Some(Duration::ZERO), alone_since: None, seen_others: false }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Applies one observation made `now` after the bot started.
    pub fn step(&mut self, o: &Observation, now: Duration) -> Step {
        let in_lobby_before = self.phase == Phase::Lobby;
        match o.phase {
            Phase::Ended if self.phase == Phase::InCall => return Step::Exit(Exit::CallEnded),
            Phase::Ended => return Step::Exit(Exit::Removed),
            Phase::Denied => return Step::Exit(if in_lobby_before { Exit::NotAdmitted } else { Exit::Removed }),
            Phase::SignInRequired => return Step::Exit(Exit::SignInRequired),
            Phase::NotFound => return Step::Exit(Exit::NotFound),
            _ => {}
        }
        // A brief "loading" in the call (a re-render) doesn't count as leaving it.
        let next = if self.phase == Phase::InCall && o.phase == Phase::Loading { Phase::InCall } else { o.phase };
        let changed = next != self.phase;
        if changed {
            self.phase = next;
            self.since = now;
            if next == Phase::InCall {
                self.call_started.get_or_insert(now);
            }
        }

        if matches!(self.phase, Phase::Loading | Phase::Prejoin) {
            self.joining_since.get_or_insert(now);
        } else {
            self.joining_since = None;
        }
        match self.phase {
            Phase::Loading | Phase::Prejoin
                if self.joining_since.is_some_and(|t| now - t > self.limits.join) && self.call_started.is_none() =>
            {
                return Step::Exit(Exit::JoinFailed)
            }
            Phase::Lobby if now - self.since > self.limits.lobby => return Step::Exit(Exit::LobbyTimeout),
            Phase::InCall => {
                if !o.alone {
                    self.seen_others = true;
                }
                self.alone_since = if o.alone { Some(self.alone_since.unwrap_or(now)) } else { None };
                let limit = if self.seen_others { self.limits.everyone_left } else { self.limits.nobody_joined };
                if self.alone_since.is_some_and(|t| now - t > limit) {
                    return Step::Exit(if self.seen_others { Exit::EveryoneLeft } else { Exit::NobodyJoined });
                }
                if self.call_started.is_some_and(|t| now - t > self.limits.max_call) {
                    return Step::Exit(Exit::MaxDuration);
                }
            }
            _ => {}
        }
        if changed {
            Step::Entered(self.phase)
        } else {
            Step::Stay
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(phase: Phase, alone: bool) -> Observation {
        Observation { phase, alone, ..Observation::loading() }
    }
    const S: fn(u64) -> Duration = Duration::from_secs;

    fn exit(step: Step) -> Option<Exit> {
        match step {
            Step::Exit(e) => Some(e),
            _ => None,
        }
    }

    #[test]
    fn joins_then_leaves_when_everyone_has_gone() {
        let mut r = Rules::new(Limits::default());
        assert!(matches!(r.step(&at(Phase::Prejoin, false), S(2)), Step::Entered(Phase::Prejoin)));
        assert!(matches!(r.step(&at(Phase::Lobby, false), S(5)), Step::Entered(Phase::Lobby)));
        assert!(matches!(r.step(&at(Phase::InCall, false), S(30)), Step::Entered(Phase::InCall)));
        assert!(exit(r.step(&at(Phase::InCall, true), S(600))).is_none());
        assert!(exit(r.step(&at(Phase::InCall, true), S(630))).is_none());
        assert_eq!(exit(r.step(&at(Phase::InCall, true), S(661))), Some(Exit::EveryoneLeft));
    }

    #[test]
    fn waits_longer_for_the_first_arrival() {
        let mut r = Rules::new(Limits::default());
        r.step(&at(Phase::InCall, true), S(10));
        assert!(exit(r.step(&at(Phase::InCall, true), S(10 + 14 * 60))).is_none());
        assert_eq!(exit(r.step(&at(Phase::InCall, true), S(10 + 15 * 60 + 1))), Some(Exit::NobodyJoined));
    }

    #[test]
    fn someone_returning_resets_the_alone_clock() {
        let mut r = Rules::new(Limits::default());
        r.step(&at(Phase::InCall, false), S(0));
        r.step(&at(Phase::InCall, true), S(100));
        r.step(&at(Phase::InCall, false), S(150));
        assert!(exit(r.step(&at(Phase::InCall, true), S(200))).is_none());
        assert!(exit(r.step(&at(Phase::InCall, true), S(259))).is_none());
    }

    #[test]
    fn lobby_and_join_time_out() {
        let mut r = Rules::new(Limits::default());
        r.step(&at(Phase::Lobby, false), S(10));
        assert_eq!(exit(r.step(&at(Phase::Lobby, false), S(10 + 15 * 60 + 1))), Some(Exit::LobbyTimeout));
        let mut r = Rules::new(Limits::default());
        assert_eq!(exit(r.step(&at(Phase::Loading, false), S(121))), Some(Exit::JoinFailed));
    }

    #[test]
    fn a_flapping_join_page_still_times_out() {
        let mut r = Rules::new(Limits::default());
        for s in 0..120 {
            let phase = if s % 2 == 0 { Phase::Loading } else { Phase::Prejoin };
            assert!(exit(r.step(&at(phase, false), S(s))).is_none());
        }
        assert_eq!(exit(r.step(&at(Phase::Prejoin, false), S(121))), Some(Exit::JoinFailed));
    }

    #[test]
    fn denial_in_the_lobby_is_not_being_removed() {
        let mut r = Rules::new(Limits::default());
        r.step(&at(Phase::Lobby, false), S(1));
        assert_eq!(exit(r.step(&at(Phase::Denied, false), S(2))), Some(Exit::NotAdmitted));
        let mut r = Rules::new(Limits::default());
        r.step(&at(Phase::InCall, false), S(1));
        assert_eq!(exit(r.step(&at(Phase::Ended, false), S(2))), Some(Exit::CallEnded));
        assert_eq!(exit(Rules::new(Limits::default()).step(&at(Phase::SignInRequired, false), S(1))), Some(Exit::SignInRequired));
    }

    #[test]
    fn a_rerender_does_not_leave_the_call() {
        let mut r = Rules::new(Limits::default());
        r.step(&at(Phase::InCall, false), S(1));
        assert!(matches!(r.step(&at(Phase::Loading, false), S(500)), Step::Stay));
        assert_eq!(r.phase(), Phase::InCall);
        assert_eq!(exit(r.step(&at(Phase::InCall, false), S(4 * 60 * 60 + 2))), Some(Exit::MaxDuration));
    }
}
