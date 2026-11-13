//! Clipboard history, and the panel that shows it beside the screenshot
//! history (clipboard.html).
//!
//! What you copy is kept on this Mac only: text, links, images and copied
//! files, newest first, each once however often it is copied. Anything a
//! password manager marks private (nspasteboard.org) is never read, and the
//! words Eavesy puts on the clipboard for a moment to paste a dictation are
//! not history either. Nothing here syncs.
//!
//! The panel opens from its shortcuts (`hotkeys::Action::Clipboard`,
//! `Action::Screenshots`) and from the pill. Return puts the chosen item on
//! the clipboard, hands the keyboard back to the app you were in and presses
//! ⌘V there.

// tauri-nspanel re-exports the legacy `cocoa`/`objc` crates: their APIs are deprecated and
// their `msg_send!` macros trip `unexpected_cfgs`. Moving to objc2 is a separate migration.
#![allow(deprecated, unexpected_cfgs)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub const LABEL: &str = "clipboard";
const SIZE: (f64, f64) = (760.0, 500.0);
/// How often the pasteboard's change count is looked at. Reading the count
/// is one cheap call; the contents are only read when it moved.
const POLL: Duration = Duration::from_millis(400);
const KEEP_ITEMS: i64 = 1000;
const KEEP_FOR_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// The most rows one listing returns; search reaches the rest.
const LIST_LIMIT: i64 = 500;
const TEXT_LIMIT: usize = 1 << 20;
const IMAGE_LIMIT: usize = 32 << 20;
const TITLE_CHARS: usize = 160;

/// Which of the panel's two lists is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum View {
    Clipboard,
    Screenshots,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Link,
    Image,
    File,
}

impl Kind {
    fn name(self) -> &'static str {
        match self { Kind::Text => "text", Kind::Link => "link", Kind::Image => "image", Kind::File => "file" }
    }
}

/// Something read off the clipboard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Copied {
    kind: Kind,
    /// The text, the link, or a copied file's path. Empty for an image.
    text: String,
    /// An image, as PNG.
    png: Vec<u8>,
    width: i64,
    height: i64,
}

impl Copied {
    pub fn text(text: String) -> Self {
        let trimmed = text.trim();
        let link = (trimmed.starts_with("https://") || trimmed.starts_with("http://")) && !trimmed.contains(char::is_whitespace);
        Copied { kind: if link { Kind::Link } else { Kind::Text }, text, png: Vec::new(), width: 0, height: 0 }
    }

    pub fn file(path: String) -> Self {
        Copied { kind: Kind::File, text: path, png: Vec::new(), width: 0, height: 0 }
    }

    pub fn image(png: Vec<u8>, width: i64, height: i64) -> Self {
        Copied { kind: Kind::Image, text: String::new(), png, width, height }
    }

    /// The same thing copied twice has the same hash, so it is kept once.
    fn hash(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        // A file and the text of its path are different things to paste.
        hasher.update(if self.kind == Kind::File { b"file:".as_slice() } else { b"".as_slice() });
        hasher.update(if self.kind == Kind::Image { self.png.as_slice() } else { self.text.as_bytes() });
        hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

/// One row of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    id: i64,
    kind: String,
    title: String,
    last_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    items: Vec<Row>,
    /// How many match in all; `items` holds the newest of them.
    total: i64,
}

/// Everything about one item, for the preview beside the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    id: i64,
    kind: String,
    text: String,
    source: Option<String>,
    first_ms: i64,
    last_ms: i64,
    times: i64,
    width: i64,
    height: i64,
    chars: usize,
    words: usize,
    bytes: i64,
    /// An image's file, readable through the asset protocol.
    image: Option<String>,
}

/// The line that names an item in the list: its first line with any text,
/// on one line, cut to fit.
fn title(kind: Kind, text: &str, width: i64, height: i64) -> String {
    match kind {
        Kind::Image => format!("Image · {width} × {height}"),
        Kind::File => Path::new(text).file_name().map_or_else(|| text.to_string(), |name| name.to_string_lossy().into_owned()),
        Kind::Text | Kind::Link => {
            let line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
            let mut title: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
            if title.chars().count() > TITLE_CHARS {
                title = title.chars().take(TITLE_CHARS).collect::<String>() + "…";
            }
            title
        }
    }
}

