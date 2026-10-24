//! Speaks with macOS's own voice (`/usr/bin/say`, the voice chosen in System
//! Settings → Accessibility → Spoken Content). One line at a time; a new line
//! or a dictation stops the one playing.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static PLAYING: Mutex<Option<Child>> = Mutex::new(None);
/// `say` reads a long line for a long time; summaries are a sentence or two.
const MAX_SPOKEN: usize = 600;

pub fn say(text: &str) {
    let text: String = text.chars().filter(|c| !c.is_control()).take(MAX_SPOKEN).collect();
    if text.trim().is_empty() {
        return;
    }
    let mut playing = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stop_locked(&mut playing);
    // `--` so a line starting with a dash is read, not taken as a flag.
    match Command::new("/usr/bin/say").arg("--").arg(text).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(child) => *playing = Some(child),
        Err(error) => tracing::warn!("could not speak: {error}"),
    }
}

/// Stops speaking at once, so you can talk.
pub fn stop() {
    let mut playing = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stop_locked(&mut playing);
}

fn stop_locked(playing: &mut Option<Child>) {
    if let Some(mut child) = playing.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
