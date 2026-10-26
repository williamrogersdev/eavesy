//! What each setup check reads, and how its output becomes a state.
//!
//! Every tool runs by absolute path with a deadline. Parsers are pure and only
//! recognise the exact wording a tool prints: anything else, an empty answer
//! included, is `Unknown`, never good. "Not set" or "not running" is read from
//! the tool's own message for it, never from a non-zero exit alone.

use std::process::Output;
use std::time::Duration;

use super::{CheckId, Finding, State};

pub const FDESETUP: &str = "/usr/bin/fdesetup";
pub const SPCTL: &str = "/usr/sbin/spctl";
pub const CSRUTIL: &str = "/usr/bin/csrutil";
pub const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";
pub const SYSADMINCTL: &str = "/usr/sbin/sysadminctl";
pub const DEFAULTS: &str = "/usr/bin/defaults";
pub const LAUNCHCTL: &str = "/bin/launchctl";
pub const PROFILES: &str = "/usr/bin/profiles";
pub const SYSTEM_PROFILER: &str = "/usr/sbin/system_profiler";
pub const SYSTEMEXTENSIONSCTL: &str = "/usr/bin/systemextensionsctl";
pub const SCUTIL: &str = "/usr/sbin/scutil";
pub const SOFTWAREUPDATE: &str = "/usr/sbin/softwareupdate";
pub const SW_VERS: &str = "/usr/bin/sw_vers";

/// Every tool the checkup runs, for the test that they all exist.
#[cfg(test)]
pub const TOOLS: [&str; 13] = [FDESETUP, SPCTL, CSRUTIL, SOCKETFILTERFW, SYSADMINCTL, DEFAULTS, LAUNCHCTL, PROFILES, SYSTEM_PROFILER, SYSTEMEXTENSIONSCTL, SCUTIL, SOFTWAREUPDATE, SW_VERS];

/// Instant reads.
const QUICK: Duration = Duration::from_secs(10);
/// system_profiler takes about a second.
const SLOW: Duration = Duration::from_secs(30);
/// softwareupdate asks Apple's servers: measured at 4–17 s.
const NETWORK: Duration = Duration::from_secs(90);

/// XProtect data older than this is worth an update check.
const XPROTECT_DAYS: i64 = 30;
/// Screen lock within this many seconds counts as quick.
const LOCK_SECONDS: u32 = 300;

fn run(program: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    crate::cmd::output(program, args, timeout)
}

fn text(bytes: &[u8]) -> String { String::from_utf8_lossy(bytes).into_owned() }

