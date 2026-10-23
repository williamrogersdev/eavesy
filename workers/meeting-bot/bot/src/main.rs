//! Eavesy's meeting bot. Joins a call as a named guest, waits to be admitted,
//! and streams the call's audio to Eavesy in segments of about a minute, with
//! a timeline of who was speaking, until the call ends or it is left alone.
//!
//! One bot per process (and per container), configured by environment:
//!   MEETING_URL, PLATFORM (meet|teams), BOT_NAME,
//!   INGEST_URL   where segments and events go: http://eavesy.internal/bots/<id>,
//!                which the container's Durable Object intercepts,
//!   INGEST_TOKEN optional bearer token, for running against a plain HTTP server,
//!   CHROME_PATH  (default chromium), CONTROL_PORT (default 8080).
//! SIGTERM (how the Durable Object stops it) makes it leave and deliver.

mod audio;
mod cdp;
mod control;
mod ingest;
mod platform;
mod rules;

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio::time::{interval, Instant, MissedTickBehavior};

use audio::Segmenter;
use ingest::{log, Ingest};
use platform::{browser::Browser, AudioBlock, Kind, Phase, Session};
use rules::{Exit, Limits, Rules, Step};

const HEARTBEAT: Duration = Duration::from_secs(60);
/// How often the speaking indicator is read, and so how long one look covers.
const TICK_MS: u64 = 1_000;
/// Spans per report at most, so one report stays well under Eavesy's size
/// limit for an event; a backlog goes out over the next reports.
const MAX_SPANS_PER_REPORT: usize = 2_000;
const ANNOUNCEMENT: &str = "Eavesy Notetaker is transcribing this call for the person who invited it.";

struct Config {
    meeting_url: String,
    kind: Kind,
    bot_name: String,
    ingest_url: String,
    ingest_token: Option<String>,
    chrome: String,
    control_port: u16,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn config() -> Result<Config, String> {
    let need = |n: &str| env(n).ok_or_else(|| format!("{n} is required"));
    let platform = need("PLATFORM")?;
    Ok(Config {
        meeting_url: need("MEETING_URL")?,
        kind: Kind::parse(&platform).ok_or_else(|| format!("unsupported PLATFORM {platform}"))?,
        bot_name: env("BOT_NAME").unwrap_or_else(|| "Eavesy Notetaker".into()),
        ingest_url: env("INGEST_URL").unwrap_or_else(|| "http://eavesy.internal".into()).trim_end_matches('/').to_owned(),
        ingest_token: env("INGEST_TOKEN"),
        chrome: env("CHROME_PATH").unwrap_or_else(|| "chromium".into()),
        control_port: env("CONTROL_PORT").and_then(|p| p.parse().ok()).unwrap_or(8080),
    })
}

/// Who spoke when, on the recording's clock, plus everyone seen in the call.
/// `spans` stays in start order: `note` only ever adds a span at the current
/// time, and only grows spans that may still be going on.
#[derive(Default)]
struct Speakers {
    spans: Vec<(String, u64, u64)>,
    participants: BTreeSet<String>,
    /// Spans before this index were final when they were sent. Each report
    /// carries the spans from the first still-open or unsent one on and names
    /// that span's start as `speakersFrom`: Eavesy drops what it holds from
    /// that time and keeps the report instead. A time, not an index, so a
    /// report that never arrived (or a span Eavesy threw out) leaves a gap
    /// but never shifts or doubles the spans after it.
    sent_final: usize,
}

impl Speakers {
    fn note(&mut self, names: &[String], at_ms: u64, tick_ms: u64) {
        for name in names {
            match self.spans.iter_mut().rev().find(|(n, _, end)| n == name && *end + tick_ms * 2 >= at_ms) {
                Some(span) => span.2 = at_ms + tick_ms,
                None => self.spans.push((name.clone(), at_ms, at_ms + tick_ms)),
            }
        }
    }

