//! Runs a system tool by absolute path and gives up on it after a deadline.
//!
//! For the short, fixed commands Eavesy reads the Mac's state with (codesign,
//! the security checkup). Their output is a few lines, well within the pipe
//! buffer, so polling the child can't stall it.

use std::ffi::OsStr;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Runs `program` with `args`, killing it if it hasn't finished within `timeout`.
pub fn output<S: AsRef<OsStr>>(program: &str, args: &[S], timeout: Duration) -> Result<Output, String> {
    let name = program.rsplit('/').next().unwrap_or(program);
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("couldn't run {name}: {error}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().map_err(|error| format!("{name} failed: {error}")),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} didn't answer"));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name} failed: {error}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_what_the_command_printed() {
        let out = output("/bin/echo", &["hello"], Duration::from_secs(5)).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hello\n");
        assert!(out.status.success());
    }

    #[test]
    fn gives_up_on_a_command_that_hangs() {
        let started = Instant::now();
        let error = output("/bin/sleep", &["30"], Duration::from_millis(200)).unwrap_err();
        assert_eq!(error, "sleep didn't answer");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn says_when_the_program_is_missing() {
        assert!(output("/no/such/tool", &[] as &[&str], Duration::from_secs(1)).unwrap_err().starts_with("couldn't run tool"));
    }
}