fn error(error: rusqlite::Error) -> String {
    format!("clipboard history: {error}")
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clips(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            text TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            hash TEXT NOT NULL UNIQUE,
            source TEXT,
            first_ms INTEGER NOT NULL,
            last_ms INTEGER NOT NULL,
            times INTEGER NOT NULL DEFAULT 1,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS clips_last ON clips(last_ms DESC);",
    )
    .map_err(error)
}

fn image_path(images: &Path, hash: &str) -> PathBuf {
    images.join(format!("{hash}.png"))
}

/// Keeps what was copied. Copying the newest item again changes nothing;
/// copying an older one again brings it back to the top. Returns whether the
/// list changed.
fn record(conn: &Connection, images: &Path, copied: &Copied, source: Option<&str>, now_ms: i64) -> Result<bool, String> {
    let hash = copied.hash();
    let newest: Option<String> = conn.query_row("SELECT hash FROM clips ORDER BY last_ms DESC, id DESC LIMIT 1", [], |row| row.get(0)).optional().map_err(error)?;
    if newest.as_deref() == Some(hash.as_str()) {
        return Ok(false);
    }
    if copied.kind == Kind::Image {
        std::fs::create_dir_all(images).map_err(|e| e.to_string())?;
        let path = image_path(images, &hash);
        if !path.exists() {
            std::fs::write(&path, &copied.png).map_err(|e| e.to_string())?;
        }
    }
    let bytes = if copied.kind == Kind::Image { copied.png.len() } else { copied.text.len() } as i64;
    conn.execute(
        "INSERT INTO clips(kind,text,title,hash,source,first_ms,last_ms,times,width,height,bytes) VALUES(?1,?2,?3,?4,?5,?6,?6,1,?7,?8,?9)
         ON CONFLICT(hash) DO UPDATE SET last_ms=excluded.last_ms, times=times+1",
        params![copied.kind.name(), copied.text, title(copied.kind, &copied.text, copied.width, copied.height), hash, source, now_ms, copied.width, copied.height, bytes],
    )
    .map_err(error)?;
    prune(conn, images, now_ms)?;
    Ok(true)
}

/// Drops what is older than the keeping time or past the keeping count,
/// with the image files that went with it.
fn prune(conn: &Connection, images: &Path, now_ms: i64) -> Result<(), String> {
    let stale = "last_ms < ?1 OR id NOT IN (SELECT id FROM clips ORDER BY last_ms DESC, id DESC LIMIT ?2)";
    let cutoff = now_ms - KEEP_FOR_MS;
    let gone: Vec<String> = {
        let mut statement = conn.prepare(&format!("SELECT hash FROM clips WHERE kind='image' AND ({stale})")).map_err(error)?;
        let rows = statement.query_map(params![cutoff, KEEP_ITEMS], |row| row.get(0)).map_err(error)?;
        rows.collect::<Result<_, _>>().map_err(error)?
    };
    conn.execute(&format!("DELETE FROM clips WHERE {stale}"), params![cutoff, KEEP_ITEMS]).map_err(error)?;
    for hash in gone {
        let _ = std::fs::remove_file(image_path(images, &hash));
    }
    Ok(())
}

