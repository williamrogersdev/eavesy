use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const APPLICATIONS: &str = "/Applications";

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

/// On launch from a disk image, asks to move Eavesy into Applications so
/// updates, permissions and login items all point at one stable copy.
pub fn offer_move_on_launch(app: &AppHandle) {
    if let Some(misplaced) = misplaced() {
        offer_move(app, misplaced, "Eavesy is running from the disk image. Move it to Applications so it can update itself and keep your permissions?");
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
src="$1"; dst="$2"; old="$2.eavesy-old"
rm -rf "$old"
if [ -e "$dst" ]; then mv "$dst" "$old"; fi
if ditto "$src" "$dst"; then rm -rf "$old" || true; else rm -rf "$dst"; [ -e "$old" ] && mv "$old" "$dst"; exit 1; fi
xattr -dr com.apple.quarantine "$dst" 2>/dev/null || true
if [ -n "$3" ]; then chown -R "$3" "$dst" || true; fi
"#;

/// `Ok(None)` when the user cancelled the admin password prompt.
fn copy_to_applications(bundle: &Path) -> Result<Option<PathBuf>, String> {
    let name = bundle.file_name().ok_or("the app bundle has no name")?;
    let target = Path::new(APPLICATIONS).join(name);
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
            let root = std::env::temp_dir().join(format!("eavesy-dmg-test-{}", std::process::id()));
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
    fn the_copy_script_replaces_an_older_install() {
        let root = std::env::temp_dir().join(format!("eavesy-move-test-{}", std::process::id()));
        let src = root.join("src/Eavesy.app");
        let dst = root.join("dst/Eavesy.app");
        std::fs::create_dir_all(src.join("Contents")).unwrap();
        std::fs::write(src.join("Contents/version"), "new").unwrap();
        std::fs::create_dir_all(dst.join("Contents")).unwrap();
        std::fs::write(dst.join("Contents/version"), "old").unwrap();
        let owner = current_owner().unwrap();
        let status =
            Command::new("/bin/sh").args(["-c", COPY_SCRIPT, "sh"]).arg(&src).arg(&dst).arg(&owner).status().unwrap();
        assert!(status.success());
        {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::metadata(dst.join("Contents/version")).unwrap();
            assert_eq!(format!("{}:{}", meta.uid(), meta.gid()), owner);
        }
        assert_eq!(std::fs::read_to_string(dst.join("Contents/version")).unwrap(), "new");
        assert!(!root.join("dst/Eavesy.app.eavesy-old").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
