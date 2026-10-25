use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::hotkeys::{self, Action, HotkeyError};
use crate::panel;
use crate::settings::{self, Settings};
use crate::store;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingDto {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    pub duration_sec: i64,
    pub source: String,
    pub status: String,
    pub summary: Option<String>,
    pub transcript: Option<String>,
    pub has_audio: bool,
    pub has_video: bool,
}

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    copy_to_clipboard(&app, &text)
}

/// Puts Eavesy's words on the clipboard for the user to paste themselves.
/// Every clipboard write Eavesy makes goes through here or the paste below:
/// it calls off a pending restore, so the user's old clipboard never comes
/// back over words they were just told to ⌘V.
pub fn copy_to_clipboard(app: &AppHandle, text: &str) -> Result<(), String> {
    cancel_clipboard_restore();
    app.clipboard()
        .write_text(text.to_string())
        .map_err(|e| format!("failed to copy to clipboard: {e}"))
}

/// For the one clipboard write that isn't text (copying a screenshot): the
/// caller writes the image itself, and this makes sure a pending restore
/// from a dictation can't put the old clipboard back over it.
pub fn cancel_clipboard_restore() {
    restore().cancel();
}

#[tauri::command]
pub async fn paste_to_frontmost(app: AppHandle, text: String, learn: Option<bool>) -> Result<(), String> {
    hide_panel_on_main_thread(&app).await?;

    // Hiding the launcher hands focus back to the app it opened over; wait for that app to be in
    // front before pasting into it.
    std::thread::sleep(std::time::Duration::from_millis(120));
    for _ in 0..8 {
        if !crate::app_menu::is_active() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    paste_text_with_learning(&app, &text, learn.unwrap_or(true))
}

/// A paste's pending restore of the user's own clipboard. A newer paste
/// takes the restore over, so Eavesy's own words on the clipboard are never
/// mistaken for the user's, and any other change to the clipboard since
/// Eavesy wrote it (the user copying something) calls the restore off.
struct Restore<T> {
    generation: u64,
    /// While a restore is pending: what to put back, or None when the
    /// clipboard held nothing that can be put back.
    pending: Option<Option<T>>,
    /// The pasteboard's change count just after Eavesy wrote its words.
    written: Option<isize>,
}

impl<T> Restore<T> {
    const fn new() -> Self {
        Self { generation: 0, pending: None, written: None }
    }

    /// A paste is about to write its words: what the clipboard holds is kept
    /// to put back. A restore still pending already holds the user's own
    /// clipboard, unless something else was copied since Eavesy's write.
    fn begin(&mut self, count_now: Option<isize>, snapshot: impl FnOnce() -> Option<T>) -> u64 {
        let untouched = self.written.is_some() && self.written == count_now;
        self.pending = match self.pending.take() {
            Some(previous) if untouched => Some(previous),
            _ => Some(snapshot()),
        };
        self.generation += 1;
        self.written = None;
        self.generation
    }

    fn wrote(&mut self, generation: u64, count: Option<isize>) {
        if self.generation == generation {
            self.written = count;
        }
    }

    /// Eavesy's words stay on the clipboard: nothing is put back.
    fn cancel(&mut self) {
        self.generation += 1;
        self.pending = None;
        self.written = None;
    }

    /// What to put back once `generation`'s paste has been read: only for the
    /// newest paste, and only while the clipboard still holds Eavesy's write.
    fn finish(&mut self, generation: u64, count_now: Option<isize>) -> Option<T> {
        if self.generation != generation {
            return None;
        }
        let untouched = self.written.is_some() && self.written == count_now;
        self.written = None;
        self.pending.take().flatten().filter(|_| untouched)
    }
}

static RESTORE: std::sync::Mutex<Restore<clip::Snapshot>> = std::sync::Mutex::new(Restore::new());

fn restore() -> std::sync::MutexGuard<'static, Restore<clip::Snapshot>> {
    RESTORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// How long a pasting app gets to read the pasteboard before the user's own
/// clipboard comes back. Slow web-view apps need a while; the change-count
/// check keeps a late restore from undoing anything the user copied.
const RESTORE_AFTER: std::time::Duration = std::time::Duration::from_millis(800);

pub fn paste_text(app: &AppHandle, text: &str) -> Result<(), String> {
    paste_text_with_learning(app, text, true)
}
fn paste_text_with_learning(app: &AppHandle, text: &str, learn: bool) -> Result<(), String> {
    let generation = {
        let mut restore = restore();
        let generation = restore.begin(clip::change_count(), clip::snapshot);
        if let Err(error) = app.clipboard().write_text(text.to_string()) {
            restore.cancel();
            return Err(format!("failed to copy to clipboard: {error}"));
        }
        restore.wrote(generation, clip::change_count());
        generation
    };

    #[cfg(target_os = "macos")]
    {
        let learning_target = if learn { crate::paste_learning::capture() } else { None };
        if let Err(error) = crate::dictation::press_paste() {
            eprintln!("paste: {error}");
            // The words stay on the clipboard for ⌘V: nothing is put back.
            restore().cancel();
            let message = "Couldn't paste automatically. Grant Accessibility to Eavesy in System \
                 Settings → Privacy & Security → Accessibility. The text is on your \
                 clipboard — press ⌘V to paste it now."
                .to_string();
            let _ = app
                .notification()
                .builder()
                .title("Eavesy couldn't paste")
                .body(&message)
                .show();
            return Err(message);
        }
        crate::paste_learning::observe(app.clone(), learning_target, text.to_string());
    }

    // The key press is posted, not awaited: give the app time to read the
    // pasteboard before the user's own clipboard comes back. Off this
    // thread, so whoever pasted can say so at once. Put back under the lock,
    // so a paste starting meanwhile can't snapshot Eavesy's own words.
    std::thread::spawn(move || {
        std::thread::sleep(RESTORE_AFTER);
        let mut restore = restore();
        if let Some(previous) = restore.finish(generation, clip::change_count()) {
            clip::put_back(&previous);
        }
    });

    Ok(())
}

/// The whole general pasteboard, every item and type, so a paste can put back
/// an image or a copied file as well as text.
#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
mod clip {
    use tauri_nspanel::cocoa::base::{id, nil};
    use tauri_nspanel::objc::{class, msg_send, sel, sel_impl};

    /// Each pasteboard item's types and their raw data.
    pub struct Snapshot(Vec<Vec<(String, Vec<u8>)>>);

    /// Past this, a clipboard is too big to hold on to: it isn't put back.
    const LIMIT: usize = 32 << 20;
    /// Marked by password managers and the like (nspasteboard.org): never
    /// kept or put back, or their own clearing of it would stop working.
    const PRIVATE: [&str; 3] =
        ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"];

    struct Pool(id);
    impl Pool {
        unsafe fn new() -> Self {
            Pool(msg_send![class!(NSAutoreleasePool), new])
        }
    }
    impl Drop for Pool {
        fn drop(&mut self) {
            unsafe {
                let _: () = msg_send![self.0, drain];
            }
        }
    }

    unsafe fn general() -> id {
        msg_send![class!(NSPasteboard), generalPasteboard]
    }

    unsafe fn rust_string(string: id) -> Option<String> {
        if string == nil {
            return None;
        }
        let utf8: *const std::os::raw::c_char = msg_send![string, UTF8String];
        (!utf8.is_null()).then(|| std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    pub fn change_count() -> Option<isize> {
        unsafe {
            let _pool = Pool::new();
            let pasteboard = general();
            if pasteboard == nil {
                return None;
            }
            let count: isize = msg_send![pasteboard, changeCount];
            Some(count)
        }
    }

    /// None when the clipboard can't be kept: private, too big, or unreadable.
    pub fn snapshot() -> Option<Snapshot> {
        unsafe {
            let _pool = Pool::new();
            let pasteboard = general();
            if pasteboard == nil {
                return None;
            }
            let items: id = msg_send![pasteboard, pasteboardItems];
            let mut saved = Vec::new();
            let mut total = 0usize;
            let item_count: usize = if items == nil { 0 } else { msg_send![items, count] };
            for index in 0..item_count {
                let item: id = msg_send![items, objectAtIndex: index];
                let types: id = msg_send![item, types];
                let type_count: usize = if types == nil { 0 } else { msg_send![types, count] };
                let mut kept = Vec::new();
                for type_index in 0..type_count {
                    let kind: id = msg_send![types, objectAtIndex: type_index];
                    let Some(name) = rust_string(kind) else { continue };
                    if PRIVATE.contains(&name.as_str()) {
                        return None;
                    }
                    let data: id = msg_send![item, dataForType: kind];
                    if data == nil {
                        continue;
                    }
                    let length: usize = msg_send![data, length];
                    total += length;
                    if total > LIMIT {
                        return None;
                    }
                    let bytes: *const u8 = msg_send![data, bytes];
                    let bytes = if length == 0 || bytes.is_null() {
                        Vec::new()
                    } else {
                        std::slice::from_raw_parts(bytes, length).to_vec()
                    };
                    kept.push((name, bytes));
                }
                saved.push(kept);
            }
            Some(Snapshot(saved))
        }
    }

    pub fn put_back(snapshot: &Snapshot) {
        unsafe {
            let _pool = Pool::new();
            let pasteboard = general();
            if pasteboard == nil {
                return;
            }
            let _: isize = msg_send![pasteboard, clearContents];
            let objects: id = msg_send![class!(NSMutableArray), array];
            for item in snapshot.0.iter().filter(|item| !item.is_empty()) {
                let pasteboard_item: id = msg_send![class!(NSPasteboardItem), new];
                for (name, bytes) in item {
                    let Ok(name) = std::ffi::CString::new(name.as_str()) else { continue };
                    let kind: id = msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()];
                    let data: id = msg_send![class!(NSData), dataWithBytes: bytes.as_ptr() length: bytes.len()];
                    let _: bool = msg_send![pasteboard_item, setData: data forType: kind];
                }
                let _: () = msg_send![objects, addObject: pasteboard_item];
                let _: () = msg_send![pasteboard_item, release];
            }
            let count: usize = msg_send![objects, count];
            if count > 0 {
                let _: bool = msg_send![pasteboard, writeObjects: objects];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod clip {
    pub struct Snapshot;
    pub fn change_count() -> Option<isize> {
        None
    }
    pub fn snapshot() -> Option<Snapshot> {
        None
    }
    pub fn put_back(_: &Snapshot) {}
}

#[tauri::command]
pub async fn hide_panel(app: AppHandle) -> Result<(), String> {
    hide_panel_on_main_thread(&app).await
}

async fn hide_panel_on_main_thread(app: &AppHandle) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(panel::hide(&handle));
    })
    .map_err(|error| format!("failed to schedule launcher hide: {error}"))?;

    receiver
        .await
        .map_err(|_| "launcher hide task ended before returning a result".to_string())?
}

// Reads settings.json (and can rewrite it): off the main thread, so hovering
// the control never waits on the disk.
#[tauri::command(async)]
pub fn get_settings(app: AppHandle) -> Settings {
    settings::load(&app)
}

#[tauri::command(async)]
pub fn set_launcher_position(app: AppHandle, position: settings::LauncherPosition) -> Result<(), String> {
    settings::update(&app, |config| config.launcher_position = position)?;
    crate::hud::reset_frame(&app);
    let handle = app.clone();
    app.run_on_main_thread(move || crate::placement::place(&handle))
        .map_err(|error| format!("could not reposition Eavesy: {error}"))
}

/// Turns live captions on or off. Speech Recognition permission is asked for
/// by the launcher when they are turned on, never by a recording.
#[tauri::command(async)]
pub fn set_live_captions(app: AppHandle, enabled: bool) -> Result<(), String> {
    settings::update(&app, |config| config.live_captions = Some(enabled)).map(drop)
}

/// Setup's practice box is open in the panel and wants the next dictation.
#[tauri::command]
pub fn set_dictation_in_panel(wants: bool) {
    crate::dictation::set_panel_wants_dictation(wants);
}

/// The panel put a dictation's words in its box.
#[tauri::command]
pub fn ack_dictation_text(session_id: String) {
    crate::dictation::ack_panel_dictation(&session_id);
}

/// Turns the start and stop sounds on or off.
#[tauri::command(async)]
pub fn set_capture_sounds(app: AppHandle, enabled: bool) -> Result<(), String> {
    settings::update(&app, |config| config.capture_sounds = Some(enabled)).map(drop)
}

/// How many lines of live words the control shows while recording, whether
/// it is see-through, and (when given) whether faster live words are on and
/// whether a finished dictation opens with its words.
#[tauri::command(async)]
pub fn set_hud_look(app: AppHandle, lines: u8, translucent: bool, fast_live_words: Option<bool>, result_preview: Option<bool>) -> Result<(), String> {
    if !matches!(lines, 0 | 1 | 2 | 4) {
        return Err(format!("the preview shows 0, 1, 2 or 4 lines, not {lines}"));
    }
    crate::hud::set_look(&app, lines, translucent, fast_live_words, result_preview);
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupStatus {
    pub paired: bool,
    pub completed: bool,
}

// Reads settings.json and the Keychain: off the main thread, so Talk never waits on them.
#[tauri::command(async)]
pub fn get_setup_status(app: AppHandle) -> SetupStatus {
    let config = settings::load(&app);
    SetupStatus {
        paired: settings::device_token(&app).is_some(),
        completed: config.setup_completed,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub email: Option<String>,
    pub name: Option<String>,
}

#[tauri::command]
pub async fn account_info(app: AppHandle) -> Option<AccountInfo> {
    let credential = settings::device_credential(&app)?;
    let unknown = AccountInfo { email: None, name: None };
    let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build() else {
        return Some(unknown);
    };
    match client
        .get(format!("{}/api/devices/me", credential.base))
        .bearer_auth(credential.token)
        .send()
        .await
    {
        Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => None,
        Ok(response) if response.status().is_success() => Some(response.json().await.unwrap_or(unknown)),
        _ => Some(unknown),
    }
}

#[tauri::command]
pub async fn disconnect_account(app: AppHandle) -> Result<(), String> {
    if let Some(credential) = settings::device_credential(&app) {
        if let Ok(client) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build() {
            let _ = client
                .delete(format!("{}/api/devices/me", credential.base))
                .bearer_auth(credential.token)
                .send()
                .await;
        }
    }
    settings::delete_device_token(&app)
}

#[tauri::command(async)]
pub fn complete_setup(app: AppHandle) -> Result<(), String> {
    settings::update(&app, |config| config.setup_completed = true).map(drop)
}

/// Gives `action` ("toggle" or "dictation") a shortcut; "" leaves it unbound.
/// With `swap`, takes the other action's shortcut and gives it this one's.
#[tauri::command]
pub fn set_hotkey(app: AppHandle, action: String, accelerator: String, swap: Option<bool>) -> Result<(), HotkeyError> {
    let action = Action::parse(&action)?;
    let result = hotkeys::set_hotkey(&app, action, &accelerator, swap.unwrap_or(false));
    hotkeys_changed(&app);
    result
}

/// The tray menu, the HUD and the panel's Eavesy tab show the current shortcuts; tell them.
fn hotkeys_changed(app: &AppHandle) {
    crate::tray::refresh(app);
    let _ = app.emit_to("hud", "hotkeys:changed", ());
    let _ = app.emit_to("main", "hotkeys:changed", ());
}

#[tauri::command]
pub fn get_hotkey_defaults() -> hotkeys::Bindings {
    hotkeys::Bindings::defaults()
}

#[tauri::command]
pub fn reset_hotkey(app: AppHandle, action: String, swap: Option<bool>) -> Result<(), HotkeyError> {
    let action = Action::parse(&action)?;
    let result = hotkeys::set_hotkey(&app, action, action.default_accelerator(), swap.unwrap_or(false));
    hotkeys_changed(&app);
    result
}

#[tauri::command]
pub fn reset_all_hotkeys(app: AppHandle) -> Result<(), HotkeyError> {
    let result = hotkeys::reset_all(&app);
    hotkeys_changed(&app);
    result
}

#[derive(Serialize)]
pub struct FnStatus {
    input_monitoring: bool,
    /// fn held with a key needs Accessibility (an event tap that can drop the key).
    accessibility: bool,
    globe_action: &'static str,
}

/// What still stands between the fn key and an Eavesy shortcut.
#[tauri::command(async)]
pub fn fn_status() -> FnStatus {
    #[cfg(target_os = "macos")]
    {
        let globe = match crate::fn_key::GlobeAction::read() {
            crate::fn_key::GlobeAction::DoNothing => "do_nothing",
            crate::fn_key::GlobeAction::InputSource => "input_source",
            crate::fn_key::GlobeAction::Emoji => "emoji",
            crate::fn_key::GlobeAction::Dictation => "dictation",
            crate::fn_key::GlobeAction::Unknown => "unknown",
        };
        FnStatus {
            input_monitoring: crate::fn_key::input_monitoring_granted(),
            accessibility: crate::permissions::accessibility_granted(),
            globe_action: globe,
        }
    }
    #[cfg(not(target_os = "macos"))]
    FnStatus { input_monitoring: false, accessibility: false, globe_action: "unknown" }
}

#[tauri::command]
pub fn show_launcher(app: AppHandle) {
    let _ = app.emit("launcher:recordings", ());
    hotkeys::show_launcher(&app);
}

#[tauri::command]
pub fn focus_preview_editor(app: AppHandle, session_id: String) -> Result<u64, String> {
    validate_live_preview_session(&crate::hud::current(), &session_id)?;
    let revision = crate::live_edit::revision(&session_id);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = crate::hud::current();
        if matches!(state.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing | crate::hud::Phase::Done) && state.session_id.as_deref() == Some(session_id.as_str()) {
            crate::hud::focus_editor_on_main(&handle);
        }
    }).map_err(|error| format!("Could not focus transcript editor: {error}"))?;
    Ok(revision)
}

/// The transcript box let go of the keyboard (blur, Esc, a tone button or
/// Copy): hand it back to the app the user was in, so their next keystroke
/// lands there and not in Eavesy. With `session_id`, only while that capture
/// is still the one on screen. Does nothing when the box never took it.
#[tauri::command]
pub async fn release_preview_editor(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    if session_id.is_some() && crate::hud::current().session_id != session_id {
        return Ok(());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        crate::hud::release_preview_editor_on_main(&handle);
        let _ = sender.send(());
    })
    .map_err(|error| format!("Could not hand the keyboard back: {error}"))?;
    receiver.await.map_err(|_| "Could not hand the keyboard back".to_string())
}

fn validate_live_preview_session(state: &crate::hud::HudState, session_id: &str) -> Result<(), String> {
    // Done allows an edit already in flight when Stop completed. Other captures
    // and idle/failed previews may only use the explicit saved-transcript editor.
    if state.session_id.as_deref() == Some(session_id)
        && matches!(state.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing | crate::hud::Phase::Done) {
        Ok(())
    } else { Err("This capture is no longer accepting live corrections".into()) }
}

#[tauri::command]
pub async fn update_live_preview_edit(app: AppHandle, session_id: String, source: String, text: String, revision: u64) -> Result<(), String> {
    validate_live_preview_session(&crate::hud::current(), &session_id)?;
    crate::live_edit::update(&session_id, source, text, revision)?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_live_preview_session(&crate::hud::current(), &session_id)?;
        if let Some(recording) = store::get(&app, &session_id)? {
            if recording.folder_path.is_some() {
                if let Some(text) = crate::live_edit::corrected(&session_id, recording.transcript.as_deref().unwrap_or("")) {
                    if !store::save_live_preview_transcript(&app, &session_id, &text)? {
                        return Err("Transcript was edited in its folder; reopen it before correcting".into());
                    }
                }
            }
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn dismiss_hud(app: AppHandle, session_id: Option<String>) {
    let state = crate::hud::current();
    if session_id.is_some() && state.session_id != session_id { return; }
    if !matches!(state.phase, crate::hud::Phase::Recording | crate::hud::Phase::Transcribing) {
        let mut idle = crate::hud::HudState::idle();
        idle.session_id = state.session_id;
        crate::hud::set_state(&app, idle);
    }
}


/// Hovering a finished dictation opens its transcript drawer; returns once
/// the control has the drawer's size.
#[tauri::command]
pub async fn peek_hud(app: AppHandle, session_id: String, open: bool) {
    let _ = tauri::async_runtime::spawn_blocking(move || crate::hud::set_peek(&app, session_id, open)).await;
}

/// A dictation rewritten in another tone (`style`, and as a prompt for an AI
/// agent with `forAgents`), from the HUD's tone buttons.
#[tauri::command]
pub async fn restyle_dictation(app: AppHandle, session_id: String, text: String, style: String, for_agents: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = crate::dictation::pasted_project(&session_id);
        crate::transcribe::restyle_dictation(&app, &text, project.as_deref(), &style, for_agents)
    })
    .await
    .map_err(|error| format!("Could not change the tone: {error}"))?
}

/// Puts a rewrite where the dictation's words went: "replaced" in the app, or "copied".
#[tauri::command]
pub async fn replace_dictation(app: AppHandle, session_id: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::dictation::deliver_rewrite(&app, &session_id, &text).map(str::to_string))
        .await
        .map_err(|error| format!("Could not put the rewrite in place: {error}"))?
}

/// The capture control painted a new phase: its native shadow can follow now.
#[tauri::command]
pub fn hud_painted(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::hud::repainted_on_main(&handle));
}

