//! What Eavesy can do about a check: turn a setting on with your admin password,
//! or open the System Settings pane where you change it yourself.
//!
//! The admin commands are fixed strings with nothing from a request in them, and
//! every one only tightens a setting. All the ones in a batch run under a single
//! password prompt. What they changed is read back from the checks afterwards,
//! never from their output: `do shell script` drops stdout when the last command
//! fails.

use std::time::Duration;

use super::CheckId;

const OSASCRIPT: &str = "/usr/bin/osascript";
const OPEN: &str = "/usr/bin/open";
/// Long enough for you to find your password; then it counts as cancelled.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(600);

/// A setting Eavesy turns on with your admin password.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verb {
    Firewall,
    Stealth,
    Gatekeeper,
    AutoLogin,
}

impl Verb {
    pub fn check(self) -> CheckId {
        match self {
            Verb::Firewall => CheckId::Firewall,
            Verb::Stealth => CheckId::Stealth,
            Verb::Gatekeeper => CheckId::Gatekeeper,
            Verb::AutoLogin => CheckId::AutoLogin,
        }
    }

    /// What the card and the password prompt say.
    pub fn label(self) -> &'static str {
        match self {
            Verb::Firewall => "Turn on the firewall",
            Verb::Stealth => "Turn on stealth mode",
            Verb::Gatekeeper => "Turn on Gatekeeper",
            Verb::AutoLogin => "Turn off automatic login and delete its saved password",
        }
    }

    fn command(self) -> &'static str {
        match self {
            Verb::Firewall => "/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on",
            Verb::Stealth => "/usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on",
            Verb::Gatekeeper => "/usr/sbin/spctl --global-enable",
            // The saved password goes with the setting, even if the setting was already gone.
            Verb::AutoLogin => "/usr/bin/defaults delete /Library/Preferences/com.apple.loginwindow autoLoginUser; /bin/rm -f /etc/kcpassword",
        }
    }
}

/// How a check gets fixed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Remedy {
    Admin(Verb),
    /// The System Settings pane where you change it.
    Pane(&'static str),
    /// Nothing Eavesy or Settings can change from here.
    Explain(&'static str),
}

pub fn remedy(id: CheckId) -> Remedy {
    match id {
        CheckId::Firewall => Remedy::Admin(Verb::Firewall),
        CheckId::Stealth => Remedy::Admin(Verb::Stealth),
        CheckId::Gatekeeper => Remedy::Admin(Verb::Gatekeeper),
        CheckId::AutoLogin => Remedy::Admin(Verb::AutoLogin),
        CheckId::Sip => Remedy::Explain(
            "System Integrity Protection can only be turned back on from Recovery: restart holding the power button, open Terminal from Utilities, run csrutil enable, then restart.",
        ),
        other => Remedy::Pane(pane(other)),
    }
}

/// The System Settings pane for a check, as an extension id.
pub fn pane(id: CheckId) -> &'static str {
    match id {
        CheckId::Updates | CheckId::Xprotect => "com.apple.Software-Update-Settings.extension",
        CheckId::Filevault | CheckId::Gatekeeper | CheckId::LockdownMode | CheckId::Sip => "com.apple.settings.PrivacySecurity.extension",
        CheckId::ScreenLock => "com.apple.Lock-Screen-Settings.extension",
        CheckId::AutoLogin => "com.apple.Users-Groups-Settings.extension",
        CheckId::Firewall | CheckId::Stealth | CheckId::Dns => "com.apple.Network-Settings.extension",
        CheckId::RemoteLogin | CheckId::ScreenSharing | CheckId::FileSharing => "com.apple.Sharing-Settings.extension",
        CheckId::Profiles => "com.apple.Profiles-Settings.extension",
        CheckId::SystemExtensions => "com.apple.LoginItems-Settings.extension",
    }
}

pub fn open_pane(id: CheckId) -> Result<(), String> {
    let url = format!("x-apple.systempreferences:{}", pane(id));
    let out = crate::cmd::output(OPEN, &[url.as_str()], Duration::from_secs(10))?;
    if out.status.success() { Ok(()) } else { Err(format!("couldn't open System Settings: {}", String::from_utf8_lossy(&out.stderr).trim())) }
}