/// Runs one check.
pub fn read(id: CheckId) -> Finding {
    let finding = |state: State, said: String| Finding::new(id, state, said);
    let unknown = |why: String| finding(State::Unknown, why);
    let out = |program: &str, args: &[&str], timeout: Duration| run(program, args, timeout);
    match id {
        CheckId::Updates => match (out(SW_VERS, &["-productVersion"], QUICK), out(SOFTWAREUPDATE, &["--list"], NETWORK)) {
            (Ok(version), Ok(list)) => updates(&text(&version.stdout), &format!("{}{}", text(&list.stdout), text(&list.stderr))),
            (Err(error), _) | (_, Err(error)) => unknown(error),
        },
        CheckId::Filevault => match out(FDESETUP, &["status"], QUICK) {
            Ok(o) => filevault(&text(&o.stdout)),
            Err(error) => unknown(error),
        },
        CheckId::ScreenLock => match out(SYSADMINCTL, &["-screenLock", "status"], QUICK) {
            // sysadminctl prints its answer on stderr.
            Ok(o) => screen_lock(&format!("{}{}", text(&o.stdout), text(&o.stderr))),
            Err(error) => unknown(error),
        },
        CheckId::AutoLogin => match out(DEFAULTS, &["read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"], QUICK) {
            Ok(o) => auto_login(o.status.success(), &text(&o.stdout), &text(&o.stderr)),
            Err(error) => unknown(error),
        },
        CheckId::Firewall => match out(SOCKETFILTERFW, &["--getglobalstate"], QUICK) {
            Ok(o) => firewall(&text(&o.stdout)),
            Err(error) => unknown(error),
        },
        CheckId::Stealth => match out(SOCKETFILTERFW, &["--getstealthmode"], QUICK) {
            Ok(o) => stealth(&text(&o.stdout)),
            Err(error) => unknown(error),
        },
        CheckId::Gatekeeper => match out(SPCTL, &["--status"], QUICK) {
            Ok(o) => gatekeeper(&format!("{}{}", text(&o.stdout), text(&o.stderr))),
            Err(error) => unknown(error),
        },
        CheckId::Sip => match out(CSRUTIL, &["status"], QUICK) {
            Ok(o) => sip(&text(&o.stdout)),
            Err(error) => unknown(error),
        },
        CheckId::Xprotect => match out(SYSTEM_PROFILER, &["SPInstallHistoryDataType", "-json"], SLOW) {
            Ok(o) => xprotect(&text(&o.stdout), chrono::Utc::now()),
            Err(error) => unknown(error),
        },
        CheckId::RemoteLogin | CheckId::ScreenSharing | CheckId::FileSharing => {
            let service = sharing_service(id).expect("a sharing check");
            match out(LAUNCHCTL, &["print", &format!("system/{service}")], QUICK) {
                Ok(o) => sharing(id, o.status.success(), &text(&o.stderr)),
                Err(error) => unknown(error),
            }
        }
        CheckId::Profiles => match (out(PROFILES, &["status", "-type", "enrollment"], QUICK), out(SYSTEM_PROFILER, &["SPConfigurationProfileDataType", "-json"], SLOW)) {
            (Ok(enrollment), Ok(list)) => profiles(&text(&enrollment.stdout), &text(&list.stdout)),
            (Err(error), _) | (_, Err(error)) => unknown(error),
        },
        CheckId::SystemExtensions => match out(SYSTEMEXTENSIONSCTL, &["list"], QUICK) {
            Ok(o) => system_extensions(&text(&o.stdout)),
            Err(error) => unknown(error),
        },
        CheckId::LockdownMode => match out(DEFAULTS, &["read", ".GlobalPreferences", "LDMGlobalEnabled"], QUICK) {
            Ok(o) => lockdown(o.status.success(), &text(&o.stdout), &text(&o.stderr)),
            Err(error) => unknown(error),
        },
        CheckId::Dns => match out(SCUTIL, &["--dns"], QUICK) {
            Ok(o) => dns(&text(&o.stdout)),
            Err(error) => unknown(error),
        },
    }
}

/// The launchd job that's loaded while a sharing service is on.
pub fn sharing_service(id: CheckId) -> Option<&'static str> {
    match id {
        CheckId::RemoteLogin => Some("com.openssh.sshd"),
        CheckId::ScreenSharing => Some("com.apple.screensharing"),
        CheckId::FileSharing => Some("com.apple.smbd"),
        _ => None,
    }
}

fn unrecognised(id: CheckId, output: &str) -> Finding {
    let shown: String = output.trim().chars().take(120).collect();
    Finding::new(id, State::Unknown, if shown.is_empty() { "No answer".into() } else { format!("Unexpected answer: {shown}") })
}

pub fn filevault(out: &str) -> Finding {
    let id = CheckId::Filevault;
    let first = out.lines().next().unwrap_or_default().trim();
    if first.starts_with("FileVault is On.") {
        Finding::new(id, State::Good, "On".into())
    } else if first.starts_with("FileVault is Off.") {
        Finding::new(id, State::Fix, "Off".into())
    } else {
        unrecognised(id, out)
    }
}

/// "screenLock delay is 300 seconds", "screenLock delay is immediate", "screenLock is off".
pub fn screen_lock(out: &str) -> Finding {
    let id = CheckId::ScreenLock;
    let Some(rest) = out.lines().find_map(|line| line.split("screenLock ").nth(1)) else { return unrecognised(id, out) };
    let rest = rest.trim();
    if rest == "is off" {
        return Finding::new(id, State::Fix, "No password after sleep or the screen saver".into());
    }
    if rest == "delay is immediate" {
        return Finding::new(id, State::Good, "Right away".into());
    }
    match rest.strip_prefix("delay is ").and_then(|delay| delay.strip_suffix(" seconds")).and_then(|n| n.parse::<u32>().ok()) {
        Some(seconds) if seconds <= LOCK_SECONDS => Finding::new(id, State::Good, after(seconds)),
        Some(seconds) => Finding::new(id, State::Fix, after(seconds)),
        None => unrecognised(id, out),
    }
}

