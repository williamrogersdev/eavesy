//! Talking with your Claude Code sessions (docs/plans/voice-conversation.md,
//! pieces 3 to 3c). Claude Code's hooks run `Eavesy --agent-hook …` (hook.rs),
//! which reaches this module over a Unix socket only you can open. A stopped
//! session goes in the queue, Eavesy says what it needs and suggests a reply,
//! and the reply you send goes back through the held Stop hook into the same
//! session.
//!
//! Off until you turn it on in Settings. The socket only ever hands back a
//! reply you sent from the card; it can't approve anything.

pub mod card;
pub mod hook;
pub mod install;
pub mod naming;
pub mod protocol;
pub mod queue;
pub mod speak;
pub mod suggest;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

use protocol::{Answer, Event, HookMessage};
use queue::{Kind, Queue};

const STATE_EVENT: &str = "agents:state";
/// A finished turn that needs nothing stays on the card this long after it's said.
const FINISHED_LINGER: Duration = Duration::from_secs(8);

static QUEUE: Mutex<Option<Queue>> = Mutex::new(None);
/// Held Stop hooks, by queue item: sending on one ends that hook's wait.
static HOLDS: Mutex<Option<HashMap<u64, oneshot::Sender<Answer>>>> = Mutex::new(None);

fn with_queue<T>(f: impl FnOnce(&mut Queue) -> T) -> T {
    let mut queue = QUEUE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(queue.get_or_insert_with(Queue::default))
}

fn with_holds<T>(f: impl FnOnce(&mut HashMap<u64, oneshot::Sender<Answer>>) -> T) -> T {
    let mut holds = HOLDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(holds.get_or_insert_with(HashMap::new))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `eavesy-agents.sock` in your own temporary folder (`/var/folders/…/T`, only
/// you can open it), shared by the app and the hook command. Socket paths
/// are capped near 104 bytes, which a long user name in Application Support
/// could pass.
pub fn socket_path() -> Option<PathBuf> {
    const NAME: &str = "eavesy-agents.sock";
    // Development builds can point at a test server instead.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("EAVESY_AGENTS_SOCKET") {
        return Some(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        let mut buf = vec![0 as libc::c_char; 1024];
        let len = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buf.as_mut_ptr(), buf.len()) };
        if len > 0 && len <= buf.len() {
            let dir = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned();
            if !dir.is_empty() {
                return Some(PathBuf::from(dir).join(NAME));
            }
        }
    }
    Some(dirs::data_dir()?.join("com.eavesy.desktop").join(NAME))
}

/// Starts listening for hooks, and keeps installed hooks pointing at this app.
pub fn start(app: &AppHandle) {
    let settings = crate::settings::load(app);
    if settings.agent_voice() {
        if let Err(error) = install_hooks(settings.agent_hold_secs()) {
            tracing::warn!("could not refresh the Claude Code hooks: {error}");
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = listen(app).await {
            tracing::warn!("agents socket stopped: {error}");
        }
    });
}