#[tauri::command]
pub fn close_hud(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || crate::hud::set_hidden_on_main(&handle, true))
        .map_err(|error| format!("could not close the capture control: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStart {
    code: String,
    verification_url: String,
    expires_in_sec: Option<u64>,
}

#[derive(Deserialize)]
struct PairStatus {
    status: String,
    token: Option<String>,
}

#[tauri::command]
pub async fn pair_device(app: AppHandle) -> Result<(), String> {
    if PAIRING.swap(true, Ordering::SeqCst) {
        return Err("Sign-in is already in progress. Finish it in your browser or cancel it.".to_string());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) { PAIRING.store(false, Ordering::SeqCst); }
    }
    let _done = Done;
    let generation = PAIR_GENERATION.load(Ordering::SeqCst);

    let result = pair_device_inner(&app, generation).await;
    let cancelled = matches!(&result, Err(e) if e == PAIR_CANCELLED);
    if !cancelled {
        let (title, body) = match &result {
            Ok(()) => ("Signed in", "Eavesy for Mac is connected to your account.".to_string()),
            Err(e) => ("Couldn't connect this Mac", e.clone()),
        };
        let _ = app.notification().builder().title(title).body(body).show();
    }
    if result.is_ok() {
        if settings::load(&app).setup_completed {
            let _ = show_settings(app.clone());
        } else {
            show_setup(app.clone());
        }
    }
    if let Err(error) = &result {
        if !cancelled {
            crate::telemetry::capture("device.pair", error);
        }
    }
    result
}