/// `LIKE` pattern for text that contains `query` as typed.
fn like(query: &str) -> String {
    let mut pattern = String::from("%");
    for ch in query.chars() {
        if matches!(ch, '%' | '_' | '\\') { pattern.push('\\'); }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

fn list(conn: &Connection, query: &str) -> Result<Listing, String> {
    let query = query.trim();
    let filter = if query.is_empty() { "1=1" } else { "(text LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' OR source LIKE ?1 ESCAPE '\\')" };
    let pattern = like(query);
    let total: i64 = (if query.is_empty() {
        conn.query_row("SELECT count(*) FROM clips", [], |row| row.get(0))
    } else {
        conn.query_row(&format!("SELECT count(*) FROM clips WHERE {filter}"), params![pattern], |row| row.get(0))
    })
    .map_err(error)?;
    let sql = format!("SELECT id,kind,title,last_ms FROM clips WHERE {filter} ORDER BY last_ms DESC, id DESC LIMIT {LIST_LIMIT}");
    let mut statement = conn.prepare(&sql).map_err(error)?;
    let map = |row: &rusqlite::Row<'_>| Ok(Row { id: row.get(0)?, kind: row.get(1)?, title: row.get(2)?, last_ms: row.get(3)? });
    let items = (if query.is_empty() { statement.query_map([], map) } else { statement.query_map(params![pattern], map) })
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(Listing { items, total })
}

struct Stored {
    detail: Detail,
    hash: String,
}

fn get(conn: &Connection, images: &Path, id: i64) -> Result<Option<Stored>, String> {
    conn.query_row(
        "SELECT id,kind,text,source,first_ms,last_ms,times,width,height,bytes,hash FROM clips WHERE id=?1",
        params![id],
        |row| {
            let kind: String = row.get(1)?;
            let text: String = row.get(2)?;
            let hash: String = row.get(10)?;
            let image = (kind == "image").then(|| image_path(images, &hash).to_string_lossy().into_owned());
            Ok(Stored {
                detail: Detail {
                    id: row.get(0)?,
                    chars: text.chars().count(),
                    words: text.split_whitespace().count(),
                    kind,
                    text,
                    source: row.get(3)?,
                    first_ms: row.get(4)?,
                    last_ms: row.get(5)?,
                    times: row.get(6)?,
                    width: row.get(7)?,
                    height: row.get(8)?,
                    bytes: row.get(9)?,
                    image,
                },
                hash,
            })
        },
    )
    .optional()
    .map_err(error)
}

/// An item was pasted or copied from the panel: it is the newest again.
fn touch(conn: &Connection, id: i64, now_ms: i64) -> Result<(), String> {
    conn.execute("UPDATE clips SET last_ms=?2, times=times+1 WHERE id=?1", params![id, now_ms]).map(|_| ()).map_err(error)
}

fn remove(conn: &Connection, images: &Path, id: i64) -> Result<(), String> {
    if let Some(stored) = get(conn, images, id)? {
        conn.execute("DELETE FROM clips WHERE id=?1", params![id]).map_err(error)?;
        if stored.detail.kind == "image" {
            let _ = std::fs::remove_file(image_path(images, &stored.hash));
        }
    }
    Ok(())
}

fn clear(conn: &Connection, images: &Path) -> Result<(), String> {
    conn.execute("DELETE FROM clips", []).map_err(error)?;
    let _ = std::fs::remove_dir_all(images);
    Ok(())
}

static DB: Mutex<Option<Connection>> = Mutex::new(None);

/// Runs `work` on the history's database, opening it on first use.
fn with_db<T>(app: &AppHandle, work: impl FnOnce(&Connection, &Path) -> Result<T, String>) -> Result<T, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let images = dir.join("clipboard-images");
    let mut slot = DB.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(dir.join("clipboard.sqlite3")).map_err(error)?;
        migrate(&conn)?;
        *slot = Some(conn);
    }
    let conn = slot.as_ref().ok_or("clipboard history is unavailable")?;
    work(conn, &images)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The watcher that is allowed to run; a newer start or a stop retires it.
static WATCHER: AtomicU64 = AtomicU64::new(0);
/// The pasteboard's change count after the panel's own write, which is not
/// something newly copied (`use_item` has already moved it to the top).
static OWN_WRITE: AtomicIsize = AtomicIsize::new(-1);

pub fn start(app: &AppHandle) {
    watch(app, crate::settings::load(app).clipboard_history());
}

/// Starts or stops keeping what is copied.
fn watch(app: &AppHandle, enabled: bool) {
    let generation = WATCHER.fetch_add(1, Ordering::SeqCst) + 1;
    if !enabled { return; }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("eavesy-clipboard".into()).spawn(move || {
        // What is on the clipboard as Eavesy starts is the first item.
        let mut seen = None;
        let mut deferred = false;
        while WATCHER.load(Ordering::SeqCst) == generation {
            let count = pasteboard::change_count();
            if count != seen || deferred {
                seen = count;
                // A dictation being pasted: its words are on the clipboard
                // for a moment and the old contents come back. Look again
                // once that is over, in case the words stayed.
                deferred = crate::commands::paste_in_flight();
                if !deferred && count != Some(OWN_WRITE.load(Ordering::SeqCst)) {
                    keep(&app);
                }
            }
            std::thread::sleep(POLL);
        }
    });
    if let Err(error) = spawned {
        crate::telemetry::capture("clipboard.watch", &error.to_string());
    }
}

fn keep(app: &AppHandle) {
    let Some(copied) = pasteboard::read() else { return };
    let source = match crate::app_menu::frontmost() {
        Some((_, name)) => name,
        None => crate::app_menu::is_active().then(|| "Eavesy".to_string()),
    };
    match with_db(app, |conn, images| record(conn, images, &copied, source.as_deref(), now_ms())) {
        Ok(true) => { let _ = app.emit_to(LABEL, "clipboard:changed", ()); }
        Ok(false) => {}
        Err(error) => crate::telemetry::capture("clipboard.record", &error),
    }
}

#[tauri::command]
pub fn set_clipboard_history(app: AppHandle, enabled: bool) -> Result<(), String> {
    crate::settings::update(&app, |config| config.clipboard_history = Some(enabled))?;
    watch(&app, enabled);
    Ok(())
}

#[tauri::command(async)]
pub fn clipboard_list(app: AppHandle, query: Option<String>) -> Result<Listing, String> {
    with_db(&app, |conn, _| list(conn, query.as_deref().unwrap_or("")))
}

#[tauri::command(async)]
pub fn clipboard_item(app: AppHandle, id: i64) -> Result<Option<Detail>, String> {
    let detail = with_db(&app, |conn, images| get(conn, images, id))?.map(|stored| stored.detail);
    if let Some(image) = detail.as_ref().and_then(|detail| detail.image.as_ref()) {
        app.asset_protocol_scope().allow_file(image).map_err(|e| e.to_string())?;
    }
    Ok(detail)
}

#[tauri::command(async)]
pub fn clipboard_delete(app: AppHandle, id: i64) -> Result<(), String> {
    with_db(&app, |conn, images| remove(conn, images, id))
}

#[tauri::command(async)]
pub fn clipboard_clear(app: AppHandle) -> Result<(), String> {
    with_db(&app, clear)
}

/// Puts an item from the history back on the clipboard and closes the
/// panel; with `paste`, also pastes it into the app you were in. Says which
/// happened: "pasted", or "copied" when it could only be copied.
#[tauri::command(async)]
pub fn clipboard_use(app: AppHandle, id: i64, paste: bool) -> Result<&'static str, String> {
    let stored = with_db(&app, |conn, images| get(conn, images, id))?.ok_or("That item is no longer in your clipboard history.")?;
    crate::commands::cancel_clipboard_restore();
    match stored.detail.kind.as_str() {
        "image" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let bytes = std::fs::read(stored.detail.image.as_deref().unwrap_or_default()).map_err(|_| "That image is no longer saved.".to_string())?;
            let image = tauri::image::Image::from_bytes(&bytes).map_err(|e| e.to_string())?;
            app.clipboard().write_image(&image).map_err(|e| e.to_string())?;
        }
        "file" => {
            let path = PathBuf::from(&stored.detail.text);
            if !path.exists() { return Err("That file has been moved or deleted.".into()); }
            on_main(&app, move |_| crate::visual::copy_file(&path))??;
        }
        _ => crate::commands::copy_to_clipboard(&app, &stored.detail.text)?,
    }
    OWN_WRITE.store(pasteboard::change_count().unwrap_or(-1), Ordering::SeqCst);
    with_db(&app, |conn, _| touch(conn, id, now_ms()))?;
    Ok(deliver(&app, paste))
}

