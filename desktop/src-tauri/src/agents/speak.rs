//! Speaks with macOS's own voice (`/usr/bin/say`, the voice chosen in System
//! Settings → Accessibility → Spoken Content). One line at a time; a new line
//! or a dictation stops the one playing.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static PLAYING: Mutex<Option<Child>> = Mutex::new(None);
/// `say` reads a long line for a long time; summaries are a sentence or two.
const MAX_SPOKEN: usize = 600;

pub fn say(text: &str) {
    let text = speakable(text);
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

/// What `say` is given: no control characters, and no `[[ … ]]` embedded
/// speech commands (`say` would change its voice or rate or go silent on
/// them), since the text can come from an agent.
fn speakable(text: &str) -> String {
    let mut text: String = text.chars().filter(|c| !c.is_control()).take(MAX_SPOKEN).collect();
    while text.contains("[[") || text.contains("]]") {
        text = text.replace("[[", "[").replace("]]", "]");
    }
    text
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

#[cfg(test)]
mod tests {
    use super::speakable;

    #[test]
    fn embedded_speech_commands_are_read_as_text() {
        assert_eq!(speakable("hi [[slnc 99999]] there [[[volm 0]]]"), "hi [slnc 99999] there [volm 0]");
        assert_eq!(speakable("a\u{7}b\nc"), "abc");
    }
}
