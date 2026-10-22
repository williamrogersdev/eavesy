//! Meet and Teams in Chromium, driven over the DevTools protocol. Chromium
//! runs headful under Xvfb: both apps treat headless Chromium as unsupported.

use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::Instant;

use super::{AudioBlock, Kind, Observation, Session};
use crate::cdp::Cdp;
use crate::ingest::log;

const CAPTURE_JS: &str = include_str!("js/capture.js");
const MEET_JS: &str = include_str!("js/meet.js");
const TEAMS_JS: &str = include_str!("js/teams.js");
const DEBUG_PORT: u16 = 9222;

pub struct Browser {
    kind: Kind,
    meeting_url: String,
    bot_name: String,
    chrome_path: String,
    chrome: Option<Child>,
    page: Option<Cdp>,
}

impl Browser {
    pub fn new(kind: Kind, meeting_url: String, bot_name: String, chrome_path: String) -> Self {
        Self { kind, meeting_url, bot_name, chrome_path, chrome: None, page: None }
    }

    fn adapter(&self) -> &'static str {
        match self.kind {
            Kind::Meet => "meet",
            Kind::Teams => "teams",
        }
    }

    /// Teams links open a "use the desktop app?" launcher unless told to stay in the browser.
    pub fn join_url(kind: Kind, url: &str) -> String {
        match kind {
            Kind::Meet => url.to_owned(),
            Kind::Teams => {
                let sep = if url.contains('?') { '&' } else { '?' };
                format!("{url}{sep}msLaunch=false&directDl=false&suppressPrompt=true&type=meetup-join")
            }
        }
    }

    fn page(&self) -> Result<&Cdp, String> {
        self.page.as_ref().ok_or_else(|| "browser not open".to_owned())
    }

    async fn eval(&self, expression: &str) -> Result<Value, String> {
        self.page()?.eval(expression).await
    }

    fn call_adapter(&self, body: &str) -> String {
        format!("(() => {{ const e = window.__eavesy; const a = e && e.adapters[{:?}]; if (!a) return null; {body} }})()", self.adapter())
    }
}

fn launch(chrome_path: &str) -> Result<Child, String> {
    let profile = std::env::temp_dir().join(format!("eavesy-profile-{}", std::process::id()));
    Command::new(chrome_path)
        .args([
            &format!("--remote-debugging-port={DEBUG_PORT}"),
            "--remote-debugging-address=127.0.0.1",
            &format!("--user-data-dir={}", profile.display()),
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-features=Translate,MediaRouter,OptimizationHints,GlobalMediaControls",
            // The join screens want a camera and microphone; fake ones answer
            // without a permission prompt, and the bot turns both off.
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
            "--lang=en-US",
            // Small enough that the apps ask for small video, big enough for their layouts.
            "--window-size=1024,640",
            "--no-sandbox",
            "about:blank",
        ])
        .env("LANG", "en_US.UTF-8")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("launch {chrome_path}: {e}"))
}