static PAIRING: AtomicBool = AtomicBool::new(false);
static PAIR_GENERATION: AtomicU64 = AtomicU64::new(0);
const PAIR_CANCELLED: &str = "Sign-in cancelled.";

#[tauri::command]
pub fn cancel_pairing() {
    PAIR_GENERATION.fetch_add(1, Ordering::SeqCst);
}

async fn pair_device_inner(app: &AppHandle, generation: u64) -> Result<(), String> {
    let cancelled = || PAIR_GENERATION.load(Ordering::SeqCst) != generation;
    let config = settings::load(app);
    let recordings_root = crate::fs_writer::recordings_root(app)?;
    let base = crate::base_url::api_base();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("could not start pairing: {e}"))?;
    let response = client
        .post(format!("{}/api/devices/pair/start", base.trim_end_matches('/')))
        .json(&serde_json::json!({
            "deviceId": &config.device_id,
            "name": "Eavesy for Mac",
            "rootFolderPath": recordings_root.to_string_lossy(),
        }))
        .send()
        .await
        .map_err(|e| format!("could not contact Eavesy: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("could not start pairing (HTTP {})", response.status()));
    }
    if cancelled() {
        return Err(PAIR_CANCELLED.to_string());
    }
    let pairing: PairStart = response
        .json()
        .await
        .map_err(|e| format!("invalid pairing response: {e}"))?;

    if !crate::base_url::same_origin(&pairing.verification_url, &base) {
        return Err("The server returned a sign-in link on a different site, so it was not opened.".to_string());
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&pairing.verification_url)
        .status()
        .map_err(|e| format!("could not open your browser: {e}"))?;

    const POLL_INTERVAL_SEC: u64 = 2;
    let window_sec = pairing.expires_in_sec.unwrap_or(600);
    let minutes = window_sec / 60;

    for _ in 0..(window_sec / POLL_INTERVAL_SEC) {
        tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SEC)).await;
        if cancelled() {
            return Err(PAIR_CANCELLED.to_string());
        }
        let response = match client
            .post(format!("{}/api/devices/pair/status", base.trim_end_matches('/')))
            .json(&serde_json::json!({
                "code": &pairing.code,
                "deviceId": &config.device_id,
            }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => continue,
        };
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err("The pairing code expired. Run Connect account again.".to_string());
        }
        if !response.status().is_success() {
            continue;
        }
        let status: PairStatus = response
            .json()
            .await
            .map_err(|e| format!("invalid pairing status: {e}"))?;
        if status.status == "paired" {
            let token = status.token.ok_or("pairing completed without a credential")?;
            settings::save_device_token(app, &base, &token)?;
            crate::sync::wake();
            return Ok(());
        }
    }
    Err(format!(
        "Pairing timed out. Run Connect account and approve it within {minutes} minutes."
    ))
}