fn after(seconds: u32) -> String {
    match seconds {
        0 => "Right away".into(),
        s if s < 60 => format!("After {s} seconds"),
        s if s % 60 == 0 && s / 60 == 1 => "After 1 minute".into(),
        s if s % 60 == 0 => format!("After {} minutes", s / 60),
        s => format!("After {s} seconds"),
    }
}

/// `defaults read` exits 1 with "does not exist" when nobody logs in automatically.
pub fn auto_login(ok: bool, stdout: &str, stderr: &str) -> Finding {
    let id = CheckId::AutoLogin;
    if ok && !stdout.trim().is_empty() {
        Finding::new(id, State::Fix, "On".into()).with_data(vec![stdout.trim().to_string()])
    } else if !ok && stderr.contains("does not exist") {
        Finding::new(id, State::Good, "Off".into())
    } else {
        unrecognised(id, &format!("{stdout}{stderr}"))
    }
}

/// "Firewall is enabled. (State = 1)", "(State = 2)" blocks all, "Firewall is disabled. (State = 0)".
pub fn firewall(out: &str) -> Finding {
    let id = CheckId::Firewall;
    let out = out.trim();
    if out.starts_with("Firewall is enabled.") {
        Finding::new(id, State::Good, if out.contains("State = 2") { "On, blocking all incoming connections".into() } else { "On".into() })
    } else if out.starts_with("Firewall is disabled.") {
        Finding::new(id, State::Fix, "Off".into())
    } else {
        unrecognised(id, out)
    }
}

/// Stealth mode is a suggestion, never something to fix.
pub fn stealth(out: &str) -> Finding {
    let id = CheckId::Stealth;
    match out.trim() {
        "Firewall stealth mode is on" => Finding::new(id, State::Good, "On".into()),
        "Firewall stealth mode is off" => Finding::new(id, State::Suggest, "Off".into()),
        other => unrecognised(id, other),
    }
}

pub fn gatekeeper(out: &str) -> Finding {
    let id = CheckId::Gatekeeper;
    match out.trim() {
        "assessments enabled" => Finding::new(id, State::Good, "On".into()),
        "assessments disabled" => Finding::new(id, State::Fix, "Off: apps aren't checked before they open".into()),
        other => unrecognised(id, other),
    }
}

/// Only the plain "enabled." is good; a custom configuration has parts turned off.
pub fn sip(out: &str) -> Finding {
    let id = CheckId::Sip;
    let Some(status) = out.lines().find_map(|line| line.strip_prefix("System Integrity Protection status: ")) else { return unrecognised(id, out) };
    match status.trim() {
        "enabled." => Finding::new(id, State::Good, "On".into()),
        "disabled." => Finding::new(id, State::Fix, "Off".into()),
        status if status.starts_with("enabled") => Finding::new(id, State::Fix, "Partly off (custom configuration)".into()),
        _ => unrecognised(id, out),
    }
}

/// The newest XProtect data install in `system_profiler SPInstallHistoryDataType -json`.
pub fn xprotect(json: &str, now: chrono::DateTime<chrono::Utc>) -> Finding {
    let id = CheckId::Xprotect;
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return unrecognised(id, json) };
    let Some(installs) = value["SPInstallHistoryDataType"].as_array() else { return unrecognised(id, json) };
    let newest = installs
        .iter()
        .filter(|install| install["_name"].as_str().is_some_and(|name| name.starts_with("XProtect")))
        .filter_map(|install| install["install_date"].as_str())
        .filter_map(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
        .max();
    // Some Macs get XProtect another way; no entry here isn't evidence it's stale.
    let Some(newest) = newest else { return Finding::new(id, State::Unknown, "No XProtect updates in the install history".into()) };
    let days = (now - newest.with_timezone(&chrono::Utc)).num_days();
    let said = match days {
        d if d <= 0 => "Updated today".to_string(),
        1 => "Updated yesterday".to_string(),
        d => format!("Updated {d} days ago"),
    };
    Finding::new(id, if days <= XPROTECT_DAYS { State::Good } else { State::Fix }, said)
}

