//! A short sound as the mic goes live and as it stops, so a recording is
//! never a guess. macOS system sounds, quiet, and off in Settings.

use tauri::AppHandle;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cue {
    Start,
    Stop,
}

impl Cue {
    fn name(self) -> &'static str {
        match self {
            Cue::Start => "Tink",
            Cue::Stop => "Pop",
        }
    }
}

/// The cue for a HUD change, if any: into recording, or out of it to a stop.
pub fn cue_for(was_recording: bool, now_recording: bool, failed: bool) -> Option<Cue> {
    match (was_recording, now_recording) {
        (false, true) => Some(Cue::Start),
        (true, false) if !failed => Some(Cue::Stop),
        _ => None,
    }
}

pub fn play(app: &AppHandle, cue: Cue) {
    if !crate::settings::load(app).capture_sounds() {
        return;
    }
    let _ = app.run_on_main_thread(move || imp::play(cue.name()));
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
mod imp {
    use tauri_nspanel::{
        cocoa::{base::{id, nil}, foundation::NSString},
        objc::{class, msg_send, sel, sel_impl},
    };

    const VOLUME: f32 = 0.35;

    pub fn play(name: &str) {
        unsafe {
            let name = NSString::alloc(nil).init_str(name);
            let sound: id = msg_send![class!(NSSound), soundNamed: name];
            if sound == nil {
                return;
            }
            let _: () = msg_send![sound, stop];
            let _: () = msg_send![sound, setVolume: VOLUME];
            let _: bool = msg_send![sound, play];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn play(_name: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sounds_only_mark_the_mic_going_live_and_a_real_stop() {
        assert_eq!(cue_for(false, true, false), Some(Cue::Start));
        assert_eq!(cue_for(true, false, false), Some(Cue::Stop));
        assert_eq!(cue_for(true, false, true), None);
        assert_eq!(cue_for(true, true, false), None);
        assert_eq!(cue_for(false, false, false), None);
    }
}