// SQLite, filesystem migration, and serialization run off the UI thread.
#[tauri::command(async)]
pub fn list_recordings(app: AppHandle, offset: Option<usize>, limit: Option<usize>, query: Option<String>, filter: Option<String>, search: Option<crate::history_search::Request>) -> Result<store::HistoryPage, String> {
    let token=search.as_ref().map(crate::history_search::register).transpose()?;
    let mut page = store::page(&app, offset.unwrap_or(0), limit.unwrap_or(50), query.as_deref().unwrap_or(""), filter.as_deref().unwrap_or("all"), token.as_ref())?;
    let mut origins = crate::cloud_pull::origins(&app);
    origins.extend(crate::capture_sync::origins(&app));
    for item in &mut page.items {
        item.device = origins.get(&item.id).cloned();
    }
    Ok(page)
}

#[tauri::command(async)]
pub fn cancel_history_search(search: crate::history_search::Request) -> Result<(),String> {
    crate::history_search::cancel(search)
}

#[derive(Serialize)]
pub struct RecordingDetails {
    #[serde(flatten)]
    recording: RecordingDto,
    revision: i64,
}

#[tauri::command(async)]
pub fn get_recording(app: AppHandle, id: String) -> Result<Option<RecordingDetails>, String> {
    Ok(store::details(&app, &id)?.map(|(r,revision)| RecordingDetails { revision, recording: RecordingDto {
        id:r.id,title:r.title,started_at_ms:r.started_at_ms,duration_sec:r.duration_sec,source:r.source,status:r.status,
        summary:r.summary,transcript:r.transcript,has_audio:r.has_audio,has_video:r.has_video,
    }}))
}

