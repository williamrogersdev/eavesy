use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const APPLICATIONS: &str = "/Applications";
const APP_NAME: &str = "Eavesy.app";

/// Prefer the installed app before the single-instance plugin can let a loose
/// copy become the owner of our shared data and shortcuts. Never overwrite an
/// installed app just because someone opened another download.
#[cfg(target_os = "macos")]
pub fn open_existing_installation() -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Ok(false);
    }
    let Ok(exe) = std::env::current_exe() else { return Ok(false) };
    let mut directories = vec![PathBuf::from(APPLICATIONS)];
    if let Some(home) = dirs::home_dir() {
        directories.push(home.join("Applications"));
    }
    let installed = existing_installation(&exe, &directories, |path| {
        use objc2_foundation::{NSBundle, NSString};
        let identifier = NSBundle::bundleWithPath(&NSString::from_str(&path.to_string_lossy()))
            .and_then(|bundle| bundle.bundleIdentifier());
        if identifier.is_none() && path.exists() {
            crate::telemetry::capture("install_location.identify", "An Applications candidate exists but its bundle identifier couldn't be read");
        }
        identifier.is_some_and(|identifier| identifier.to_string() == "com.eavesy.desktop")
    });
    // Both copies have the same bundle ID. Without -n, Launch Services may
    // reactivate this loose copy instead of starting the installed executable.
    // The installed app's single-instance plugin handles an already running app.
    launch_existing(installed, |installed| {
        match Command::new("/usr/bin/open").args(["-n", "-a"]).arg(installed).status() {
            Ok(status) if status.success() => Ok(()),
            result => {
                crate::telemetry::capture("install_location.open_existing", &format!("{result:?}"));
                Err(format!("Eavesy is already installed at {} but couldn't be opened. Open that app from Finder, or replace it with a fresh download. This extra copy will quit to keep your recordings and updates in one place.", installed.display()))
            }
        }
    })
}

fn launch_existing(installed: Option<PathBuf>, launch: impl FnOnce(&Path) -> Result<(), String>) -> Result<bool, String> {
    match installed {
        Some(path) => launch(&path).map(|()| true),
        None => Ok(false),
    }
}

/// Startup can fail before Tauri and its dialog plugin exist. Present a native
/// alert on the main thread, without initializing capture or shared app state.
#[cfg(target_os = "macos")]
#[allow(deprecated, unexpected_cfgs)]
pub fn show_launch_error(message: &str) {
    use tauri_nspanel::cocoa::base::{id, nil, YES};
    use tauri_nspanel::cocoa::foundation::NSString;
    use tauri_nspanel::objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let application: id = msg_send![class!(NSApplication), sharedApplication];
        let alert: id = msg_send![class!(NSAlert), new];
        let title = NSString::alloc(nil).init_str("Open your installed Eavesy app");
        let detail = NSString::alloc(nil).init_str(message);
        let button = NSString::alloc(nil).init_str("Quit");
        let _: () = msg_send![alert, setMessageText: title];
        let _: () = msg_send![alert, setInformativeText: detail];
        let _: id = msg_send![alert, addButtonWithTitle: button];
        let _: () = msg_send![application, activateIgnoringOtherApps: YES];
        let _: isize = msg_send![alert, runModal];
        let _: () = msg_send![alert, release];
        let _: () = msg_send![title, release];
        let _: () = msg_send![detail, release];
        let _: () = msg_send![button, release];
    }
}

fn existing_installation(
    exe: &Path,
    directories: &[PathBuf],
    is_eavesy: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let bundle = app_bundle(exe)?;
    if is_cargo_bundle(bundle) {
        return None;
    }
    let installed = directories.iter().map(|dir| dir.join(APP_NAME)).find(|path| is_eavesy(path))?;
    let resolved = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    (resolved(bundle) != resolved(&installed)).then_some(installed)
}

fn app_bundle(exe: &Path) -> Option<&Path> {
    exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))
}

