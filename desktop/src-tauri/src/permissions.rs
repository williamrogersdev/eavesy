//! macOS privacy permissions beyond what the capture sidecar checks: Accessibility, Input
//! Monitoring and Notifications, a per-permission status that tells "never asked" from "denied",
//! and one command per permission that asks for it alone, behind
//! [`crate::panel::yield_for_system_prompt`] so the prompt can be clicked.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::audio::Permissions;

/// Where a permission stands. macOS can't always say whether it has asked: Accessibility and
/// Screen Recording only report granted or not, so those are `NotGranted` until granted.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    Granted,
    Denied,
    /// Never asked: requesting it shows the macOS prompt.
    NotDetermined,
    /// Blocked by a device-management profile or parental controls.
    Restricted,
    /// Not granted, and macOS doesn't say whether it was asked.
    #[default]
    NotGranted,
}

impl PermissionStatus {
    pub fn from_flag(granted: bool) -> Self {
        if granted { Self::Granted } else { Self::NotGranted }
    }

    /// Reads the sidecar's `micStatus` / `speechStatus`, falling back to the plain flag for an
    /// older sidecar that doesn't send one.
    pub fn from_sidecar(status: Option<&str>, granted: bool) -> Self {
        match status {
            Some("granted") => Self::Granted,
            Some("denied") => Self::Denied,
            Some("notDetermined") => Self::NotDetermined,
            Some("restricted") => Self::Restricted,
            _ => Self::from_flag(granted),
        }
    }

    /// `IOHIDCheckAccess`: 0 granted, 1 denied, 2 unknown (never asked).
    pub fn from_hid_access(access: u32) -> Self {
        match access {
            0 => Self::Granted,
            1 => Self::Denied,
            _ => Self::NotDetermined,
        }
    }

    /// `UNAuthorizationStatus`: 0 not determined, 1 denied, 2 authorized, 3 provisional,
    /// 4 ephemeral.
    pub fn from_notification_status(status: isize) -> Self {
        match status {
            0 => Self::NotDetermined,
            1 => Self::Denied,
            2..=4 => Self::Granted,
            _ => Self::NotGranted,
        }
    }

