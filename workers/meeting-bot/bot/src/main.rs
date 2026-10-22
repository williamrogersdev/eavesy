//! Eavesy's meeting bot. Joins a call as a named guest, waits to be admitted,
//! and streams the call's audio to Eavesy in segments of about a minute, with
//! a timeline of who was speaking, until the call ends or it is left alone.
//!
//! One bot per process (and per container), configured by environment:
//!   MEETING_URL, PLATFORM (meet|teams), BOT_NAME,
//!   INGEST_URL   where segments and events go (default http://eavesy.internal,
//!                which the container's Worker intercepts),
//!   INGEST_TOKEN optional bearer token, for running against a plain HTTP server,
//!   CHROME_PATH  (default chromium), CONTROL_PORT (default 8080).

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
#[derive(Default)]
struct Speakers {
    spans: Vec<(String, u64, u64)>,
    participants: BTreeSet<String>,
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

    fn json(&self) -> Value {
        json!({
            "participants": self.participants,
            "speakers": self.spans.iter().map(|(n, s, e)| json!([n, s, e])).collect::<Vec<_>>(),
        })
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
    tokio::spawn(control::serve(cfg.control_port, leave_tx.clone(), status.clone()));
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
                for segment in segmenter.push(&block.pcm, block.peak, since.elapsed().as_millis() as u64) {
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
                        speakers.note(&others, since.elapsed().as_millis() as u64, 1_000);
                        if !announced {
                            announced = session.announce(ANNOUNCEMENT).await;
                            if announced { log(json!({ "msg": "announced" })); }
                        }
                    }
                    if last_heartbeat.elapsed() >= HEARTBEAT {
                        last_heartbeat = Instant::now();
                        log(json!({ "msg": "heartbeat", "audioBlocks": blocks, "detail": seen.detail }));
                        ingest.event("heartbeat", None, speakers.json());
                    }
                } else if rules.phase() == Phase::Loading && started.elapsed().as_secs() % 15 == 14 {
                    log(json!({ "msg": "still loading", "detail": seen.detail }));
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
            for segment in segmenter.push(&block.pcm, block.peak, since.elapsed().as_millis() as u64) {
                ingest.segment(segment);
            }
        }
    }
    if let Some(segment) = segmenter.finish() {
        ingest.segment(segment);
    }
    ingest.event("speakers", None, speakers.json());
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
}