async fn listen(app: AppHandle) -> std::io::Result<()> {
    let path = socket_path().ok_or_else(|| std::io::Error::other("no Application Support folder"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // A socket left by a crash would refuse the bind. Single-instance means
    // no other Eavesy is listening on it.
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    let uid = unsafe { libc::getuid() };
    loop {
        let (stream, _) = listener.accept().await?;
        if stream.peer_cred().map(|cred| cred.uid()).ok() != Some(uid) {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            handle(app, stream).await;
        });
    }
}

async fn write(stream: &mut UnixStream, answer: &Answer) -> bool {
    let Ok(mut line) = serde_json::to_string(answer) else { return false };
    line.push('\n');
    stream.write_all(line.as_bytes()).await.is_ok()
}

async fn handle(app: AppHandle, stream: UnixStream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    let mut limited = (&mut reader).take(protocol::MAX_LINE as u64);
    let read = tokio::time::timeout(Duration::from_millis(500), limited.read_line(&mut line)).await;
    if !matches!(read, Ok(Ok(n)) if n > 0) {
        return;
    }
    let mut stream = reader.into_inner();
    let Ok(message) = serde_json::from_str::<HookMessage>(line.trim()) else {
        let _ = write(&mut stream, &Answer::Ack { hold: false }).await;
        return;
    };
    let settings = crate::settings::load(&app);
    if message.v != protocol::VERSION || !settings.agent_voice() {
        let _ = write(&mut stream, &Answer::Ack { hold: false }).await;
        return;
    }
    match message.event {
        Event::Prompt => {
            let _ = write(&mut stream, &Answer::Ack { hold: false }).await;
            if let Some(prompt) = message.prompt.clone() {
                with_queue(|queue| queue.note_prompt(&message.session_id, prompt));
            }
            // You answered the session yourself, so its card is done.
            if let Some(item) = with_queue(|queue| queue.remove_session(&message.session_id)) {
                release(item.id, Answer::Release);
                refresh(&app);
            }
        }
        Event::Notification => {
            let _ = write(&mut stream, &Answer::Ack { hold: false }).await;
            if message.notification_type.as_deref() == Some("permission_prompt") {
                enqueue(&app, &message, Kind::Approval, None);
            }
        }
        Event::ToolDone => {
            let _ = write(&mut stream, &Answer::Ack { hold: false }).await;
            if with_queue(|queue| queue.clear_approval(&message.session_id)).is_some() {
                refresh(&app);
            }
        }
        // A turn that your reply started is held again when it stops: that's
        // the conversation going on, so `stop_hook_active` doesn't change it.
        Event::Stop => {
            let hold_secs = settings.agent_hold_secs();
            let hold = message.attended && hold_secs > 0;
            if !write(&mut stream, &Answer::Ack { hold }).await {
                return;
            }
            if hold {
                let (tx, rx) = oneshot::channel();
                let id = enqueue(&app, &message, Kind::Finished, Some(tx));
                wait_for_reply(&app, id, rx, stream, Duration::from_secs(u64::from(hold_secs))).await;
            } else {
                enqueue(&app, &message, Kind::Finished, None);
            }
        }
    }
}

/// Adds the session to the queue and fetches its summary in the background.
/// A held stop registers its hook first, so a quick summary can release it.
fn enqueue(app: &AppHandle, message: &HookMessage, kind: Kind, hold: Option<oneshot::Sender<Answer>>) -> u64 {
    let (id, replaced, prompt) = with_queue(|queue| {
        let name = naming::name(&message.session_id, message.cwd.as_deref(), &queue.names_in_use());
        let (id, replaced) = queue.push(&message.session_id, name, kind, message.message.clone(), hold.is_some(), now_ms());
        (id, replaced, queue.prompt(&message.session_id).map(str::to_string))
    });
    if let Some(tx) = hold {
        with_holds(|holds| holds.insert(id, tx));
    }
    if let Some(old) = replaced {
        release(old.id, Answer::Release);
    }
    let app = app.clone();
    let event = message.event;
    let text = message.message.clone().unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let name = with_queue(|queue| queue.get(id).map(|item| item.name.clone())).unwrap_or_default();
        let suggestion = suggest::suggest(&app, event, &name, prompt.as_deref(), &text).await;
        let still_held = with_queue(|queue| {
            queue.resolve(id, suggestion.summary, suggestion.reply, suggestion.needs_you);
            queue.get(id).is_some_and(|item| item.held)
        });
        if !still_held {
            release(id, Answer::Release);
        }
        refresh(&app);
    });
    id
}

