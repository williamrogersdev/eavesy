//! Eavesy's identity as a macOS app: the menu bar (Eavesy ▸ About, Check for Updates…,
//! Settings…, Hide, Quit, and a standard Edit menu) and when Eavesy is the active app.
//!
//! Eavesy keeps the default Regular activation policy: it has a Dock icon (clicking it reopens
//! the launcher through `RunEvent::Reopen`) and a real menu bar whenever it is active. The
//! launcher and the HUD stay non-activating panels, so the HUD never takes focus. Showing the
//! launcher calls [`activate`], which makes Eavesy the active app so the menu bar says Eavesy and
//! ⌘C/⌘V/⌘A/⌘Z/⌘, work in its inputs; hiding it calls [`return_focus`], which hands focus back to
//! the app that was in front before, so pasting into that app still works.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

pub const ABOUT: &str = "app_about";
pub const CHECK_FOR_UPDATES: &str = "app_check_for_updates";
pub const SETTINGS: &str = "app_settings";

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
    Menu::with_items(app, &[&eavesy, &edit])
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;
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
        _ => return false,
    }
    true
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
/// window Eavesy is about to open comes to the front. Main thread only.
pub fn present(app: &AppHandle) {
    if crate::panel::is_visible(app) {
        let _ = crate::panel::hide_and(app, crate::panel::AfterHide::KeepFocus);
    }
    imp::activate_app();
}

/// Makes Eavesy the active app without touching the launcher. Main thread only.
pub fn activate_only() {
    imp::activate_app();
}

/// Makes Eavesy the active app, remembering which app was in front. Main thread only.
pub fn activate() {
    imp::remember_frontmost();
    imp::activate_app();
}

/// Hands focus back to the app that was in front before [`activate`], if Eavesy is still the
/// active app (when the user clicked another app, that app is already in front). Main thread only.
pub fn return_focus() {
    imp::return_focus();
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

    fn frontmost_app() -> Option<i32> {
        unsafe {
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let front: id = msg_send![workspace, frontmostApplication];
            if front == nil {
                return None;
            }
            let pid: i32 = msg_send![front, processIdentifier];
            (pid > 0).then_some(pid)
        }
    }

    pub fn remember_frontmost() {
        if let Some(pid) = frontmost_app().filter(|pid| *pid != own_pid()) {
            PREVIOUS.store(pid, Ordering::SeqCst);
        }
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
        let pid = PREVIOUS.load(Ordering::SeqCst);
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
    pub fn activate_app() {}
    pub fn is_active() -> bool {
        false
    }
    pub fn return_focus() {}
    pub fn order_front_about_panel(_version: &str) {}
}