    /// The next report's speakers: spans from the first one not yet sent for
    /// good, about `cap` of them. A span stays open while its speaker may
    /// still carry on (`note` extends a span ending within two ticks), so it
    /// is sent again, grown, in the next report. `now_ms` None means the call
    /// is over and every span is final.
    ///
    /// Eavesy replaces by start time, so a report always carries every span
    /// sharing a start with its first and last (two people starting on the
    /// same tick): a start never straddles two reports.
    fn report(&mut self, now_ms: Option<u64>, tick_ms: u64, cap: usize) -> Value {
        let len = self.spans.len();
        let first = self.sent_final.min(len);
        // With everything sent, a time past every span: Eavesy keeps all it has.
        let from_ms = self.spans.get(first).map_or_else(|| self.spans.last().map_or(0, |s| s.1 + 1), |s| s.1);
        let from = self.spans.partition_point(|s| s.1 < from_ms);
        let mut to = (from + cap).min(len);
        if to > from && to < len {
            to = self.spans.partition_point(|s| s.1 <= self.spans[to - 1].1);
        }
        let chunk = &self.spans[from..to];
        let open = |end: u64| now_ms.is_some_and(|now| end + tick_ms * 2 >= now);
        self.sent_final = chunk.iter().position(|(_, _, end)| open(*end)).map_or(to, |i| from + i);
        json!({
            "participants": self.participants,
            "speakersFrom": from_ms,
            "speakers": chunk.iter().map(|(n, s, e)| json!([n, s, e])).collect::<Vec<_>>(),
        })
    }

    /// Whether every span has gone out final.
    fn all_sent(&self) -> bool {
        self.sent_final >= self.spans.len()
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cfg = match config() {
        Ok(c) => c,
        Err(e) => {
            log(json!({ "msg": "config", "error": e }));
            std::process::exit(2);
        }
    };
    let (leave_tx, leave_rx) = watch::channel(false);
    let status = control::Status::default();
    tokio::spawn(control::serve(cfg.control_port, status.clone()));
    // The platform stops a container with SIGTERM: leave and deliver what's
    // left, exactly as for a leave request.
    let term = leave_tx.clone();
    tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut sigterm), Ok(mut sigint)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
        tokio::select! { _ = sigterm.recv() => {}, _ = sigint.recv() => {} }
        let _ = term.send(true);
    });

    let (ingest, workers) = Ingest::start(cfg.ingest_url.clone(), cfg.ingest_token.clone());
    ingest.event("joining_call", None, json!({}));
    let session = Browser::new(cfg.kind, cfg.meeting_url.clone(), cfg.bot_name.clone(), cfg.chrome.clone());
    let (code, sub_code) = match run(session, &cfg, &ingest, leave_rx, &status).await {
        Ok(exit) => ("call_ended", exit.sub_code()),
        Err(e) => {
            log(json!({ "msg": "fatal", "error": e }));
            ("fatal", "bot_error")
        }
    };
    log(json!({ "msg": "finished", "code": code, "subCode": sub_code }));
    ingest.event(code, Some(sub_code), json!({}));
    ingest.finish(workers, Some(sub_code)).await;
}

