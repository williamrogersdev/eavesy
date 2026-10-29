//! Notices a call starting and offers to record it.
//!
//! Two signals: which apps hold the microphone (the capture engine's
//! `--watch-mic` reports, so this works without a calendar), and the
//! signed-in account's calendar (`/api/calendar-events`), which names the
//! meeting and carries the per-meeting choice. A call that has held the mic
//! for `CALL_DWELL_MS` gets the prompt in the capture control. With "Record
//! my meetings automatically" on (the default) it counts down and then
//! records unless the user says "Don't record"; off, it only asks. Nothing
//! ever records without that prompt on screen. A recording the prompt started
//! stops once the call has let go of the mic for `END_GRACE_MS`.

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::audio::Captures;
use crate::hud::{self, HudState, Phase};
use crate::settings;

/// How long a call holds the mic before the prompt shows: a mic check or a
/// stray Siri request lets go well before this.
pub const CALL_DWELL_MS: i64 = 12_000;
/// How long the prompt counts down before recording starts.
pub const COUNTDOWN_MS: i64 = 10_000;
/// How long a prompt that only asks stays up without an answer.
pub const ASK_FOR_MS: i64 = 2 * 60_000;
/// How long the call may let go of the mic before its recording stops (a
/// device switch or rejoin lets go briefly).
pub const END_GRACE_MS: i64 = 90_000;
/// A meeting this close to its start counts as the one under way.
const EARLY_JOIN_MS: i64 = 10 * 60_000;
const TICK: Duration = Duration::from_secs(2);
const CALENDAR_EVERY: Duration = Duration::from_secs(60);
const ACCOUNT_TIMEOUT: Duration = Duration::from_secs(8);

