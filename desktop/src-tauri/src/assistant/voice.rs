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
    let answer = match super::thread::send(app, text.to_string(), true) {
        Ok(()) => super::thread::last_reply(app),
        Err(error) => Some((None, error)),
    };
    let Some((turn, reply)) = answer else {
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
    let said = say(app, turn, &reply);
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
/// Returns whether it's speaking.
pub fn say(app: &AppHandle, turn: Option<usize>, reply: &str) -> bool {
    if hud::current().is_live() {
        return false;
    }
    let line = spoken_line(reply);
    if line.is_empty() {
        return false;
    }
    crate::agents::speak::say(&line);
    if let Some(turn) = turn {
        super::thread::mark_spoken(app, turn);
    }
    hold_esc(app);
    true
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
            Some((turn, reply)) if say(&app, turn, &reply) => Ok(()),
            Some(_) => Err("Eavesy doesn't talk while you're recording.".into()),
            None => Err("There's nothing to repeat.".into()),
        },
        "open" => {
            crate::hotkeys::show_launcher_and_emit(&app, Some(super::EVENT_SHOW));
            Ok(())
        }
        other => Err(format!("unknown action '{other}'")),
    }
}

fn wait_until_quiet() {
    while crate::agents::speak::status().0 {
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
/// on screen (B4). Lists, paths and code are left to the screen.
fn spoken_line(reply: &str) -> String {
    let prose: String = reply
        .lines()
        .map(str::trim)
        .take_while(|line| !line.starts_with("```"))
        .filter(|line| !line.is_empty() && !line.starts_with(['-', '*', '#', '|', '>']) && !line.starts_with(|c: char| c.is_ascii_digit()))
        .collect::<Vec<_>>()
        .join(" ");
    let mut said = String::new();
    let mut sentences = 0;
    for (i, c) in prose.char_indices() {
        said.push(c);
        let ends = matches!(c, '.' | '!' | '?') && prose[i + c.len_utf8()..].starts_with(char::is_whitespace);
        if ends {
            sentences += 1;
            if sentences == 2 {
                break;
            }
        }
        if said.chars().count() >= SPOKEN_CHARS {
            // Cut at a word, not mid-word.
            if let Some(space) = said.rfind(' ') {
                said.truncate(space);
            }
            said.push('…');
            break;
        }
    }
    let said = said.trim().to_string();
    if said.is_empty() {
        return if reply.trim().is_empty() { String::new() } else { "It's on screen.".into() };
    }
    let rest = reply.trim().len() > said.trim_end_matches('…').len() + 2;
    if rest { format!("{said} The rest is on screen.") } else { said }
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
