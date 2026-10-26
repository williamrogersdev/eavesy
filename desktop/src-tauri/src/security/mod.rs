//! The security checkup: how this Mac's own protections are set, read with
//! Apple's tools, and the few settings Eavesy can turn on for you.
//!
//! Reading never needs a password or Full Disk Access. Changing a setting goes
//! through `fix`, one admin prompt per batch, and only ever tightens it.

pub mod checks;
pub mod fix;

use serde::{Deserialize, Serialize};

/// One check. The model names these exactly; anything else fails to parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckId {
    Updates,
    Filevault,
    ScreenLock,
    AutoLogin,
    Firewall,
    Stealth,
    Gatekeeper,
    Sip,
    Xprotect,
    RemoteLogin,
    ScreenSharing,
    FileSharing,
    Profiles,
    SystemExtensions,
    LockdownMode,
    Dns,
}

impl CheckId {
    pub const ALL: [CheckId; 16] = [
        CheckId::Updates,
        CheckId::Filevault,
        CheckId::ScreenLock,
        CheckId::AutoLogin,
        CheckId::Firewall,
        CheckId::Stealth,
        CheckId::Gatekeeper,
        CheckId::Sip,
        CheckId::Xprotect,
        CheckId::RemoteLogin,
        CheckId::ScreenSharing,
        CheckId::FileSharing,
        CheckId::Profiles,
        CheckId::SystemExtensions,
        CheckId::LockdownMode,
        CheckId::Dns,
    ];

    /// The id as the model and the log write it.
    pub fn key(self) -> String {
        serde_json::to_value(self).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
    }

    #[cfg(test)]
    pub fn from_key(key: &str) -> Option<CheckId> { serde_json::from_value(serde_json::Value::String(key.into())).ok() }

    pub fn title(self) -> &'static str {
        match self {
            CheckId::Updates => "macOS updates",
            CheckId::Filevault => "FileVault disk encryption",
            CheckId::ScreenLock => "Password after sleep",
            CheckId::AutoLogin => "Automatic login",
            CheckId::Firewall => "Firewall",
            CheckId::Stealth => "Stealth mode",
            CheckId::Gatekeeper => "Gatekeeper",
            CheckId::Sip => "System Integrity Protection",
            CheckId::Xprotect => "XProtect malware definitions",
            CheckId::RemoteLogin => "Remote Login (SSH)",
            CheckId::ScreenSharing => "Screen Sharing",
            CheckId::FileSharing => "File Sharing",
            CheckId::Profiles => "Configuration profiles",
            CheckId::SystemExtensions => "System extensions",
            CheckId::LockdownMode => "Lockdown Mode",
            CheckId::Dns => "DNS",
        }
    }

    /// Why it matters, in fixed words (the plan's decision 7: explanations are rule-written).
    pub fn why(self) -> &'static str {
        match self {
            CheckId::Updates => "Updates close security holes that attackers already know about.",
            CheckId::Filevault => "Without it, anyone holding your Mac can read your files off the disk.",
            CheckId::ScreenLock => "A Mac left open asks for your password only after this delay.",
            CheckId::AutoLogin => "Anyone who turns on your Mac gets straight to your desktop, and the password is stored in a weakly hidden file.",
            CheckId::Firewall => "Blocks apps you haven't allowed from accepting connections from the network.",
            CheckId::Stealth => "Your Mac stops answering probes such as ping on networks you don't trust.",
            CheckId::Gatekeeper => "Checks that apps come from identified developers and were scanned by Apple before they open.",
            CheckId::Sip => "Protects the system itself from changes, even by an admin. Only Recovery can turn it back on.",
            CheckId::Xprotect => "Apple's built-in malware definitions, updated quietly in the background.",
            CheckId::RemoteLogin => "Lets others log in to this Mac over the network with a password or key.",
            CheckId::ScreenSharing => "Lets others see and control your screen over the network.",
            CheckId::FileSharing => "Shares folders on this Mac with the network.",
            CheckId::Profiles => "Profiles can change settings, add certificates or route traffic. Check you recognise each one.",
            CheckId::SystemExtensions => "These run with deep access, for example VPNs and security tools. Check you recognise each one.",
            CheckId::LockdownMode => "Extreme protection for people who may be personally targeted. It turns off many features.",
            CheckId::Dns => "Who answers when your Mac looks up a web address.",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Good,
    /// Worth changing.
    Fix,
    /// Worth considering; fine to leave.
    Suggest,
    /// Shown for you to know, nothing to change.
    Info,
    /// The check couldn't tell. Never counted as good.
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Finding {
    pub id: CheckId,
    pub state: State,
    /// What the check found, in a few words.
    pub said: String,
    /// Names read from the Mac (profiles, extensions, pending updates). Untrusted text.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<String>,
}

impl Finding {
    pub fn new(id: CheckId, state: State, said: String) -> Finding { Finding { id, state, said, data: Vec::new() } }

    pub fn with_data(self, data: Vec<String>) -> Finding { Finding { data, ..self } }
}

/// Runs every check at once; the slowest (Software Update asks Apple) sets the time.
pub fn checkup() -> Vec<Finding> { read_all(&CheckId::ALL) }

pub fn read_all(ids: &[CheckId]) -> Vec<Finding> {
    std::thread::scope(|scope| {
        let running: Vec<_> = ids.iter().map(|&id| scope.spawn(move || checks::read(id))).collect();
        running
            .into_iter()
            .zip(ids)
            .map(|(handle, &id)| handle.join().unwrap_or_else(|_| Finding::new(id, State::Unknown, "The check failed".into())))
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_and_nothing_else_parses() {
        for id in CheckId::ALL {
            assert_eq!(CheckId::from_key(&id.key()), Some(id));
        }
        assert_eq!(CheckId::ScreenLock.key(), "screen_lock");
        assert_eq!(CheckId::from_key("firewall_off"), None);
        assert_eq!(CheckId::from_key("Firewall"), None);
        assert_eq!(CheckId::from_key(""), None);
    }

    /// The model's tool list offers exactly these ids.
    #[test]
    fn the_model_is_offered_the_same_ids() {
        let ts = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/src/server/assistant.ts")).unwrap();
        let tool = &ts[ts.find("name: 'security_fix'").expect("security_fix in assistant.ts")..];
        let list = &tool[tool.find("enum: [").unwrap() + 7..];
        let offered: Vec<&str> = list[..list.find(']').unwrap()].split(',').map(|id| id.trim().trim_matches('\'')).collect();
        let ours: Vec<String> = CheckId::ALL.iter().map(|id| id.key()).collect();
        assert_eq!(offered, ours);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod on_this_mac {
    /// Reads this Mac (never changes it): `cargo test -- --ignored checkup_reads --nocapture`.
    #[test]
    #[ignore]
    fn checkup_reads_this_mac() {
        for finding in super::checkup() {
            println!("{finding:?}");
            assert_ne!(finding.state, super::State::Unknown, "{finding:?}");
        }
    }
}
