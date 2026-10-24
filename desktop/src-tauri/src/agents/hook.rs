//! `Eavesy --agent-hook <stop|notification|prompt>`: the command Claude Code
//! runs for its hooks. It runs before Tauri starts (no window, no telemetry,
//! no single-instance check), hands the event to the running app over the
//! agents socket, and for a held stop waits for your reply.
//!
//! It never stands in Claude's way: if the app isn't running or doesn't answer
//! within `CONNECT_BUDGET`, it exits 0 with no output and Claude carries on.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::protocol::{self, Answer, Event, HookMessage};

const CONNECT_BUDGET: Duration = Duration::from_millis(250);
/// A held hook gives up on its own after this, whatever the app says; Claude
/// Code's own hook timeout is set a little above the hold window.
const MAX_HOLD: Duration = Duration::from_secs(30 * 60);

/// Runs the hook if this process was started as one. Returns false otherwise.
pub fn maybe_run() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let Some(at) = args.iter().position(|arg| arg == "--agent-hook") else {
        return false;
    };
    let event = match args.get(at + 1).map(String::as_str) {
        Some("stop") => Event::Stop,
        Some("notification") => Event::Notification,
        Some("prompt") => Event::Prompt,
        _ => return true,
    };
    let mut input = Vec::new();
    let _ = std::io::stdin().take(protocol::MAX_LINE as u64).read_to_end(&mut input);
    let Some(socket) = super::socket_path() else { return true };
    let env = |key: &str| std::env::var(key).ok();
    let attended = env("EAVESY_NO_HOLD").as_deref() != Some("1")
        && protocol::attended(env("CLAUDE_CODE_SESSION_ATTENDED").as_deref(), env("CLAUDE_CODE_ENTRYPOINT").as_deref());
    let Some(message) = message(event, &input, attended, env("CLAUDE_CODE_HOST_SESSION_ID")) else {
        return true;
    };
    if let Some(reply) = deliver(&socket, &message) {
        println!("{}", protocol::block_output(&reply));
    }
    true
}

/// The hook's stdin as the app wants it, or None when it isn't a hook payload.
pub fn message(event: Event, input: &[u8], attended: bool, host_session_id: Option<String>) -> Option<HookMessage> {
    let value: Value = serde_json::from_slice(input).ok()?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let session_id = text("session_id").filter(|id| !id.is_empty())?;
    let (message, prompt) = match event {
        Event::Stop => (text("last_assistant_message").map(|m| protocol::tail(&m, protocol::MAX_MESSAGE_CHARS)), None),
        Event::Notification => (text("message").map(|m| protocol::head(&m, protocol::MAX_PROMPT_CHARS)), None),
        Event::Prompt => (None, text("prompt").map(|p| protocol::head(&p, protocol::MAX_PROMPT_CHARS))),
    };
    Some(HookMessage {
        v: protocol::VERSION,
        event,
        session_id,
        cwd: text("cwd"),
        message,
        prompt,
        notification_type: text("notification_type"),
        attended,
        host_session_id: host_session_id.filter(|id| !id.is_empty()),
    })
}

/// Sends the event, and if the app holds it, waits for your reply. None means
/// let Claude carry on: no app, no answer in time, a release, or a dropped
/// connection.
pub fn deliver(socket: &Path, message: &HookMessage) -> Option<String> {
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_write_timeout(Some(CONNECT_BUDGET)).ok()?;
    stream.set_read_timeout(Some(CONNECT_BUDGET)).ok()?;
    let mut line = serde_json::to_string(message).ok()?;
    line.push('\n');
    stream.write_all(line.as_bytes()).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    if read_answer(&mut reader)? != (Answer::Ack { hold: true }) {
        return None;
    }
    stream.set_read_timeout(Some(MAX_HOLD)).ok()?;
    match read_answer(&mut reader)? {
        Answer::Reply { text } if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

fn read_answer(reader: &mut impl BufRead) -> Option<Answer> {
    let mut line = String::new();
    reader.by_ref().take(protocol::MAX_LINE as u64).read_line(&mut line).ok()?;
    serde_json::from_str(line.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::time::Instant;

    fn stop_message() -> HookMessage {
        message(Event::Stop, br#"{"session_id":"s1","cwd":"/tmp/p","last_assistant_message":"Ship it?"}"#, true, None).unwrap()
    }

    fn temp_socket(name: &str) -> std::path::PathBuf {
        // Socket paths are capped near 104 bytes, so not the long per-user temp dir.
        let id = uuid::Uuid::new_v4().simple().to_string();
        let path = std::path::PathBuf::from("/tmp").join(format!("ev-{name}-{}.sock", &id[..8]));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn hook_input_becomes_a_message() {
        let m = stop_message();
        assert_eq!(m.session_id, "s1");
        assert_eq!(m.message.as_deref(), Some("Ship it?"));
        assert!(m.attended);
        assert!(message(Event::Stop, b"not json", true, None).is_none());
        assert!(message(Event::Stop, br#"{"session_id":""}"#, true, None).is_none());
        let prompt = message(Event::Prompt, br#"{"session_id":"s1","prompt":"fix it"}"#, false, Some("local_1".into())).unwrap();
        assert_eq!(prompt.prompt.as_deref(), Some("fix it"));
        assert_eq!(prompt.host_session_id.as_deref(), Some("local_1"));
    }

    #[test]
    fn no_app_means_carry_on_at_once() {
        let started = Instant::now();
        assert_eq!(deliver(&temp_socket("missing"), &stop_message()), None);
        assert!(started.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn a_silent_app_is_given_up_on_quickly() {
        let path = temp_socket("silent");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(600));
            drop(stream);
        });
        let started = Instant::now();
        assert_eq!(deliver(&path, &stop_message()), None);
        assert!(started.elapsed() < Duration::from_millis(500));
        server.join().unwrap();
        let _ = std::fs::remove_file(path);
    }

    fn serve(path: &Path, answers: Vec<Answer>) -> std::thread::JoinHandle<HookMessage> {
        let listener = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut writer = stream;
            for answer in answers {
                writer.write_all(format!("{}\n", serde_json::to_string(&answer).unwrap()).as_bytes()).unwrap();
            }
            serde_json::from_str(line.trim()).unwrap()
        })
    }

    #[test]
    fn a_held_stop_returns_your_reply() {
        let path = temp_socket("reply");
        let server = serve(&path, vec![Answer::Ack { hold: true }, Answer::Reply { text: "ship it".into() }]);
        assert_eq!(deliver(&path, &stop_message()).as_deref(), Some("ship it"));
        assert_eq!(server.join().unwrap().session_id, "s1");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_release_or_no_hold_returns_nothing() {
        for answers in [vec![Answer::Ack { hold: false }], vec![Answer::Ack { hold: true }, Answer::Release], vec![Answer::Ack { hold: true }]] {
            let path = temp_socket("release");
            let server = serve(&path, answers);
            assert_eq!(deliver(&path, &stop_message()), None);
            server.join().unwrap();
            let _ = std::fs::remove_file(path);
        }
    }
}