/// Checks a shortcut before saving it: the modifier rule, the other action,
/// then macOS and common app shortcuts.
/// Runs off the main thread: it shells out to `defaults` and `plutil`.
#[tauri::command(async)]
pub fn check_hotkey(app: AppHandle, action: String, accelerator: String) -> Result<Option<crate::shortcut_conflicts::Conflict>, HotkeyError> {
    let action = Action::parse(&action)?;
    let settings = settings::load(&app);
    let current = hotkeys::Bindings::of(&settings);
    crate::shortcut_conflicts::check(&current, action, &accelerator)
}

/// What else uses each saved shortcut (macOS, another app, a 🌐 shortcut),
/// for the notes Settings keeps under them.
/// Runs off the main thread: it shells out to `defaults` and `plutil`.
#[tauri::command(async)]
pub fn check_all_hotkeys(app: AppHandle) -> crate::shortcut_conflicts::SavedConflicts {
    let settings = settings::load(&app);
    crate::shortcut_conflicts::check_saved(&hotkeys::Bindings::of(&settings))
}

#[tauri::command]
// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
#[allow(deprecated)]
pub fn open_keyboard_settings(app: AppHandle, input_monitoring: bool) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let url = if input_monitoring {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
    } else { "x-apple.systempreferences:com.apple.Keyboard-Settings.extension" };
    app.shell().open(url, None).map_err(|e| e.to_string())
}

