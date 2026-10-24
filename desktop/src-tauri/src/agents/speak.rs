//! Speaks with macOS's own voice (`/usr/bin/say`, the voice chosen in System
//! Settings → Accessibility → Spoken Content). One line at a time; a new line
//! or a dictation stops the one playing.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The line playing, numbered so its watcher knows it's still the one.
static PLAYING: Mutex<Option<(u64, Child)>> = Mutex::new(None);
static NEXT: Mutex<u64> = Mutex::new(0);
/// When Eavesy last stopped talking, and whether the line played to its end
/// (false: it was cut off).
static QUIET_SINCE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
/// `say` reads a long line for a long time; summaries are a sentence or two.
const MAX_SPOKEN: usize = 600;
const POLL: Duration = Duration::from_millis(100);

pub fn say(text: &str) {
    let text: String = text.chars().filter(|c| !c.is_control()).take(MAX_SPOKEN).collect();
    if text.trim().is_empty() {
        return;
    }
    let mut playing = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stop_locked(&mut playing);
    // `--` so a line starting with a dash is read, not taken as a flag.
    match Command::new("/usr/bin/say").arg("--").arg(text).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(child) => {
            let line = {
                let mut next = NEXT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                *next += 1;
                *next
            };
            *playing = Some((line, child));
            std::thread::spawn(move || watch(line));
        }
        Err(error) => tracing::warn!("could not speak: {error}"),
    }
}

/// Notes when the line finishes by itself.
fn watch(line: u64) {
    loop {
        std::thread::sleep(POLL);
        let mut playing = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match playing.as_mut() {
            Some((current, child)) if *current == line => {
                if !matches!(child.try_wait(), Ok(None)) {
                    *playing = None;
                    *QUIET_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), true));
                    return;
                }
            }
            // Stopped or replaced: whoever did that noted it.
            _ => return,
        }
    }
}

/// Stops speaking at once, so you can talk.
pub fn stop() {
    let mut playing = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stop_locked(&mut playing);
}

/// Whether a line is playing, and if not, since when it's been quiet and
/// whether the last line was heard to its end.
pub fn status() -> (bool, Option<(Instant, bool)>) {
    let speaking = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some();
    (speaking, *QUIET_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
}

fn stop_locked(playing: &mut Option<(u64, Child)>) {
    if let Some((_, mut child)) = playing.take() {
        let _ = child.kill();
        let _ = child.wait();
        *QUIET_SINCE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((Instant::now(), false));
    }
}