async fn run(
    mut session: impl Session,
    cfg: &Config,
    ingest: &Ingest,
    mut leave: watch::Receiver<bool>,
    status: &control::Status,
) -> Result<Exit, String> {
    let started = Instant::now();
    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<AudioBlock>();
    session.open(audio_tx).await?;

    let mut rules = Rules::new(Limits::default());
    let mut segmenter = Segmenter::default();
    let mut speakers = Speakers::default();
    let mut recording_since: Option<Instant> = None;
    let mut announced = false;
    let mut last_heartbeat = Instant::now();
    let mut blocks: u64 = 0;
    let mut tick = interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let exit = loop {
        tokio::select! {
            Some(block) = audio_rx.recv() => {
                // Audio before admission (a lobby jingle) isn't the meeting.
                let Some(since) = recording_since else { continue };
                blocks += 1;
                for segment in segmenter.push(&block.pcm, block.peak, block.at.saturating_duration_since(since).as_millis() as u64) {
                    ingest.segment(segment);
                }
            }
            changed = leave.changed() => {
                if changed.is_err() || *leave.borrow() {
                    break Exit::LeftOnRequest;
                }
            }
            why = session.closed() => return Err(why),
            _ = tick.tick() => {
                let seen = session.observe().await;
                let step = rules.step(&seen, started.elapsed());
                status.set(format!("{:?}", rules.phase()));
                match step {
                    Step::Exit(exit) => break exit,
                    Step::Entered(phase) => {
                        log(json!({ "msg": "phase", "phase": format!("{phase:?}"), "detail": seen.detail }));
                        match phase {
                            Phase::Lobby => ingest.event("in_waiting_room", None, json!({})),
                            Phase::InCall => {
                                recording_since.get_or_insert_with(Instant::now);
                                ingest.event("in_call_recording", None, json!({}));
                            }
                            _ => {}
                        }
                    }
                    Step::Stay => {}
                }
                if let Some(since) = recording_since {
                    if rules.phase() == Phase::InCall {
                        speakers.participants.extend(seen.participants.iter().filter(|n| **n != cfg.bot_name).cloned());
                        let others: Vec<String> = seen.speaking.into_iter().filter(|n| *n != cfg.bot_name).collect();
                        speakers.note(&others, since.elapsed().as_millis() as u64, TICK_MS);
                        if !announced {
                            announced = session.announce(ANNOUNCEMENT).await;
                            if announced { log(json!({ "msg": "announced" })); }
                        }
                    }
                } else if rules.phase() == Phase::Loading && started.elapsed().as_secs() % 15 == 14 {
                    log(json!({ "msg": "still loading", "detail": seen.detail }));
                }
                // In every phase, the lobby included: Eavesy's watchdog takes a
                // bot it hasn't heard from in a while for lost.
                if last_heartbeat.elapsed() >= HEARTBEAT {
                    last_heartbeat = Instant::now();
                    log(json!({ "msg": "heartbeat", "phase": format!("{:?}", rules.phase()), "audioBlocks": blocks, "detail": seen.detail }));
                    let body = match recording_since {
                        Some(since) => speakers.report(Some(since.elapsed().as_millis() as u64), TICK_MS, MAX_SPANS_PER_REPORT),
                        None => json!({}),
                    };
                    ingest.event("heartbeat", None, body);
                }
            }
        }
    };

    if exit.must_leave() {
        session.leave().await;
    }
    // Blocks already captured belong to the meeting.
    while let Ok(block) = audio_rx.try_recv() {
        if let Some(since) = recording_since {
            for segment in segmenter.push(&block.pcm, block.peak, block.at.saturating_duration_since(since).as_millis() as u64) {
                ingest.segment(segment);
            }
        }
    }
    if let Some(segment) = segmenter.finish() {
        ingest.segment(segment);
    }
    // The rest of the timeline, final now, in as many reports as it takes.
    loop {
        ingest.event("speakers", None, speakers.report(None, TICK_MS, MAX_SPANS_PER_REPORT));
        if speakers.all_sent() {
            break;
        }
    }
    Ok(exit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaker_spans_merge_while_someone_keeps_talking() {
        let mut s = Speakers::default();
        s.note(&["Ana".into()], 0, 1_000);
        s.note(&["Ana".into(), "Ben".into()], 1_000, 1_000);
        s.note(&["Ana".into()], 2_000, 1_000);
        s.note(&["Ana".into()], 9_000, 1_000);
        assert_eq!(s.spans, vec![("Ana".into(), 0, 3_000), ("Ben".into(), 1_000, 2_000), ("Ana".into(), 9_000, 10_000)]);
    }

    fn spans(report: &Value) -> (u64, Vec<(String, u64, u64)>) {
        let from = report["speakersFrom"].as_u64().unwrap();
        let list = report["speakers"].as_array().unwrap().iter().map(|s| (s[0].as_str().unwrap().to_owned(), s[1].as_u64().unwrap(), s[2].as_u64().unwrap())).collect();
        (from, list)
    }

    /// What Eavesy keeps: its spans starting before `speakersFrom`, then the report.
    fn apply(stored: &mut Vec<(String, u64, u64)>, report: &Value) {
        let (from, list) = spans(report);
        stored.retain(|s| s.1 < from);
        stored.extend(list);
    }

    #[test]
    fn reports_carry_only_what_changed_and_resend_open_spans() {
        let mut s = Speakers::default();
        let mut stored = Vec::new();
        s.note(&["Ana".into()], 0, 1_000);
        s.note(&["Ben".into()], 5_000, 1_000);
        // Ben may still be talking at 6 s: his span goes again next time.
        let first = s.report(Some(6_000), 1_000, 100);
        assert_eq!(spans(&first).0, 0);
        assert_eq!(spans(&first).1.len(), 2);
        apply(&mut stored, &first);
        s.note(&["Ben".into()], 6_000, 1_000);
        s.note(&["Cy".into()], 20_000, 1_000);
        let second = s.report(Some(21_000), 1_000, 100);
        assert_eq!(spans(&second).0, 5_000);
        apply(&mut stored, &second);
        assert_eq!(stored, s.spans);
        // Nothing new and everything closed: an empty report from the end.
        let third = s.report(Some(60_000), 1_000, 100);
        apply(&mut stored, &third);
        let fourth = s.report(Some(61_000), 1_000, 100);
        assert_eq!(spans(&fourth), (20_001, vec![]));
        assert_eq!(stored, s.spans);
    }

    #[test]
    fn a_dropped_report_leaves_a_gap_but_shifts_and_doubles_nothing() {
        let mut s = Speakers::default();
        let mut stored = Vec::new();
        s.note(&["Ana".into()], 0, 1_000);
        apply(&mut stored, &s.report(Some(5_000), 1_000, 100));
        s.note(&["Ben".into()], 10_000, 1_000);
        s.note(&["Cy".into()], 15_000, 1_000);
        // Ben is final and Cy still open in this report, which Eavesy never gets.
        let dropped = s.report(Some(16_000), 1_000, 100);
        assert_eq!(spans(&dropped).0, 10_000);
        s.note(&["Cy".into()], 16_000, 1_000);
        s.note(&["Dee".into()], 30_000, 1_000);
        // The next one starts where Cy's span does, whatever Eavesy did or didn't keep.
        let next = s.report(Some(31_000), 1_000, 100);
        assert_eq!(spans(&next).0, 15_000);
        apply(&mut stored, &next);
        assert_eq!(stored, vec![("Ana".into(), 0, 1_000), ("Cy".into(), 15_000, 17_000), ("Dee".into(), 30_000, 31_000)]);
        // Only Ben, final in the lost report, is missing: nothing is doubled,
        // as an index into a timeline Eavesy never held would have done.
        assert_eq!(s.spans.len(), 4);
    }

    #[test]
    fn spans_starting_together_travel_together() {
        let mut s = Speakers::default();
        let mut stored = Vec::new();
        s.note(&["Ana".into(), "Ben".into()], 0, 1_000);
        s.note(&["Ben".into()], 1_000, 1_000);
        // Ana is done, Ben may go on: both started at 0, so both go again.
        let first = s.report(Some(3_500), 1_000, 100);
        assert_eq!(spans(&first).0, 0);
        apply(&mut stored, &first);
        s.note(&["Ben".into()], 3_500, 1_000);
        let second = s.report(Some(9_000), 1_000, 100);
        assert_eq!(spans(&second).0, 0);
        assert_eq!(spans(&second).1.len(), 2);
        apply(&mut stored, &second);
        assert_eq!(stored, s.spans);
        assert!(s.all_sent());
        // A cap that would cut a shared start stretches to cover it.
        let mut s = Speakers::default();
        s.note(&["P0".into(), "P1".into(), "P2".into()], 0, 1_000);
        s.note(&["P3".into()], 5_000, 1_000);
        let report = s.report(None, 1_000, 2);
        assert_eq!(spans(&report).1.len(), 3);
        assert!(!s.all_sent());
    }

    #[test]
    fn a_long_timeline_goes_out_in_capped_reports() {
        let mut s = Speakers::default();
        for i in 0..25u64 {
            s.note(&[format!("P{}", i % 3)], i * 10_000, 1_000);
        }
        let mut stored = Vec::new();
        let mut reports = 0;
        loop {
            let report = s.report(None, 1_000, 10);
            assert!(spans(&report).1.len() <= 10);
            apply(&mut stored, &report);
            reports += 1;
            if s.all_sent() {
                break;
            }
        }
        assert_eq!(reports, 3);
        assert_eq!(stored, s.spans);
    }
}
