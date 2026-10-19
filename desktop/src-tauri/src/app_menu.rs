//! Eavesy's identity as a macOS app: the menu bar (Eavesy, Edit, Capture, View, Window and
//! Help) and when Eavesy is the active app.
//!
//! Eavesy keeps the default Regular activation policy: it has a Dock icon (clicking it reopens
//! the launcher through `RunEvent::Reopen`) and a real menu bar whenever it is active. The
//! launcher and the HUD stay non-activating panels, so the HUD never takes focus. Showing the
//! launcher calls [`activate`], which makes Eavesy the active app so the menu bar says Eavesy and
//! ⌘C/⌘V/⌘A/⌘Z/⌘, work in its inputs; hiding it calls [`return_focus`], which hands focus back to
//! the app that was in front before, so pasting into that app still works.

use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle,
};

pub const ABOUT: &str = "app_about";
pub const CHECK_FOR_UPDATES: &str = "app_check_for_updates";
pub const SETTINGS: &str = "app_settings";
pub const RECORD: &str = "app_record";
pub const SHOW_RECORDINGS: &str = "app_show_recordings";
pub const OPEN_WEB_APP: &str = "app_open_web_app";
pub const SHOW_CONTROL: &str = "app_show_control";
pub const HIDE_CONTROL: &str = "app_hide_control";
pub const HELP: &str = "app_help";
pub const WHATS_NEW: &str = "app_whats_new";
pub const CONTACT: &str = "app_contact";
pub const SETUP: &str = "app_setup";
pub const COPY_DIAGNOSTICS: &str = "app_copy_diagnostics";
const WINDOW_MENU: &str = "app_window_menu";
const HELP_MENU: &str = "app_help_menu";