/// Keeps the hook waiting until you reply, the hold runs out, the item goes
/// away, or the hook itself is gone (you pressed Esc in Claude, say).
async fn wait_for_reply(app: &AppHandle, id: u64, rx: oneshot::Receiver<Answer>, mut stream: UnixStream, hold: Duration) {
    let (read_half, mut write_half) = stream.split();
    let mut closed = BufReader::new(read_half);
    let mut scratch = Vec::new();
    let answer = tokio::select! {
        answer = rx => answer.unwrap_or(Answer::Release),
        _ = tokio::time::sleep(hold) => Answer::Release,
        _ = closed.read_until(b'\n', &mut scratch) => Answer::Release,
    };
    with_holds(|holds| holds.remove(&id));
    if let Ok(mut line) = serde_json::to_string(&answer) {
        line.push('\n');
        let _ = write_half.write_all(line.as_bytes()).await;
    }
    // The session stopped waiting; its card stays, but a reply can only be copied now.
    if with_queue(|queue| queue.unhold(id)) {
        refresh(app);
    }
}

fn release(id: u64, answer: Answer) {
    if let Some(tx) = with_holds(|holds| holds.remove(&id)) {
        let _ = tx.send(answer);
    }
}

#[derive(Serialize, Clone)]
pub struct Snapshot {
    items: Vec<queue::Item>,
}

fn snapshot() -> Snapshot {
    Snapshot { items: with_queue(|queue| queue.ordered().into_iter().cloned().collect()) }
}

/// Tells the card, and says the item at the front if it hasn't been said.
fn refresh(app: &AppHandle) {
    let state = snapshot();
    let _ = app.emit(STATE_EVENT, state.clone());
    let Some(head) = state.items.first().cloned() else {
        card::hide(app);
        return;
    };
    card::show(app);
    let Some(line) = utterance(&state.items, crate::hud::current().is_live()) else { return };
    speak::say(&line);
    with_queue(|queue| queue.mark_spoken(head.id));
    if head.kind == Kind::Finished {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FINISHED_LINGER).await;
            if with_queue(|queue| queue.get(head.id).is_some_and(|item| item.kind == Kind::Finished) && queue.remove(head.id).is_some()) {
                refresh(&app);
            }
        });
    }
}

/// What to say about the front of the queue, if anything: never while you're
/// dictating, and never the same item twice. Only questions and approvals
/// count the others still waiting.
fn utterance(items: &[queue::Item], dictating: bool) -> Option<String> {
    let head = items.first()?;
    if head.spoken || dictating {
        return None;
    }
    let others = if head.kind == Kind::Finished { 0 } else { items.iter().skip(1).filter(|item| item.kind != Kind::Finished).count() };
    Some(queue::speech(head, others))
}

/// A dictation ended: say whatever waited while you talked.
pub fn dictation_ended(app: &AppHandle) {
    refresh(app);
}

fn install_hooks(hold_secs: u32) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let file = install::settings_file().ok_or("No home folder")?;
    install::install(&file, &exe, hold_secs)
}

#[tauri::command]
pub fn agents_state() -> Snapshot {
    snapshot()
}

/// Sends your reply to the session, through its held hook. When the session
/// stopped waiting, the reply is copied for you to paste instead.
#[tauri::command]
pub fn agents_send(app: AppHandle, id: u64, session_id: String, text: String) -> Result<&'static str, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Write a reply first.".into());
    }
    if text.chars().count() > protocol::MAX_REPLY_CHARS {
        return Err(format!("That reply is too long to send. Keep it under {} characters.", protocol::MAX_REPLY_CHARS));
    }
    // The card names the session it showed you, so a reply never lands in another one.
    let held = with_queue(|queue| queue.get(id).filter(|item| item.session_id == session_id).map(|item| item.held))
        .ok_or("That session isn't waiting any more.")?;
    let sent = held && with_holds(|holds| holds.remove(&id)).is_some_and(|tx| tx.send(Answer::Reply { text: text.clone() }).is_ok());
    if !sent {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        // Copied before the card goes, so a failed copy leaves your reply on it.
        app.clipboard().write_text(text).map_err(|error| error.to_string())?;
    }
    with_queue(|queue| queue.remove(id));
    refresh(&app);
    Ok(if sent { "sent" } else { "copied" })
}

