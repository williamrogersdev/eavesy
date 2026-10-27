//! Other copies of Eavesy on this Mac share its bundle identifier, so macOS
//! may open one of them for a notification, a link or a Spotlight search, and
//! the user ends up in an old version. When the real copy runs from
//! /Applications, every other copy that isn't newer is dropped from Launch
//! Services, so macOS stops choosing it. No files are touched: a copy can
//! still be opened by double-clicking it, which registers it again.

use std::path::{Path, PathBuf};
use std::time::Duration;

const LSREGISTER: &str =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// Runs once, a little after launch, so startup isn't slowed.
pub fn clean_up_in_background() {
    if cfg!(debug_assertions) || crate::install_location::label() != "applications" {
        return;
    }
    let Some(own) = own_bundle() else { return };
    let _ = std::thread::Builder::new().name("stray-copies".into()).spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let (mut unregistered, mut failed, mut newer) = (0u32, 0u32, 0u32);
        for (path, version) in registered_copies() {
            match should_unregister(&own, env!("CARGO_PKG_VERSION"), &path, version.as_deref()) {
                Some(true) if unregister(&path) => unregistered += 1,
                Some(true) => failed += 1,
                Some(false) => newer += 1,
                None => {}
            }
        }
        if unregistered + failed + newer > 0 {
            tracing::info!("other Eavesy copies: {unregistered} unregistered, {failed} failed, {newer} newer left alone");
            crate::telemetry::track(
                "stray_copies_found",
                serde_json::json!({ "unregistered": unregistered, "failed": failed, "newer": newer }),
            );
        }
    });
}

fn own_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app")).map(Path::to_path_buf)
}

/// `None` for this copy itself; `Some(false)` for a newer copy, which is left
/// registered; `Some(true)` for any other copy.
fn should_unregister(own: &Path, own_version: &str, other: &Path, other_version: Option<&str>) -> Option<bool> {
    if other == own {
        return None;
    }
    let path = other.to_string_lossy();
    let throwaway = path.contains("/.Trash/")
        || path.starts_with("/Volumes/")
        || path.starts_with("/private/")
        || path.contains("/target/");
    let newer = other_version.is_some_and(|v| is_newer(v, own_version));
    Some(throwaway || !newer)
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    version_parts(candidate) > version_parts(current)
}

fn unregister(path: &Path) -> bool {
    std::process::Command::new(LSREGISTER)
        .arg("-u")
        .arg(path)
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
fn registered_copies() -> Vec<(PathBuf, Option<String>)> {
    use tauri_nspanel::cocoa::base::{id, nil};
    use tauri_nspanel::cocoa::foundation::NSString;
    use tauri_nspanel::objc::{class, msg_send, sel, sel_impl};

    unsafe fn to_string(value: id) -> Option<String> {
        if value == nil {
            return None;
        }
        let bytes: *const std::os::raw::c_char = msg_send![value, UTF8String];
        (!bytes.is_null()).then(|| std::ffi::CStr::from_ptr(bytes).to_string_lossy().into_owned())
    }

    let mut copies = Vec::new();
    unsafe {
        let identifier = NSString::alloc(nil).init_str("com.eavesy.desktop");
        let key = NSString::alloc(nil).init_str("CFBundleShortVersionString");
        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let urls: id = msg_send![workspace, URLsForApplicationsWithBundleIdentifier: identifier];
        if urls != nil {
            let count: usize = msg_send![urls, count];
            for index in 0..count {
                let url: id = msg_send![urls, objectAtIndex: index];
                let path: id = msg_send![url, path];
                let Some(path) = to_string(path) else { continue };
                let bundle: id = msg_send![class!(NSBundle), bundleWithURL: url];
                let version = if bundle == nil {
                    None
                } else {
                    let value: id = msg_send![bundle, objectForInfoDictionaryKey: key];
                    to_string(value)
                };
                copies.push((PathBuf::from(path), version));
            }
        }
        let _: () = msg_send![identifier, release];
        let _: () = msg_send![key, release];
    }
    copies
}

#[cfg(not(target_os = "macos"))]
fn registered_copies() -> Vec<(PathBuf, Option<String>)> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{is_newer, should_unregister};
    use std::path::Path;

    const OWN: &str = "/Applications/Eavesy.app";

    fn decide(other: &str, version: Option<&str>) -> Option<bool> {
        should_unregister(Path::new(OWN), "0.5.0", Path::new(other), version)
    }

    #[test]
    fn older_and_unreadable_copies_are_unregistered() {
        assert_eq!(decide("/Users/dana/Downloads/Eavesy.app", Some("0.4.0")), Some(true));
        assert_eq!(decide("/Applications/Eavesy 2.app", Some("0.5.0")), Some(true));
        assert_eq!(decide("/Users/dana/Desktop/Eavesy.app", None), Some(true));
    }

    #[test]
    fn throwaway_locations_are_unregistered_whatever_their_version() {
        for path in [
            "/Users/dana/.Trash/Eavesy.app",
            "/Volumes/Eavesy/Eavesy.app",
            "/private/var/folders/x/T/AppTranslocation/ABC/d/Eavesy.app",
            "/Users/dana/eavesy/desktop/src-tauri/target/debug/bundle/macos/Eavesy.app",
        ] {
            assert_eq!(decide(path, Some("0.9.0")), Some(true), "{path}");
        }
    }

    #[test]
    fn itself_and_newer_copies_stay_registered() {
        assert_eq!(decide(OWN, Some("0.5.0")), None);
        assert_eq!(decide("/Users/dana/Downloads/Eavesy.app", Some("0.6.0")), Some(false));
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.4.0", "0.4.0"));
        assert!(is_newer("1.0.0", "0.99.0"));
    }
}
