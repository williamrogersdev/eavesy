//! The `eavesy` command. The app bundles the CLI (cli/, compiled with
//! `bun build --compile`) as the `eavesy-cli` sidecar; this module links it to
//! `~/.local/bin/eavesy` when the person turns it on in Settings. The link is
//! the only state: there is no setting to drift out of sync with the disk.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Sidecar name inside `Eavesy.app/Contents/MacOS`. Not `eavesy`: that is the app itself.
const SIDECAR: &str = "eavesy-cli";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CliStatus {
    /// The app has a bundled CLI to link (false in builds without the sidecar).
    pub available: bool,
    /// `link_path` is a symlink to this app's CLI.
    pub installed: bool,
    /// Something else is at `link_path`; Eavesy will not replace it.
    pub conflict: bool,
    pub link_path: String,
}

fn bundled_cli() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.join(SIDECAR);
    path.is_file().then_some(path)
}

fn link_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".local").join("bin").join("eavesy"))
        .ok_or_else(|| "could not find your home folder".to_string())
}

enum Existing {
    Nothing,
    /// A symlink to an Eavesy CLI: this copy, or one from a moved or older app.
    Ours(PathBuf),
    Foreign,
}

/// A link is ours when it points at this app's own sidecar (`current`, which also
/// covers dev builds outside a bundle), or at an Eavesy bundle's sidecar that no
/// longer exists: the app was moved or deleted, so nothing else is using it.
/// A link into another bundle that still exists is left alone.
fn existing(link: &Path, current: Option<&Path>) -> Existing {
    match std::fs::symlink_metadata(link) {
        Err(error) if error.kind() == ErrorKind::NotFound => Existing::Nothing,
        Ok(meta) if meta.file_type().is_symlink() => match std::fs::read_link(link) {
            Ok(target) if current == Some(target.as_path()) || (is_bundled_sidecar(&target) && !target.exists()) => {
                Existing::Ours(target)
            }
            _ => Existing::Foreign,
        },
        _ => Existing::Foreign,
    }
}

/// `Eavesy….app/Contents/MacOS/eavesy-cli`: where the bundler puts the sidecar
/// (the bundle may be renamed, e.g. `Eavesy 2.app`). The file name alone is not
/// enough to claim a link as ours.
fn is_bundled_sidecar(target: &Path) -> bool {
    let mut parts = target.components().rev().map(|c| c.as_os_str().to_string_lossy());
    parts.next().is_some_and(|name| name == SIDECAR)
        && parts.next().is_some_and(|name| name == "MacOS")
        && parts.next().is_some_and(|name| name == "Contents")
        && parts.next().is_some_and(|name| name.starts_with("Eavesy") && name.ends_with(".app"))
}

fn status_for(link: &Path, target: Option<&Path>) -> CliStatus {
    let (installed, conflict) = match existing(link, target) {
        Existing::Nothing => (false, false),
        Existing::Ours(points_to) => (target.is_some_and(|t| t == points_to), false),
        Existing::Foreign => (false, true),
    };
    CliStatus { available: target.is_some(), installed, conflict, link_path: link.to_string_lossy().into_owned() }
}

fn install(link: &Path, target: &Path) -> Result<(), String> {
    match existing(link, Some(target)) {
        Existing::Foreign => {
            return Err(format!("{} already exists and is not Eavesy's. Remove it, then try again.", link.display()))
        }
        Existing::Ours(points_to) if points_to == target => return Ok(()),
        Existing::Ours(_) | Existing::Nothing => {}
    }
    let dir = link.parent().ok_or_else(|| format!("{} has no parent folder", link.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    // Link beside it, then rename over: the command never disappears if this fails halfway.
    let temp = dir.join(format!(".eavesy-link-{}", uuid::Uuid::new_v4()));
    symlink(target, &temp).map_err(|e| format!("could not link {}: {e}", link.display()))?;
    std::fs::rename(&temp, link).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("could not link {}: {e}", link.display())
    })
}

/// Removes the link only when it is Eavesy's; never deletes anything else.
fn uninstall(link: &Path, current: Option<&Path>) -> Result<(), String> {
    match existing(link, current) {
        Existing::Ours(_) => std::fs::remove_file(link).map_err(|e| format!("could not remove {}: {e}", link.display())),
        Existing::Nothing => Ok(()),
        Existing::Foreign => Err(format!("{} is not Eavesy's, so it was left alone.", link.display())),
    }
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(ErrorKind::Unsupported, "only supported on macOS"))
}

#[tauri::command]
pub fn cli_status() -> Result<CliStatus, String> {
    Ok(status_for(&link_path()?, bundled_cli().as_deref()))
}

