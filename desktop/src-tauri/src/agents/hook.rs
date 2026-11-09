//! `Eavesy --agent-hook <stop|notification|prompt|tool_done>`: the command Claude Code
//! runs for its hooks. It runs before Tauri starts (no window, no telemetry,
//! no single-instance check), hands the event to the running app over the
//! agents socket, and for a held stop waits for your reply.
//!
//! It never stands in Claude's way: if the app isn't running or doesn't answer
//! within `CONNECT_BUDGET`, it exits 0 with no output and Claude carries on.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::net::Shutdown;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
        Some("tool_done") => Event::ToolDone,
        _ => return true,
    };
    let mut input = Vec::new();
    let _ = std::io::stdin().take(protocol::MAX_LINE as u64).read_to_end(&mut input);
    let Some(socket) = super::socket_path() else { return true };
    let env = |key: &str| std::env::var(key).ok();
    let attended = env("EAVESY_NO_HOLD").as_deref() != Some("1")
        && protocol::attended(env("CLAUDE_CODE_SESSION_ATTENDED").as_deref(), env("CLAUDE_CODE_ENTRYPOINT").as_deref());
    // A `claude -p` that a desktop session runs inherits that session's app and id.
    let host_session_id = if attended { env("CLAUDE_CODE_HOST_SESSION_ID") } else { None };
    let Some(mut message) = message(event, &input, attended, host_session_id) else {
        return true;
    };
    if attended {
        message.host_app = super::host::from_env(env("__CFBundleIdentifier").as_deref(), env("TERM_PROGRAM").as_deref());
    }
    let transcript = transcript_path(&input);
    if let Some(reply) = deliver(&socket, &message, transcript.as_deref()) {
        println!("{}", protocol::block_output(&reply));
    }
    true
}

/// The hook's stdin as the app wants it, or None when it isn't a hook payload.
pub fn message(event: Event, input: &[u8], attended: bool, host_session_id: Option<String>) -> Option<HookMessage> {
    let value: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        // A tool's output can be past the read cap; only the session id is needed.
        Err(_) if event == Event::ToolDone => serde_json::json!({ "session_id": leading_session_id(input)? }),
        Err(_) => return None,
    };
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    let session_id = text("session_id").filter(|id| !id.is_empty())?;
    let (message, prompt) = match event {
        Event::Stop => (text("last_assistant_message").map(|m| protocol::tail(&m, protocol::MAX_MESSAGE_CHARS)), None),
        Event::Notification => (text("message").map(|m| protocol::head(&m, protocol::MAX_PROMPT_CHARS)), None),
        Event::Prompt => (None, text("prompt").map(|p| protocol::head(&p, protocol::MAX_PROMPT_CHARS))),
        Event::ToolDone => (None, None),
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
        host_app: None,
    })
}

/// Claude Code writes `session_id` first, so it's found even in cut-off input.
fn leading_session_id(input: &[u8]) -> Option<String> {
    const KEY: &[u8] = br#""session_id":""#;
    let start = input.windows(KEY.len()).position(|window| window == KEY)? + KEY.len();
    let rest = &input[start..];
    let end = rest.iter().position(|&byte| byte == b'"')?;
    let id = std::str::from_utf8(&rest[..end]).ok()?;
    (!id.is_empty() && id.len() <= 128).then(|| id.to_string())
}

fn transcript_path(input: &[u8]) -> Option<PathBuf> {
    let value: Value = serde_json::from_slice(input).ok()?;
    let path = PathBuf::from(value.get("transcript_path")?.as_str()?);
    path.is_absolute().then_some(path)
}

/// Sends the event, and if the app holds it, waits for your reply. None means
/// let Claude carry on: no app, no answer in time, a release, a dropped
/// connection, or a message you typed into the session yourself.
pub fn deliver(socket: &Path, message: &HookMessage, transcript: Option<&Path>) -> Option<String> {
    deliver_within(socket, message, CONNECT_BUDGET, transcript)
}

/// `deliver`, with how long the app gets to acknowledge. Tests that exercise the reply
/// path give a loaded machine more room than the hook's real budget.
#[cfg(not(unix))]
fn deliver_within(_socket: &Path, _message: &HookMessage, _budget: Duration, _transcript: Option<&Path>) -> Option<String> {
    None
}

#[cfg(unix)]
fn deliver_within(socket: &Path, message: &HookMessage, budget: Duration, transcript: Option<&Path>) -> Option<String> {
    // Measured before connecting, so a message typed while the app answers still counts.
    let watch = transcript.and_then(|path| Some((path.to_path_buf(), std::fs::metadata(path).ok()?.len())));
    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_write_timeout(Some(budget)).ok()?;
    stream.set_read_timeout(Some(budget)).ok()?;
    let mut line = serde_json::to_string(message).ok()?;
    line.push('\n');
    stream.write_all(line.as_bytes()).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    if read_answer(&mut reader)? != (Answer::Ack { hold: true }) {
        return None;
    }
    // macOS refuses socket options once the app has closed its end, which it does right
    // after a reply it had ready at once; the reply is already buffered, so read it anyway.
    let _ = stream.set_read_timeout(Some(MAX_HOLD));
    let done = Arc::new(AtomicBool::new(false));
    if let Some((path, from)) = watch {
        let stream = stream.try_clone().ok()?;
        let done = done.clone();
        std::thread::spawn(move || {
            if wait_for_typed_message(&path, from, &done) {
                let _ = stream.shutdown(Shutdown::Both);
            }
        });
    }
    let answer = read_answer(&mut reader);
    done.store(true, Ordering::Relaxed);
    match answer? {
        Answer::Reply { text } if !text.trim().is_empty() => Some(text),
        _ => None,
    }
}

