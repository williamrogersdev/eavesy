use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_TOGGLE_HOTKEY: &str = "Cmd+Shift+Space";
pub const DEFAULT_DICTATION_HOTKEY: &str = "Cmd+Shift+D";
/// Recording segment length. Each sealed segment is uploaded and transcribed on
/// its own, so this bounds how stale the cloud transcript is while recording.
pub const DEFAULT_SEGMENT_SEC: u32 = 60;
/// The capture sidecar refuses anything shorter.
const MIN_SEGMENT_SEC: u32 = 30;
const MAX_SEGMENT_SEC: u32 = 600;

// Variant names are persisted as snake_case settings values; renaming would break saved settings.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherPosition {
    TopLeft,
    TopRight,
    #[default]
    TopCenter,
    BottomCenter,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct HudFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PanelSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub toggle_hotkey: String,
    pub dictation_hotkey: String,
    #[serde(default = "new_device_id")]
    pub device_id: String,
    #[serde(default)]
    pub setup_completed: bool,
    #[serde(default)]
    pub recordings_root: Option<String>,
    #[serde(default)]
    pub launcher_position: LauncherPosition,
    #[serde(default)]
    pub hud_frame: Option<HudFrame>,
    #[serde(default)]
    pub hud_hidden: bool,
    #[serde(default)]
    pub panel_size: Option<PanelSize>,
    /// Self-hosting: origin of your own Eavesy server (e.g. `https://eavesy.example.com`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
    /// Unset means the current default, so a future default change reaches
    /// people who never chose a length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_sec: Option<u32>,
    /// On-device live captions for meetings and voice notes (on unless turned off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_captions: Option<bool>,
    /// Copy new macOS screenshots into the history (on unless turned off). A new
    /// key: the old `auto_import_screenshots` saved `false` for everyone who never chose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub add_screenshots: Option<bool>,
    /// A short sound as a recording starts and stops (on unless turned off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_sounds: Option<bool>,
    /// Lines of live words the control shows while recording: 0, 1, 2 or 4
    /// (off unless chosen: the plain bar is quieter while you talk).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_preview_lines: Option<u8>,
    /// A see-through control instead of a solid one (on unless turned off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_translucent: Option<bool>,
    /// Live words from a second, fast recognizer about a second sooner, until
    /// the accurate one catches up (on unless turned off). Read as each
    /// capture starts, so a change applies from the next recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_live_words: Option<bool>,
    /// A finished dictation opens with its words, editable, and the tone row,
    /// instead of only a Pasted stamp (on unless turned off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_result_preview: Option<bool>,
    /// Eavesy says when a Claude Code session finishes or needs you, and sends
    /// the reply you approve back into it (off unless turned on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_voice: Option<bool>,
    /// How long a finished session waits for your reply before it ends its
    /// turn; 0 never waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_hold_secs: Option<u32>,
    /// Eavesy shows and says what agents send through your Eavesy connection
    /// (`send_to_human`, `ask_human`), and sends your typed answer back (off
    /// unless turned on).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_messages: Option<bool>,
}

pub const DEFAULT_AGENT_HOLD_SECS: u32 = 300;
pub const MAX_AGENT_HOLD_SECS: u32 = 1_800;

impl Settings {
    pub fn agent_voice(&self) -> bool {
        self.agent_voice.unwrap_or(false)
    }

    pub fn agent_messages(&self) -> bool {
        self.agent_messages.unwrap_or(false)
    }

    pub fn agent_hold_secs(&self) -> u32 {
        self.agent_hold_secs.unwrap_or(DEFAULT_AGENT_HOLD_SECS).min(MAX_AGENT_HOLD_SECS)
    }

    pub fn segment_sec(&self) -> u32 {
        self.segment_sec
            .unwrap_or(DEFAULT_SEGMENT_SEC)
            .clamp(MIN_SEGMENT_SEC, MAX_SEGMENT_SEC)
    }

    pub fn live_captions(&self) -> bool {
        self.live_captions.unwrap_or(true)
    }