#[tauri::command]
pub fn agents_later(app: AppHandle, id: u64) {
    with_queue(|queue| queue.later(id, now_ms()));
    speak::stop();
    refresh(&app);
}

/// Lets the session end its turn without a reply.
#[tauri::command]
pub fn agents_dismiss(app: AppHandle, id: u64) {
    with_queue(|queue| queue.remove(id));
    release(id, Answer::Release);
    speak::stop();
    refresh(&app);
}

#[tauri::command]
pub fn agents_repeat(app: AppHandle) {
    let head = with_queue(|queue| queue.head().map(|item| item.id));
    if let Some(id) = head {
        with_queue(|queue| queue.later(id, 0));
    }
    refresh(&app);
}

#[tauri::command]
pub fn agents_edit(app: AppHandle) {
    speak::stop();
    card::take_keys(&app);
}

#[tauri::command]
pub fn set_agent_voice(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        // Hooks first: the setting only says on once Claude Code will call us.
        install_hooks(crate::settings::load(&app).agent_hold_secs())?;
        crate::settings::update(&app, |config| config.agent_voice = Some(true))?;
        Ok(())
    } else {
        // Off first: until the hooks are gone, the app tells them not to hold.
        crate::settings::update(&app, |config| config.agent_voice = Some(false))?;
        for item in with_queue(|queue| queue.ordered().into_iter().map(|item| item.id).collect::<Vec<_>>()) {
            with_queue(|queue| queue.remove(item));
            release(item, Answer::Release);
        }
        speak::stop();
        refresh(&app);
        install::uninstall(&install::settings_file().ok_or("No home folder")?)
    }
}

#[tauri::command]
pub fn set_agent_hold(app: AppHandle, seconds: u32) -> Result<(), String> {
    let seconds = seconds.min(crate::settings::MAX_AGENT_HOLD_SECS);
    if crate::settings::load(&app).agent_voice() {
        install_hooks(seconds)?;
    }
    crate::settings::update(&app, |config| config.agent_hold_secs = Some(seconds))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use queue::Queue;

    fn items(queue: &Queue) -> Vec<queue::Item> {
        queue.ordered().into_iter().cloned().collect()
    }

    #[test]
    fn says_the_front_once_and_never_over_dictation() {
        let mut queue = Queue::default();
        let (a, _) = queue.push("a", "eavesy".into(), Kind::Finished, None, true, 1);
        queue.resolve(a, "wants to know about the flag".into(), Some("No flag".into()), true);
        let (b, _) = queue.push("b", "repackify".into(), Kind::Approval, None, false, 2);
        queue.resolve(b, "needs approval to run a command".into(), None, true);
        let (c, _) = queue.push("c", "docs".into(), Kind::Finished, None, false, 3);
        queue.resolve(c, "finished the docs".into(), None, false);

        let front = items(&queue);
        assert_eq!(front[0].id, b);
        assert_eq!(utterance(&front, true), None);
        let line = utterance(&front, false).unwrap();
        assert!(line.starts_with("2 sessions need you. First, repackify"), "{line}");

        queue.mark_spoken(b);
        assert_eq!(utterance(&items(&queue), false), None);
    }

    #[test]
    fn a_finished_session_is_said_alone() {
        let mut queue = Queue::default();
        let (a, _) = queue.push("a", "docs".into(), Kind::Finished, None, false, 1);
        queue.resolve(a, "finished the docs".into(), None, false);
        assert_eq!(utterance(&items(&queue), false).as_deref(), Some("docs: finished the docs."));
    }

    #[test]
    fn a_tool_running_clears_only_its_approval() {
        let mut queue = Queue::default();
        queue.push("a", "eavesy".into(), Kind::Approval, None, false, 1);
        queue.push("b", "docs".into(), Kind::Finished, None, false, 2);
        assert!(queue.clear_approval("b").is_none());
        assert!(queue.clear_approval("a").is_some());
        assert!(queue.clear_approval("a").is_none());
    }
}
