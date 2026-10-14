use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const DEFAULT_TOGGLE_HOTKEY: &str = "Cmd+Shift+Space";
pub const DEFAULT_DICTATION_HOTKEY: &str = "Cmd+Shift+D";

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
    /// Self-hosting: origin of your own Eavesy server (e.g. `https://eavesy.example.com`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_base_url: Option<String>,
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
    let settings = load_unapplied(app);
    crate::base_url::set_settings_override(settings.api_base_url.as_deref());
    settings
}

fn load_unapplied(app: &AppHandle) -> Settings {
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

pub fn device_token(app: &AppHandle) -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(token) = std::env::var("EAVESY_DEVICE_TOKEN") {
        if !token.trim().is_empty() {
            return Some(token);
        }
    }
    let account = load(app).device_id;
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            DEVICE_TOKEN_SERVICE,
            "-a",
            &account,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!token.is_empty()).then_some(token)
}

pub fn save_device_token(app: &AppHandle, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("device token cannot be empty".to_string());
    }
    let account = load(app).device_id;
    let status = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            DEVICE_TOKEN_SERVICE,
            "-a",
            &account,
            "-w",
            token,
        ])
        .status()
        .map_err(|e| format!("could not open Keychain: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("could not save the Eavesy device credential in Keychain".to_string())
    }
}

pub fn delete_device_token(app: &AppHandle) -> Result<(), String> {
    let account = load(app).device_id;
    let output = std::process::Command::new("security")
        .args(["delete-generic-password", "-s", DEVICE_TOKEN_SERVICE, "-a", &account])
        .output()
        .map_err(|e| format!("could not open Keychain: {e}"))?;
    if output.status.success() || output.status.code() == Some(44) {
        Ok(())
    } else {
        Err("could not remove the Eavesy device credential from Keychain".to_string())
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