fn loose_bundle(exe: &Path, user_applications: Option<&Path>) -> Option<PathBuf> {
    let bundle = app_bundle(exe)?;
    let installed = bundle.file_name().is_some_and(|name| name == APP_NAME)
        && (bundle.parent() == Some(Path::new(APPLICATIONS)) || bundle.parent() == user_applications);
    if is_cargo_bundle(bundle) || installed {
        return None;
    }
    Some(bundle.to_path_buf())
}

pub const MOVE_TO_APPLICATIONS: &str = "Eavesy is running from a disk image or another drive, so it can't replace itself. \
Quit Eavesy, drag it into your Applications folder, eject the disk image, then open Eavesy from Applications and update again.";

/// Where the running Eavesy.app lives, when the updater can't swap it in place.
/// The updater moves the old bundle into the system temp folder, so the bundle
/// must be on the same volume: a mounted disk image, another drive or a
/// Gatekeeper translocation mount all fail with EXDEV.
#[derive(Debug, Clone, PartialEq)]
pub struct Misplaced {
    pub bundle: PathBuf,
    /// The volume Eavesy was opened from, ejected after the move if it's a disk image.
    pub volume: Option<PathBuf>,
}

pub fn misplaced() -> Option<Misplaced> {
    match std::env::current_exe() {
        Ok(exe) => classify(&exe, |bundle| same_volume(bundle, &std::env::temp_dir())),
        // updates::install_error still explains the EXDEV failure if this check can't run.
        Err(e) => {
            crate::telemetry::capture("install_location.locate", &e.to_string());
            None
        }
    }
}

/// Where this copy runs from, as a fixed category for launch analytics, so
/// stray copies (a disk image, a build folder) show up next to the real one.
pub fn label() -> &'static str {
    match std::env::current_exe() {
        Ok(exe) => location_label(&exe),
        Err(_) => "unknown",
    }
}

fn location_label(exe: &Path) -> &'static str {
    let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app")) else {
        return "unbundled";
    };
    let path = bundle.to_string_lossy();
    if path.contains("/AppTranslocation/") {
        "translocated"
    } else if bundle.parent() == Some(Path::new(APPLICATIONS)) {
        "applications"
    } else if is_cargo_bundle(bundle) {
        "build_folder"
    } else if path.starts_with("/Volumes/") {
        "other_volume"
    } else if path.contains("/Applications/") {
        "user_applications"
    } else {
        "other"
    }
}

/// `…/target/<profile>/bundle/macos/Eavesy.app`, as `cargo tauri build` lays it out.
fn is_cargo_bundle(bundle: &Path) -> bool {
    let parts: Vec<_> = bundle.components().rev().skip(1).take(4).map(|c| c.as_os_str()).collect();
    matches!(parts.as_slice(), [macos, bundle, _profile, target] if *macos == "macos" && *bundle == "bundle" && *target == "target")
}

/// `on_temp_volume` is `None` when the volumes can't be compared; then a
/// `/Volumes` path is assumed to be another drive, and anything else is not.
fn classify(exe: &Path, on_temp_volume: impl FnOnce(&Path) -> Option<bool>) -> Option<Misplaced> {
    let bundle = exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))?;
    let translocated = bundle.to_string_lossy().contains("/AppTranslocation/");
    if !translocated && on_temp_volume(bundle).unwrap_or_else(|| volume_root(bundle).is_none()) {
        return None;
    }
    let volume = if translocated { None } else { volume_root(bundle) };
    Some(Misplaced { bundle: bundle.to_path_buf(), volume })
}

fn volume_root(bundle: &Path) -> Option<PathBuf> {
    let mut parts = bundle.strip_prefix("/Volumes").ok()?.components();
    Some(Path::new("/Volumes").join(parts.next()?))
}

fn same_volume(a: &Path, b: &Path) -> Option<bool> {
    use std::os::unix::fs::MetadataExt;
    Some(std::fs::metadata(a).ok()?.dev() == std::fs::metadata(b).ok()?.dev())
}