/// Meeting apps: holding the mic means a call.
const MEETING_APPS: &[(&str, &str)] = &[
    ("us.zoom.xos", "Zoom"),
    ("com.microsoft.teams2", "Teams"),
    ("com.microsoft.teams", "Teams"),
    ("com.cisco.webexmeetingsapp", "Webex"),
    ("Cisco-Systems.Spark", "Webex"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"),
];
/// Browsers: holding the mic may be a Meet call or anything else, so on their
/// own they only ask, never count down.
const BROWSERS: &[&str] = &[
    "com.google.Chrome",
    "com.apple.Safari",
    "company.thebrowser.Browser",
    "org.mozilla.firefox",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signal {
    App(String),
    Browser(String),
}

impl Signal {
    fn bundle(&self) -> &str {
        match self {
            Signal::App(id) | Signal::Browser(id) => id,
        }
    }
}

/// The call in a mic report, if any: a meeting app before a browser.
/// `precise` reports name the apps taking input; otherwise `apps` is every
/// app running while the mic is in use by someone.
pub fn signal_in(apps: &[String]) -> Option<Signal> {
    if let Some(id) = apps.iter().find(|id| MEETING_APPS.iter().any(|(app, _)| app == id)) {
        return Some(Signal::App(id.clone()));
    }
    apps.iter().find(|id| BROWSERS.contains(&id.as_str())).map(|id| Signal::Browser(id.clone()))
}

fn app_name(signal: &Signal) -> &'static str {
    match signal {
        Signal::App(id) => MEETING_APPS.iter().find(|(app, _)| app == id).map(|(_, name)| *name).unwrap_or("A call"),
        Signal::Browser(_) => "A call in your browser",
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub title: String,
    pub starts_at: i64,
    pub ends_at: i64,
    pub meeting_url: Option<String>,
    #[serde(default)]
    pub record_choice: Option<String>,
}

/// The meeting under way at `now` (or starting within EARLY_JOIN_MS), nearest start first.
/// The server only lists meeting-like events.
pub fn event_at(events: &[Event], now: i64) -> Option<&Event> {
    events
        .iter()
        .filter(|event| now >= event.starts_at - EARLY_JOIN_MS && now < event.ends_at)
        .min_by_key(|event| (event.starts_at - now).abs())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Prompt {
    /// The meeting this prompt is for: the calendar event, or the app and when its call began.
    pub key: String,
    pub title: String,
    /// Counts down and records, rather than only asking.
    pub countdown: bool,
}

/// What the watcher sees now.
pub struct Moment<'a> {
    pub now: i64,
    /// A capture is running or starting, or a prompt is already up.
    pub busy: bool,
    /// "Record my meetings automatically".
    pub auto_record: bool,
    /// The call holding the mic, and since when.
    pub call: Option<(&'a Signal, i64)>,
    pub event: Option<&'a Event>,
    /// Prompts the user answered "Don't record" (or let pass) for.
    pub dismissed: &'a HashSet<String>,
}

/// Whether to put up a prompt now, and which.
pub fn decide(moment: &Moment) -> Option<Prompt> {
    if moment.busy {
        return None;
    }
    let (signal, since) = moment.call?;
    if moment.now - since < CALL_DWELL_MS {
        return None;
    }
    let key = match moment.event {
        Some(event) => format!("event:{}", event.id),
        None => format!("app:{}:{since}", signal.bundle()),
    };
    if moment.dismissed.contains(&key) {
        return None;
    }
    let choice = moment.event.and_then(|event| event.record_choice.as_deref());
    if choice == Some("skip") {
        return None;
    }
    // A browser counts as a call only alongside a calendar meeting with a link.
    let sure = match signal {
        Signal::App(_) => true,
        Signal::Browser(_) => moment.event.is_some_and(|event| event.meeting_url.is_some()),
    };
    let countdown = sure && (choice == Some("record") || moment.auto_record);
    let title = moment.event.map(|event| event.title.clone()).unwrap_or_else(|| app_name(signal).to_string());
    Some(Prompt { key, title, countdown })
}

/// A recording the prompt started, and what started it.
#[derive(Clone, Debug)]
pub struct AutoRecording {
    pub session_id: String,
    pub bundle: String,
    /// Mic reports say which app takes input: the call's end can be seen.
    pub precise: bool,
    pub event_ends_at: Option<i64>,
}

/// Whether a recording the prompt started should stop: its call let go of
/// the mic `END_GRACE_MS` ago (`gone_since`), or, when that can't be seen,
/// its meeting ended that long ago.
pub fn should_stop(recording: &AutoRecording, gone_since: Option<i64>, now: i64) -> bool {
    if recording.precise {
        return gone_since.is_some_and(|since| now - since >= END_GRACE_MS);
    }
    recording.event_ends_at.is_some_and(|ends| now - ends >= END_GRACE_MS)
}

#[derive(Default)]
struct Watch {
    precise: bool,
    apps: Vec<String>,
    call: Option<(Signal, i64)>,
    events: Vec<Event>,
    dismissed: HashSet<String>,
    /// The prompt on screen, and when it counts down to or gives up.
    prompt: Option<(Prompt, i64)>,
    auto: Option<AutoRecording>,
    /// When the auto recording's app was last seen gone from the mic.
    gone_since: Option<i64>,
}

static WATCH: Mutex<Option<Watch>> = Mutex::new(None);

fn with_watch<T>(f: impl FnOnce(&mut Watch) -> T) -> T {
    let mut guard = WATCH.lock().unwrap_or_else(|error| error.into_inner());
    f(guard.get_or_insert_with(Watch::default))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Starts the watcher: the mic reports, the calendar and the decisions.
pub fn start(app: &AppHandle) {
    let reader = app.clone();
    std::thread::spawn(move || read_mic_reports(&reader));
    let ticker = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut calendar_at: Option<Instant> = None;
        loop {
            if calendar_at.is_none_or(|at| at.elapsed() >= CALENDAR_EVERY) {
                calendar_at = Some(Instant::now());
                if let Some(events) = fetch_events(&ticker).await {
                    with_watch(|watch| watch.events = events);
                }
            }
            tick(&ticker);
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Runs `--watch-mic` for as long as the app does, starting it again if it stops.
fn read_mic_reports(app: &AppHandle) {
    #[derive(Deserialize)]
    struct Report {
        event: String,
        #[serde(default)]
        precise: bool,
        #[serde(default)]
        apps: Vec<String>,
    }
    loop {
        let Ok(bin) = crate::audio::capture_bin(app) else {
            std::thread::sleep(Duration::from_secs(60));
            continue;
        };
        let child = Command::new(bin).arg("--watch-mic").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                tracing::warn!("meeting watch: could not start the mic watch: {error}");
                std::thread::sleep(Duration::from_secs(60));
                continue;
            }
        };
        // Held open for as long as it runs: it quits when its stdin closes.
        let stdin = child.stdin.take();
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(report) = serde_json::from_str::<Report>(&line) else { continue };
                if report.event == "mic" {
                    with_watch(|watch| {
                        watch.precise = report.precise;
                        watch.apps = report.apps;
                    });
                }
            }
        }
        drop(stdin);
        let _ = child.kill();
        let _ = child.wait();
        with_watch(|watch| watch.apps.clear());
        std::thread::sleep(Duration::from_secs(30));
    }
}

async fn fetch_events(app: &AppHandle) -> Option<Vec<Event>> {
    #[derive(Deserialize)]
    struct Answer {
        #[serde(default)]
        upcoming: Vec<Event>,
    }
    let credential = settings::device_credential(app)?;
    let client = crate::sync::http_client().ok()?;
    let response = client
        .get(crate::base_url::join(&credential.base, "/api/calendar-events"))
        .bearer_auth(credential.token)
        .timeout(ACCOUNT_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    Some(response.json::<Answer>().await.ok()?.upcoming)
}

fn tick(app: &AppHandle) {
    let now = now_ms();
    let auto_record = settings::load(app).auto_record_meetings();
    let capturing = app.state::<Captures>().is_busy();
    enum Act {
        Show(Prompt, Option<i64>),
        Record(Prompt),
        Clear(String),
        Stop(String),
    }
    let acts = with_watch(|watch| {
        let mut acts = Vec::new();
        // Follow the call: when it began, and whether the recording's app is still on.
        let signal = signal_in(&watch.apps);
        match (&watch.call, &signal) {
            (Some((was, _)), Some(is)) if was == is => {}
            (_, Some(is)) => watch.call = Some((is.clone(), now)),
            (_, None) => watch.call = None,
        }
        if let Some(recording) = &watch.auto {
            if !capturing {
                watch.auto = None;
                watch.gone_since = None;
            } else {
                let holds = watch.apps.contains(&recording.bundle);
                watch.gone_since = if holds { None } else { Some(watch.gone_since.unwrap_or(now)) };
                if should_stop(recording, watch.gone_since, now) {
                    acts.push(Act::Stop(recording.session_id.clone()));
                    watch.auto = None;
                    watch.gone_since = None;
                }
            }
        }
        // A prompt on screen: count down, give up, or step aside for a capture the user started.
        if let Some((prompt, until)) = watch.prompt.clone() {
            if capturing || watch.call.is_none() {
                watch.prompt = None;
                if watch.call.is_none() {
                    watch.dismissed.insert(prompt.key.clone());
                }
                acts.push(Act::Clear(prompt.key));
            } else if now >= until {
                watch.prompt = None;
                watch.dismissed.insert(prompt.key.clone());
                acts.push(if prompt.countdown { Act::Record(prompt) } else { Act::Clear(prompt.key) });
            }
            return acts;
        }
        let event = event_at(&watch.events, now);
        let moment = Moment {
            now,
            busy: capturing,
            auto_record,
            call: watch.call.as_ref().map(|(signal, since)| (signal, *since)),
            event,
            dismissed: &watch.dismissed,
        };
        if let Some(prompt) = decide(&moment) {
            let until = now + if prompt.countdown { COUNTDOWN_MS } else { ASK_FOR_MS };
            watch.prompt = Some((prompt.clone(), until));
            acts.push(Act::Show(prompt.clone(), prompt.countdown.then_some(until)));
        }
        acts
    });
    for act in acts {
        match act {
            Act::Show(prompt, deadline) => show_prompt(app, &prompt, deadline),
            Act::Clear(key) => clear_prompt(app, &key),
            Act::Record(prompt) => record(app, &prompt),
            Act::Stop(session_id) => stop(app, session_id),
        }
    }
}

fn prompt_session(key: &str) -> String {
    format!("meeting-prompt:{key}")
}

fn show_prompt(app: &AppHandle, prompt: &Prompt, deadline: Option<i64>) {
    hud::set_state(
        app,
        HudState {
            phase: Phase::Prompt,
            session_id: Some(prompt_session(&prompt.key)),
            mode: Some("meeting".into()),
            started_at_ms: deadline,
            message: Some(prompt.title.clone()),
            notice: None,
        },
    );
}

fn clear_prompt(app: &AppHandle, key: &str) {
    let session = prompt_session(key);
    hud::set_state_if(app, HudState::idle(), |now| now.phase == Phase::Prompt && now.session_id.as_deref() == Some(&session));
}

/// Starts the Meeting recording the prompt was for. It goes through the
/// `mixed` source, so the cloud links it to the calendar event and names it.
fn record(app: &AppHandle, prompt: &Prompt) {
    clear_prompt(app, &prompt.key);
    let started = crate::audio::start_audio_capture(app, &app.state::<Captures>(), Some("mixed".into()), None, None, None, Instant::now());
    match started {
        Ok(session) => with_watch(|watch| {
            let bundle = watch.call.as_ref().map(|(signal, _)| signal.bundle().to_string()).unwrap_or_default();
            let event_ends_at = event_at(&watch.events, now_ms()).map(|event| event.ends_at);
            watch.auto = Some(AutoRecording { session_id: session.session_id, bundle, precise: watch.precise, event_ends_at });
            watch.gone_since = None;
        }),
        // The capture start already shows why (a permission, say); the prompt won't repeat.
        Err(error) => tracing::warn!("meeting watch: could not start recording: {error}"),
    }
}

fn stop(app: &AppHandle, session_id: String) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = crate::audio::stop_capture(handle.clone(), handle.state::<Captures>(), session_id) {
            tracing::warn!("meeting watch: could not stop the recording after the call ended: {error}");
        }
    });
}