    /// One of the line counts the control is drawn for; anything else reads as off.
    pub fn hud_preview_lines(&self) -> u8 {
        self.hud_preview_lines.filter(|lines| matches!(lines, 0 | 1 | 2 | 4)).unwrap_or(0)
    }

    pub fn hud_result_preview(&self) -> bool {
        self.hud_result_preview.unwrap_or(true)
    }

    pub fn fast_live_words(&self) -> bool {
        self.fast_live_words.unwrap_or(true)
    }

    pub fn add_screenshots(&self) -> bool {
        self.add_screenshots.unwrap_or(true)
    }

    pub fn capture_sounds(&self) -> bool {
        self.capture_sounds.unwrap_or(true)
    }
}

fn new_device_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            toggle_hotkey: DEFAULT_TOGGLE_HOTKEY.to_string(),
            dictation_hotkey: DEFAULT_DICTATION_HOTKEY.to_string(),
            device_id: new_device_id(),
            setup_completed: false,
            recordings_root: None,
            launcher_position: LauncherPosition::default(),
            hud_frame: None,
            hud_hidden: false,
            panel_size: None,
            api_base_url: None,
            segment_sec: None,
            live_captions: None,
            add_screenshots: None,
            capture_sounds: None,
            hud_preview_lines: None,
            hud_translucent: None,
            fast_live_words: None,
            hud_result_preview: None,
            agent_voice: None,
            agent_hold_secs: None,
            agent_messages: None,
        }
    }
}

pub fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("could not resolve app config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Every read and write of settings.json goes through this lock, so a
/// load-modify-save never interleaves with another one and a reader never
/// sees a file another thread is replacing.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The device id from the last file that parsed. A damaged file must never
/// hand out a new one: it names the Keychain item that holds the credential.
static KNOWN_DEVICE_ID: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn known_device_id() -> Option<String> {
    KNOWN_DEVICE_ID.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

fn remember_device_id(id: &str) {
    *KNOWN_DEVICE_ID.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(id.to_string());
}

pub fn load(app: &AppHandle) -> Settings {
    let settings = match settings_path(app) {
        Ok(path) => {
            let _guard = lock();
            load_at(&path, &keychain::System)
        }
        Err(_) => fallback(None, &keychain::System),
    };
    crate::base_url::set_settings_override(settings.api_base_url.as_deref());
    settings
}

/// Loads the settings, lets `change` edit them, and saves the result, all
/// under one lock so concurrent writers never undo each other. `change` must
/// only edit fields: anything that loads settings itself would deadlock.
pub fn update(app: &AppHandle, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let path = settings_path(app)?;
    let settings = {
        let _guard = lock();
        update_at(&path, &keychain::System, change)?
    };
    crate::base_url::set_settings_override(settings.api_base_url.as_deref());
    Ok(settings)
}

/// Defaults for when the file can't be used, keeping the device id whenever
/// one can be found: from the damaged text, this run, or the Keychain.
fn fallback(raw: Option<&str>, keychain: &impl Keychain) -> Settings {
    let mut settings = Settings::default();
    if let Some(id) = salvage_device_id(raw, known_device_id, || keychain.accounts().unwrap_or_default()) {
        settings.device_id = id;
    }
    settings
}

/// The device id a damaged settings file still names, or one known some other
/// way. The Keychain only counts when it holds exactly one Eavesy credential.
fn salvage_device_id(
    raw: Option<&str>,
    known: impl FnOnce() -> Option<String>,
    accounts: impl FnOnce() -> Vec<String>,
) -> Option<String> {
    static DEVICE_ID: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r#""device_id"\s*:\s*"([^"\\]+)""#).unwrap());
    raw.and_then(|raw| DEVICE_ID.captures(raw))
        .map(|found| found[1].to_string())
        .or_else(known)
        .or_else(|| match accounts().as_slice() {
            [only] => Some(only.clone()),
            _ => None,
        })
}

/// Reads the file, assuming the lock is held. A file that is missing gets
/// defaults written; one that doesn't parse is kept as `settings.json.bad`
/// and replaced by defaults with its device id; one that can't be read at
/// all is left alone.
fn load_at(path: &std::path::Path, keychain: &impl Keychain) -> Settings {
    match std::fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(settings) => {
                remember_device_id(&settings.device_id);
                // Written back when serde filled anything in: a device id
                // generated just now must be the one used next time too.
                if serde_json::to_string_pretty(&settings).ok().as_deref() != Some(raw.as_str()) {
                    let _ = save_at(path, &settings);
                }
                settings
            }
            Err(error) => {
                let settings = fallback(Some(&raw), keychain);
                let bad = path.with_extension("json.bad");
                tracing::warn!("settings.json could not be read ({error}); kept it as {}", bad.display());
                if std::fs::rename(path, &bad).is_ok() || !path.exists() {
                    let _ = save_at(path, &settings);
                }
                remember_device_id(&settings.device_id);
                settings
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let settings = fallback(None, keychain);
            let _ = save_at(path, &settings);
            remember_device_id(&settings.device_id);
            settings
        }
        Err(error) => {
            tracing::warn!("settings.json could not be opened ({error}); using defaults without saving");
            fallback(None, keychain)
        }
    }
}

fn update_at(path: &std::path::Path, keychain: &impl Keychain, change: impl FnOnce(&mut Settings)) -> Result<Settings, String> {
    let mut settings = load_at(path, keychain);
    change(&mut settings);
    save_at(path, &settings)?;
    Ok(settings)
}

/// Replaces the file in one step (a temporary file renamed over it), so a
/// reader sees the old settings or the new, never half of either.
fn save_at(path: &std::path::Path, settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("could not serialize settings: {e}"))?;
    crate::fs_writer::atomic_write(path, json.as_bytes()).map_err(|e| format!("could not write settings: {e}"))?;
    remember_device_id(&settings.device_id);
    Ok(())
}