/// On launch from a loose copy, asks to move Eavesy into Applications so
/// updates, permissions and login items all point at one stable copy.
pub fn offer_move_on_launch(app: &AppHandle) {
    let user_applications = dirs::home_dir().map(|home| home.join("Applications"));
    let loose = std::env::current_exe().ok().and_then(|exe| loose_bundle(&exe, user_applications.as_deref()));
    if let Some(misplaced) = misplaced().or_else(|| loose.map(|bundle| Misplaced { bundle, volume: None })) {
        offer_move(app, misplaced, "Keep one Eavesy app in Applications, whether you installed it with Homebrew or downloaded it. Move this copy to Applications?");
    }
}

/// Shows the native "Move to Applications" prompt. Safe to call from any thread.
pub fn offer_move(app: &AppHandle, misplaced: Misplaced, message: &str) {
    let handle = app.clone();
    let message = message.to_string();
    let _ = app.run_on_main_thread(move || {
        crate::app_menu::present(&handle);
        let mover = handle.clone();
        handle
            .dialog()
            .message(message)
            .title("Move Eavesy to Applications")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom("Move to Applications".into(), "Not Now".into()))
            .show(move |accepted| {
                if accepted {
                    move_and_relaunch(mover, misplaced);
                }
            });
    });
}

fn move_and_relaunch(app: AppHandle, misplaced: Misplaced) {
    tauri::async_runtime::spawn_blocking(move || match copy_to_applications(&misplaced.bundle) {
        Ok(Some(target)) => relaunch_from(&app, &target, misplaced.volume.as_deref()),
        Ok(None) => {}
        Err(error) => {
            crate::telemetry::capture("install_location.move", &error);
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                handle
                    .dialog()
                    .message(format!("{MOVE_TO_APPLICATIONS}\n\n({error})"))
                    .title("Eavesy couldn't move itself")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::Ok)
                    .show(|_| {});
            });
        }
    });
}

const COPY_SCRIPT: &str = r#"set -e
src="$1"; dst="$2"
staging="$(mktemp -d "$(dirname "$dst")/.eavesy-install.XXXXXX")"
copy="$staging/$(basename "$dst")"
trap 'rm -rf "$staging"' EXIT
if [ -e "$dst" ] || [ -L "$dst" ]; then echo "Eavesy is already in Applications; open the installed copy." >&2; exit 1; fi
ditto "$src" "$copy"
xattr -dr com.apple.quarantine "$copy" 2>/dev/null || true
if [ -n "$3" ]; then chown -R "$3" "$copy" || echo "eavesy:chown-failed"; fi
mv -n "$copy" "$(dirname "$dst")/"
if [ -e "$copy" ]; then echo "Another Eavesy installation appeared; open the installed copy." >&2; exit 1; fi
"#;