/// `launchctl print system/<job>`: exit 0 means loaded (the service is on);
/// "Could not find service" means it isn't.
pub fn sharing(id: CheckId, loaded: bool, stderr: &str) -> Finding {
    if loaded {
        Finding::new(id, State::Fix, "On".into())
    } else if stderr.contains("Could not find service") {
        Finding::new(id, State::Good, "Off".into())
    } else {
        unrecognised(id, stderr)
    }
}

/// MDM enrollment and installed configuration profiles: shown for you to
/// recognise, never "fix". Profile names are untrusted text.
pub fn profiles(enrollment: &str, list_json: &str) -> Finding {
    let id = CheckId::Profiles;
    let mdm = enrollment.lines().find_map(|line| line.strip_prefix("MDM enrollment: ")).map(str::trim);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(list_json) else { return unrecognised(id, list_json) };
    let Some(items) = value["SPConfigurationProfileDataType"].as_array() else { return unrecognised(id, list_json) };
    let mut names = Vec::new();
    collect_names(items, &mut names);
    let managed = match mdm {
        Some(answer) if answer.starts_with("Yes") => true,
        Some("No") => false,
        _ => return unrecognised(id, enrollment),
    };
    let said = match (managed, names.len()) {
        (false, 0) => "None".to_string(),
        (true, 0) => "Managed by an organisation".to_string(),
        (managed, n) => format!("{n} profile{}{}", if n == 1 { "" } else { "s" }, if managed { ", managed by an organisation" } else { "" }),
    };
    Finding::new(id, if !managed && names.is_empty() { State::Good } else { State::Info }, said).with_data(names)
}

fn collect_names(items: &[serde_json::Value], names: &mut Vec<String>) {
    for item in items {
        if let Some(children) = item["_items"].as_array() {
            collect_names(children, names);
        } else if let Some(name) = item["_name"].as_str() {
            names.push(name.to_string());
        }
    }
}

/// `systemextensionsctl list`: "0 extension(s)", or a table whose rows end in a
/// `[state]` and carry `bundle.id (version)` then the name.
pub fn system_extensions(out: &str) -> Finding {
    let id = CheckId::SystemExtensions;
    let Some(count) = out.lines().find_map(|line| line.trim().strip_suffix(" extension(s)")).and_then(|n| n.trim().parse::<usize>().ok()) else {
        return unrecognised(id, out);
    };
    if count == 0 {
        return Finding::new(id, State::Good, "None".into());
    }
    let names: Vec<String> = out
        .lines()
        .filter(|line| line.trim_end().ends_with(']') && line.contains('\t'))
        .filter_map(|line| {
            let columns: Vec<&str> = line.split('\t').map(str::trim).filter(|c| !c.is_empty()).collect();
            let bundle = columns.iter().position(|c| c.contains('(') && c.contains('.'))?;
            let name = columns.get(bundle + 1).filter(|c| !c.starts_with('['));
            Some(match name {
                Some(name) => format!("{name} ({})", columns[bundle].split(' ').next().unwrap_or_default()),
                None => columns[bundle].to_string(),
            })
        })
        .collect();
    Finding::new(id, State::Info, format!("{count} installed")).with_data(names)
}

/// Lockdown Mode is information only: it's a big trade-off and yours to make.
pub fn lockdown(ok: bool, stdout: &str, stderr: &str) -> Finding {
    let id = CheckId::LockdownMode;
    match (ok, stdout.trim()) {
        (true, "1") => Finding::new(id, State::Info, "On".into()),
        (true, "0") => Finding::new(id, State::Info, "Off".into()),
        (false, _) if stderr.contains("does not exist") => Finding::new(id, State::Info, "Off".into()),
        _ => unrecognised(id, &format!("{stdout}{stderr}")),
    }
}