#[tauri::command]
pub fn set_cli_installed(enabled: bool) -> Result<CliStatus, String> {
    let link = link_path()?;
    let target = bundled_cli();
    if enabled {
        let target = target.as_deref().ok_or("This build of Eavesy does not include the eavesy command.")?;
        install(&link, target)?;
    } else {
        uninstall(&link, target.as_deref())?;
    }
    Ok(status_for(&link, target.as_deref()))
}

/// Startup: if the person installed the command and the app has since moved or
/// updated, point the link at this copy so it does not dangle.
pub fn repair_link() {
    let (Ok(link), Some(target)) = (link_path(), bundled_cli()) else { return };
    if let Existing::Ours(points_to) = existing(&link, Some(&target)) {
        if points_to != target {
            if let Err(error) = install(&link, &target) {
                eprintln!("could not update the eavesy command link: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eavesy-cli-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sidecar(dir: &Path, app: &str) -> PathBuf {
        let path = dir.join(app).join("Contents/MacOS").join(SIDECAR);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        path
    }

    #[test]
    fn installs_creates_the_bin_folder_and_reports_installed() {
        let dir = scratch();
        let target = sidecar(&dir, "Eavesy.app");
        let link = dir.join("home/.local/bin/eavesy");
        assert!(!status_for(&link, Some(&target)).installed);
        install(&link, &target).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), target);
        let status = status_for(&link, Some(&target));
        assert!(status.installed && status.available && !status.conflict);
        install(&link, &target).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(link.parent().unwrap()).unwrap().collect();
        assert_eq!(leftovers.len(), 1, "no temporary links left behind");
        uninstall(&link, Some(&target)).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        uninstall(&link, Some(&target)).unwrap();
    }

    #[test]
    fn repoints_a_link_from_a_moved_app() {
        let dir = scratch();
        let old = sidecar(&dir, "Downloads/Eavesy.app");
        let new = sidecar(&dir, "Applications/Eavesy.app");
        let link = dir.join("eavesy");
        install(&link, &old).unwrap();
        // While the old copy still exists it belongs to that copy, not this one.
        let status = status_for(&link, Some(&new));
        assert!(!status.installed && status.conflict);
        assert!(install(&link, &new).is_err());
        // Once it has moved away, the dangling link is repointed.
        std::fs::remove_dir_all(dir.join("Downloads")).unwrap();
        assert!(!status_for(&link, Some(&new)).conflict);
        install(&link, &new).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), new);
    }

    #[test]
    fn never_replaces_or_removes_someone_elses_eavesy() {
        let dir = scratch();
        let target = sidecar(&dir, "Eavesy.app");
        let file = dir.join("file/eavesy");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "mine").unwrap();
        let other_link = dir.join("link/eavesy");
        std::fs::create_dir_all(other_link.parent().unwrap()).unwrap();
        symlink(Path::new("/usr/local/lib/node_modules/@eavesy/cli/dist/eavesy.js"), &other_link).unwrap();
        // Same file name as the sidecar, but not inside an app bundle.
        let lookalike = dir.join("lookalike/eavesy");
        std::fs::create_dir_all(lookalike.parent().unwrap()).unwrap();
        symlink(Path::new("/opt/tools/eavesy-cli"), &lookalike).unwrap();
        // Bundle layout, but another app's bundle.
        let other_app = dir.join("other-app/eavesy");
        std::fs::create_dir_all(other_app.parent().unwrap()).unwrap();
        symlink(Path::new("/Applications/Other.app/Contents/MacOS/eavesy-cli"), &other_app).unwrap();

        for link in [&file, &other_link, &lookalike, &other_app] {
            assert!(status_for(link, Some(&target)).conflict);
            assert!(install(link, &target).is_err());
            assert!(uninstall(link, Some(&target)).is_err());
            assert!(std::fs::symlink_metadata(link).is_ok());
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");
    }

    #[test]
    fn a_dev_build_owns_a_link_to_its_own_sidecar() {
        let dir = scratch();
        let dev = dir.join("target/debug").join(SIDECAR);
        std::fs::create_dir_all(dev.parent().unwrap()).unwrap();
        std::fs::write(&dev, "#!/bin/sh\n").unwrap();
        let link = dir.join("eavesy");
        install(&link, &dev).unwrap();
        assert!(status_for(&link, Some(&dev)).installed);
        uninstall(&link, Some(&dev)).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn unavailable_without_a_bundled_cli() {
        let status = status_for(Path::new("/nonexistent/eavesy"), None);
        assert!(!status.available && !status.installed && !status.conflict);
    }
}
