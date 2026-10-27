//! Delivers segments and status events to Eavesy. Each kind has its own
//! ordered queue with retries, so a slow upload never holds up a status.

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::Segment;

/// A delivery keeps retrying this long before it's given up and logged.
const GIVE_UP_AFTER: Duration = Duration::from_secs(15 * 60);

/// Segments waiting in memory at most (~1.9 MB each): about two hours of a
/// delivery outage. Past that each new segment is dropped (and reported).
const MAX_QUEUED_SEGMENTS: usize = 120;

pub struct Ingest {
    segments: mpsc::Sender<Segment>,
    events: mpsc::UnboundedSender<Value>,
    /// Segments that never arrived, reported with `done` so the gap is known.
    lost: Arc<Mutex<Vec<u32>>>,
}

pub struct Workers {
    segments: JoinHandle<()>,
    events: JoinHandle<()>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Ingest {
    pub fn start(base: String, token: Option<String>) -> (Self, Workers) {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .user_agent("eavesy-bot/0.1")
            .build()
            .expect("http client");
        let (seg_tx, mut seg_rx) = mpsc::channel::<Segment>(MAX_QUEUED_SEGMENTS);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<Value>();
        let lost = Arc::new(Mutex::new(Vec::new()));

        let (h, b, t, l) = (http.clone(), base.clone(), token.clone(), lost.clone());
        let segments = tokio::spawn(async move {
            while let Some(mut seg) = seg_rx.recv().await {
                // A cheap handle per retry instead of copying ~1.9 MB each time.
                let wav = bytes::Bytes::from(std::mem::take(&mut seg.wav));
                let url = format!("{b}/segments/{}", seg.idx);
                let ok = deliver(|| {
                    with_token(h.put(&url), &t)
                        .header("content-type", "audio/wav")
                        .header("x-segment-start-ms", seg.offset_ms)
                        .header("x-segment-duration-ms", seg.duration_ms)
                        .header("x-segment-active-ms", seg.active_ms)
                        .body(wav.clone())
                })
                .await;
                log(json!({ "msg": "segment", "idx": seg.idx, "bytes": wav.len(), "activeMs": seg.active_ms, "ok": ok }));
                if !ok {
                    l.lock().unwrap().push(seg.idx);
                }
            }
        });
        let events = tokio::spawn(async move {
            while let Some(body) = ev_rx.recv().await {
                let url = format!("{base}/events");
                let ok = deliver(|| with_token(http.post(&url), &token).json(&body)).await;
                log(json!({ "msg": "event", "code": body.get("code"), "ok": ok }));
            }
        });
        (Self { segments: seg_tx, events: ev_tx, lost }, Workers { segments, events })
    }

    pub fn segment(&self, segment: Segment) {
        if let Err(mpsc::error::TrySendError::Full(segment)) = self.segments.try_send(segment) {
            log(json!({ "msg": "segment dropped, queue full", "idx": segment.idx }));
            self.lost.lock().unwrap().push(segment.idx);
        }
    }

    pub fn event(&self, code: &str, sub_code: Option<&str>, extra: Value) {
        let _ = self.events.send(event_body(code, sub_code, extra));
    }

    /// Delivers every queued segment, then sends `done`: Eavesy starts
    /// collecting on it, so nothing may still be in flight behind it.
    pub async fn finish(self, workers: Workers, sub_code: Option<&str>) {
        let Ingest { segments, events, lost } = self;
        drop(segments);
        let _ = workers.segments.await;
        let mut lost = lost.lock().unwrap().clone();
        lost.sort_unstable();
        let _ = events.send(event_body("done", sub_code, json!({ "lostSegments": lost })));
        drop(events);
        let _ = workers.events.await;
    }
}

fn event_body(code: &str, sub_code: Option<&str>, extra: Value) -> Value {
    let mut body = json!({ "code": code, "subCode": sub_code, "at": now_ms() });
    if let (Some(obj), Value::Object(more)) = (body.as_object_mut(), extra) {
        obj.extend(more);
    }
    body
}

fn with_token(request: reqwest::RequestBuilder, token: &Option<String>) -> reqwest::RequestBuilder {
    match token {
        Some(t) => request.bearer_auth(t),
        None => request,
    }
}

async fn deliver(build: impl Fn() -> reqwest::RequestBuilder) -> bool {
    let started = tokio::time::Instant::now();
    let mut wait = Duration::from_secs(1);
    loop {
        match build().send().await {
            Ok(r) if r.status().is_success() => return true,
            // 4xx other than a timeout, "too early" and throttling won't change on retry.
            Ok(r) if r.status().is_client_error() && !matches!(r.status().as_u16(), 408 | 425 | 429) => {
                log(json!({ "msg": "rejected", "status": r.status().as_u16() }));
                return false;
            }
            Ok(r) => log(json!({ "msg": "retry", "status": r.status().as_u16() })),
            Err(e) => log(json!({ "msg": "retry", "error": e.to_string() })),
        }
        if started.elapsed() > GIVE_UP_AFTER {
            return false;
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(30));
    }
}

pub fn log(value: Value) {
    eprintln!("{value}");
}
