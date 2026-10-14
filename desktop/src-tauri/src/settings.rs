use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_TOGGLE_HOTKEY: &str = "Cmd+Shift+Space";
pub const DEFAULT_DICTATION_HOTKEY: &str = "Cmd+Shift+D";

// Variant names are persisted as snake_case settings values; renaming would break saved settings.
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherPosition {
    TopLeft,
    TopRight,
    #[default]
    TopCenter,
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

pub fn load(app: &AppHandle) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };

    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(settings) => {
                if serde_json::to_string_pretty(&settings).ok().as_deref() != Some(raw.as_str()) {
                    let _ = save(app, &settings);
                }
                settings
            }
            Err(_) => {
                let defaults = Settings::default();
                let _ = save(app, &defaults);
                defaults
            }
        },
        Err(_) => {
            let defaults = Settings::default();
            let _ = save(app, &defaults);
            defaults
        }
    }
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

pub fn device_token(app: &AppHandle) -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(token) = std::env::var("EAVESY_DEVICE_TOKEN") {
        if !token.trim().is_empty() {
            return Some(token);
        }
    }
    TOKEN_CACHE.get(|| {
        let account = load(app).device_id;
        let token = load_token(&keychain::System, &account)?;
        Ok((account, token))
    })
}

pub fn save_device_token(app: &AppHandle, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("device token cannot be empty".to_string());
    }
    let account = load(app).device_id;
    keychain::System.write(&account, token)?;
    TOKEN_CACHE.set(&account, Some(token.to_string()));
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
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create config dir: {e}"))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("could not serialize settings: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("could not write settings: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

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
}
