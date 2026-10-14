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

const DEVICE_TOKEN_SERVICE: &str = "com.eavesy.desktop.device-token";

/// The device credential as last read from or written to the Keychain. The sync
/// loop asks for it on every pass; reading the Keychain each time cost a process
/// spawn (and settings.json read) per iteration.
static TOKEN_CACHE: TokenCache = TokenCache::new();

struct TokenCache(std::sync::Mutex<Option<(String, Option<String>)>>);

impl TokenCache {
    const fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }

    fn get(&self, account: impl FnOnce() -> String, read: impl FnOnce(&str) -> Option<String>) -> Option<String> {
        let mut cached = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((_, token)) = cached.as_ref() {
            return token.clone();
        }
        let account = account();
        let token = read(&account);
        *cached = Some((account, token.clone()));
        token
    }

    fn set(&self, account: &str, token: Option<String>) {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((account.to_string(), token));
    }
}

pub fn device_token(app: &AppHandle) -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(token) = std::env::var("EAVESY_DEVICE_TOKEN") {
        if !token.trim().is_empty() {
            return Some(token);
        }
    }
    TOKEN_CACHE.get(|| load(app).device_id, |account| keychain::read(account).unwrap_or_else(|error| {
        eprintln!("could not read the device credential: {error}");
        None
    }))
}

pub fn save_device_token(app: &AppHandle, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("device token cannot be empty".to_string());
    }
    let account = load(app).device_id;
    keychain::write(&account, token)?;
    TOKEN_CACHE.set(&account, Some(token.to_string()));
    Ok(())
}

pub fn delete_device_token(app: &AppHandle) -> Result<(), String> {
    let account = load(app).device_id;
    keychain::delete(&account)?;
    TOKEN_CACHE.set(&account, None);
    Ok(())
}

/// Keychain access through the Security framework, so the credential is never
/// passed on a command line (visible to every user in `ps`).
#[cfg(target_os = "macos")]
mod keychain {
    use super::DEVICE_TOKEN_SERVICE;
    use security_framework::passwords;

    const ITEM_NOT_FOUND: i32 = -25300;

    pub fn read(account: &str) -> Result<Option<String>, String> {
        migrate_legacy_item(account);
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

    pub fn write(account: &str, token: &str) -> Result<(), String> {
        passwords::set_generic_password(DEVICE_TOKEN_SERVICE, account, token.as_bytes())
            .map_err(|error| format!("could not save the Eavesy device credential in Keychain: {error}"))
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match passwords::delete_generic_password(DEVICE_TOKEN_SERVICE, account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!("could not remove the Eavesy device credential from Keychain: {error}")),
        }
    }

    /// Builds before this one stored the credential with the `security` tool, so
    /// the item's access list trusts only that tool and a direct read would show a
    /// Keychain prompt. Re-create it as this app's own item once. The token only
    /// travels over the tool's stdout, never its arguments.
    fn migrate_legacy_item(account: &str) {
        let marker = legacy_marker(account);
        if marker.as_ref().is_some_and(|marker| marker.exists()) {
            return;
        }
        let legacy = std::process::Command::new("security")
            .args(["find-generic-password", "-s", DEVICE_TOKEN_SERVICE, "-a", account, "-w"])
            .output();
        if let Some(output) = legacy.ok().filter(|output| output.status.success()) {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let deleted = std::process::Command::new("security")
                .args(["delete-generic-password", "-s", DEVICE_TOKEN_SERVICE, "-a", account])
                .output()
                .is_ok_and(|output| output.status.success());
            if token.is_empty() || !deleted {
                eprintln!("could not move the device credential to a Keychain item owned by Eavesy");
                return;
            }
            if let Err(error) = write(account, &token) {
                eprintln!("{error}");
                return;
            }
        }
        if let Some(marker) = marker {
            if let Err(error) = std::fs::write(&marker, b"") {
                eprintln!("could not record the Keychain migration: {error}");
            }
        }
    }

    fn legacy_marker(account: &str) -> Option<std::path::PathBuf> {
        let dir = dirs::data_dir()?.join("com.eavesy.desktop");
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir.join(format!(".keychain-migrated-{account}")))
    }
}

#[cfg(not(target_os = "macos"))]
mod keychain {
    pub fn read(_account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn write(_account: &str, _token: &str) -> Result<(), String> {
        Err("the device credential can only be stored on macOS".to_string())
    }
    pub fn delete(_account: &str) -> Result<(), String> {
        Ok(())
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
    use std::cell::Cell;

    #[test]
    fn the_credential_is_read_from_the_keychain_once() {
        let cache = TokenCache::new();
        let reads = Cell::new(0);
        let read = |_: &str| {
            reads.set(reads.get() + 1);
            Some("token".to_string())
        };
        for _ in 0..5 {
            assert_eq!(cache.get(|| "device".to_string(), read), Some("token".to_string()));
        }
        assert_eq!(reads.get(), 1);
    }

    #[test]
    fn pairing_and_disconnecting_update_the_cached_credential() {
        let cache = TokenCache::new();
        let never = |_: &str| -> Option<String> { panic!("cached state should be used") };
        assert_eq!(cache.get(|| "device".to_string(), |_| None), None);
        cache.set("device", Some("new".to_string()));
        assert_eq!(cache.get(|| "device".to_string(), never), Some("new".to_string()));
        cache.set("device", None);
        assert_eq!(cache.get(|| "device".to_string(), never), None);
    }
}