/// Where builds before the Security framework switch stored the credential, using
/// the `security` tool (so that item's access list trusts only the tool).
const LEGACY_TOKEN_SERVICE: &str = "com.eavesy.desktop.device-token";
/// The app-owned item. A different service name lets the new item exist next to
/// the legacy one while migrating, instead of overwriting it in place.
const DEVICE_TOKEN_SERVICE: &str = "com.eavesy.desktop.device-token.v2";

/// The device credential as last read from or written to the Keychain. The sync
/// loop asks for it on every pass; reading the Keychain each time cost a process
/// spawn (and a settings.json read) per iteration.
static TOKEN_CACHE: TokenCache = TokenCache::new();

#[derive(Default)]
struct CacheState {
    /// The last successful read or write: (account, token). A failed read (locked
    /// Keychain, access denied) is never cached, so it is retried next time.
    value: Option<(String, Option<String>)>,
    /// Bumped by every pair/disconnect, so a read that started before one cannot
    /// overwrite what it stored.
    generation: u64,
}

struct TokenCache(std::sync::Mutex<CacheState>);

impl TokenCache {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(CacheState { value: None, generation: 0 }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CacheState> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The cached token, or the result of `load` (which runs without the lock held).
    fn get(&self, load: impl FnOnce() -> Result<(String, Option<String>), String>) -> Option<String> {
        let generation = {
            let state = self.lock();
            if let Some((_, token)) = state.value.as_ref() {
                return token.clone();
            }
            state.generation
        };
        match load() {
            Ok((account, token)) => {
                let mut state = self.lock();
                if state.generation == generation {
                    state.value = Some((account, token.clone()));
                }
                token
            }
            Err(error) => {
                eprintln!("could not read the device credential: {error}");
                None
            }
        }
    }

    fn set(&self, account: &str, token: Option<String>) {
        let mut state = self.lock();
        state.generation += 1;
        state.value = Some((account.to_string(), token));
    }
}

/// Keychain operations, behind a trait so migration can be tested without one.
pub(crate) trait Keychain {
    /// `Ok(None)` when there is no item; `Err` when the Keychain could not answer
    /// (locked, access denied).
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, token: &str) -> Result<(), String>;
    /// Succeeds when there is no item.
    fn delete(&self, account: &str) -> Result<(), String>;
    fn read_legacy(&self, account: &str) -> Legacy;
    /// Succeeds when there is no item.
    fn delete_legacy(&self, account: &str) -> Result<(), String>;
    /// The accounts (device ids) holding an Eavesy credential.
    fn accounts(&self) -> Result<Vec<String>, String>;
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Legacy {
    Found(String),
    NotFound,
    /// The Keychain could not answer; this says nothing about whether an item exists.
    Unavailable(String),
}

/// Reads the credential, moving a legacy item to the app-owned item first if
/// needed. The new item is written and read back before the legacy one is
/// deleted; if that fails the legacy item stays and the token is still returned.
pub(crate) fn load_token(keychain: &impl Keychain, account: &str) -> Result<Option<String>, String> {
    if let Some(token) = keychain.read(account)? {
        return Ok(Some(token));
    }
    let token = match keychain.read_legacy(account) {
        Legacy::NotFound => return Ok(None),
        Legacy::Unavailable(error) => return Err(error),
        Legacy::Found(token) => token,
    };
    let moved = keychain
        .write(account, &token)
        .and_then(|()| match keychain.read(account)? {
            Some(stored) if stored == token => Ok(()),
            _ => Err("the migrated credential did not read back".to_string()),
        });
    match moved {
        Ok(()) => {
            if let Err(error) = keychain.delete_legacy(account) {
                eprintln!("moved the device credential but could not remove the old item: {error}");
            }
        }
        Err(error) => eprintln!("could not move the device credential to an Eavesy-owned item yet: {error}"),
    }
    Ok(Some(token))
}

/// A device token together with the server that issued it. Every request made with
/// the token must go to `base`; never look the base up again separately, or a change
/// of server between the two lookups would send the token to the wrong host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credential {
    pub base: String,
    pub token: String,
}

