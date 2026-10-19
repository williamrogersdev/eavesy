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

fn classify(exe: &Path, on_temp_volume: impl FnOnce(&Path) -> bool) -> Option<Misplaced> {
    let bundle = exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))?;
    let translocated = bundle.to_string_lossy().contains("/AppTranslocation/");
    if !translocated && on_temp_volume(bundle) {
        return None;
    }
    let volume = if translocated { None } else { volume_root(bundle) };
    Some(Misplaced { bundle: bundle.to_path_buf(), volume })
}

fn volume_root(bundle: &Path) -> Option<PathBuf> {
    let mut parts = bundle.strip_prefix("/Volumes").ok()?.components();
    Some(Path::new("/Volumes").join(parts.next()?))
}

fn same_volume(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => true,
    }
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
    // /Applications isn't writable for this user: ask for an admin password.
    let script = format!(
        "do shell script {} with administrator privileges",
        applescript_string(&format!(
            "/bin/sh -c {} sh {} {}",
            shell_quote(COPY_SCRIPT),
            shell_quote(&bundle.to_string_lossy()),
            shell_quote(&target.to_string_lossy())
        ))
    );
    let output = Command::new("/usr/bin/osascript").args(["-e", &script]).output().map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    match admin_copy_outcome(output.status.success(), &stderr) {
        Ok(true) => Ok(Some(target)),
        Ok(false) => Ok(None),
        Err(error) => Err(error),
    }
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

/// Waits for this process to exit, ejects the volume only if it is a mounted
/// disk image (never a real drive), then opens the copy in Applications.
const RELAUNCH_SCRIPT: &str = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if [ -n "$3" ] && hdiutil info | awk -F'\t' -v v="$3" '$NF == v { found = 1 } END { exit !found }'; then
  hdiutil detach "$3" -quiet
fi
open "$2"
"#;

fn relaunch_from(app: &AppHandle, target: &Path, volume: Option<&Path>) {
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
            classify(&exe, |_| false),
            Some(Misplaced { bundle: "/Volumes/Eavesy/Eavesy.app".into(), volume: Some("/Volumes/Eavesy".into()) })
        );
        let drive = Path::new("/Volumes/Work/Apps/Eavesy.app").join(EXE);
        assert_eq!(classify(&drive, |_| false).unwrap().volume, Some("/Volumes/Work".into()));
    }

    #[test]
    fn a_translocated_copy_is_misplaced_but_nothing_is_ejected() {
        let exe = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Eavesy.app").join(EXE);
        assert_eq!(classify(&exe, |_| true).unwrap().volume, None);
    }

    #[test]
    fn the_system_volume_is_fine() {
        assert_eq!(classify(&Path::new("/Applications/Eavesy.app").join(EXE), |_| true), None);
        assert_eq!(classify(Path::new("/Users/me/eavesy/desktop/src-tauri/target/debug/eavesy"), |_| false), None);
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
        assert!(!same_volume(&image.mount, &std::env::temp_dir()));
        assert!(same_volume(&image.root, &std::env::temp_dir()));
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
        let status = Command::new("/bin/sh").args(["-c", COPY_SCRIPT, "sh"]).arg(&src).arg(&dst).status().unwrap();
        assert!(status.success());
        assert_eq!(std::fs::read_to_string(dst.join("Contents/version")).unwrap(), "new");
        assert!(!root.join("dst/Eavesy.app.eavesy-old").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