    pub fn granted(self) -> bool {
        self == Self::Granted
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatuses {
    pub mic: PermissionStatus,
    pub speech: PermissionStatus,
    pub screen: PermissionStatus,
    pub accessibility: PermissionStatus,
    pub input_monitoring: PermissionStatus,
    pub notifications: PermissionStatus,
}

/// Fills in the permissions the sidecar can't see, and every status.
pub fn complete(permissions: &mut Permissions, mic_status: Option<&str>, speech_status: Option<&str>) {
    let accessibility = accessibility_granted();
    let input_monitoring = input_monitoring_status();
    let notifications = notification_status();
    permissions.accessibility = accessibility;
    permissions.input_monitoring = input_monitoring.granted();
    permissions.notifications = notifications.granted();
    permissions.status = PermissionStatuses {
        mic: PermissionStatus::from_sidecar(mic_status, permissions.mic),
        speech: PermissionStatus::from_sidecar(speech_status, permissions.speech),
        screen: PermissionStatus::from_flag(permissions.screen),
        accessibility: PermissionStatus::from_flag(accessibility),
        input_monitoring,
        notifications,
    };
    // A sidecar run that asked for the microphone reports `mic` from the answer, which can arrive
    // before the status settles. Only an unsettled status yields to it.
    if permissions.mic && matches!(permissions.status.mic, PermissionStatus::NotDetermined | PermissionStatus::NotGranted) {
        permissions.status.mic = PermissionStatus::Granted;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Microphone,
    Speech,
    Screen,
}

impl Request {
    pub fn sidecar_arg(self) -> &'static str {
        match self {
            Request::Microphone => "mic",
            Request::Speech => "speech",
            Request::Screen => "screen",
        }
    }
}

/// Asks for the microphone alone. Returns every permission afterwards.
#[tauri::command(async)]
pub fn request_microphone(app: AppHandle) -> Result<Permissions, String> {
    crate::audio::request_permission(app, Request::Microphone)
}

/// Asks for Speech Recognition alone (live captions and the dictation paste).
#[tauri::command(async)]
pub fn request_speech(app: AppHandle) -> Result<Permissions, String> {
    crate::audio::request_permission(app, Request::Speech)
}

/// Asks for Screen & System Audio Recording alone.
#[tauri::command(async)]
pub fn request_screen(app: AppHandle) -> Result<Permissions, String> {
    crate::audio::request_permission(app, Request::Screen)
}

/// Shows the Accessibility prompt ("Eavesy would like to control this computer"), which offers
/// to open System Settings. Returns whether Accessibility is already granted.
#[tauri::command(async)]
pub fn request_accessibility(app: AppHandle) -> bool {
    if accessibility_granted() {
        return true;
    }
    crate::panel::yield_while_prompt_shows(&app, accessibility_granted);
    imp::prompt_accessibility()
}

/// Shows the Input Monitoring prompt (needed for the Fn / Globe shortcut). macOS applies a new
/// grant only after Eavesy relaunches; see `relaunch_app`. Returns the status now.
#[tauri::command(async)]
pub fn request_input_monitoring(app: AppHandle) -> PermissionStatus {
    request_input_monitoring_inner(&app)
}

pub fn request_input_monitoring_inner(app: &AppHandle) -> PermissionStatus {
    let status = input_monitoring_status();
    if status.granted() {
        return status;
    }
    crate::panel::yield_while_prompt_shows(app, || input_monitoring_status().granted());
    imp::request_input_monitoring();
    input_monitoring_status()
}

/// Asks to show notifications. Returns the status after the user answers (or after two minutes).
#[tauri::command]
pub async fn request_notifications(app: AppHandle) -> PermissionStatus {
    use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
    let status = imp::fetch_notification_status(FRESH);
    if status != PermissionStatus::NotDetermined {
        return status;
    }
    // Stepped aside only while the prompt is likely on screen, not for the whole wait.
    let answered_flag = Arc::new(AtomicBool::new(false));
    let flag = answered_flag.clone();
    crate::panel::yield_while_prompt_shows(&app, move || flag.load(Ordering::SeqCst));
    let (done, answered) = tokio::sync::oneshot::channel();
    imp::request_notifications(Box::new(move || {
        answered_flag.store(true, Ordering::SeqCst);
        let _ = done.send(());
    }));
    let _ = tokio::time::timeout(std::time::Duration::from_secs(120), answered).await;
    imp::fetch_notification_status(FRESH)
}

/// How long a caller that needs the current answer waits for macOS before using the last one.
const FRESH: std::time::Duration = std::time::Duration::from_secs(2);

pub fn accessibility_granted() -> bool {
    imp::accessibility_granted()
}

pub fn input_monitoring_status() -> PermissionStatus {
    imp::input_monitoring_status()
}

/// The notification status, without blocking a permission refresh on macOS: returns the last
/// answer and refreshes it in the background, waiting briefly only before the first answer.
pub fn notification_status() -> PermissionStatus {
    imp::fetch_notification_status(std::time::Duration::ZERO)
}

/// The System Settings anchor for each pane `open_privacy_settings` accepts.
pub fn privacy_anchor(pane: &str) -> Option<&'static str> {
    Some(match pane {
        "microphone" => "Privacy_Microphone",
        "screen" => "Privacy_ScreenCapture",
        "accessibility" => "Privacy_Accessibility",
        "speech" => "Privacy_SpeechRecognition",
        "input_monitoring" => "Privacy_ListenEvent",
        "automation" => "Privacy_Automation",
        _ => return None,
    })
}

/// Notifications live outside Privacy & Security.
pub const NOTIFICATIONS_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

#[cfg(target_os = "macos")]
mod imp {
    use super::PermissionStatus;
    use crate::cf::*;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::time::Duration;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
        fn CGRequestListenEventAccess() -> bool;
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(
            allocator: CFTypeRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CFTypeRef;
    }

    const LISTEN_EVENT: u32 = 1;

    pub fn accessibility_granted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    pub fn prompt_accessibility() -> bool {
        unsafe {
            let keys = [kAXTrustedCheckOptionPrompt];
            let values = [kCFBooleanTrue];
            let options = Owned(CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            ));
            AXIsProcessTrustedWithOptions(options.0)
        }
    }

    pub fn input_monitoring_status() -> PermissionStatus {
        PermissionStatus::from_hid_access(unsafe { IOHIDCheckAccess(LISTEN_EVENT) })
    }

    pub fn request_input_monitoring() {
        unsafe {
            CGRequestListenEventAccess();
        }
    }

