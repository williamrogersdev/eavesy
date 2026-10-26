//! Only run a capture engine signed by the same team as Eavesy
//! (docs/plans/device-security.md, phase 0).
//!
//! A signed Eavesy reads its own team ID once, then checks the SwiftAudio
//! binary with `codesign --verify --strict` against a requirement naming that
//! team. A binary that fails is never launched. A dev build has no team ID, so
//! there is nothing to compare against and the check is skipped.
//!
//! A deep verify costs a few hundred milliseconds, so it runs once in the
//! background at launch and is cached by the file's inode, size and ctime
//! (ctime, unlike mtime, can't be set back with `touch`). There's still a
//! moment between the check and the launch in which the file could be
//! swapped; closing it needs `fexecve`, which macOS doesn't have.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

const CODESIGN: &str = "/usr/bin/codesign";

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    path: PathBuf,
    ino: u64,
    size: u64,
    ctime: i64,
    ctime_ns: i64,
}

impl Stamp {
    fn of(path: &Path) -> Result<Self, String> {
        let meta = std::fs::metadata(path).map_err(|error| format!("capture engine unreadable: {error}"))?;
        Ok(Self { path: path.to_path_buf(), ino: meta.ino(), size: meta.size(), ctime: meta.ctime(), ctime_ns: meta.ctime_nsec() })
    }
}

/// The last verdict, for the file as it was then.
static VERDICT: Mutex<Option<(Stamp, Result<(), String>)>> = Mutex::new(None);

/// Eavesy's own team ID, or `None` for an unsigned or ad-hoc (dev) build.
fn own_team() -> Option<&'static str> {
    static TEAM: OnceLock<Option<String>> = OnceLock::new();
    TEAM.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let output = Command::new(CODESIGN).arg("-dv").arg("--verbose=2").arg(&exe).output().ok()?;
        // codesign prints the details on stderr.
        team_from_details(&String::from_utf8_lossy(&output.stderr))
    })
    .as_deref()
}

/// `TeamIdentifier=ABCDE12345` from `codesign -dv` output. "not set" (ad-hoc)
/// and anything that isn't a plain team ID give `None`.
fn team_from_details(details: &str) -> Option<String> {
    let team = details.lines().find_map(|line| line.strip_prefix("TeamIdentifier="))?.trim();
    (team.len() == 10 && team.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())).then(|| team.to_string())
}

/// The designated requirement the engine must meet: a Developer ID (or other
/// Apple-anchored) signature whose leaf certificate names our team.
fn requirement(team: &str) -> String {
    format!("=anchor apple generic and certificate leaf[subject.OU] = \"{team}\"")
}

fn verify(path: &Path, team: &str) -> Result<(), String> {
    let output = Command::new(CODESIGN)
        .args(["--verify", "--strict", "-R"])
        .arg(requirement(team))
        .arg(path)
        .output()
        .map_err(|error| format!("couldn't check the capture engine's signature: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let why = String::from_utf8_lossy(&output.stderr);
        Err(format!("the capture engine isn't signed by Eavesy's developer, so it won't be run ({}). Reinstall Eavesy.", why.trim()))
    }
}

/// Ok when `path` may be run. Uses the cached verdict while the file is
/// unchanged; otherwise checks it now.
pub fn check(path: &Path) -> Result<(), String> {
    let Some(team) = own_team() else { return Ok(()) };
    let stamp = Stamp::of(path)?;
    if let Some((seen, verdict)) = VERDICT.lock().map_err(|_| "capture engine check is unavailable".to_string())?.as_ref() {
        if *seen == stamp {
            return verdict.clone();
        }
    }
    let verdict = verify(path, team);
    if let Err(error) = &verdict {
        crate::telemetry::capture("sidecar_trust.verify", error);
    }
    if let Ok(mut slot) = VERDICT.lock() {
        *slot = Some((stamp, verdict.clone()));
    }
    verdict
}

/// Checks the engine in the background, so the first capture doesn't wait for it.
pub fn warm(path: PathBuf) {
    std::thread::spawn(move || {
        let _ = check(&path);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_a_real_team_id() {
        let signed = "Executable=/Applications/Eavesy.app/Contents/MacOS/eavesy\nAuthority=Developer ID Application: W R (AB12CD34EF)\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2";
        assert_eq!(team_from_details(signed).as_deref(), Some("AB12CD34EF"));
        assert_eq!(team_from_details("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(team_from_details("code object is not signed at all"), None);
        assert_eq!(team_from_details(""), None);
        assert_eq!(team_from_details("TeamIdentifier=ab12\" or true"), None);
    }

    #[test]
    fn requirement_names_the_team() {
        assert_eq!(requirement("AB12CD34EF"), "=anchor apple generic and certificate leaf[subject.OU] = \"AB12CD34EF\"");
    }

    #[test]
    fn a_changed_file_is_checked_again() {
        let dir = std::env::temp_dir().join(format!("eavesy-sidecar-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("SwiftAudio");
        std::fs::write(&file, b"one").unwrap();
        let before = Stamp::of(&file).unwrap();
        std::fs::write(&file, b"three").unwrap();
        let after = Stamp::of(&file).unwrap();
        assert_ne!(before, after);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