/// The shell script: the commands one after another, so one failing doesn't stop
/// the rest. Always in the same order.
fn script(verbs: &[Verb]) -> String {
    let mut verbs = verbs.to_vec();
    verbs.sort();
    verbs.dedup();
    verbs.iter().map(|verb| verb.command()).collect::<Vec<_>>().join("; ")
}

/// What the password prompt says: only fixed labels.
fn prompt(verbs: &[Verb]) -> String {
    let labels: Vec<String> = verbs.iter().map(|verb| verb.label().to_lowercase()).collect();
    format!("Eavesy wants to {}.", labels.join(", "))
}

fn applescript(verbs: &[Verb]) -> String {
    format!(
        "do shell script {} with prompt {} with administrator privileges",
        crate::install_location::applescript_string(&script(verbs)),
        crate::install_location::applescript_string(&prompt(verbs))
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admin {
    /// The password was given and the commands ran; the checks say what changed.
    Ran,
    Cancelled,
    /// osascript couldn't run, or a command failed. Some may still have changed.
    Failed(String),
}

/// Runs the verbs under one admin password prompt. Blocks until it's answered.
pub fn run_admin(verbs: &[Verb]) -> Admin {
    match crate::cmd::output(OSASCRIPT, &["-e", &applescript(verbs)], PROMPT_TIMEOUT) {
        Ok(out) => outcome(out.status.success(), &String::from_utf8_lossy(&out.stderr)),
        Err(error) => Admin::Failed(error),
    }
}

fn outcome(success: bool, stderr: &str) -> Admin {
    if success {
        return Admin::Ran;
    }
    // osascript reports a cancelled password prompt as error -128.
    if stderr.contains("(-128)") {
        return Admin::Cancelled;
    }
    let stderr = stderr.trim();
    Admin::Failed(if stderr.is_empty() { "the admin command failed".into() } else { stderr.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_is_fixed_and_in_order() {
        assert_eq!(
            script(&[Verb::Gatekeeper, Verb::Firewall, Verb::Gatekeeper]),
            "/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on; /usr/sbin/spctl --global-enable"
        );
        assert_eq!(prompt(&[Verb::Firewall, Verb::AutoLogin]), "Eavesy wants to turn on the firewall, turn off automatic login and delete its saved password.");
        let source = applescript(&[Verb::Stealth]);
        assert!(source.starts_with("do shell script \"/usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on\" with prompt "));
        assert!(source.ends_with(" with administrator privileges"));
    }

    #[test]
    fn a_cancelled_prompt_is_told_apart() {
        assert_eq!(outcome(true, ""), Admin::Ran);
        assert_eq!(outcome(false, "execution error: User canceled. (-128)"), Admin::Cancelled);
        assert_eq!(outcome(false, "0:59: execution error: nope (1)"), Admin::Failed("0:59: execution error: nope (1)".into()));
    }

    /// The AppleScript compiles, prompt and all, without running anything.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_applescript_compiles() {
        let out = std::env::temp_dir().join(format!("eavesy-fix-{}.scpt", std::process::id()));
        let all = [Verb::Firewall, Verb::Stealth, Verb::Gatekeeper, Verb::AutoLogin];
        let compiled = std::process::Command::new("/usr/bin/osacompile").args(["-e", &applescript(&all), "-o"]).arg(&out).output().unwrap();
        let _ = std::fs::remove_file(&out);
        assert!(compiled.status.success(), "{}", String::from_utf8_lossy(&compiled.stderr));
    }

    #[test]
    fn every_check_has_a_remedy_and_admin_ones_point_back() {
        for id in CheckId::ALL {
            if let Remedy::Admin(verb) = remedy(id) {
                assert_eq!(verb.check(), id);
            }
            assert!(pane(id).starts_with("com.apple."));
        }
        assert!(matches!(remedy(CheckId::Sip), Remedy::Explain(_)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn every_pane_exists() {
        for id in CheckId::ALL {
            let appex = format!("/System/Library/ExtensionKit/Extensions/{}", pane(id).trim_end_matches(".extension"));
            let found = std::fs::read_dir("/System/Library/ExtensionKit/Extensions")
                .unwrap()
                .filter_map(Result::ok)
                .any(|entry| {
                    let info = entry.path().join("Contents/Info.plist");
                    std::fs::read(&info).is_ok_and(|bytes| bytes.windows(pane(id).len()).any(|w| w == pane(id).as_bytes()))
                });
            assert!(found, "{appex} isn't installed");
        }
    }
}