#[tauri::command]
// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
#[allow(deprecated)]
pub fn open_web_app(app: AppHandle, path: Option<String>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let url = format!("{}/app{}", crate::sync::api_base(), web_app_path(path.as_deref()));
    app.shell().open(url, None).map_err(|e| e.to_string())
}

/// A page under /app, such as `/settings#projects`; anything else opens /app.
fn web_app_path(path: Option<&str>) -> &str {
    match path {
        Some(path)
            if path.starts_with('/')
                && !path.starts_with("//")
                && path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_#".contains(c)) =>
        {
            path
        }
        _ => "",
    }
}

#[tauri::command]
pub fn set_panel_pinned(pinned: bool) { panel::set_pinned(pinned); }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    signed_out: bool,
}

/// Whether uploads are paused because the server rejected this Mac's credential.
#[tauri::command]
pub fn sync_status() -> SyncStatus {
    SyncStatus { signed_out: crate::sync::signed_out() }
}

#[tauri::command]
pub async fn get_hud_state(app: AppHandle) -> serde_json::Value {
    let handle = app.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        let mut state = crate::hud::current();
        if state.phase == crate::hud::Phase::Done {
            if let Some(recording) = state.session_id.as_deref().and_then(|id| store::get(&app, id).ok().flatten()) {
                if let Some(transcript) = recording.transcript { state.message = Some(transcript); }
            }
        }
        state
    }).await.unwrap_or_else(|_| crate::hud::current());
    crate::hud::shown(&handle, &state)
}