/// The same for a screenshot from the history.
#[tauri::command]
pub async fn clipboard_use_capture(app: AppHandle, id: String, paste: bool) -> Result<&'static str, String> {
    crate::visual::copy_capture_media(app.clone(), id).await?;
    tauri::async_runtime::spawn_blocking(move || deliver(&app, paste)).await.map_err(|e| e.to_string())
}

/// Closes the panel and, with `paste`, presses ⌘V in the app that gets the
/// keyboard back. Never call on the main thread.
fn deliver(app: &AppHandle, paste: bool) -> &'static str {
    let _ = on_main(app, hide_on_main);
    if !paste { return "copied"; }
    // Closing the panel hands focus back to the app it opened over; wait for
    // that app to be in front before pasting into it.
    std::thread::sleep(Duration::from_millis(120));
    for _ in 0..8 {
        if !crate::app_menu::is_active() { break; }
        std::thread::sleep(Duration::from_millis(50));
    }
    match crate::dictation::press_paste() {
        Ok(()) => "pasted",
        Err(error) => {
            use tauri_plugin_notification::NotificationExt;
            eprintln!("clipboard: {error}");
            let _ = app.notification().builder().title("Copied, not pasted").body("Allow Eavesy in System Settings → Privacy & Security → Accessibility to paste for you. It's on your clipboard: press ⌘V.").show();
            "copied"
        }
    }
}

