//! Talking to Eavesy out loud (docs/plans/assistant.md B4–B7). The Talk to Eavesy
//! shortcut records exactly like dictation; when it stops, the words go to the thread
//! instead of the cursor, and Eavesy answers on the pill and out loud, in a sentence
//! or two. Esc, the shortcut, or starting any dictation stops it talking.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::hud::{self, HudState, Phase};

/// The HUD mode for a recording that goes to Eavesy.
pub const MODE: &str = "assistant";

/// Longest line said out loud; the rest is on screen (B4).
const SPOKEN_CHARS: usize = 220;
/// How long the answer stays on the pill once Eavesy has finished saying it.
const ANSWER_STAYS: Duration = Duration::from_secs(8);
/// Far longer than any spoken line takes: past it, speech is stopped and Esc given back.
const LONGEST_SPEECH: Duration = Duration::from_secs(120);

/// The next recording to open is for Eavesy (set between the key press and the mic opening).
static STARTING: AtomicBool = AtomicBool::new(false);
/// Recordings whose words go to Eavesy.
static SESSIONS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Eavesy has Esc while it's talking.
static HOLDS_ESC: AtomicBool = AtomicBool::new(false);

fn sessions<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut guard = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(HashSet::new))
}

/// A Talk to Eavesy press is opening the mic.
pub fn begin() {
    STARTING.store(true, Ordering::SeqCst);
}

/// Whether the recording opening now is for Eavesy, so the pill says so from the start.
pub fn starting() -> bool {
    STARTING.load(Ordering::SeqCst)
}

/// The mic is open: this recording's words go to Eavesy.
pub fn bind(session_id: &str) {
    STARTING.store(false, Ordering::SeqCst);
    sessions(|all| all.insert(session_id.to_string()));
}

/// The mic didn't open.
pub fn cancel() {
    STARTING.store(false, Ordering::SeqCst);
}

/// Whether this recording's words are still waiting to go to Eavesy.
pub fn is_for(session_id: &str) -> bool {
    sessions(|all| all.contains(session_id))
}

/// Whether this recording was for Eavesy. Taken once, with its words or without.
pub fn take(session_id: &str) -> bool {
    sessions(|all| all.remove(session_id))
}

/// Sends what you said to the thread, then shows and says the answer. Blocking.
pub fn deliver(app: &AppHandle, session_id: &str, text: &str) {
    let thinking = HudState {
        phase: Phase::Transcribing,
        session_id: Some(session_id.to_string()),
        mode: Some(MODE.to_string()),
        started_at_ms: None,
        message: None,
        notice: None,
    };
    hud::advance_from(app, session_id, &[Phase::Recording, Phase::Transcribing], thinking);
    if let Err(error) = super::thread::send(app, text.to_string(), true) {
        // Not an answer: your words weren't sent, and the pill says so in its own voice.
        let failed = HudState {
            phase: Phase::Failed,
            session_id: Some(session_id.to_string()),
            mode: None,
            started_at_ms: None,
            message: Some(format!("{error} What you said wasn't sent.")),
            notice: None,
        };
        hud::advance_from(app, session_id, &[Phase::Recording, Phase::Transcribing], failed);
        return;
    }
    let Some((turn, reply)) = super::thread::last_reply(app) else {
        hud::advance_from(app, session_id, &[Phase::Transcribing], HudState { session_id: Some(session_id.to_string()), ..HudState::idle() });
        return;
    };
    let shown = HudState {
        phase: Phase::Done,
        session_id: Some(session_id.to_string()),
        mode: Some(MODE.to_string()),
        started_at_ms: None,
        message: Some(reply.clone()),
        notice: None,
    };
    let on_pill = hud::advance_from(app, session_id, &[Phase::Transcribing], shown);
    // A card waiting for your click is in the panel; open it there (voice can open a
    // card, never press it).
    if super::waiting_cards(app) > 0 {
        crate::hotkeys::show_launcher_and_emit(app, Some(super::EVENT_SHOW));
    }
    let said = say(app, Some(turn), &reply).is_ok();
    if on_pill {
        let app = app.clone();
        let session_id = session_id.to_string();
        std::thread::spawn(move || {
            if said {
                wait_until_quiet();
            }
            std::thread::sleep(ANSWER_STAYS);
            let idle = HudState { session_id: Some(session_id.clone()), ..HudState::idle() };
            hud::advance_from(&app, &session_id, &[Phase::Done], idle);
        });
    }
}

/// Says the start of `reply` out loud, unless you're dictating or recording (B5).
/// `Err` says why it didn't.
pub fn say(app: &AppHandle, turn: Option<u64>, reply: &str) -> Result<(), String> {
    if hud::current().is_live() {
        return Err("Eavesy doesn't talk while you're recording.".into());
    }
    let line = spoken_line(reply);
    if line.is_empty() {
        return Err("There's nothing to say.".into());
    }
    crate::agents::speak::say(&line);
    if let Some(turn) = turn {
        super::thread::mark_spoken(app, turn);
    }
    hold_esc(app);
    Ok(())
}

/// Stops Eavesy mid-sentence.
pub fn hush(app: &AppHandle) {
    crate::agents::speak::stop();
    release_esc(app);
}

