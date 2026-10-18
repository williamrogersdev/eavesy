//! A spare capture engine, launched before the dictation hotkey is pressed.
//!
//! A cold start spends its first ~100 ms (more after the app sat idle)
//! launching the engine and loading its frameworks, and anything said in that
//! time is never recorded. The spare has done all of that and built its mic
//! session, but has not started it: the microphone stays closed, and macOS
//! shows no recording indicator, until it is handed a capture. One spare at a
//! time; it is replaced once the capture it became has stopped.

use std::ffi::OsString;
use std::io::Write;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

static SPARE: Mutex<Option<Engine>> = Mutex::new(None);

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

/// A started capture: the engine process and its pipes.
pub type Started = (Child, ChildStdin, ChildStdout);

impl Engine {
    /// Launches `cmd`, which must wait for a `start` line before capturing.
    pub fn launch(mut cmd: Command) -> Result<Engine, String> {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start a spare capture engine: {e}"))?;
        match (child.stdin.take(), child.stdout.take()) {
            (Some(stdin), Some(stdout)) => Ok(Engine { child, stdin, stdout }),
            _ => {
                reap(&mut child);
                Err("spare capture engine has no pipes".to_string())
            }
        }
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Hands the capture to this engine: it starts as a cold launch with
    /// `args` would. On failure the engine is gone and the caller starts cold.
    pub fn start(mut self, args: &[OsString]) -> Result<Started, String> {
        let sent = start_line(args)
            .ok_or_else(|| "a capture argument is not UTF-8".to_string())
            .and_then(|line| {
                writeln!(self.stdin, "{line}")
                    .and_then(|()| self.stdin.flush())
                    .map_err(|e| format!("spare capture engine did not take the start: {e}"))
            });
        match sent {
            Ok(()) => Ok((self.child, self.stdin, self.stdout)),
            Err(error) => {
                reap(&mut self.child);
                Err(error)
            }
        }
    }
}

fn reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// `{"start":[...]}`: what the engine would have been launched with.
pub fn start_line(args: &[OsString]) -> Option<String> {
    let args = args.iter().map(|a| a.to_str()).collect::<Option<Vec<_>>>()?;
    Some(serde_json::json!({ "start": args }).to_string())
}

/// The spare, if there is one and it is still running.
pub fn take() -> Option<Engine> {
    let mut engine = SPARE.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    if engine.alive() {
        Some(engine)
    } else {
        reap(&mut engine.child);
        None
    }
}

/// Launches a spare unless a live one is waiting already. The launch happens
/// outside the lock, so a press taking the spare never waits on it.
pub fn refill(make: impl FnOnce() -> Result<Command, String>) -> Result<(), String> {
    if !needs_spare() {
        return Ok(());
    }
    let mut engine = Engine::launch(make()?)?;
    let mut spare = SPARE.lock().unwrap_or_else(|e| e.into_inner());
    if spare.is_some() {
        // Another refill got there first.
        drop(spare);
        reap(&mut engine.child);
    } else {
        *spare = Some(engine);
    }
    Ok(())
}

/// Whether no live spare is waiting; a dead one is cleared away.
fn needs_spare() -> bool {
    let mut spare = SPARE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(engine) = spare.as_mut() else { return true };
    if engine.alive() {
        return false;
    }
    reap(&mut engine.child);
    *spare = None;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    /// Stands in for the engine: answers its start line with the line itself.
    fn echo_engine() -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("read line; echo \"$line\"; read stop; echo \"$stop\"");
        cmd
    }

    #[test]
    fn the_start_line_carries_the_cold_launch_arguments() {
        let args: Vec<OsString> = ["--mode", "audio", "--out", "/tmp/a \"b\".m4a"].map(Into::into).into();
        assert_eq!(
            start_line(&args).unwrap(),
            r#"{"start":["--mode","audio","--out","/tmp/a \"b\".m4a"]}"#
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_argument_that_is_not_utf8_cannot_be_sent() {
        use std::os::unix::ffi::OsStringExt;
        assert_eq!(start_line(&[OsString::from_vec(vec![0xff])]), None);
    }

    #[test]
    fn a_started_spare_is_the_capture_with_its_pipes() {
        let engine = Engine::launch(echo_engine()).unwrap();
        let (mut child, mut stdin, stdout) = engine.start(&["--mode".into(), "audio".into()]).unwrap();
        writeln!(stdin, "stop").unwrap();
        let lines: Vec<String> = BufReader::new(stdout).lines().map(Result::unwrap).collect();
        assert_eq!(lines, [r#"{"start":["--mode","audio"]}"#, "stop"]);
        assert!(child.wait().unwrap().success());
    }

    /// The only test that touches `SPARE`; any other must share a lock with it.
    #[test]
    fn a_spare_that_died_is_not_handed_out_and_is_replaced() {
        let mut quits = Command::new("/bin/sh");
        quits.arg("-c").arg("exit 0");
        refill(|| Ok(quits)).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while SPARE.lock().unwrap().as_mut().is_some_and(Engine::alive) {
            assert!(std::time::Instant::now() < deadline, "the shell never exited");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(take().is_none(), "a dead spare is never handed out");

        refill(|| Ok(echo_engine())).unwrap();
        refill(|| Err("a live spare is kept, not relaunched".to_string())).unwrap();
        let (mut child, stdin, _) = take().unwrap().start(&[]).unwrap();
        assert!(take().is_none(), "the spare is handed out once");
        drop(stdin);
        let _ = child.wait();
    }
}
