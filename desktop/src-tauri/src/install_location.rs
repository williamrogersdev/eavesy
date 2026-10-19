use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const APPLICATIONS: &str = "/Applications";

pub const MOVE_TO_APPLICATIONS: &str = "Eavesy is running from a disk image or another read-only location, so it can't replace itself. \
Quit Eavesy, drag it into your Applications folder, eject the disk image, then open Eavesy from Applications and update again.";

/// Where the running Eavesy.app lives, when that place can't be updated in
/// place: a read-only volume such as a mounted disk image, or a Gatekeeper
/// translocation mount.
#[derive(Debug, Clone, PartialEq)]
pub struct Misplaced {
    pub bundle: PathBuf,
    /// The disk image to eject once Eavesy has been copied out of it.
    pub volume: Option<PathBuf>,
}

pub fn misplaced() -> Option<Misplaced> {
    match std::env::current_exe() {
        Ok(exe) => classify(&exe, can_write_in),
        Err(e) => {
            crate::telemetry::capture("install_location.locate", &e.to_string());
            None
        }
    }
}

fn classify(exe: &Path, writable: impl FnOnce(&Path) -> bool) -> Option<Misplaced> {
    let bundle = exe.ancestors().find(|p| p.extension().is_some_and(|ext| ext == "app"))?;
    let path = bundle.to_string_lossy();
    if path.contains("/AppTranslocation/") {
        return Some(Misplaced { bundle: bundle.to_path_buf(), volume: None });
    }
    let volume = volume_root(bundle)?;
    if writable(bundle.parent()?) {
        return None;
    }
    Some(Misplaced { bundle: bundle.to_path_buf(), volume: Some(volume) })
}

fn volume_root(bundle: &Path) -> Option<PathBuf> {
    let mut parts = bundle.strip_prefix("/Volumes").ok()?.components();
    Some(Path::new("/Volumes").join(parts.next()?))
}

fn can_write_in(dir: &Path) -> bool {
    let probe = dir.join(format!(".eavesy-write-probe-{}", std::process::id()));
    let writable = std::fs::File::create(&probe).is_ok();
    let _ = std::fs::remove_file(&probe);
    writable
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
        Ok(target) => relaunch_from(&app, &target, misplaced.volume.as_deref()),
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
if ditto "$src" "$dst"; then rm -rf "$old"; else rm -rf "$dst"; [ -e "$old" ] && mv "$old" "$dst"; exit 1; fi
xattr -dr com.apple.quarantine "$dst" 2>/dev/null || true
"#;

fn copy_to_applications(bundle: &Path) -> Result<PathBuf, String> {
    let name = bundle.file_name().ok_or("the app bundle has no name")?;
    let target = Path::new(APPLICATIONS).join(name);
    let output = Command::new("/bin/sh")
        .args(["-c", COPY_SCRIPT, "sh"])
        .arg(bundle)
        .arg(&target)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(target);
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
    if output.status.success() {
        Ok(target)
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn relaunch_from(app: &AppHandle, target: &Path, volume: Option<&Path>) {
    let spawned = Command::new("/bin/sh")
        .args([
            "-c",
            r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; [ -n "$3" ] && hdiutil detach "$3" -quiet; open "$2""#,
            "sh",
        ])
        .arg(std::process::id().to_string())
        .arg(target)
        .arg(volume.map(Path::as_os_str).unwrap_or_default())
        .spawn();
    match spawned {
        Ok(_) => app.exit(0),
        Err(e) => crate::telemetry::capture("install_location.relaunch", &e.to_string()),
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
    fn a_read_only_disk_image_is_misplaced_and_ejected_after_the_move() {
        let exe = Path::new("/Volumes/Eavesy/Eavesy.app").join(EXE);
        assert_eq!(
            classify(&exe, |_| false),
            Some(Misplaced { bundle: "/Volumes/Eavesy/Eavesy.app".into(), volume: Some("/Volumes/Eavesy".into()) })
        );
    }

    #[test]
    fn a_writable_external_drive_is_left_alone() {
        assert_eq!(classify(&Path::new("/Volumes/Work/Apps/Eavesy.app").join(EXE), |_| true), None);
    }

    #[test]
    fn a_translocated_copy_is_misplaced_but_nothing_is_ejected() {
        let exe = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/Eavesy.app").join(EXE);
        let found = classify(&exe, |_| true).unwrap();
        assert_eq!(found.volume, None);
    }

    #[test]
    fn applications_and_dev_builds_are_fine() {
        assert_eq!(classify(&Path::new("/Applications/Eavesy.app").join(EXE), |_| false), None);
        assert_eq!(classify(Path::new("/Users/me/eavesy/desktop/src-tauri/target/debug/eavesy"), |_| false), None);
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