/// Runs `work` on the main thread and waits for it.
fn on_main<T: Send + 'static>(app: &AppHandle, work: impl FnOnce(&AppHandle) -> T + Send + 'static) -> Result<T, String> {
    let (done, wait) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = done.send(work(&handle)); }).map_err(|e| e.to_string())?;
    wait.recv_timeout(Duration::from_secs(2)).map_err(|_| "Eavesy is busy. Try again.".to_string())
}

#[tauri::command]
pub fn show_clipboard(app: AppHandle, view: View) {
    open(&app, view);
}

#[tauri::command]
pub fn hide_clipboard(app: AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || hide_on_main(&handle));
}

/// A shortcut was pressed: opens the panel on `view`, or lets the open panel
/// decide (the same view again closes it, the other one switches to it).
pub fn toggle(app: &AppHandle, view: View) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if is_visible(&handle) {
            let _ = handle.emit_to(LABEL, "clipboard:shortcut", view);
        } else {
            show_on_main(&handle, view);
        }
    });
}

/// Opens the panel on `view`, whether or not it is already open.
pub fn open(app: &AppHandle, view: View) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_on_main(&handle, view));
}

/// Where the panel goes: centred on the screen the pointer is on, a little
/// above the middle, where a launcher is expected.
fn origin(area: (f64, f64, f64, f64), size: (f64, f64)) -> (f64, f64) {
    let x = area.0 + ((area.2 - size.0) / 2.0).max(0.0);
    let y = area.1 + ((area.3 - size.1) * 0.3).max(0.0);
    (x.round(), y.round())
}

fn place(app: &AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|point| app.monitor_from_point(point.x, point.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let area = (area.position.x as f64 / scale, area.position.y as f64 / scale, area.size.width as f64 / scale, area.size.height as f64 / scale);
    let (x, y) = origin(area, SIZE);
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

fn show_on_main(app: &AppHandle, view: View) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let was_visible = is_visible(app);
    // The app the paste will go to: the one in front now, never Eavesy.
    let target = crate::app_menu::frontmost().and_then(|(_, name)| name);
    if !was_visible { place(app, &window); }
    imp::show(app, &window);
    crate::app_menu::activate();
    let _ = app.emit_to(LABEL, "clipboard:opened", serde_json::json!({ "view": view, "target": target, "fresh": !was_visible }));
}

/// Closes the panel and hands the keyboard back to the app it opened over,
/// unless Eavesy's own panel is what took it.
fn hide_on_main(app: &AppHandle) {
    if !is_visible(app) { return; }
    imp::hide(app);
    if !crate::panel::is_visible(app) {
        crate::app_menu::return_focus();
    }
}

pub fn is_visible(app: &AppHandle) -> bool {
    imp::is_visible(app)
}

/// Builds the panel, hidden, so the first press of the shortcut opens it at
/// once instead of waiting for a web view to start.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("clipboard.html".into()))
        .title("Eavesy Clipboard")
        .inner_size(SIZE.0, SIZE.1)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .focused(false)
        .visible(false)
        .accept_first_mouse(true)
        .build()
        .map_err(|e| format!("could not build the clipboard panel: {e}"))?;
    imp::install(app, &window)
}

#[cfg(target_os = "macos")]
mod imp {
    use tauri::{AppHandle, WebviewWindow};
    use tauri_nspanel::{cocoa::appkit::NSWindowCollectionBehavior, panel_delegate, ManagerExt, WebviewWindowExt};
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    const NONACTIVATING_PANEL: i32 = 1 << 7;
    /// One above the capture control and the launcher (25, hud.rs and
    /// panel.rs), so the pill never covers it.
    const LEVEL: i32 = 26;

    pub fn install(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
        apply_vibrancy(window, NSVisualEffectMaterial::Popover, Some(NSVisualEffectState::Active), Some(16.0))
            .map_err(|e| format!("failed to apply vibrancy: {e}"))?;
        let panel = window.to_panel().map_err(|e| format!("failed to convert the clipboard window to a panel: {e}"))?;
        panel.set_style_mask(NONACTIVATING_PANEL);
        panel.set_level(LEVEL);
        panel.set_collection_behaviour(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
        );
        // Like a menu: a click anywhere else closes it.
        let delegate = panel_delegate!(EavesyClipboardDelegate { window_did_resign_key });
        let handle = app.clone();
        delegate.set_listener(Box::new(move |name: String| {
            if name == "window_did_resign_key" && !crate::panel::is_yielding() {
                let close = handle.clone();
                let _ = handle.run_on_main_thread(move || super::hide_on_main(&close));
            }
        }));
        panel.set_delegate(delegate);
        panel.set_released_when_closed(false);
        Ok(())
    }