/// Same-volume moves are a single atomic rename, so interruption cannot strand
/// the only app in staging. RENAME_EXCL also refuses a concurrent installation.
#[cfg(target_os = "macos")]
fn move_local_bundle(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    let target = CString::new(target.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
    // Both paths are valid NUL-terminated strings for the duration of the call.
    let status = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
    if status == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

/// `Ok(None)` when the user cancelled the admin password prompt.
fn copy_to_applications(bundle: &Path) -> Result<Option<PathBuf>, String> {
    let target = Path::new(APPLICATIONS).join(APP_NAME);
    if target.exists() || target.is_symlink() {
        return Err("Eavesy is already in Applications. Quit this copy and open Eavesy from Applications to update it.".into());
    }
    #[cfg(target_os = "macos")]
    if same_volume(bundle, Path::new(APPLICATIONS)) == Some(true) {
        move_local_bundle(bundle, &target).map_err(|error| {
            format!("Eavesy couldn't move into Applications ({error}). Move it there using Finder, then open it from Applications.")
        })?;
        return Ok(Some(target));
    }
    let output = Command::new("/bin/sh")
        .args(["-c", COPY_SCRIPT, "sh"])
        .arg(bundle)
        .arg(&target)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(Some(target));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !needs_admin(&stderr) {
        return admin_copy_outcome(false, &stderr).map(|_| None);
    }
    // /Applications isn't writable for this user: ask for an admin password.
    let owner = current_owner();
    if owner.is_none() {
        crate::telemetry::capture("install_location.owner", "couldn't read the user's uid and gid");
    }
    let script = admin_command(bundle, &target, owner.as_deref());
    let output = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    if String::from_utf8_lossy(&output.stdout).contains("eavesy:chown-failed") {
        crate::telemetry::capture("install_location.owner", "couldn't hand the copy in Applications back to the user");
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    match admin_copy_outcome(output.status.success(), &stderr) {
        Ok(true) => Ok(Some(target)),
        Ok(false) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The copy runs as root, so it is handed back to this user (`uid:gid`, read
/// from the per-user temp folder) and later updates don't need a password.
fn current_owner() -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(std::env::temp_dir()).ok()?;
    (meta.uid() != 0).then(|| format!("{}:{}", meta.uid(), meta.gid()))
}

fn admin_command(bundle: &Path, target: &Path, owner: Option<&str>) -> String {
    format!(
        "do shell script {} with administrator privileges",
        applescript_string(&format!(
            "/bin/sh -c {} sh {} {} {}",
            shell_quote(COPY_SCRIPT),
            shell_quote(&bundle.to_string_lossy()),
            shell_quote(&target.to_string_lossy()),
            shell_quote(owner.unwrap_or_default())
        ))
    )
}

fn needs_admin(stderr: &str) -> bool {
    stderr.contains("Permission denied") || stderr.contains("Operation not permitted")
}

fn admin_copy_outcome(success: bool, stderr: &str) -> Result<bool, String> {
    if success {
        return Ok(true);
    }
    // osascript reports a cancelled password prompt as error -128.
    if stderr.contains("(-128)") {
        return Ok(false);
    }
    let stderr = stderr.trim();
    Err(if stderr.is_empty() { "copying to Applications failed".into() } else { stderr.to_string() })
}

/// Waits for this process to exit, ejects the disk image if one is given, then
/// opens the copy in Applications.
const RELAUNCH_SCRIPT: &str = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if [ -n "$3" ]; then hdiutil detach "$3" -quiet; fi
open "$2"
"#;

/// Only volumes `hdiutil` lists as mounted disk images are ejected, never a real drive.
fn mounted_disk_image(volume: &Path) -> bool {
    let volume = volume.canonicalize().unwrap_or_else(|_| volume.to_path_buf());
    match Command::new("hdiutil").args(["info", "-plist"]).output() {
        Ok(output) if output.status.success() => lists_mount_point(&String::from_utf8_lossy(&output.stdout), &volume),
        Ok(output) => {
            crate::telemetry::capture("install_location.hdiutil", &String::from_utf8_lossy(&output.stderr));
            false
        }
        Err(e) => {
            crate::telemetry::capture("install_location.hdiutil", &e.to_string());
            false
        }
    }
}

fn lists_mount_point(plist: &str, volume: &Path) -> bool {
    let wanted = format!("<string>{}</string>", xml_escape(&volume.to_string_lossy()));
    let mut lines = plist.lines().map(str::trim);
    while let Some(line) = lines.next() {
        if line == "<key>mount-point</key>" && lines.next() == Some(wanted.as_str()) {
            return true;
        }
    }
    false
}

fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn relaunch_from(app: &AppHandle, target: &Path, volume: Option<&Path>) {
    let volume = volume.filter(|v| mounted_disk_image(v));
    let spawned = Command::new("/bin/sh")
        .args(["-c", RELAUNCH_SCRIPT, "sh"])
        .arg(std::process::id().to_string())
        .arg(target)
        .arg(volume.map(Path::as_os_str).unwrap_or_default())
        .spawn();
    match spawned {
        Ok(_) => app.exit(0),
        Err(e) => {
            crate::telemetry::capture("install_location.relaunch", &e.to_string());
            let _ = Command::new("open").arg("-R").arg(target).spawn();
            let handle = app.clone();
            let message = format!(
                "Eavesy was copied to {}. Quit this copy, eject the disk image, then open Eavesy from Applications.",
                target.display()
            );
            let _ = app.run_on_main_thread(move || {
                handle
                    .dialog()
                    .message(message)
                    .title("Open Eavesy from Applications")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::Ok)
                    .show(|_| {});
            });
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', r"\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "Contents/MacOS/eavesy";

    fn assert_no_staging(parent: &Path) {
        for entry in std::fs::read_dir(parent).unwrap() {
            assert!(!entry.unwrap().file_name().to_string_lossy().starts_with(".eavesy-install."));
        }
    }

    #[test]
    fn failed_handoffs_do_not_allow_the_loose_copy_to_continue() {
        assert_eq!(launch_existing(None, |_| panic!("no installed copy to launch")), Ok(false));
        assert_eq!(launch_existing(Some("/Applications/Eavesy.app".into()), |_| Ok(())), Ok(true));
        assert_eq!(launch_existing(Some("/Applications/Eavesy.app".into()), |_| Err("launch failed".into())), Err("launch failed".into()));
    }

    #[test]
    fn downloads_disk_images_and_renamed_copies_use_the_installed_app() {
        let directories = [PathBuf::from(APPLICATIONS), PathBuf::from("/Users/dana/Applications")];
        let installed = Path::new("/Applications/Eavesy.app");
        for source in [
            "/Users/dana/Downloads/Eavesy.app",
            "/Users/dana/Desktop/Eavesy.app",
            "/Applications/Eavesy 2.app",
            "/Users/dana/Applications/Eavesy.app",
            "/Volumes/Eavesy/Eavesy.app",
            "/private/var/folders/x/AppTranslocation/ABC/d/Eavesy.app",
        ] {
            assert_eq!(existing_installation(&Path::new(source).join(EXE), &directories, |p| p == installed), Some(installed.into()), "{source}");
        }
        assert_eq!(existing_installation(&installed.join(EXE), &directories, |p| p == installed), None);
    }

    #[test]
    fn user_applications_is_supported_and_unrelated_bundles_are_ignored() {
        let directories = [PathBuf::from(APPLICATIONS), PathBuf::from("/Users/dana/Applications")];
        let installed = Path::new("/Users/dana/Applications/Eavesy.app");
        let source = Path::new("/Users/dana/Downloads/Eavesy.app").join(EXE);
        assert_eq!(existing_installation(&source, &directories, |p| p == installed), Some(installed.into()));
        assert_eq!(existing_installation(&installed.join(EXE), &directories, |p| p == installed), None);
        assert_eq!(existing_installation(&source, &directories, |_| false), None);
    }

    #[test]
    fn development_builds_are_not_redirected_or_offered_a_move() {
        for source in [
            "/Users/dana/eavesy/desktop/src-tauri/target/release/bundle/macos/Eavesy.app/Contents/MacOS/eavesy",
            "/Users/dana/eavesy/desktop/src-tauri/target/debug/eavesy",
        ] {
            assert_eq!(existing_installation(Path::new(source), &[PathBuf::from(APPLICATIONS)], |_| true), None);
            assert_eq!(loose_bundle(Path::new(source), None), None);
        }
    }

    #[test]
    fn local_copies_offer_installation_but_the_installed_app_does_not() {
        let user_applications = Path::new("/Users/dana/Applications");
        for source in ["/Users/dana/Downloads/Eavesy.app", "/Applications/Eavesy 2.app", "/Users/dana/Desktop/Eavesy.app"] {
            assert_eq!(loose_bundle(&Path::new(source).join(EXE), Some(user_applications)), Some(source.into()));
        }
        for source in ["/Applications/Eavesy.app", "/Users/dana/Applications/Eavesy.app"] {
            assert_eq!(loose_bundle(&Path::new(source).join(EXE), Some(user_applications)), None);
        }
    }

    #[test]
    fn symlinks_to_the_installed_bundle_do_not_cause_a_relaunch_loop() {
        let root = std::env::temp_dir().join(format!("eavesy-install-link-{}", uuid::Uuid::new_v4()));
        let applications = root.join("Applications");
        let installed = applications.join(APP_NAME);
        std::fs::create_dir_all(&installed).unwrap();
        let link = root.join(APP_NAME);
        std::os::unix::fs::symlink(&installed, &link).unwrap();
        assert_eq!(existing_installation(&link.join(EXE), &[applications], |p| p == installed), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn locations_are_fixed_categories() {
        let cases = [
            ("/Applications/Eavesy.app/Contents/MacOS/eavesy", "applications"),
            ("/Users/dana/Applications/Eavesy.app/Contents/MacOS/eavesy", "user_applications"),
            ("/Volumes/Eavesy/Eavesy.app/Contents/MacOS/eavesy", "other_volume"),
            ("/private/var/folders/x/T/AppTranslocation/ABC/d/Eavesy.app/Contents/MacOS/eavesy", "translocated"),
            ("/Users/dana/eavesy/desktop/src-tauri/target/debug/bundle/macos/Eavesy.app/Contents/MacOS/eavesy", "build_folder"),
            ("/Users/dana/Downloads/Eavesy.app/Contents/MacOS/eavesy", "other"),
            ("/Users/dana/target/stuff/bundle/Eavesy.app/Contents/MacOS/eavesy", "other"),
            ("/Users/dana/eavesy/desktop/src-tauri/target/debug/eavesy", "unbundled"),
        ];
        for (exe, expected) in cases {
            assert_eq!(location_label(Path::new(exe)), expected, "{exe}");
        }
    }

    #[test]
    fn another_volume_is_misplaced() {
        let exe = Path::new("/Volumes/Eavesy/Eavesy.app").join(EXE);
        assert_eq!(
            classify(&exe, |_| Some(false)),
            Some(Misplaced { bundle: "/Volumes/Eavesy/Eavesy.app".into(), volume: Some("/Volumes/Eavesy".into()) })
        );
        let drive = Path::new("/Volumes/Work/Apps/Eavesy.app").join(EXE);
        assert_eq!(classify(&drive, |_| Some(false)).unwrap().volume, Some("/Volumes/Work".into()));
    }

    #[test]
    fn a_translocated_copy_is_misplaced_but_nothing_is_ejected() {
        let exe = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Eavesy.app").join(EXE);
        assert_eq!(classify(&exe, |_| Some(true)).unwrap().volume, None);
    }

    #[test]
    fn the_system_volume_is_fine() {
        assert_eq!(classify(&Path::new("/Applications/Eavesy.app").join(EXE), |_| Some(true)), None);
        assert_eq!(classify(Path::new("/Users/me/eavesy/desktop/src-tauri/target/debug/eavesy"), |_| Some(false)), None);
    }

    /// A scratch disk image, detached and deleted even if the test fails.
    struct ScratchImage {
        root: PathBuf,
        mount: PathBuf,
    }

    impl ScratchImage {
        fn mount() -> Self {
            let root = std::env::temp_dir().join(format!("eavesy-dmg-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).unwrap();
            let scratch = ScratchImage { mount: root.join("mount"), root };
            let image = scratch.root.join("test.dmg");
            let hdiutil = |args: &[&std::ffi::OsStr]| Command::new("hdiutil").args(args).status().unwrap().success();
            assert!(hdiutil(&["create".as_ref(), "-quiet".as_ref(), "-size".as_ref(), "2m".as_ref(), "-fs".as_ref(), "HFS+".as_ref(), image.as_os_str()]));
            assert!(hdiutil(&[
                "attach".as_ref(),
                "-quiet".as_ref(),
                "-nobrowse".as_ref(),
                "-readonly".as_ref(),
                "-mountpoint".as_ref(),
                scratch.mount.as_os_str(),
                image.as_os_str(),
            ]));
            scratch
        }
    }

    impl Drop for ScratchImage {
        fn drop(&mut self) {
            let _ = Command::new("hdiutil").args(["detach", "-quiet", "-force"]).arg(&self.mount).status();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_mounted_disk_image_is_on_another_volume_than_temp() {
        let image = ScratchImage::mount();
        assert_eq!(same_volume(&image.mount, &std::env::temp_dir()), Some(false));
        assert_eq!(same_volume(&image.root, &std::env::temp_dir()), Some(true));
        assert!(mounted_disk_image(&image.mount));
        assert!(!mounted_disk_image(Path::new("/")));
    }

    #[test]
    fn an_unreadable_location_is_judged_by_its_path() {
        let dmg = Path::new("/Volumes/Eavesy/Eavesy.app").join(EXE);
        assert!(classify(&dmg, |_| None).is_some());
        assert_eq!(classify(&Path::new("/Applications/Eavesy.app").join(EXE), |_| None), None);
    }

    #[test]
    fn only_listed_mount_points_count_as_disk_images() {
        let plist = "<dict>\n\t<key>mount-point</key>\n\t<string>/Volumes/Eavesy</string>\n</dict>";
        assert!(lists_mount_point(plist, Path::new("/Volumes/Eavesy")));
        assert!(!lists_mount_point(plist, Path::new("/Volumes/Eavesy 1")));
        assert!(!lists_mount_point(plist, Path::new("/Volumes/Work")));
        let amp = "<key>mount-point</key>\n<string>/Volumes/A &amp; B</string>";
        assert!(lists_mount_point(amp, Path::new("/Volumes/A & B")));
    }

    #[test]
    fn only_permission_failures_ask_for_a_password() {
        assert!(needs_admin("ditto: /Applications/Eavesy.app: Permission denied"));
        assert!(!needs_admin("ditto: No space left on device"));
    }

    #[test]
    fn the_admin_command_passes_source_target_and_owner_in_order() {
        let command = admin_command(Path::new("/Volumes/E/Eavesy.app"), Path::new("/Applications/Eavesy.app"), Some("501:20"));
        assert!(command.starts_with("do shell script \"/bin/sh -c "));
        assert!(command.ends_with(" sh '/Volumes/E/Eavesy.app' '/Applications/Eavesy.app' '501:20'\" with administrator privileges"));
        assert!(admin_command(Path::new("/a.app"), Path::new("/b.app"), None).contains(" '/b.app' ''\""));
    }

    #[test]
    fn cancelling_the_password_prompt_is_not_an_error() {
        assert_eq!(admin_copy_outcome(true, ""), Ok(true));
        assert_eq!(admin_copy_outcome(false, "execution error: User canceled. (-128)"), Ok(false));
        assert_eq!(admin_copy_outcome(false, "  "), Err("copying to Applications failed".into()));
        assert_eq!(admin_copy_outcome(false, "ditto: no space\n"), Err("ditto: no space".into()));
    }

    #[test]
    fn quoting_survives_awkward_paths() {
        assert_eq!(shell_quote("/Volumes/Bob's/Eavesy.app"), r"'/Volumes/Bob'\''s/Eavesy.app'");
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
    }

    #[test]
    fn an_atomic_local_move_leaves_no_duplicate_or_staging() {
        let root = std::env::temp_dir().join(format!("eavesy-move-test-{}", std::process::id()));
        let src = root.join("src/Eavesy 2.app");
        let dst = root.join("dst/Eavesy.app");
        std::fs::create_dir_all(src.join("Contents")).unwrap();
        std::fs::write(src.join("Contents/version"), "new").unwrap();
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        move_local_bundle(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("Contents/version")).unwrap(), "new");
        assert!(!src.exists());
        assert_no_staging(dst.parent().unwrap());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_copy_script_preserves_an_existing_install_and_cleans_up() {
        let root = std::env::temp_dir().join(format!("eavesy-existing-test-{}", uuid::Uuid::new_v4()));
        let src = root.join("src/Eavesy 2.app");
        let dst = root.join("dst/Eavesy.app");
        for (bundle, version) in [(&src, "download"), (&dst, "installed")] {
            std::fs::create_dir_all(bundle.join("Contents")).unwrap();
            std::fs::write(bundle.join("Contents/version"), version).unwrap();
        }
        let output = Command::new("/bin/sh").args(["-c", COPY_SCRIPT, "sh"]).arg(&src).arg(&dst).arg("").output().unwrap();
        assert!(!output.status.success());
        assert_eq!(std::fs::read_to_string(dst.join("Contents/version")).unwrap(), "installed");
        assert_eq!(std::fs::read_to_string(src.join("Contents/version")).unwrap(), "download");
        assert_no_staging(dst.parent().unwrap());
        assert!(move_local_bundle(&src, &dst).is_err());
        assert_eq!(std::fs::read_to_string(src.join("Contents/version")).unwrap(), "download");
        assert_eq!(std::fs::read_to_string(dst.join("Contents/version")).unwrap(), "installed");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_concurrent_install_is_preserved_and_the_source_is_left_intact() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("eavesy-install-race-{}", uuid::Uuid::new_v4()));
        let src = root.join("src/Eavesy.app");
        let dst = root.join("dst/Eavesy.app");
        let bin = root.join("bin");
        std::fs::create_dir_all(src.join("Contents")).unwrap();
        std::fs::write(src.join("Contents/version"), "download").unwrap();
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        // Simulate Homebrew finishing an installation after our existence
        // check, while the source is safely copied into staging.
        let shim = bin.join("mv");
        std::fs::write(&shim, r#"#!/bin/sh
set -e
if [ "$1" = "-n" ]; then
  mkdir -p "$EAVESY_TEST_TARGET/Contents"
  echo installed > "$EAVESY_TEST_TARGET/Contents/version"
fi
/bin/mv "$@"
"#).unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new("/bin/sh")
            .args(["-c", COPY_SCRIPT, "sh"])
            .arg(&src).arg(&dst).arg("")
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("EAVESY_TEST_TARGET", &dst)
            .output().unwrap();
        assert!(!output.status.success());
        assert_eq!(std::fs::read_to_string(src.join("Contents/version")).unwrap(), "download");
        assert_eq!(std::fs::read_to_string(dst.join("Contents/version")).unwrap(), "installed\n");
        assert_no_staging(dst.parent().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_disk_image_is_copied_and_left_mounted_for_the_relauncher() {
        let image = ScratchImage::mount();
        let target = image.root.join(APP_NAME);
        let output = Command::new("/bin/sh").args(["-c", COPY_SCRIPT, "sh"]).arg(&image.mount).arg(&target).arg("").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(target.is_dir());
        assert!(image.mount.is_dir());
        assert_no_staging(&image.root);
    }

    #[test]
    fn stale_staging_from_an_interruption_does_not_block_a_retry() {
        let root = std::env::temp_dir().join(format!("eavesy-stale-install-{}", uuid::Uuid::new_v4()));
        let source = root.join("source/Eavesy.app");
        std::fs::create_dir_all(source.join("Contents")).unwrap();
        std::fs::write(source.join("Contents/version"), "download").unwrap();
        let stale = root.join(".eavesy-install.stale");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("keep"), "previous attempt").unwrap();
        let target = root.join(APP_NAME);
        let output = Command::new("/bin/sh").args(["-c", COPY_SCRIPT, "sh"]).arg(&source).arg(&target).arg("").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(std::fs::read_to_string(source.join("Contents/version")).unwrap(), "download");
        assert_eq!(std::fs::read_to_string(target.join("Contents/version")).unwrap(), "download");
        assert_eq!(std::fs::read_to_string(stale.join("keep")).unwrap(), "previous attempt");
        std::fs::remove_dir_all(root).unwrap();
    }
}
