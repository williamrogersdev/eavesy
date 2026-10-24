//! How Eavesy talks (assistant.md G4 and G5): a style, two dials and the spoken
//! voice. The style crosses to the server only as these fixed values, which pick
//! prompt text the server owns, so a settings file can't carry instructions.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

use crate::agents::speak;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    Plain,
    #[default]
    Eavesy,
    More,
}

/// Less, the default, or more of something.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dial {
    Less,
    #[default]
    Default,
    More,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Style {
    #[serde(default)]
    pub preset: Preset,
    #[serde(default)]
    pub chattiness: Dial,
    #[serde(default)]
    pub warmth: Dial,
}

/// What Eavesy says when you try a voice: the style's own voice, as the spec has it.
const SAMPLE: &str = "Two dev servers outlived their sessions. Want me to show them out?";

#[tauri::command(async)]
pub fn set_assistant_style(app: AppHandle, window: WebviewWindow, style: Style) -> Result<(), String> {
    super::from_ui(&window)?;
    crate::settings::update(&app, |config| config.assistant_style = Some(style)).map(drop)
}

/// The voices this Mac has, for the picker.
#[tauri::command(async)]
pub fn assistant_voices(window: WebviewWindow) -> Result<Vec<speak::VoiceInfo>, String> {
    super::from_ui(&window)?;
    Ok(speak::voices().to_vec())
}

/// `name` none is the voice chosen in System Settings; `rate` none is its speed.
/// Says a line in the new voice so you hear what you picked.
#[tauri::command(async)]
pub fn set_assistant_voice(app: AppHandle, window: WebviewWindow, name: Option<String>, rate: Option<u16>) -> Result<(), String> {
    super::from_ui(&window)?;
    let voice = speak::Voice::checked(name, rate)?;
    crate::settings::update(&app, |config| {
        config.assistant_voice = voice.name.clone();
        config.assistant_voice_rate = voice.rate;
    })?;
    speak::say(SAMPLE);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_reads_partial_and_old_settings_as_the_default() {
        assert_eq!(serde_json::from_str::<Style>("{}").unwrap(), Style::default());
        let plain: Style = serde_json::from_str(r#"{"preset":"plain","warmth":"more"}"#).unwrap();
        assert_eq!(plain, Style { preset: Preset::Plain, chattiness: Dial::Default, warmth: Dial::More });
        assert!(serde_json::from_str::<Style>(r#"{"preset":"unhinged"}"#).is_err());
        assert_eq!(serde_json::to_value(Style::default()).unwrap(), serde_json::json!({"preset":"eavesy","chattiness":"default","warmth":"default"}));
    }
}