    /// `UNUserNotificationCenter` throws when the process isn't an app bundle (`cargo run`,
    /// tests), so outside one notifications count as not granted and are never requested.
    fn in_app_bundle() -> bool {
        use objc2_foundation::NSBundle;
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    /// Last answer from macOS: `u8::MAX` until the first one arrives.
    static CACHED: AtomicU8 = AtomicU8::new(u8::MAX);
    const FIRST_ANSWER: Duration = Duration::from_millis(500);

    fn cached() -> Option<PermissionStatus> {
        match CACHED.load(Ordering::SeqCst) {
            u8::MAX => None,
            raw => Some(PermissionStatus::from_notification_status(raw as isize)),
        }
    }

    /// Asks macOS for the status and waits up to `wait` for this answer (`FIRST_ANSWER` when
    /// there is no earlier one), otherwise returns the last known status.
    pub fn fetch_notification_status(wait: Duration) -> PermissionStatus {
        use block2::RcBlock;
        use objc2_user_notifications::{UNNotificationSettings, UNUserNotificationCenter};
        use std::ptr::NonNull;

        if !in_app_bundle() {
            return PermissionStatus::NotGranted;
        }
        let wait = if cached().is_none() { wait.max(FIRST_ANSWER) } else { wait };
        let (send, receive) = std::sync::mpsc::channel();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let status = unsafe { settings.as_ref() }.authorizationStatus().0;
            CACHED.store(status.clamp(0, u8::MAX as isize - 1) as u8, Ordering::SeqCst);
            let _ = send.send(());
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
        if !wait.is_zero() {
            let _ = receive.recv_timeout(wait);
        }
        cached().unwrap_or(PermissionStatus::NotGranted)
    }

    pub fn request_notifications(answered: Box<dyn FnOnce() + Send>) {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::NSError;
        use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
        use std::sync::Mutex;

        if !in_app_bundle() {
            answered();
            return;
        }
        let answered = Mutex::new(Some(answered));
        let block = RcBlock::new(move |_granted: Bool, _error: *mut NSError| {
            if let Some(answered) = answered.lock().ok().and_then(|mut answered| answered.take()) {
                answered();
            }
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
            &block,
        );
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::PermissionStatus;
    pub fn accessibility_granted() -> bool {
        true
    }
    pub fn prompt_accessibility() -> bool {
        true
    }
    pub fn input_monitoring_status() -> PermissionStatus {
        PermissionStatus::Granted
    }
    pub fn request_input_monitoring() {}
    pub fn fetch_notification_status(_wait: std::time::Duration) -> PermissionStatus {
        PermissionStatus::Granted
    }
    pub fn request_notifications(answered: Box<dyn FnOnce() + Send>) {
        answered();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_statuses_tell_never_asked_from_denied() {
        assert_eq!(PermissionStatus::from_sidecar(Some("notDetermined"), false), PermissionStatus::NotDetermined);
        assert_eq!(PermissionStatus::from_sidecar(Some("denied"), false), PermissionStatus::Denied);
        assert_eq!(PermissionStatus::from_sidecar(Some("restricted"), false), PermissionStatus::Restricted);
        assert_eq!(PermissionStatus::from_sidecar(None, true), PermissionStatus::Granted);
        assert_eq!(PermissionStatus::from_sidecar(None, false), PermissionStatus::NotGranted);
    }

    #[test]
    fn system_codes_map_to_statuses() {
        assert_eq!(PermissionStatus::from_hid_access(0), PermissionStatus::Granted);
        assert_eq!(PermissionStatus::from_hid_access(1), PermissionStatus::Denied);
        assert_eq!(PermissionStatus::from_hid_access(2), PermissionStatus::NotDetermined);
        assert_eq!(PermissionStatus::from_notification_status(0), PermissionStatus::NotDetermined);
        assert_eq!(PermissionStatus::from_notification_status(1), PermissionStatus::Denied);
        assert_eq!(PermissionStatus::from_notification_status(3), PermissionStatus::Granted);
    }

    #[test]
    fn statuses_serialize_for_the_bridge() {
        let json = serde_json::to_value(PermissionStatuses::default()).unwrap();
        assert_eq!(json["inputMonitoring"], "notGranted");
        assert_eq!(serde_json::to_value(PermissionStatus::NotDetermined).unwrap(), "notDetermined");
    }

    #[test]
    fn privacy_panes_include_input_monitoring_and_automation() {
        assert_eq!(privacy_anchor("input_monitoring"), Some("Privacy_ListenEvent"));
        assert_eq!(privacy_anchor("automation"), Some("Privacy_Automation"));
        assert_eq!(privacy_anchor("speech"), Some("Privacy_SpeechRecognition"));
        assert_eq!(privacy_anchor("camera"), None);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn notifications_outside_an_app_bundle_are_not_granted_and_never_crash() {
        assert_eq!(notification_status(), PermissionStatus::NotGranted);
    }

    #[test]
    fn requests_map_to_one_sidecar_flag_each() {
        assert_eq!(Request::Microphone.sidecar_arg(), "mic");
        assert_eq!(Request::Speech.sidecar_arg(), "speech");
        assert_eq!(Request::Screen.sidecar_arg(), "screen");
    }
}
