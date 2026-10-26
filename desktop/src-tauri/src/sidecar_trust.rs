//! Only run a capture engine signed by the same team as Eavesy
//! (docs/plans/device-security.md, phase 0).
//!
//! A signed Eavesy reads its own team ID once, then checks the SwiftAudio
//! binary with `codesign --verify --strict` against a requirement naming that
//! team. A binary that fails is never launched. A dev build is unsigned or
//! ad-hoc signed, so there is no team to compare against and the check is
//! skipped. If Eavesy can't tell which of the two it is, it refuses the engine
//! and asks again on the next capture.
//!
//! A deep verify costs a few hundred milliseconds, so it runs once in the
//! background at launch and is cached by the file's inode, size and ctime
//! (ctime, unlike mtime, can't be set back with `touch`). A capture that starts
//! during that first check waits for it. There's still a moment between the
//! check and the launch in which the file could be swapped; closing it needs
//! `fexecve`, which macOS doesn't have.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

const CODESIGN: &str = "/usr/bin/codesign";
/// A deep verify takes well under a second; anything near this is stuck.
const CODESIGN_TIMEOUT: Duration = Duration::from_secs(15);

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

/// Runs codesign, giving up (and killing it) after `CODESIGN_TIMEOUT`.
fn codesign(args: &[&std::ffi::OsStr]) -> Result<Output, String> {
    let child = Command::new(CODESIGN)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("couldn't run codesign: {error}"))?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(CODESIGN_TIMEOUT) {
        Ok(output) => output.map_err(|error| format!("codesign failed: {error}")),
        Err(_) => {
            // SAFETY: kill(2) on our own child's pid; the waiting thread reaps it.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            Err("codesign didn't answer".to_string())
        }
    }
}

/// How Eavesy itself is signed. A definite answer is kept for the life of the
/// process; `Unknown` is asked again next time.
fn own_signer() -> Signer {
    static SIGNER: Mutex<Option<Signer>> = Mutex::new(None);
    let mut slot = SIGNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(known) = slot.as_ref() {
        return known.clone();
    }
    let signer = match std::env::current_exe().map_err(|error| error.to_string()).and_then(|exe| codesign(&["-dv".as_ref(), "--verbose=2".as_ref(), exe.as_os_str()])) {
        // codesign prints the details on stderr.
        Ok(output) => {
            let details = String::from_utf8_lossy(&output.stderr);
            let signer = signer_from_details(&details);
            if signer == Signer::Unknown {
                crate::telemetry::capture("sidecar_trust.signer", &format!("unrecognised codesign output: {}", details.chars().take(300).collect::<String>()));
            }
            signer
        }
        Err(error) => {
            crate::telemetry::capture("sidecar_trust.signer", &error);
            Signer::Unknown
        }
    };
    if signer != Signer::Unknown {
        *slot = Some(signer.clone());
    }
    signer
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
    let requirement = requirement(team);
    let output = codesign(&["--verify".as_ref(), "--strict".as_ref(), "-R".as_ref(), requirement.as_ref(), path.as_os_str()])
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
        // A panic mid-check leaves at worst an old verdict, which the stamp check discards.
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        Signer::Unknown => return Err("couldn't read Eavesy's own signature, so the capture engine won't be run. Try again, or quit and reopen Eavesy.".to_string()),
    };
    VERDICTS.check(path, |path| {
        let verdict = verify(path, &team);
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
    fn reads_a_dev_build_with_the_real_codesign() {
        // Test binaries are ad-hoc signed by the linker, like a dev build.
        let exe = std::env::current_exe().unwrap();
        let output = codesign(&["-dv".as_ref(), "--verbose=2".as_ref(), exe.as_os_str()]).unwrap();
        assert_eq!(signer_from_details(&String::from_utf8_lossy(&output.stderr)), Signer::Nobody);
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