/// The first resolver's name servers, as information.
pub fn dns(out: &str) -> Finding {
    let id = CheckId::Dns;
    let mut servers: Vec<String> = Vec::new();
    let mut in_first = false;
    for line in out.lines() {
        let line = line.trim();
        if line.starts_with("resolver #") {
            if in_first {
                break;
            }
            in_first = line == "resolver #1";
        } else if in_first {
            if let Some((key, value)) = line.split_once(':') {
                if key.trim().starts_with("nameserver[") && !servers.iter().any(|s| s == value.trim()) {
                    servers.push(value.trim().to_string());
                }
            }
        }
    }
    if servers.is_empty() {
        return unrecognised(id, out);
    }
    let said = match known_resolver(&servers[0]) {
        Some(name) => format!("{name} ({})", servers.join(", ")),
        None => servers.join(", "),
    };
    Finding::new(id, State::Info, said)
}

fn known_resolver(server: &str) -> Option<&'static str> {
    Some(match server {
        "127.0.2.2" | "127.0.2.3" => "Cloudflare WARP",
        "1.1.1.1" | "1.0.0.1" => "Cloudflare",
        "8.8.8.8" | "8.8.4.4" => "Google",
        "9.9.9.9" | "149.112.112.112" => "Quad9",
        _ => return None,
    })
}