    pub fn show(app: &AppHandle, _window: &WebviewWindow) {
        if let Ok(panel) = app.get_webview_panel(super::LABEL) {
            panel.show();
            panel.make_key_window();
        }
    }

    pub fn hide(app: &AppHandle) {
        if let Ok(panel) = app.get_webview_panel(super::LABEL) {
            panel.order_out(None);
        }
    }

    pub fn is_visible(app: &AppHandle) -> bool {
        app.get_webview_panel(super::LABEL).map(|panel| panel.is_visible()).unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::{AppHandle, Manager, WebviewWindow};

    pub fn install(_app: &AppHandle, _window: &WebviewWindow) -> Result<(), String> { Ok(()) }

    pub fn show(_app: &AppHandle, window: &WebviewWindow) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    pub fn hide(app: &AppHandle) {
        if let Some(window) = app.get_webview_window(super::LABEL) { let _ = window.hide(); }
    }

    pub fn is_visible(app: &AppHandle) -> bool {
        app.get_webview_window(super::LABEL).and_then(|window| window.is_visible().ok()).unwrap_or(false)
    }
}

/// Reading the general pasteboard. Safe on any thread.
#[cfg(target_os = "macos")]
mod pasteboard {
    use super::{Copied, IMAGE_LIMIT, TEXT_LIMIT};
    use tauri_nspanel::{
        cocoa::base::{id, nil},
        objc::{class, msg_send, sel, sel_impl},
    };

    /// Marked by password managers and the like (nspasteboard.org): never read.
    const PRIVATE: [&str; 3] = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"];
    /// `NSBitmapImageFileTypePNG`.
    const PNG: usize = 4;

    struct Pool(id);
    impl Pool {
        unsafe fn new() -> Self { Pool(msg_send![class!(NSAutoreleasePool), new]) }
    }
    impl Drop for Pool {
        fn drop(&mut self) {
            unsafe { let _: () = msg_send![self.0, drain]; }
        }
    }

    unsafe fn ns(text: &str) -> id {
        let Ok(text) = std::ffi::CString::new(text) else { return nil };
        msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()]
    }