pub fn device_token(app: &AppHandle) -> Option<String> {
    device_credential(app).map(|c| c.token)
}

pub fn device_credential(app: &AppHandle) -> Option<Credential> {
    #[cfg(debug_assertions)]
    if let Ok(token) = std::env::var("EAVESY_DEVICE_TOKEN") {
        if !token.trim().is_empty() {
            return Some(Credential { base: crate::base_url::api_base(), token });
        }
    }
    let stored = TOKEN_CACHE.get(|| {
        let account = load(app).device_id;
        let stored = load_token(&keychain::System, &account)?;
        Ok((account, stored))
    })?;
    credential_for(&stored, crate::base_url::api_base())
}

/// The credential for `base`, carrying that same base so callers cannot pair the token
/// with a different server.
fn credential_for(stored: &str, base: String) -> Option<Credential> {
    let token = token_for_base(stored, &base)?;
    Some(Credential { base, token })
}

/// The Keychain value is `<base>\n<token>`, so a credential is bound to the server
/// that issued it. A value without a base predates self-hosting and belongs to eavesy.com.
fn bind_token(base: &str, token: &str) -> String {
    format!("{base}\n{token}")
}

fn split_bound(stored: &str) -> (&str, &str) {
    match stored.split_once('\n') {
        Some((base, token)) => (base, token),
        None => (crate::base_url::DEFAULT_BASE, stored),
    }
}

/// The token, but only when it was issued by `current_base`. Never hand a credential
/// to a different server, whatever settings.json says.
fn token_for_base(stored: &str, current_base: &str) -> Option<String> {
    let (bound, token) = split_bound(stored);
    (bound == current_base && !token.is_empty()).then(|| token.to_string())
}

/// Stores the credential bound to `base`, the server that issued it.
pub fn save_device_token(app: &AppHandle, base: &str, token: &str) -> Result<(), String> {
    if token.trim().is_empty() || token.contains('\n') {
        return Err("invalid device token".to_string());
    }
    let account = load(app).device_id;
    let stored = bind_token(base, token);
    keychain::System.write(&account, &stored)?;
    TOKEN_CACHE.set(&account, Some(stored));
    Ok(())
}

