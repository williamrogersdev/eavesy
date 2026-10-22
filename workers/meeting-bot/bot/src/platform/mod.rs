//! What a meeting platform has to provide. The recorder, the leave rules and
//! delivery to Eavesy never see a browser: Meet and Teams implement
//! [`Session`] with Chromium ([`browser`]), and Zoom will implement it with
//! the Linux Meeting SDK.

pub mod browser;

use serde::Deserialize;
use tokio::sync::mpsc;

/// Remote audio as the call delivers it: 16 kHz mono PCM, with the block's
/// peak level (0..1) so speech time is counted without decoding again.
pub struct AudioBlock {
    pub pcm: Vec<i16>,
    pub peak: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// The app is still loading, or showing something we don't recognise.
    Loading,
    /// The join screen: name, devices, the join button.
    Prejoin,
    /// Waiting for the host to admit us.
    Lobby,
    InCall,
    /// The call ended, or we were removed from it.
    Ended,
    Denied,
    SignInRequired,
    NotFound,
}

/// One look at the meeting.
#[derive(Debug, Deserialize)]
pub struct Observation {
    pub phase: Phase,
    #[serde(default)]
    pub alone: bool,
    /// Everyone the app lists, the bot included.
    #[serde(default)]
    pub participants: Vec<String>,
    /// Who the app shows as talking right now.
    #[serde(default)]
    pub speaking: Vec<String>,
    /// Anything worth logging when the phase is unexpected (URL, title, audio tap).
    #[serde(flatten)]
    pub detail: serde_json::Map<String, serde_json::Value>,
}

impl Observation {
    pub fn loading() -> Self {
        Self { phase: Phase::Loading, alone: false, participants: vec![], speaking: vec![], detail: Default::default() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Meet,
    Teams,
}

impl Kind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "meet" => Some(Self::Meet),
            "teams" => Some(Self::Teams),
            _ => None,
        }
    }
}

/// A joined (or joining) meeting on one platform.
#[allow(async_fn_in_trait)] // used generically, never as a trait object
pub trait Session {
    /// Starts joining. Audio is sent to `audio` from the moment the call delivers any.
    async fn open(&mut self, audio: mpsc::UnboundedSender<AudioBlock>) -> Result<(), String>;
    /// Looks at the meeting once, moving the join flow along if it can.
    async fn observe(&mut self) -> Observation;
    /// Tells the call the bot is transcribing it. Best effort.
    async fn announce(&mut self, message: &str) -> bool;
    /// Leaves the call, if it is in one.
    async fn leave(&mut self);
    /// Resolves if the session died on its own (the browser crashed).
    async fn closed(&mut self) -> String;
}