/// The user answered the prompt: record now, or don't record this meeting.
#[tauri::command(async)]
pub fn answer_meeting_prompt(app: AppHandle, session_id: String, record: bool) -> Result<(), String> {
    let prompt = with_watch(|watch| {
        let open = watch.prompt.as_ref().is_some_and(|(prompt, _)| prompt_session(&prompt.key) == session_id);
        if !open {
            return None;
        }
        let (prompt, _) = watch.prompt.take()?;
        watch.dismissed.insert(prompt.key.clone());
        Some(prompt)
    });
    let Some(prompt) = prompt else {
        // Already gone (counted down, or the call ended): nothing to answer.
        hud::set_state_if(&app, HudState::idle(), |now| now.phase == Phase::Prompt && now.session_id.as_deref() == Some(&session_id));
        return Ok(());
    };
    if record {
        self::record(&app, &prompt);
    } else {
        clear_prompt(&app, &prompt.key);
    }
    Ok(())
}

/// Turns "Record my meetings automatically" on or off.
#[tauri::command(async)]
pub fn set_auto_record_meetings(app: AppHandle, enabled: bool) -> Result<(), String> {
    settings::update(&app, |config| config.auto_record_meetings = Some(enabled)).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_800_000_000_000;

    fn event(id: &str, start_min: i64, end_min: i64, choice: Option<&str>) -> Event {
        Event {
            id: id.into(),
            title: format!("{id} meeting"),
            starts_at: T + start_min * 60_000,
            ends_at: T + end_min * 60_000,
            meeting_url: Some("https://meet.google.com/abc-defg-hij".into()),
            record_choice: choice.map(String::from),
        }
    }

    fn moment<'a>(call: Option<(&'a Signal, i64)>, event: Option<&'a Event>, dismissed: &'a HashSet<String>) -> Moment<'a> {
        Moment { now: T, busy: false, auto_record: true, call, event, dismissed }
    }

    fn zoom() -> Signal {
        Signal::App("us.zoom.xos".into())
    }

    #[test]
    fn a_meeting_app_or_a_browser_on_the_mic_is_a_call() {
        let apps = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        assert_eq!(signal_in(&apps(&["com.apple.Siri", "us.zoom.xos"])), Some(zoom()));
        assert_eq!(signal_in(&apps(&["com.google.Chrome", "us.zoom.xos"])), Some(zoom()));
        assert_eq!(signal_in(&apps(&["com.google.Chrome"])), Some(Signal::Browser("com.google.Chrome".into())));
        assert_eq!(signal_in(&apps(&["com.apple.VoiceMemos"])), None);
        assert_eq!(signal_in(&[]), None);
    }

    #[test]
    fn a_meeting_app_holding_the_mic_counts_down_by_default() {
        let none = HashSet::new();
        let zoom = zoom();
        let prompt = decide(&moment(Some((&zoom, T - CALL_DWELL_MS)), None, &none)).unwrap();
        assert!(prompt.countdown);
        assert_eq!(prompt.title, "Zoom");
        assert_eq!(prompt.key, format!("app:us.zoom.xos:{}", T - CALL_DWELL_MS));
    }

    #[test]
    fn a_short_grab_of_the_mic_is_not_a_call() {
        let none = HashSet::new();
        let zoom = zoom();
        assert_eq!(decide(&moment(Some((&zoom, T - CALL_DWELL_MS + 1)), None, &none)), None);
    }

    #[test]
    fn no_mic_signal_means_no_prompt_even_at_a_meetings_start() {
        let none = HashSet::new();
        let standup = event("standup", 0, 15, None);
        assert_eq!(decide(&moment(None, Some(&standup), &none)), None);
    }

    #[test]
    fn the_calendar_names_the_prompt_and_keys_it_to_the_event() {
        let none = HashSet::new();
        let zoom = zoom();
        let review = event("review", 0, 30, None);
        let prompt = decide(&moment(Some((&zoom, T - 60_000)), Some(&review), &none)).unwrap();
        assert_eq!(prompt, Prompt { key: "event:review".into(), title: "review meeting".into(), countdown: true });
    }

    #[test]
    fn never_prompts_while_recording() {
        let none = HashSet::new();
        let zoom = zoom();
        let mut busy = moment(Some((&zoom, T - 60_000)), None, &none);
        busy.busy = true;
        assert_eq!(decide(&busy), None);
    }

    #[test]
    fn dont_record_holds_for_that_meeting() {
        let zoom = zoom();
        let review = event("review", 0, 30, None);
        let dismissed: HashSet<String> = ["event:review".to_string()].into();
        assert_eq!(decide(&moment(Some((&zoom, T - 60_000)), Some(&review), &dismissed)), None);
        // The same app on a new call (a new start time) asks again.
        let dismissed: HashSet<String> = [format!("app:us.zoom.xos:{}", T - 60_000)].into();
        assert_eq!(decide(&moment(Some((&zoom, T - 60_000)), None, &dismissed)), None);
        assert!(decide(&moment(Some((&zoom, T - 30_000)), None, &dismissed)).is_some());
    }

    #[test]
    fn with_the_setting_off_it_only_asks() {
        let none = HashSet::new();
        let zoom = zoom();
        let mut off = moment(Some((&zoom, T - 60_000)), None, &none);
        off.auto_record = false;
        assert!(!decide(&off).unwrap().countdown);
    }

    #[test]
    fn a_meeting_marked_record_counts_down_even_with_the_setting_off() {
        let none = HashSet::new();
        let zoom = zoom();
        let review = event("review", 0, 30, Some("record"));
        let mut off = moment(Some((&zoom, T - 60_000)), Some(&review), &none);
        off.auto_record = false;
        assert!(decide(&off).unwrap().countdown);
    }

    #[test]
    fn a_meeting_marked_skip_never_prompts() {
        let none = HashSet::new();
        let zoom = zoom();
        let review = event("review", 0, 30, Some("skip"));
        assert_eq!(decide(&moment(Some((&zoom, T - 60_000)), Some(&review), &none)), None);
    }

    #[test]
    fn a_browser_counts_down_only_for_a_calendar_meeting_with_a_link() {
        let none = HashSet::new();
        let chrome = Signal::Browser("com.google.Chrome".into());
        let alone = decide(&moment(Some((&chrome, T - 60_000)), None, &none)).unwrap();
        assert!(!alone.countdown);
        assert_eq!(alone.title, "A call in your browser");
        let meet = event("meet", -2, 30, None);
        assert!(decide(&moment(Some((&chrome, T - 60_000)), Some(&meet), &none)).unwrap().countdown);
        let mut room = event("room", -2, 30, None);
        room.meeting_url = None;
        assert!(!decide(&moment(Some((&chrome, T - 60_000)), Some(&room), &none)).unwrap().countdown);
    }

    #[test]
    fn the_meeting_under_way_is_the_one_whose_start_is_nearest() {
        let events = vec![event("first", -30, 0, None), event("second", 0, 30, None), event("later", 60, 90, None)];
        assert_eq!(event_at(&events, T - 20 * 60_000).map(|e| e.id.as_str()), Some("first"));
        // Back to back, a minute before the next one starts is that one.
        assert_eq!(event_at(&events, T - 60_000).map(|e| e.id.as_str()), Some("second"));
        assert_eq!(event_at(&events, T + 60_000).map(|e| e.id.as_str()), Some("second"));
        assert_eq!(event_at(&events, T + 50 * 60_000).map(|e| e.id.as_str()), Some("later"));
        assert_eq!(event_at(&events, T + 40 * 60_000), None);
    }

    #[test]
    fn a_recording_stops_once_its_call_has_let_go_of_the_mic() {
        let recording = AutoRecording { session_id: "s".into(), bundle: "us.zoom.xos".into(), precise: true, event_ends_at: None };
        assert!(!should_stop(&recording, None, T));
        assert!(!should_stop(&recording, Some(T - END_GRACE_MS + 1), T));
        assert!(should_stop(&recording, Some(T - END_GRACE_MS), T));
    }

    #[test]
    fn without_precise_reports_it_stops_after_the_meeting_ends() {
        let mut recording = AutoRecording { session_id: "s".into(), bundle: "us.zoom.xos".into(), precise: false, event_ends_at: Some(T) };
        assert!(!should_stop(&recording, Some(T - 10 * END_GRACE_MS), T + END_GRACE_MS - 1));
        assert!(should_stop(&recording, None, T + END_GRACE_MS));
        recording.event_ends_at = None;
        assert!(!should_stop(&recording, Some(T - 10 * END_GRACE_MS), T + 10 * END_GRACE_MS));
    }
}