#[tauri::command]
pub async fn save_preview_transcript(app: AppHandle, session_id: String, text: String, live: Option<bool>, learn: Option<bool>) -> Result<(), String> {
    // The readiness wait and durable writes use blocking filesystem/SQLite APIs.
    tauri::async_runtime::spawn_blocking(move || {
        // Fast paste can finish just before the recording's folder is registered.
        for _ in 0..50 {
            let ready = store::get(&app, &session_id)?.is_some_and(|rec| rec.folder_path.is_some());
            if ready {
                let original = store::get(&app, &session_id)?.and_then(|rec| rec.transcript);
                if live.unwrap_or(false) {
                    if !store::save_live_preview_transcript(&app, &session_id, &text)? {
                        return Err("Transcript was edited in its folder; reopen it before correcting".into());
                    }
                } else { store::save_preview_transcript(&app, &session_id, &text)?; }
                crate::live_edit::forget(&session_id);
                // A tone change rewrites on purpose: nothing in it is a spelling to learn.
                if let Some(original) = original.filter(|original| original != &text && learn != Some(false)) {
                    let learning_app = app.clone();
                    let corrected = text.clone();
                    // Durable local edits work offline; dictionary feedback follows separately.
                    std::thread::spawn(move || {
                        if crate::settings::device_credential(&learning_app).is_none() { return; }
                        match crate::learning::feedback(&learning_app, &original, &corrected) {
                            Ok(value) => crate::learning::notify(&learning_app, serde_json::json!({ "status": "saved", "learned": value["learned"], "words": value["words"] })),
                            Err(_) => crate::learning::notify(&learning_app, serde_json::json!({ "status": "failed", "message": "Transcript saved. Dictionary could not connect; use Edit transcript to retry learning." })),
                        }
                    });
                }
                let _ = app.emit("recordings:updated", ());
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Err("Recording is still being saved. Please retry.".into())
    }).await.map_err(|error| format!("Could not save transcript: {error}"))?
}

#[tauri::command(async)]
pub fn show_settings(app: AppHandle) -> Result<(), String> {
    crate::settings_window::show(&app)
}

#[tauri::command]
pub fn show_setup(app: AppHandle) {
    hotkeys::show_launcher_and_emit(&app, Some("launcher:setup"));
}

#[tauri::command]
// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
#[allow(deprecated)]
pub fn open_privacy_settings(app: AppHandle, pane: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let url = match pane.as_str() {
        "notifications" => crate::permissions::NOTIFICATIONS_SETTINGS_URL.to_string(),
        other => {
            let anchor = crate::permissions::privacy_anchor(other).ok_or_else(|| format!("unknown privacy pane '{other}'"))?;
            format!("x-apple.systempreferences:com.apple.preference.security?{anchor}")
        }
    };
    app.shell().open(url, None).map_err(|e| e.to_string())?;
    crate::make_room::after_opening_settings(&app);
    Ok(())
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if app.state::<crate::audio::Captures>().is_busy() {
        return Err("Stop the current recording before reopening Eavesy.".into());
    }
    app.restart()
}

#[tauri::command]
pub fn show_notice(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
/// Returns whether a lone fn tap will be reported while suspended.
pub fn suspend_hotkeys(app: AppHandle, suspended: bool) -> Result<bool, HotkeyError> {
    hotkeys::suspend(&app, suspended)
}

#[cfg(test)]
mod tests {
    use super::Restore;

    #[test]
    fn the_users_clipboard_comes_back_after_a_paste() {
        let mut restore = Restore::new();
        let paste = restore.begin(Some(1), || Some("theirs"));
        restore.wrote(paste, Some(2));
        assert_eq!(restore.finish(paste, Some(2)), Some("theirs"));
        assert_eq!(restore.finish(paste, Some(2)), None, "only once");
    }

    #[test]
    fn nothing_comes_back_over_something_copied_since() {
        let mut restore = Restore::new();
        let paste = restore.begin(Some(1), || Some("theirs"));
        restore.wrote(paste, Some(2));
        // The user pressed ⌘C before the restore ran.
        assert_eq!(restore.finish(paste, Some(3)), None);
    }

    #[test]
    fn eavesys_own_copy_calls_a_pending_restore_off() {
        let mut restore = Restore::new();
        let paste = restore.begin(Some(1), || Some("theirs"));
        restore.wrote(paste, Some(2));
        // "Copied — press ⌘V": those words must stay.
        restore.cancel();
        assert_eq!(restore.finish(paste, Some(2)), None);
    }

    #[test]
    fn back_to_back_pastes_restore_the_users_clipboard_not_eavesys() {
        let mut restore = Restore::new();
        let first = restore.begin(Some(1), || Some("theirs"));
        restore.wrote(first, Some(2));
        let second = restore.begin(Some(2), || Some("eavesy's first paste"));
        restore.wrote(second, Some(3));
        assert_eq!(restore.finish(first, Some(3)), None);
        assert_eq!(restore.finish(second, Some(3)), Some("theirs"));
        // Copied in between: what they copied is what comes back.
        let mut restore = Restore::new();
        let first = restore.begin(Some(1), || Some("theirs"));
        restore.wrote(first, Some(2));
        let second = restore.begin(Some(5), || Some("copied since"));
        restore.wrote(second, Some(6));
        assert_eq!(restore.finish(second, Some(6)), Some("copied since"));
    }

    #[test]
    fn a_clipboard_that_cannot_be_kept_is_left_alone() {
        let mut restore = Restore::<&str>::new();
        let paste = restore.begin(Some(1), || None);
        restore.wrote(paste, Some(2));
        assert_eq!(restore.finish(paste, Some(2)), None);
    }

    #[test]
    fn live_corrections_only_target_the_current_capture() {
        use crate::hud::{HudState, Phase};
        for phase in [Phase::Recording, Phase::Transcribing, Phase::Done] {
            let state = HudState { phase, session_id: Some("current".into()), ..HudState::idle() };
            assert!(super::validate_live_preview_session(&state, "current").is_ok());
            assert!(super::validate_live_preview_session(&state, "another").is_err());
        }
        for phase in [Phase::Idle, Phase::Failed, Phase::Saved] {
            let state = HudState { phase, session_id: Some("current".into()), ..HudState::idle() };
            assert!(super::validate_live_preview_session(&state, "current").is_err());
        }
    }
    #[test]
    fn only_plain_app_pages_open_in_the_browser() {
        assert_eq!(super::web_app_path(Some("/settings#projects")), "/settings#projects");
        assert_eq!(super::web_app_path(Some("//evil.example")), "");
        assert_eq!(super::web_app_path(Some("/a?b=c")), "");
        assert_eq!(super::web_app_path(None), "");
    }
}
