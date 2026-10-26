//! Only run a capture engine signed by the same team as Eavesy
//! (docs/plans/device-security.md, phase 0).
//!
//! A signed Eavesy reads its own team ID once, then checks the SwiftAudio
//! binary with `codesign --verify --strict` against a requirement naming that
//! team. A binary that fails is never launched. A dev build is unsigned or
//! ad-hoc signed, so there is no team to compare against and the check is
//! skipped. If Eavesy can't tell which of the two it is, it refuses the engine.
//!
//! A deep verify costs a few hundred milliseconds, so it runs once in the
//! background at launch and is cached by the file's inode, size and ctime
//! (ctime, unlike mtime, can't be set back with `touch`). A capture that starts
//! during that first check waits for it. There's still a moment between the
//! check and the launch in which the file could be swapped; closing it needs
//! `fexecve`, which macOS doesn't have.

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

/// How Eavesy itself is signed.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Signer {
    Team(String),
    /// Unsigned or ad-hoc: a dev build.
    Nobody,
    /// codesign couldn't be run, or said something we don't recognise.
    Unknown,
}

fn own_signer() -> &'static Signer {
    static SIGNER: OnceLock<Signer> = OnceLock::new();
    SIGNER.get_or_init(|| {
        let Ok(exe) = std::env::current_exe() else { return Signer::Unknown };
        match Command::new(CODESIGN).arg("-dv").arg("--verbose=2").arg(&exe).output() {
            // codesign prints the details on stderr.
            Ok(output) => signer_from_details(&String::from_utf8_lossy(&output.stderr)),
            Err(_) => Signer::Unknown,
        }
    })
}

/// Reads `codesign -dv` output. `TeamIdentifier=ABCDE12345` is a team;
/// "not set" (ad-hoc) or "not signed at all" is nobody; anything else is unknown.
fn signer_from_details(details: &str) -> Signer {
    match details.lines().find_map(|line| line.strip_prefix("TeamIdentifier=")).map(str::trim) {
        Some("not set") => Signer::Nobody,
        Some(team) if team.len() == 10 && team.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) => Signer::Team(team.to_string()),
        Some(_) => Signer::Unknown,
        None if details.contains("code object is not signed at all") => Signer::Nobody,
        None => Signer::Unknown,
    }
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

/// The last verdict, for the file as it was then.
struct Verdicts(Mutex<Option<(Stamp, Result<(), String>)>>);

impl Verdicts {
    /// The cached verdict while the file is unchanged; otherwise runs `verify`.
    /// The lock is held while verifying, so two callers never check the same
    /// file at once: the second gets the first one's answer.
    fn check(&self, path: &Path, verify: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
        let stamp = Stamp::of(path)?;
        let mut slot = self.0.lock().map_err(|_| "capture engine check is unavailable".to_string())?;
        if let Some((seen, verdict)) = slot.as_ref() {
            if *seen == stamp {
                return verdict.clone();
            }
        }
        let verdict = verify(path);
        *slot = Some((stamp, verdict.clone()));
        verdict
    }
}

static VERDICTS: Verdicts = Verdicts(Mutex::new(None));

/// Ok when `path` may be run.
pub fn check(path: &Path) -> Result<(), String> {
    let team = match own_signer() {
        Signer::Team(team) => team,
        Signer::Nobody => return Ok(()),
        Signer::Unknown => {
            let error = "couldn't read Eavesy's own signature, so the capture engine won't be run. Reinstall Eavesy.".to_string();
            crate::telemetry::capture("sidecar_trust.signer", &error);
            return Err(error);
        }
    };
    VERDICTS.check(path, |path| {
        let verdict = verify(path, team);
        if let Err(error) = &verdict {
            crate::telemetry::capture("sidecar_trust.verify", error);
        }
        verdict
    })
}

/// Checks the engine in the background, so the first capture usually finds
/// the answer ready.
pub fn warm(path: PathBuf) {
    std::thread::spawn(move || {
        let _ = check(&path);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_a_team_from_a_dev_build_from_the_unknown() {
        let signed = "Executable=/Applications/Eavesy.app/Contents/MacOS/eavesy\nAuthority=Developer ID Application: W R (AB12CD34EF)\nTeamIdentifier=AB12CD34EF\nSealed Resources version=2";
        assert_eq!(signer_from_details(signed), Signer::Team("AB12CD34EF".into()));
        assert_eq!(signer_from_details("Signature=adhoc\nTeamIdentifier=not set\n"), Signer::Nobody);
        assert_eq!(signer_from_details("/x/eavesy: code object is not signed at all"), Signer::Nobody);
        // Anything we don't recognise refuses the engine rather than skipping the check.
        assert_eq!(signer_from_details(""), Signer::Unknown);
        assert_eq!(signer_from_details("codesign: something new went wrong"), Signer::Unknown);
        assert_eq!(signer_from_details("TeamIdentifier=ab12\" or true"), Signer::Unknown);
    }

    #[test]
    fn requirement_names_the_team() {
        assert_eq!(requirement("AB12CD34EF"), "=anchor apple generic and certificate leaf[subject.OU] = \"AB12CD34EF\"");
    }

    #[test]
    fn a_verdict_is_reused_until_the_file_changes() {
        let dir = std::env::temp_dir().join(format!("eavesy-sidecar-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("SwiftAudio");
        std::fs::write(&file, b"one").unwrap();
        let verdicts = Verdicts(Mutex::new(None));
        let runs = std::cell::Cell::new(0);
        let verify = |_: &Path| {
            runs.set(runs.get() + 1);
            Err("not ours".to_string())
        };
        assert!(verdicts.check(&file, verify).is_err());
        assert!(verdicts.check(&file, verify).is_err());
        assert_eq!(runs.get(), 1);
        std::fs::write(&file, b"three").unwrap();
        assert!(verdicts.check(&file, |_| Ok(())).is_ok());
        assert!(verdicts.check(&file, verify).is_ok());
        assert_eq!(runs.get(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