const TRANSCRIPT_POLL: Duration = Duration::from_millis(250);

/// Claude Code queues a message you type during a held Stop and only reads it
/// once the hook ends, but writes it to the transcript straight away. True once
/// such a message appears after `from`; false once `done` is set.
fn wait_for_typed_message(path: &Path, mut from: u64, done: &AtomicBool) -> bool {
    let mut partial = Vec::new();
    while !done.load(Ordering::Relaxed) {
        std::thread::sleep(TRANSCRIPT_POLL);
        let Ok(mut file) = std::fs::File::open(path) else { continue };
        let Ok(len) = file.metadata().map(|meta| meta.len()) else { continue };
        if len < from {
            from = len;
            partial.clear();
        }
        if len == from || file.seek(SeekFrom::Start(from)).is_err() {
            continue;
        }
        let mut added = Vec::new();
        if file.take(len - from).read_to_end(&mut added).is_err() {
            continue;
        }
        from = len;
        partial.extend_from_slice(&added);
        let complete = partial.iter().rposition(|&byte| byte == b'\n').map_or(0, |at| at + 1);
        let lines: Vec<u8> = partial.drain(..complete).collect();
        if lines.split(|&byte| byte == b'\n').any(is_typed_message) {
            return true;
        }
    }
    false
}

fn is_typed_message(line: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(line) else { return false };
    value.get("type").and_then(Value::as_str) == Some("queue-operation")
        && value.get("operation").and_then(Value::as_str) == Some("enqueue")
}

fn read_answer(reader: &mut impl BufRead) -> Option<Answer> {
    let mut line = String::new();
    reader.by_ref().take(protocol::MAX_LINE as u64).read_line(&mut line).ok()?;
    serde_json::from_str(line.trim()).ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::time::Instant;

    /// Room for the fake app's thread to be scheduled on a busy CI runner.
    const ROOMY: Duration = Duration::from_secs(5);

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
        let cut = message(Event::ToolDone, br#"{"session_id":"s2","tool_response":"aaaa"#, false, None).unwrap();
        assert_eq!(cut.session_id, "s2");
        assert!(message(Event::Stop, br#"{"session_id":"s2","last_assistant_message":"aa"#, false, None).is_none());
    }

    #[test]
    fn no_app_means_carry_on_at_once() {
        let started = Instant::now();
        assert_eq!(deliver(&temp_socket("missing"), &stop_message(), None), None);
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
        assert_eq!(deliver(&path, &stop_message(), None), None);
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
        assert_eq!(deliver_within(&path, &stop_message(), ROOMY, None).as_deref(), Some("ship it"));
        assert_eq!(server.join().unwrap().session_id, "s1");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_release_or_no_hold_returns_nothing() {
        for answers in [vec![Answer::Ack { hold: false }], vec![Answer::Ack { hold: true }, Answer::Release], vec![Answer::Ack { hold: true }]] {
            let path = temp_socket("release");
            let server = serve(&path, answers);
            assert_eq!(deliver_within(&path, &stop_message(), ROOMY, None), None);
            server.join().unwrap();
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn typing_into_the_session_ends_the_hold() {
        let path = temp_socket("typed");
        let transcript = std::env::temp_dir().join(format!("ev-typed-{}.jsonl", uuid::Uuid::new_v4().simple()));
        std::fs::write(&transcript, "{\"type\":\"queue-operation\",\"operation\":\"enqueue\",\"content\":\"earlier\"}\n").unwrap();
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            reader.read_line(&mut String::new()).unwrap();
            let mut writer = stream;
            writer.write_all(format!("{}\n", serde_json::to_string(&Answer::Ack { hold: true }).unwrap()).as_bytes()).unwrap();
            let mut rest = Vec::new();
            let _ = reader.read_to_end(&mut rest);
        });
        let writer = {
            let transcript = transcript.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
                file.write_all(b"{\"type\":\"assistant\"}\n{\"type\":\"queue-operation\",\"operation\":\"enq").unwrap();
                std::thread::sleep(Duration::from_millis(400));
                file.write_all(b"ueue\",\"content\":\"do this instead\"}\n").unwrap();
            })
        };
        let started = Instant::now();
        assert_eq!(deliver_within(&path, &stop_message(), ROOMY, Some(&transcript)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(started.elapsed() >= Duration::from_millis(700));
        writer.join().unwrap();
        server.join().unwrap();
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(transcript);
    }

    #[test]
    fn only_a_queued_message_counts_as_typing() {
        assert!(is_typed_message(br#"{"type":"queue-operation","operation":"enqueue","content":"hi"}"#));
        assert!(!is_typed_message(br#"{"type":"queue-operation","operation":"dequeue"}"#));
        assert!(!is_typed_message(br#"{"type":"user","operation":"enqueue"}"#));
        assert!(!is_typed_message(b"{\"type\":\"queue-oper"));
    }

    #[test]
    fn the_transcript_path_comes_from_the_hook_input() {
        assert_eq!(transcript_path(br#"{"transcript_path":"/a/b.jsonl"}"#), Some(PathBuf::from("/a/b.jsonl")));
        assert_eq!(transcript_path(br#"{"transcript_path":"b.jsonl"}"#), None);
        assert_eq!(transcript_path(b"{}"), None);
    }
}