pub fn version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let separator = || PredefinedMenuItem::separator(app);
    let about = MenuItem::with_id(app, ABOUT, "About Eavesy", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?;
    let eavesy = Submenu::with_items(
        app,
        "Eavesy",
        true,
        &[
            &about,
            &updates,
            &separator()?,
            &settings,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some("Hide Eavesy"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, Some("Quit Eavesy"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    // The recording and launcher shortcuts are global hotkeys, so they stay off these items:
    // as menu key equivalents they would fire a second time while Eavesy is active.
    let capture = Submenu::with_items(
        app,
        "Capture",
        true,
        &[
            &MenuItem::with_id(app, RECORD, "Start or Stop Recording", true, None::<&str>)?,
            &separator()?,
            &MenuItem::with_id(app, SHOW_RECORDINGS, "Show Recordings", true, None::<&str>)?,
            &MenuItem::with_id(app, OPEN_WEB_APP, "Open Eavesy on the Web", true, None::<&str>)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, SHOW_CONTROL, "Show Capture Control", true, None::<&str>)?,
            &MenuItem::with_id(app, HIDE_CONTROL, "Hide Capture Control", true, None::<&str>)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_MENU,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &separator()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let help = Submenu::with_id_and_items(
        app,
        HELP_MENU,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, HELP, "Eavesy Help", true, None::<&str>)?,
            &MenuItem::with_id(app, WHATS_NEW, "What’s New in Eavesy", true, None::<&str>)?,
            &MenuItem::with_id(app, CONTACT, "Contact Support", true, None::<&str>)?,
            &separator()?,
            &MenuItem::with_id(app, SETUP, "Run Setup Again…", true, None::<&str>)?,
            &MenuItem::with_id(app, COPY_DIAGNOSTICS, "Copy Diagnostics", true, None::<&str>)?,
        ],
    )?;
    Menu::with_items(app, &[&eavesy, &edit, &capture, &view, &window, &help])
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    imp::hide_full_screen_item();
    let menu = build(app)?;
    if let Some(MenuItemKind::Submenu(window)) = menu.get(WINDOW_MENU) {
        window.set_as_windows_menu_for_nsapp()?;
    }
    if let Some(MenuItemKind::Submenu(help)) = menu.get(HELP_MENU) {
        help.set_as_help_menu_for_nsapp()?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        handle(app, event.id.as_ref());
    });
    Ok(())
}

/// Menu handlers see every menu's events (the tray's too), so the app menu only acts on its own
/// ids and returns false for the rest.
pub fn handle(app: &AppHandle, id: &str) -> bool {
    match id {
        ABOUT => show_about(app),
        CHECK_FOR_UPDATES => crate::updates::check_interactively(app),
        SETTINGS => {
            let _ = crate::commands::show_settings(app.clone());
        }
        RECORD => crate::hotkeys::trigger_dictation(app),
        SHOW_RECORDINGS => crate::commands::show_launcher(app.clone()),
        OPEN_WEB_APP => {
            if let Err(error) = crate::commands::open_web_app(app.clone(), None) {
                crate::telemetry::capture("app_menu.open_web_app", &error);
            }
        }
        SHOW_CONTROL => crate::hud::set_hidden_on_main(app, false),
        HIDE_CONTROL => crate::hud::set_hidden_on_main(app, true),
        HELP | WHATS_NEW | CONTACT => open_site(app, site_path(id).unwrap_or("/")),
        SETUP => crate::commands::show_setup(app.clone()),
        COPY_DIAGNOSTICS => crate::diagnostics::copy(app),
        _ => return false,
    }
    true
}

// Shell::open is deprecated in favour of tauri-plugin-opener; migrating adds a plugin and capability change, so it is left for a separate change.
fn site_path(id: &str) -> Option<&'static str> {
    match id {
        HELP => Some("/docs"),
        WHATS_NEW => Some("/changelog"),
        CONTACT => Some("/contact"),
        _ => None,
    }
}

#[allow(deprecated)]
fn open_site(app: &AppHandle, path: &str) {
    use tauri_plugin_shell::ShellExt;
    let url = format!("{}{path}", crate::base_url::DEFAULT_BASE);
    if let Err(error) = app.shell().open(&url, None) {
        crate::telemetry::capture("app_menu.open_site", &error.to_string());
    }
}

/// Shows the standard About panel. The launcher is put away first because it floats above
/// ordinary windows and would cover the panel.
pub fn show_about(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        present(&handle);
        imp::order_front_about_panel(&version(&handle));
    });
}

/// Puts the launcher away without handing focus back, and makes Eavesy the active app, so a
/// window or dialog Eavesy is about to open comes to the front. Main thread only.
pub fn present(app: &AppHandle) {
    KEEP_FOCUS.store(true, std::sync::atomic::Ordering::SeqCst);
    if crate::panel::is_visible(app) {
        let _ = crate::panel::hide(app);
    }
    KEEP_FOCUS.store(false, std::sync::atomic::Ordering::SeqCst);
    imp::activate_app();
}

static KEEP_FOCUS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Makes Eavesy the active app, remembering which app was in front. Main thread only.
pub fn activate() {
    imp::remember_frontmost();
    imp::activate_app();
}

/// Hands focus back to the app that was in front before [`activate`], if Eavesy is still the
/// active app (when the user clicked another app, that app is already in front). Main thread only.
pub fn return_focus() {
    if KEEP_FOCUS.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    imp::return_focus();
}

/// The app in front right now (pid and name), unless it is Eavesy.
pub fn frontmost() -> Option<(i32, Option<String>)> {
    imp::frontmost()
}