/// The tab Chromium opened on `about:blank` at launch, the only one the bot
/// drives; after a few seconds without one, any page.
async fn page_ws_url() -> Result<String, String> {
    let http = reqwest::Client::new();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(30);
    loop {
        if let Ok(r) = http.get(format!("http://127.0.0.1:{DEBUG_PORT}/json/list")).send().await {
            if let Ok(targets) = r.json::<Vec<Value>>().await {
                let any_page = started.elapsed() > Duration::from_secs(5);
                let ours = |t: &&Value| t["type"] == "page" && (any_page || t["url"] == "about:blank");
                if let Some(url) = targets.iter().find(ours).and_then(|t| t["webSocketDebuggerUrl"].as_str()) {
                    return Ok(url.to_owned());
                }
            }
        }
        if Instant::now() > deadline {
            return Err("chromium did not open a debug port".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Turns the page's `__eavesyAudio` binding calls into audio blocks.
pub fn decode_audio(payload: &str) -> Option<AudioBlock> {
    let block: Value = serde_json::from_str(payload).ok()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(block["pcm"].as_str()?).ok()?;
    let pcm = bytes.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
    Some(AudioBlock { pcm, peak: block["peak"].as_f64().unwrap_or(0.0), at: Instant::now() })
}

impl Session for Browser {
    async fn open(&mut self, audio: mpsc::UnboundedSender<AudioBlock>) -> Result<(), String> {
        self.chrome = Some(launch(&self.chrome_path)?);
        let (page, mut events) = Cdp::connect(&page_ws_url().await?).await?;
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if event.method != "Runtime.bindingCalled" || event.params["name"] != "__eavesyAudio" {
                    continue;
                }
                if let Some(block) = event.params["payload"].as_str().and_then(decode_audio) {
                    if audio.send(block).is_err() {
                        break;
                    }
                }
            }
        });
        page.call("Page.enable", json!({})).await?;
        page.call("Runtime.enable", json!({})).await?;
        // Lets the capture script load its AudioWorklet module under the
        // apps' Trusted Types policy. Only our own injected code relies on it.
        page.call("Page.setBypassCSP", json!({ "enabled": true })).await?;
        page.call("Runtime.addBinding", json!({ "name": "__eavesyAudio" })).await?;
        let adapter = match self.kind {
            Kind::Meet => MEET_JS,
            Kind::Teams => TEAMS_JS,
        };
        page.call("Page.addScriptToEvaluateOnNewDocument", json!({ "source": format!("{CAPTURE_JS}\n{adapter}") })).await?;
        page.call("Page.navigate", json!({ "url": Self::join_url(self.kind, &self.meeting_url) })).await?;
        self.page = Some(page);
        Ok(())
    }

    async fn observe(&mut self) -> Observation {
        let body = format!("return e.step(a, {});", serde_json::to_string(&self.bot_name).unwrap());
        match self.eval(&self.call_adapter(&body)).await {
            Ok(Value::Null) => Observation::loading(),
            Ok(value) => serde_json::from_value(value.clone()).unwrap_or_else(|e| {
                log(json!({ "msg": "observe", "error": e.to_string(), "value": value }));
                Observation::loading()
            }),
            // Navigations destroy the context mid-evaluate; the next look succeeds.
            Err(e) => {
                log(json!({ "msg": "observe", "error": e }));
                Observation::loading()
            }
        }
    }

    async fn announce(&mut self, message: &str) -> bool {
        let body = format!("return a.announce({});", serde_json::to_string(message).unwrap());
        matches!(self.eval(&self.call_adapter(&body)).await, Ok(Value::Bool(true)))
    }

    async fn leave(&mut self) {
        let body = "return e.click(a.leave);";
        let _ = self.eval(&self.call_adapter(body)).await;
        // Give the app a moment to tell the server before the browser goes.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        if let Some(chrome) = self.chrome.as_mut() {
            let _ = chrome.kill().await;
        }
    }

    async fn closed(&mut self) -> String {
        match self.chrome.as_mut() {
            Some(chrome) => format!("chromium exited: {:?}", chrome.wait().await),
            None => std::future::pending().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teams_links_stay_in_the_browser() {
        let url = Browser::join_url(Kind::Teams, "https://teams.microsoft.com/l/meetup-join/19%3a?context=x");
        assert!(url.ends_with("&msLaunch=false&directDl=false&suppressPrompt=true&type=meetup-join"));
        assert_eq!(Browser::join_url(Kind::Meet, "https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
    }

    #[test]
    fn decodes_page_audio() {
        let pcm = base64::engine::general_purpose::STANDARD.encode([1u8, 0, 0xff, 0x7f]);
        let block = decode_audio(&format!(r#"{{"pcm":"{pcm}","peak":0.5}}"#)).unwrap();
        assert_eq!(block.pcm, vec![1, i16::MAX]);
        assert_eq!(block.peak, 0.5);
        assert!(decode_audio("not json").is_none());
    }

    #[test]
    fn observations_parse_from_the_page() {
        let o: Observation = serde_json::from_value(json!({
            "phase": "in_call", "alone": false, "count": 3, "speaking": ["Ana"], "participants": ["Ana", "Ben"], "tracks": 1, "tap": "worklet"
        }))
        .unwrap();
        assert_eq!(o.phase, super::super::Phase::InCall);
        assert_eq!(o.speaking, vec!["Ana"]);
        assert_eq!(o.detail["tap"], "worklet");
        let lobby: Observation = serde_json::from_value(json!({ "phase": "lobby" })).unwrap();
        assert_eq!(lobby.phase, super::super::Phase::Lobby);
    }
}