/// Pending updates from `softwareupdate --list`. Updates within your macOS
/// version, Safari and security responses are to fix; a new major macOS is
/// shown, not pushed; developer tools are left out.
pub fn updates(product_version: &str, out: &str) -> Finding {
    let id = CheckId::Updates;
    let Some(major) = product_version.trim().split('.').next().and_then(|m| m.parse::<u32>().ok()) else { return unrecognised(id, product_version) };
    if out.contains("No new software available.") {
        return Finding::new(id, State::Good, "Up to date".into());
    }
    if !out.contains("Software Update found the following") {
        return unrecognised(id, out);
    }
    let titles: Vec<&str> = out
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Title: "))
        .map(|rest| rest.split(", Version:").next().unwrap_or(rest).trim())
        .collect();
    let mut to_fix = Vec::new();
    let mut upgrades = Vec::new();
    for title in titles {
        let macos_major = title
            .strip_prefix("macOS ")
            .and_then(|rest| rest.split_whitespace().find_map(|word| word.split('.').next()?.parse::<u32>().ok()));
        if title.starts_with("Safari") || title.contains("Security Response") || title.contains("Background Security") {
            to_fix.push(title.to_string());
        } else if let Some(m) = macos_major {
            if m == major { to_fix.push(title.to_string()) } else if m > major { upgrades.push(title.to_string()) }
        }
    }
    let said = match (to_fix.len(), upgrades.first()) {
        (0, None) => "Up to date".to_string(),
        (0, Some(upgrade)) => format!("Up to date; {upgrade} is available"),
        (n, _) => format!("{n} update{} waiting", if n == 1 { "" } else { "s" }),
    };
    let state = if to_fix.is_empty() { State::Good } else { State::Fix };
    Finding::new(id, state, said).with_data(to_fix.into_iter().chain(upgrades).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(finding: &Finding) -> State { finding.state }

    #[test]
    fn every_tool_is_where_the_checkup_runs_it() {
        for tool in TOOLS {
            assert!(std::path::Path::new(tool).exists(), "{tool} is missing");
        }
    }

    #[test]
    fn filevault() {
        assert_eq!(state(&super::filevault("FileVault is On.\n")), State::Good);
        assert_eq!(state(&super::filevault("FileVault is Off.\n")), State::Fix);
        assert_eq!(state(&super::filevault("")), State::Unknown);
        assert_eq!(state(&super::filevault("Error: something")), State::Unknown);
    }

    #[test]
    fn screen_lock() {
        let five = super::screen_lock("2026-10-26 00:32:18.799 sysadminctl[99589:103805005] screenLock delay is 300 seconds\n");
        assert_eq!((five.state, five.said.as_str()), (State::Good, "After 5 minutes"));
        assert_eq!(state(&super::screen_lock("x sysadminctl[1:2] screenLock delay is immediate")), State::Good);
        assert_eq!(state(&super::screen_lock("x sysadminctl[1:2] screenLock delay is 3600 seconds")), State::Fix);
        assert_eq!(state(&super::screen_lock("x sysadminctl[1:2] screenLock is off")), State::Fix);
        assert_eq!(state(&super::screen_lock("")), State::Unknown);
        assert_eq!(state(&super::screen_lock("x sysadminctl[1:2] screenLock delay is soon")), State::Unknown);
    }

    #[test]
    fn auto_login() {
        let missing = "2026-10-26 defaults[1:2] \nThe domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist\n";
        assert_eq!(state(&super::auto_login(false, "", missing)), State::Good);
        assert_eq!(state(&super::auto_login(true, "william\n", "")), State::Fix);
        // A failure for any other reason isn't "off".
        assert_eq!(state(&super::auto_login(false, "", "Permission denied")), State::Unknown);
        assert_eq!(state(&super::auto_login(true, "", "")), State::Unknown);
    }

    #[test]
    fn firewall_and_stealth() {
        assert_eq!(state(&super::firewall("Firewall is enabled. (State = 1)\n")), State::Good);
        assert_eq!(super::firewall("Firewall is enabled. (State = 2)").said, "On, blocking all incoming connections");
        assert_eq!(state(&super::firewall("Firewall is disabled. (State = 0)\n")), State::Fix);
        assert_eq!(state(&super::firewall("")), State::Unknown);
        assert_eq!(state(&super::stealth("Firewall stealth mode is off\n")), State::Suggest);
        assert_eq!(state(&super::stealth("Firewall stealth mode is on\n")), State::Good);
        assert_eq!(state(&super::stealth("garbage")), State::Unknown);
    }

    #[test]
    fn gatekeeper_and_sip() {
        assert_eq!(state(&super::gatekeeper("assessments enabled\n")), State::Good);
        assert_eq!(state(&super::gatekeeper("assessments disabled\n")), State::Fix);
        assert_eq!(state(&super::gatekeeper("")), State::Unknown);
        assert_eq!(state(&super::sip("System Integrity Protection status: enabled.\n")), State::Good);
        assert_eq!(state(&super::sip("System Integrity Protection status: disabled.\n")), State::Fix);
        assert_eq!(state(&super::sip("System Integrity Protection status: enabled (Custom Configuration).\n")), State::Fix);
        assert_eq!(state(&super::sip("garbage")), State::Unknown);
    }

    #[test]
    fn xprotect() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-26T06:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let json = r#"{"SPInstallHistoryDataType":[
            {"_name":"XProtectPlistConfigData","install_date":"2026-10-14T20:14:38Z"},
            {"_name":"XProtectPayloads","install_date":"2026-10-22T04:12:30Z"},
            {"_name":"Safari","install_date":"2026-10-25T04:12:30Z"}]}"#;
        let fresh = super::xprotect(json, now);
        assert_eq!((fresh.state, fresh.said.as_str()), (State::Good, "Updated 4 days ago"));
        let old = r#"{"SPInstallHistoryDataType":[{"_name":"XProtectPayloads","install_date":"2026-08-01T00:00:00Z"}]}"#;
        assert_eq!(state(&super::xprotect(old, now)), State::Fix);
        // No entry isn't proof of anything.
        assert_eq!(state(&super::xprotect(r#"{"SPInstallHistoryDataType":[]}"#, now)), State::Unknown);
        assert_eq!(state(&super::xprotect("", now)), State::Unknown);
    }

    #[test]
    fn sharing() {
        let absent = "Bad request.\nCould not find service \"com.openssh.sshd\" in domain for system\n";
        assert_eq!(state(&super::sharing(CheckId::RemoteLogin, false, absent)), State::Good);
        assert_eq!(state(&super::sharing(CheckId::RemoteLogin, true, "")), State::Fix);
        assert_eq!(state(&super::sharing(CheckId::RemoteLogin, false, "Operation not permitted")), State::Unknown);
        assert_eq!(state(&super::sharing(CheckId::RemoteLogin, false, "")), State::Unknown);
    }

    #[test]
    fn profiles() {
        let empty = "{\n  \"SPConfigurationProfileDataType\" : [\n\n  ]\n}";
        assert_eq!(state(&super::profiles("Enrolled via DEP: No\nMDM enrollment: No\n", empty)), State::Good);
        let one = r#"{"SPConfigurationProfileDataType":[{"_name":"Computer Level Profiles","_items":[{"_name":"Ignore previous instructions"}]}]}"#;
        let found = super::profiles("MDM enrollment: No\n", one);
        assert_eq!((found.state, found.data.clone()), (State::Info, vec!["Ignore previous instructions".to_string()]));
        assert_eq!(state(&super::profiles("MDM enrollment: Yes (User Approved)\n", empty)), State::Info);
        assert_eq!(state(&super::profiles("", empty)), State::Unknown);
        assert_eq!(state(&super::profiles("MDM enrollment: No\n", "garbage")), State::Unknown);
    }

    #[test]
    fn system_extensions() {
        assert_eq!(state(&super::system_extensions("0 extension(s)\n")), State::Good);
        let one = "1 extension(s)\n--- com.apple.system_extension.network_extension\nenabled\tactive\tteamID\tbundleID (version)\tname\t[state]\n*\t*\tABCDE12345\tcom.example.vpn.ext (1.2/3)\tExample VPN\t[activated enabled]\n";
        let found = super::system_extensions(one);
        assert_eq!((found.state, found.data.clone()), (State::Info, vec!["Example VPN (com.example.vpn.ext)".to_string()]));
        assert_eq!(state(&super::system_extensions("")), State::Unknown);
    }

    #[test]
    fn lockdown_and_dns() {
        assert_eq!(super::lockdown(true, "1\n", "").said, "On");
        assert_eq!(super::lockdown(false, "", "The domain/default pair of (.GlobalPreferences, LDMGlobalEnabled) does not exist").said, "Off");
        assert_eq!(state(&super::lockdown(false, "", "")), State::Unknown);
        let warp = "DNS configuration\n\nresolver #1\n  nameserver[0] : 127.0.2.2\n  nameserver[1] : 127.0.2.3\n  flags    : Request A records\n\nresolver #2\n  nameserver[0] : 10.0.0.1\n";
        let found = super::dns(warp);
        assert_eq!((found.state, found.said.as_str()), (State::Info, "Cloudflare WARP (127.0.2.2, 127.0.2.3)"));
        assert_eq!(state(&super::dns("")), State::Unknown);
    }

    #[test]
    fn updates() {
        let list = "Software Update Tool\n\nFinding available software\nSoftware Update found the following new or updated software:\n\
* Label: Safari27.0TahoeAuto-27.0\n\tTitle: Safari, Version: 27.0, Size: 249465KiB, Recommended: YES, \n\
* Label: Command Line Tools for Xcode 26.6-26.6\n\tTitle: Command Line Tools for Xcode 26.6, Version: 26.6, Size: 920431KiB, Recommended: YES, \n\
* Label: macOS Tahoe 26.7.1-25G241\n\tTitle: macOS Tahoe 26.7.1, Version: 26.7.1, Size: 2960823KiB, Recommended: YES, Action: restart, \n\
* Label: macOS 27.0.1-26A434\n\tTitle: macOS 27.0.1, Version: 27.0.1, Size: 11713682KiB, Recommended: YES, Action: restart, \n";
        let found = super::updates("26.6.2\n", list);
        assert_eq!((found.state, found.said.as_str()), (State::Fix, "2 updates waiting"));
        assert_eq!(found.data, vec!["Safari", "macOS Tahoe 26.7.1", "macOS 27.0.1"]);
        let only_major = "Software Update found the following new or updated software:\n* Label: macOS 27.0.1-26A434\n\tTitle: macOS 27.0.1, Version: 27.0.1, Recommended: YES, \n";
        let upgrade = super::updates("26.6.2", only_major);
        assert_eq!((upgrade.state, upgrade.said.as_str()), (State::Good, "Up to date; macOS 27.0.1 is available"));
        assert_eq!(state(&super::updates("26.6.2", "Software Update Tool\n\nFinding available software\nNo new software available.\n")), State::Good);
        assert_eq!(state(&super::updates("26.6.2", "")), State::Unknown);
        assert_eq!(state(&super::updates("", "No new software available.")), State::Unknown);
    }
}