/// Whether Eavesy is the active app.
pub fn is_active() -> bool {
    imp::is_active()
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
mod imp {
    use std::sync::atomic::{AtomicI32, Ordering};
    use tauri_nspanel::{
        cocoa::{
            base::{id, nil, BOOL, NO, YES},
            foundation::NSString,
        },
        objc::{class, msg_send, sel, sel_impl},
    };

    static PREVIOUS: AtomicI32 = AtomicI32::new(0);
    const ACTIVATE_IGNORING_OTHER_APPS: usize = 1 << 1;

    fn own_pid() -> i32 {
        std::process::id() as i32
    }

    pub fn remember_frontmost() {
        if let Some((pid, name)) = frontmost() {
            PREVIOUS.store(pid, Ordering::SeqCst);
            crate::front_window::capture(pid, name);
        }
    }

    pub fn frontmost() -> Option<(i32, Option<String>)> {
        unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let front: id = msg_send![workspace, frontmostApplication];
            if front == nil {
                return None;
            }
            let pid: i32 = msg_send![front, processIdentifier];
            if pid <= 0 || pid == own_pid() {
                return None;
            }
            let name: id = msg_send![front, localizedName];
            Some((pid, ns_string(name)))
        }
    }

    unsafe fn ns_string(value: id) -> Option<String> {
        if value == nil {
            return None;
        }
        let bytes: *const std::os::raw::c_char = msg_send![value, UTF8String];
        if bytes.is_null() {
            return None;
        }
        let text = std::ffi::CStr::from_ptr(bytes).to_string_lossy().trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    pub fn activate_app() {
        unsafe {
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![app, activateIgnoringOtherApps: YES];
        }
    }

    pub fn is_active() -> bool {
        unsafe {
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            let active: BOOL = msg_send![app, isActive];
            active != NO
        }
    }

    pub fn return_focus() {
        let pid = PREVIOUS.swap(0, Ordering::SeqCst);
        if pid <= 0 || !is_active() {
            return;
        }
        unsafe {
            let previous: id =
                msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
            if previous == nil {
                return;
            }
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            // macOS 14+ only lets an app activate another one that the active app yields to.
            let can_yield: BOOL = msg_send![app, respondsToSelector: sel!(yieldActivationToApplication:)];
            if can_yield != NO {
                let _: () = msg_send![app, yieldActivationToApplication: previous];
            }
            let _: BOOL = msg_send![previous, activateWithOptions: ACTIVATE_IGNORING_OTHER_APPS];
        }
    }

    /// AppKit adds Enter Full Screen to a menu titled View; the launcher is a floating panel, so
    /// that item would only break it. This applies to every Eavesy window, and as a registered
    /// default it lives only in memory, never in the preferences file.
    pub fn hide_full_screen_item() {
        unsafe {
            let key = NSString::alloc(nil).init_str("NSFullScreenMenuItemEverywhere");
            let value: id = msg_send![class!(NSNumber), numberWithBool: NO];
            let registered: id = msg_send![class!(NSDictionary), dictionaryWithObject: value forKey: key];
            let defaults: id = msg_send![class!(NSUserDefaults), standardUserDefaults];
            let _: () = msg_send![defaults, registerDefaults: registered];
            let _: () = msg_send![key, release];
        }
    }

    pub fn order_front_about_panel(version: &str) {
        unsafe {
            let key = NSString::alloc(nil).init_str("ApplicationVersion");
            let value = NSString::alloc(nil).init_str(version);
            let options: id = msg_send![class!(NSDictionary), dictionaryWithObject: value forKey: key];
            let app: id = msg_send![class!(NSApplication), sharedApplication];
            let _: () = msg_send![app, orderFrontStandardAboutPanelWithOptions: options];
            let _: () = msg_send![key, release];
            let _: () = msg_send![value, release];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn remember_frontmost() {}
    pub fn frontmost() -> Option<(i32, Option<String>)> {
        None
    }
    pub fn activate_app() {}
    pub fn is_active() -> bool {
        false
    }
    pub fn return_focus() {}
    pub fn hide_full_screen_item() {}
    pub fn order_front_about_panel(_version: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_items_open_their_pages_and_other_ids_are_not_links() {
        assert_eq!(site_path(HELP), Some("/docs"));
        assert_eq!(site_path(WHATS_NEW), Some("/changelog"));
        assert_eq!(site_path(CONTACT), Some("/contact"));
        assert_eq!(site_path(SETUP), None);
        assert!(!crate::base_url::DEFAULT_BASE.ends_with('/'));
    }
}