pub fn delete_device_token(app: &AppHandle) -> Result<(), String> {
    let account = load(app).device_id;
    keychain::System.delete(&account)?;
    keychain::System.delete_legacy(&account)?;
    TOKEN_CACHE.set(&account, None);
    Ok(())
}

/// Keychain access through the Security framework, so the credential is never
/// passed on a command line (visible to every user in `ps`). Only the legacy item
/// is touched with the `security` tool, and its token only travels over stdout.
#[cfg(target_os = "macos")]
mod keychain {
    use super::{Keychain, Legacy, DEVICE_TOKEN_SERVICE, LEGACY_TOKEN_SERVICE};
    use security_framework::passwords;

    const ITEM_NOT_FOUND: i32 = -25300;
    /// `security` exits with errSecItemNotFound truncated to 44.
    const TOOL_ITEM_NOT_FOUND: i32 = 44;

    pub struct System;

    impl Keychain for System {
        fn read(&self, account: &str) -> Result<Option<String>, String> {
            match passwords::get_generic_password(DEVICE_TOKEN_SERVICE, account) {
                Ok(bytes) => {
                    let token = String::from_utf8(bytes).map_err(|_| "the stored credential is not text".to_string())?;
                    let token = token.trim().to_string();
                    Ok((!token.is_empty()).then_some(token))
                }
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
                Err(error) => Err(format!("Keychain read failed: {error}")),
            }
        }

        fn write(&self, account: &str, token: &str) -> Result<(), String> {
            passwords::set_generic_password(DEVICE_TOKEN_SERVICE, account, token.as_bytes())
                .map_err(|error| format!("could not save the Eavesy device credential in Keychain: {error}"))
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            match passwords::delete_generic_password(DEVICE_TOKEN_SERVICE, account) {
                Ok(()) => Ok(()),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
                Err(error) => Err(format!("could not remove the Eavesy device credential from Keychain: {error}")),
            }
        }

