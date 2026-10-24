//! Speaks with macOS's own voices (`/usr/bin/say`): the one chosen in Settings →
//! Assistant, or else the one in System Settings → Accessibility → Spoken
//! Content. One line at a time; a new line or a dictation stops the one playing.

use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
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
/// Words per minute a voice can be set to; `say` speaks at about 175 by default.
pub const RATES: std::ops::RangeInclusive<u16> = 100..=360;

/// Which voice, and how fast. `None` leaves each to the system.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Voice {
    pub name: Option<String>,
    pub rate: Option<u16>,
}

impl Voice {
    /// Refuses a voice this Mac doesn't have and a speed out of range.
    pub fn checked(name: Option<String>, rate: Option<u16>) -> Result<Voice, String> {
        let name = name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
        if let Some(name) = &name {
            if !voices().iter().any(|voice| &voice.name == name) {
                return Err(format!("This Mac doesn't have a voice called {name}."));
            }
        }
        if let Some(rate) = rate {
            if !RATES.contains(&rate) {
                return Err(format!("Pick a speed from {} to {} words a minute.", RATES.start(), RATES.end()));
            }
        }
        Ok(Voice { name, rate })
    }
}

static CHOSEN: Mutex<Option<Voice>> = Mutex::new(None);

/// Settings calls this whenever it loads or saves.
pub fn set_voice(voice: Voice) {
    *CHOSEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(voice);
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceInfo {
    pub name: String,
    /// Like `en_US`.
    pub locale: String,
}

/// The voices `say -v '?'` lists, read once.
pub fn voices() -> &'static [VoiceInfo] {
    static VOICES: OnceLock<Vec<VoiceInfo>> = OnceLock::new();
    VOICES.get_or_init(|| {
        match Command::new("/usr/bin/say").args(["-v", "?"]).stdin(Stdio::null()).stderr(Stdio::null()).output() {
            Ok(output) => parse_voices(&String::from_utf8_lossy(&output.stdout)),
            Err(error) => {
                tracing::warn!("could not list voices: {error}");
                Vec::new()
            }
        }
    })
}

/// Lines look like `Eddy (English (US))  en_US    # Hello! My name is Eddy.`:
/// the name can hold spaces, so the locale is the last word before the `#`.
fn parse_voices(listing: &str) -> Vec<VoiceInfo> {
    listing
        .lines()
        .filter_map(|line| {
            let (head, _) = line.split_once('#')?;
            let (name, locale) = head.trim_end().rsplit_once(char::is_whitespace)?;
            let name = name.trim();
            // A name that starts with a dash would read as a flag to `say`.
            (!name.is_empty() && !name.starts_with('-') && locale.contains('_')).then(|| VoiceInfo { name: name.to_string(), locale: locale.to_string() })
        })
        .collect()
}

/// The arguments before the text: a voice only if this Mac has it, a speed only in range.
fn voice_args(voice: &Voice) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(name) = &voice.name {
        if voices().iter().any(|known| &known.name == name) {
            args.extend(["-v".to_string(), name.clone()]);
        }
    }
    if let Some(rate) = voice.rate.filter(|rate| RATES.contains(rate)) {
        args.extend(["-r".to_string(), rate.to_string()]);
    }
    args
}

pub fn say(text: &str) {
    let text = speakable(text);
    if text.trim().is_empty() {
        return;
    }
    let voice = CHOSEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone().unwrap_or_default();
    let args = voice_args(&voice);
    let mut playing = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stop_locked(&mut playing);
    // `--` so a line starting with a dash is read, not taken as a flag.
    match Command::new("/usr/bin/say").args(args).arg("--").arg(text).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
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

#[cfg(test)]
mod tests {
    use super::{parse_voices, speakable, voice_args, Voice};

    #[test]
    fn voices_keep_names_with_spaces_and_skip_odd_lines() {
        let listing = "Albert              en_US    # Hello! My name is Albert.\nEddy (English (US)) en_US    # Hello! My name is Eddy.\n-v                  en_US    # sneaky\ngarbage\nBad Locale          xx       # hi\n";
        let voices = parse_voices(listing);
        let names: Vec<_> = voices.iter().map(|voice| voice.name.as_str()).collect();
        assert_eq!(names, ["Albert", "Eddy (English (US))"]);
        assert_eq!(voices[1].locale, "en_US");
    }

    #[test]
    fn unknown_voices_and_wild_speeds_are_dropped() {
        assert!(voice_args(&Voice { name: Some("No Such Voice Here".into()), rate: Some(5) }).is_empty());
        assert_eq!(voice_args(&Voice { name: None, rate: Some(200) }), ["-r", "200"]);
        assert!(Voice::checked(Some("No Such Voice Here".into()), None).is_err());
        assert!(Voice::checked(None, Some(1000)).is_err());
        assert_eq!(Voice::checked(Some("  ".into()), None), Ok(Voice::default()));
    }

    #[test]
    fn embedded_speech_commands_are_read_as_text() {
        assert_eq!(speakable("hi [[slnc 99999]] there [[[volm 0]]]"), "hi [slnc 99999] there [volm 0]");
        assert_eq!(speakable("a\u{7}b\nc"), "abc");
    }
}