    unsafe fn rust_string(string: id) -> Option<String> {
        if string == nil { return None; }
        let utf8: *const std::os::raw::c_char = msg_send![string, UTF8String];
        (!utf8.is_null()).then(|| std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    unsafe fn bytes(data: id) -> Vec<u8> {
        let length: usize = msg_send![data, length];
        let pointer: *const u8 = msg_send![data, bytes];
        if length == 0 || pointer.is_null() { Vec::new() } else { std::slice::from_raw_parts(pointer, length).to_vec() }
    }

    pub fn change_count() -> Option<isize> {
        unsafe {
            let _pool = Pool::new();
            let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
            if pasteboard == nil { return None; }
            let count: isize = msg_send![pasteboard, changeCount];
            Some(count)
        }
    }

    /// What is on the clipboard, or None when it is private, empty, too big
    /// or nothing Eavesy keeps. A copied file wins over its name, and text
    /// over a picture of it (a spreadsheet's cells come as both).
    pub fn read() -> Option<Copied> {
        unsafe {
            let _pool = Pool::new();
            let pasteboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
            if pasteboard == nil { return None; }
            let types: id = msg_send![pasteboard, types];
            let count: usize = if types == nil { 0 } else { msg_send![types, count] };
            let mut names = Vec::with_capacity(count);
            for index in 0..count {
                let kind: id = msg_send![types, objectAtIndex: index];
                if let Some(name) = rust_string(kind) { names.push(name); }
            }
            if names.iter().any(|name| PRIVATE.contains(&name.as_str())) { return None; }
            let has = |kind: &str| names.iter().any(|name| name == kind);
            if has("public.file-url") {
                let string: id = msg_send![pasteboard, stringForType: ns("public.file-url")];
                if let Some(url) = rust_string(string) {
                    let url: id = msg_send![class!(NSURL), URLWithString: ns(&url)];
                    if url != nil {
                        let path: id = msg_send![url, path];
                        if let Some(path) = rust_string(path).filter(|path| !path.is_empty()) { return Some(Copied::file(path)); }
                    }
                }
            }
            if has("public.utf8-plain-text") {
                let string: id = msg_send![pasteboard, stringForType: ns("public.utf8-plain-text")];
                if let Some(text) = rust_string(string).filter(|text| !text.trim().is_empty()) {
                    return (text.len() <= TEXT_LIMIT).then(|| Copied::text(text));
                }
            }
            for kind in ["public.png", "public.tiff"] {
                if !has(kind) { continue; }
                let data: id = msg_send![pasteboard, dataForType: ns(kind)];
                if data == nil { continue; }
                let length: usize = msg_send![data, length];
                if length == 0 || length > IMAGE_LIMIT { return None; }
                let rep: id = msg_send![class!(NSBitmapImageRep), imageRepWithData: data];
                if rep == nil { continue; }
                let width: isize = msg_send![rep, pixelsWide];
                let height: isize = msg_send![rep, pixelsHigh];
                let png: id = if kind == "public.png" {
                    data
                } else {
                    let properties: id = msg_send![class!(NSDictionary), dictionary];
                    msg_send![rep, representationUsingType: PNG properties: properties]
                };
                if png == nil { continue; }
                let png = bytes(png);
                if png.is_empty() || png.len() > IMAGE_LIMIT { return None; }
                return Some(Copied::image(png, width as i64, height as i64));
            }
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod pasteboard {
    pub fn change_count() -> Option<isize> { None }
    pub fn read() -> Option<super::Copied> { None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (Connection, PathBuf) {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        (conn, std::env::temp_dir().join(format!("eavesy-clipboard-{}", uuid::Uuid::new_v4())))
    }

    fn titles(conn: &Connection, query: &str) -> Vec<String> {
        list(conn, query).unwrap().items.into_iter().map(|row| row.title).collect()
    }

    #[test]
    fn the_same_thing_copied_again_is_kept_once_and_comes_back_to_the_top() {
        let (conn, dir) = db();
        let images = dir.as_path();
        assert!(record(&conn, images, &Copied::text("first".into()), Some("Notes"), 1).unwrap());
        assert!(record(&conn, images, &Copied::text("second".into()), Some("Safari"), 2).unwrap());
        // The newest again: nothing changes, so a dictation's clipboard being put back is not a new copy.
        assert!(!record(&conn, images, &Copied::text("second".into()), Some("Mail"), 3).unwrap());
        assert_eq!(titles(&conn, ""), ["second", "first"]);
        assert!(record(&conn, images, &Copied::text("first".into()), Some("Mail"), 4).unwrap());
        assert_eq!(titles(&conn, ""), ["first", "second"]);
        let first = get(&conn, images, 1).unwrap().unwrap().detail;
        assert_eq!((first.times, first.first_ms, first.last_ms, first.source.as_deref()), (2, 1, 4, Some("Notes")), "where it was first copied from is kept");
        assert_eq!(list(&conn, "").unwrap().total, 2);
    }

    #[test]
    fn what_was_copied_is_named_by_its_first_line_and_its_kind() {
        assert_eq!(Copied::text("  https://eavesy.com/docs \n".into()).kind, Kind::Link);
        assert_eq!(Copied::text("see https://eavesy.com".into()).kind, Kind::Text);
        assert_eq!(title(Kind::Text, "\n\n  Where the   open\ttickets sit \nsecond line", 0, 0), "Where the open tickets sit");
        assert_eq!(title(Kind::Image, "", 1342, 999), "Image · 1342 × 999");
        assert_eq!(title(Kind::File, "/Users/a/Desktop/Q3 plan.pdf", 0, 0), "Q3 plan.pdf");
        let long = title(Kind::Text, &"word ".repeat(100), 0, 0);
        assert_eq!(long.chars().count(), TITLE_CHARS + 1);
        assert!(long.ends_with('…'));
        // A file and the text of its path are different things to paste.
        assert_ne!(Copied::file("/tmp/a.txt".into()).hash(), Copied::text("/tmp/a.txt".into()).hash());
    }

    #[test]
    fn search_finds_text_anywhere_in_an_item_and_takes_symbols_literally() {
        let (conn, dir) = db();
        let images = dir.as_path();
        record(&conn, images, &Copied::text("Inventory (production, read today)\n100% of SKUs".into()), Some("Chrome"), 1).unwrap();
        record(&conn, images, &Copied::text("snake_case name".into()), Some("Code"), 2).unwrap();
        record(&conn, images, &Copied::image(vec![1, 2, 3], 10, 20), Some("Preview"), 3).unwrap();
        assert_eq!(titles(&conn, "skus"), ["Inventory (production, read today)"], "past the first line, any case");
        assert_eq!(titles(&conn, "100%"), ["Inventory (production, read today)"]);
        assert_eq!(titles(&conn, "e_c"), ["snake_case name"], "_ is not a wildcard");
        assert_eq!(titles(&conn, "image"), ["Image · 10 × 20"]);
        assert_eq!(titles(&conn, "preview"), ["Image · 10 × 20"], "by the app it came from");
        assert!(titles(&conn, "nothing like it").is_empty());
        let detail = get(&conn, images, 1).unwrap().unwrap().detail;
        assert_eq!((detail.words, detail.chars), (7, 47));
    }

    #[test]
    fn images_are_saved_beside_the_history_and_go_when_their_item_does() {
        let (conn, dir) = db();
        let images = dir.as_path().join("images");
        let shot = Copied::image(vec![9; 64], 8, 8);
        record(&conn, &images, &shot, None, 1).unwrap();
        let stored = get(&conn, &images, 1).unwrap().unwrap();
        let path = PathBuf::from(stored.detail.image.clone().unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), vec![9; 64]);
        assert_eq!(stored.detail.bytes, 64);
        remove(&conn, &images, 1).unwrap();
        assert!(!path.exists());
        assert!(get(&conn, &images, 1).unwrap().is_none());
        record(&conn, &images, &shot, None, 2).unwrap();
        clear(&conn, &images).unwrap();
        assert!(!images.exists());
        assert_eq!(list(&conn, "").unwrap().total, 0);
    }

    #[test]
    fn old_items_and_items_past_the_limit_are_dropped() {
        let (conn, dir) = db();
        let images = dir.as_path().join("images");
        record(&conn, &images, &Copied::image(vec![1; 8], 1, 1), None, 1).unwrap();
        record(&conn, &images, &Copied::text("kept".into()), None, KEEP_FOR_MS).unwrap();
        // Just past the keeping time for the image: it goes, with its file.
        record(&conn, &images, &Copied::text("new".into()), None, KEEP_FOR_MS + 2).unwrap();
        assert_eq!(titles(&conn, ""), ["new", "kept"]);
        assert!(std::fs::read_dir(&images).unwrap().next().is_none());
        for index in 0..KEEP_ITEMS + 5 {
            record(&conn, &images, &Copied::text(format!("item {index}")), None, KEEP_FOR_MS + 10 + index).unwrap();
        }
        let listing = list(&conn, "").unwrap();
        assert_eq!(listing.total, KEEP_ITEMS);
        assert_eq!(listing.items.len() as i64, LIST_LIMIT);
        assert_eq!(listing.items[0].title, format!("item {}", KEEP_ITEMS + 4));
    }

    #[test]
    fn using_an_item_makes_it_the_newest() {
        let (conn, dir) = db();
        record(&conn, dir.as_path(), &Copied::text("older".into()), None, 1).unwrap();
        record(&conn, dir.as_path(), &Copied::text("newer".into()), None, 2).unwrap();
        touch(&conn, 1, 3).unwrap();
        assert_eq!(titles(&conn, ""), ["older", "newer"]);
    }

    #[test]
    fn the_panel_opens_centred_a_little_above_the_middle() {
        assert_eq!(origin((0.0, 25.0, 1440.0, 875.0), SIZE), (340.0, 138.0));
        // A second screen to the left, and one too small for the panel.
        assert_eq!(origin((-1920.0, 0.0, 1920.0, 1080.0), SIZE).0, -1340.0);
        assert_eq!(origin((0.0, 0.0, 600.0, 400.0), SIZE), (0.0, 0.0));
    }

    #[test]
    fn views_are_named_for_the_ui() {
        assert_eq!(serde_json::to_value(View::Screenshots).unwrap(), serde_json::json!("screenshots"));
        assert_eq!(serde_json::from_str::<View>("\"clipboard\"").unwrap(), View::Clipboard);
    }
}