        fn read_legacy(&self, account: &str) -> Legacy {
            let output = match std::process::Command::new("security")
                .args(["find-generic-password", "-s", LEGACY_TOKEN_SERVICE, "-a", account, "-w"])
                .output()
            {
                Ok(output) => output,
                Err(error) => return Legacy::Unavailable(format!("could not run security: {error}")),
            };
            match output.status.code() {
                Some(0) => match String::from_utf8_lossy(&output.stdout).trim() {
                    "" => Legacy::NotFound,
                    token => Legacy::Found(token.to_string()),
                },
                Some(TOOL_ITEM_NOT_FOUND) => Legacy::NotFound,
                status => Legacy::Unavailable(format!(
                    "security exited with {status:?}: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )),
            }
        }

        fn delete_legacy(&self, account: &str) -> Result<(), String> {
            let output = std::process::Command::new("security")
                .args(["delete-generic-password", "-s", LEGACY_TOKEN_SERVICE, "-a", account])
                .output()
                .map_err(|error| format!("could not run security: {error}"))?;
            match output.status.code() {
                Some(0) | Some(TOOL_ITEM_NOT_FOUND) => Ok(()),
                status => Err(format!("security exited with {status:?} removing the old credential")),
            }
        }

        fn accounts(&self) -> Result<Vec<String>, String> {
            use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
            match ItemSearchOptions::new()
                .class(ItemClass::generic_password())
                .service(DEVICE_TOKEN_SERVICE)
                .load_attributes(true)
                .limit(Limit::All)
                .search()
            {
                Ok(found) => Ok(found
                    .iter()
                    .filter_map(|item| item.simplify_dict()?.get("acct").cloned())
                    .filter(|account| !account.is_empty())
                    .collect()),
                Err(error) if error.code() == ITEM_NOT_FOUND => Ok(Vec::new()),
                Err(error) => Err(format!("Keychain search failed: {error}")),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    use super::{Keychain, Legacy};

    pub struct System;

    impl Keychain for System {
        fn read(&self, _account: &str) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn write(&self, _account: &str, _token: &str) -> Result<(), String> {
            Err("the device credential can only be stored on macOS".to_string())
        }
        fn delete(&self, _account: &str) -> Result<(), String> {
            Ok(())
        }
        fn read_legacy(&self, _account: &str) -> Legacy {
            Legacy::NotFound
        }
        fn delete_legacy(&self, _account: &str) -> Result<(), String> {
            Ok(())
        }
        fn accounts(&self) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn segment_length_defaults_to_a_minute_and_respects_the_sidecar_floor() {
        let mut settings = Settings::default();
        assert_eq!(settings.segment_sec(), 60);
        settings.segment_sec = Some(5);
        assert_eq!(settings.segment_sec(), 30);
        settings.segment_sec = Some(240);
        assert_eq!(settings.segment_sec(), 240);
    }

    #[test]
    fn an_unchosen_segment_length_is_not_written_to_disk() {
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(!json.contains("segment_sec"));
        let saved: Settings = serde_json::from_str(r#"{"toggle_hotkey":"a","dictation_hotkey":"b","segment_sec":120}"#).unwrap();
        assert_eq!(saved.segment_sec(), 120);
    }

    #[test]
    fn live_words_are_off_unless_a_line_count_is_chosen() {
        let mut settings = Settings::default();
        assert_eq!(settings.hud_preview_lines(), 0);
        settings.hud_preview_lines = Some(4);
        assert_eq!(settings.hud_preview_lines(), 4);
        settings.hud_preview_lines = Some(3);
        assert_eq!(settings.hud_preview_lines(), 0);
    }

    #[test]
    fn a_finished_dictation_shows_its_words_unless_turned_off() {
        let mut settings = Settings::default();
        assert!(settings.hud_result_preview());
        settings.hud_result_preview = Some(false);
        assert!(!settings.hud_result_preview());
    }

    #[test]
    fn fast_live_words_are_on_unless_turned_off() {
        let mut settings = Settings::default();
        assert!(settings.fast_live_words());
        assert!(!serde_json::to_string(&settings).unwrap().contains("fast_live_words"));
        settings.fast_live_words = Some(false);
        assert!(!settings.fast_live_words());
        let saved: Settings =
            serde_json::from_str(r#"{"toggle_hotkey":"a","dictation_hotkey":"b","fast_live_words":false}"#).unwrap();
        assert!(!saved.fast_live_words());
    }

    #[test]
    fn live_captions_are_on_unless_turned_off() {
        let mut settings = Settings::default();
        assert!(settings.live_captions());
        settings.live_captions = Some(false);
        assert!(!settings.live_captions());
        let saved: Settings = serde_json::from_str(
            r#"{"toggle_hotkey":"Cmd+Shift+Space","dictation_hotkey":"Cmd+Shift+D"}"#,
        )
        .unwrap();
        assert!(saved.live_captions(), "settings saved before this existed");
    }

    #[test]
    fn screenshots_are_added_unless_turned_off() {
        let mut settings = Settings::default();
        assert!(settings.add_screenshots());
        settings.add_screenshots = Some(false);
        assert!(!settings.add_screenshots());
        let saved: Settings = serde_json::from_str(
            r#"{"toggle_hotkey":"a","dictation_hotkey":"b","auto_import_screenshots":false}"#,
        )
        .unwrap();
        assert!(saved.add_screenshots(), "the old off-by-default value");
    }

    #[derive(Default)]
    struct FakeKeychain {
        item: RefCell<Option<String>>,
        legacy: RefCell<Option<String>>,
        locked: bool,
        legacy_locked: bool,
        write_fails: bool,
    }

    impl Keychain for FakeKeychain {
        fn read(&self, _: &str) -> Result<Option<String>, String> {
            if self.locked {
                return Err("locked".into());
            }
            Ok(self.item.borrow().clone())
        }
        fn write(&self, _: &str, token: &str) -> Result<(), String> {
            if self.write_fails {
                return Err("write refused".into());
            }
            *self.item.borrow_mut() = Some(token.to_string());
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            *self.item.borrow_mut() = None;
            Ok(())
        }
        fn read_legacy(&self, _: &str) -> Legacy {
            if self.legacy_locked {
                return Legacy::Unavailable("security exited with Some(51)".into());
            }
            match self.legacy.borrow().clone() {
                Some(token) => Legacy::Found(token),
                None => Legacy::NotFound,
            }
        }
        fn delete_legacy(&self, _: &str) -> Result<(), String> {
            *self.legacy.borrow_mut() = None;
            Ok(())
        }
        fn accounts(&self) -> Result<Vec<String>, String> {
            Ok(self.item.borrow().iter().map(|_| "from-keychain".to_string()).collect())
        }
    }

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("eavesy-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_file_gets_defaults_written() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let settings = load_at(&path, &FakeKeychain::default());
        let saved: Settings = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.device_id, settings.device_id);
        assert_eq!(load_at(&path, &FakeKeychain::default()).device_id, settings.device_id, "stable once written");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_its_device_id_survives() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let damaged = r#"{"toggle_hotkey":"Cmd+K","dictation_hotkey":"Cmd+D","device_id":"keep-me","hud_fra"#;
        std::fs::write(&path, damaged).unwrap();
        let settings = load_at(&path, &FakeKeychain::default());
        assert_eq!(settings.device_id, "keep-me");
        assert_eq!(std::fs::read_to_string(dir.join("settings.json.bad")).unwrap(), damaged);
        let saved: Settings = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.device_id, "keep-me");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_empty_file_keeps_a_device_id_known_some_other_way() {
        assert_eq!(salvage_device_id(Some(""), || Some("known".into()), Vec::new), Some("known".into()));
        assert_eq!(salvage_device_id(Some(""), || None, || vec!["only".into()]), Some("only".into()));
        // Two credentials: no way to tell which is this Mac's.
        assert_eq!(salvage_device_id(None, || None, || vec!["a".into(), "b".into()]), None);
        assert_eq!(
            salvage_device_id(Some(r#"{"device_id": "from-file"}"#), || Some("known".into()), Vec::new),
            Some("from-file".into())
        );
        let keychain = FakeKeychain { item: RefCell::new(Some("token".into())), ..Default::default() };
        assert_eq!(salvage_device_id(Some("{"), || None, || keychain.accounts().unwrap()), Some("from-keychain".into()));
    }

    #[test]
    fn concurrent_updates_never_lose_each_other() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let threads: Vec<_> = (0..8u8)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        let _guard = lock();
                        update_at(&path, &FakeKeychain::default(), |settings| match n {
                            0 => settings.live_captions = Some(false),
                            1 => settings.capture_sounds = Some(false),
                            2 => settings.hud_hidden = true,
                            3 => settings.setup_completed = true,
                            4 => settings.add_screenshots = Some(false),
                            5 => settings.fast_live_words = Some(false),
                            6 => settings.hud_result_preview = Some(false),
                            _ => settings.hud_preview_lines = Some(2),
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let saved: Settings = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved.live_captions, Some(false));
        assert_eq!(saved.capture_sounds, Some(false));
        assert!(saved.hud_hidden && saved.setup_completed);
        assert_eq!(saved.add_screenshots, Some(false));
        assert_eq!(saved.fast_live_words, Some(false));
        assert_eq!(saved.hud_result_preview, Some(false));
        assert_eq!(saved.hud_preview_lines, Some(2));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn legacy(token: &str) -> FakeKeychain {
        FakeKeychain { legacy: RefCell::new(Some(token.into())), ..Default::default() }
    }

    #[test]
    fn a_legacy_credential_is_moved_to_the_app_owned_item() {
        let keychain = legacy("old");
        assert_eq!(load_token(&keychain, "device"), Ok(Some("old".into())));
        assert_eq!(*keychain.item.borrow(), Some("old".into()));
        assert_eq!(*keychain.legacy.borrow(), None, "removed only after the new item reads back");
    }

    #[test]
    fn no_credential_anywhere_reads_as_unpaired() {
        assert_eq!(load_token(&FakeKeychain::default(), "device"), Ok(None));
    }

    #[test]
    fn a_locked_keychain_is_an_error_not_unpaired() {
        let keychain = FakeKeychain { legacy_locked: true, ..Default::default() };
        assert!(load_token(&keychain, "device").is_err());
        let keychain = FakeKeychain { locked: true, ..legacy("old") };
        assert!(load_token(&keychain, "device").is_err());
        assert_eq!(*keychain.legacy.borrow(), Some("old".into()));
    }

    #[test]
    fn a_failed_migration_keeps_the_old_item_and_the_token() {
        let keychain = FakeKeychain { write_fails: true, ..legacy("old") };
        assert_eq!(load_token(&keychain, "device"), Ok(Some("old".into())));
        assert_eq!(*keychain.legacy.borrow(), Some("old".into()));
    }

    #[test]
    fn the_app_owned_item_is_used_without_touching_the_legacy_one() {
        let keychain = FakeKeychain { item: RefCell::new(Some("new".into())), legacy_locked: true, ..Default::default() };
        assert_eq!(load_token(&keychain, "device"), Ok(Some("new".into())));
    }

    #[test]
    fn the_credential_is_read_from_the_keychain_once() {
        let cache = TokenCache::new();
        let reads = std::cell::Cell::new(0);
        for _ in 0..5 {
            let token = cache.get(|| {
                reads.set(reads.get() + 1);
                Ok(("device".into(), Some("token".into())))
            });
            assert_eq!(token, Some("token".into()));
        }
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn a_failed_read_is_not_cached() {
        let cache = TokenCache::new();
        assert_eq!(cache.get(|| Err("locked".into())), None);
        assert_eq!(cache.get(|| Ok(("device".into(), Some("token".into())))), Some("token".into()));
    }

    #[test]
    fn pairing_and_disconnecting_update_the_cached_credential() {
        let cache = TokenCache::new();
        let never = || -> Result<(String, Option<String>), String> { panic!("cached state should be used") };
        assert_eq!(cache.get(|| Ok(("device".into(), None))), None);
        cache.set("device", Some("new".into()));
        assert_eq!(cache.get(never), Some("new".into()));
        cache.set("device", None);
        assert_eq!(cache.get(never), None);
    }

    #[test]
    fn pairing_during_a_read_is_not_overwritten_by_it() {
        let cache = TokenCache::new();
        let token = cache.get(|| {
            cache.set("device", Some("paired".into()));
            Ok(("device".into(), None))
        });
        assert_eq!(token, None);
        assert_eq!(cache.get(|| panic!("cached")), Some("paired".into()));
    }

    #[test]
    fn a_token_is_only_released_to_the_server_that_issued_it() {
        let stored = bind_token("https://eavesy.example.com", "tok");
        assert_eq!(token_for_base(&stored, "https://eavesy.example.com"), Some("tok".into()));
        assert_eq!(token_for_base(&stored, "https://eavesy.com"), None);
        assert_eq!(token_for_base(&stored, "https://evil.example"), None);
    }

    #[test]
    fn a_legacy_unbound_token_belongs_to_eavesy_com() {
        assert_eq!(token_for_base("legacy", "https://eavesy.com"), Some("legacy".into()));
        assert_eq!(token_for_base("legacy", "https://evil.example"), None);
    }

    #[test]
    fn a_credential_always_names_the_server_it_may_be_sent_to() {
        let stored = bind_token("https://new.example", "tok");
        // Paired to the new server while a long-lived client still points at the old one.
        assert_eq!(credential_for(&stored, "https://old.example".into()), None);
        assert_eq!(
            credential_for(&stored, "https://new.example".into()),
            Some(Credential { base: "https://new.example".into(), token: "tok".into() })
        );
    }
}