/// The pill's buttons on Eavesy's answer: say it again, or open the conversation.
#[tauri::command]
pub fn hud_assistant(app: AppHandle, window: WebviewWindow, action: String) -> Result<(), String> {
    if window.label() != "hud" {
        return Err("Only the pill can do that.".into());
    }
    match action.as_str() {
        "repeat" => match super::thread::last_reply(&app) {
            Some((turn, reply)) => say(&app, Some(turn), &reply),
            None => Err("There's nothing to repeat.".into()),
        },
        "open" => {
            crate::hotkeys::show_launcher_and_emit(&app, Some(super::EVENT_SHOW));
            Ok(())
        }
        other => Err(format!("unknown action '{other}'")),
    }
}

/// Waits for Eavesy to finish talking, stopping it should it ever run on.
fn wait_until_quiet() {
    let deadline = std::time::Instant::now() + LONGEST_SPEECH;
    while crate::agents::speak::status().0 {
        if std::time::Instant::now() > deadline {
            crate::agents::speak::stop();
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn escape() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// Esc stops Eavesy while it talks, and goes back to your apps once it's done.
fn hold_esc(app: &AppHandle) {
    let shortcut = escape();
    // A screen recording's marking tools may already have Esc; never take it from them.
    // They only take it during a screen recording, when Eavesy doesn't talk (B5), so
    // the check and the register below can't race with them.
    if HOLDS_ESC.load(Ordering::SeqCst) || app.global_shortcut().is_registered(shortcut) {
        return;
    }
    let registered = app.global_shortcut().on_shortcut(shortcut, |app, _, event| {
        if event.state == ShortcutState::Pressed {
            hush(app);
        }
    });
    if registered.is_err() {
        return;
    }
    HOLDS_ESC.store(true, Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        wait_until_quiet();
        release_esc(&app);
    });
}

fn release_esc(app: &AppHandle) {
    if HOLDS_ESC.swap(false, Ordering::SeqCst) {
        let _ = app.global_shortcut().unregister(escape());
    }
}

/// One or two sentences of `reply`, at most `SPOKEN_CHARS`, saying when there's more
/// on screen (B4). Lists, code, paths and links are left to the screen: a sentence
/// with any of them isn't said.
fn spoken_line(reply: &str) -> String {
    let prose = reply
        .lines()
        .map(str::trim)
        .take_while(|line| !line.starts_with("```"))
        .filter(|line| !line.is_empty() && !line.starts_with(['-', '*', '#', '|', '>']) && !line.starts_with(|c: char| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ");
    let sentences = sentences(&prose);
    let sayable: Vec<&str> = sentences.iter().copied().filter(|sentence| !has_code_or_path(sentence)).collect();
    let mut said = String::new();
    for sentence in sayable.iter().take(2) {
        let next = if said.is_empty() { sentence.to_string() } else { format!("{said} {sentence}") };
        if next.chars().count() > SPOKEN_CHARS {
            if said.is_empty() {
                // One long sentence: cut it at a word.
                let cut: String = sentence.chars().take(SPOKEN_CHARS).collect();
                said = format!("{}…", cut.rfind(' ').map_or(cut.as_str(), |space| &cut[..space]));
            }
            break;
        }
        said = next;
    }
    if said.is_empty() {
        return if reply.trim().is_empty() { String::new() } else { "It's on screen.".into() };
    }
    let all_of_it = said == reply.trim();
    if all_of_it { said } else { format!("{said} The rest is on screen.") }
}

/// `text` split after each `.`, `!` or `?` that ends a sentence.
fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        if matches!(c, '.' | '!' | '?') && text[end..].starts_with(char::is_whitespace) {
            out.push(text[start..end].trim());
            start = end;
        }
    }
    let rest = text[start..].trim();
    if !rest.is_empty() {
        out.push(rest);
    }
    out
}

fn has_code_or_path(sentence: &str) -> bool {
    sentence.contains('`')
        || sentence.split_whitespace().any(|word| {
            let word = word.trim_start_matches(['(', '"', '\'']);
            word.contains("://") || word.starts_with(['/', '~']) || word.contains("/.") || word.matches('/').count() >= 2
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_two_sentences_and_points_at_the_rest() {
        let reply = "Six dev servers are running. Two are from sessions that ended. The vite one is on 5173.";
        assert_eq!(spoken_line(reply), "Six dev servers are running. Two are from sessions that ended. The rest is on screen.");
        assert_eq!(spoken_line("All clear."), "All clear.");
    }

    #[test]
    fn leaves_lists_and_code_to_the_screen() {
        let reply = "Here's what's left:\n- vite on 5173\n- bun test\n```\nkill 123\n```";
        assert_eq!(spoken_line(reply), "Here's what's left: The rest is on screen.");
        assert_eq!(spoken_line("- just a list"), "It's on screen.");
        assert_eq!(spoken_line("  "), "");
    }

    #[test]
    fn code_paths_and_links_are_left_to_the_screen() {
        let reply = "Run `bun test` in ~/Developer/eavesy or see https://eavesy.com/docs. It's quick.";
        assert_eq!(spoken_line(reply), "It's quick. The rest is on screen.");
    }

    #[test]
    fn a_long_sentence_is_cut_at_a_word() {
        let reply = "word ".repeat(100);
        let line = spoken_line(&reply);
        assert!(line.chars().count() <= SPOKEN_CHARS + " The rest is on screen.".len());
        assert!(line.contains("… The rest is on screen."));
        assert!(!line.contains("wor…"));
    }

    #[test]
    fn a_recording_is_for_eavesy_once() {
        begin();
        assert!(starting());
        bind("talk-1");
        assert!(!starting());
        assert!(take("talk-1"));
        assert!(!take("talk-1"));
        assert!(!take("dictation-1"));
    }
}
