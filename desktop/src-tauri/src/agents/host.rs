//! The app a Claude Code session runs in: a terminal, an editor or the Claude
//! desktop app. The hook reads it from its environment, the card names it
//! ("in iTerm"), and clicking the card brings that app to the front, with the
//! session's folder for an editor that can find its window by folder.

use std::path::Path;

/// Bundle id, the name the card shows, and the `TERM_PROGRAM` it sets.
const KNOWN: &[(&str, &str, Option<&str>)] = &[
    ("com.apple.Terminal", "Terminal", Some("Apple_Terminal")),
    ("com.googlecode.iterm2", "iTerm", Some("iTerm.app")),
    ("com.mitchellh.ghostty", "Ghostty", Some("ghostty")),
    ("dev.warp.Warp-Stable", "Warp", Some("WarpTerminal")),
    ("com.github.wez.wezterm", "WezTerm", Some("WezTerm")),
    ("net.kovidgoyal.kitty", "kitty", None),
    ("co.zeit.hyper", "Hyper", Some("Hyper")),
    ("com.microsoft.VSCode", "VS Code", Some("vscode")),
    ("com.microsoft.VSCodeInsiders", "VS Code Insiders", None),
    ("com.todesktop.230313mzl4w4u92", "Cursor", None),
    ("com.exafunction.windsurf", "Windsurf", None),
    ("dev.zed.Zed", "Zed", Some("zed")),
    ("com.anthropic.claudefordesktop", "Claude", None),
];

/// Editors that focus the window already showing a folder when it's opened again.
const OPENS_FOLDERS: &[&str] = &["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.todesktop.230313mzl4w4u92", "com.exafunction.windsurf", "dev.zed.Zed"];

/// A bundle id `open -b` can be handed safely: reverse-DNS letters only, never
/// a flag, never Eavesy itself.
pub fn valid_bundle(id: &str) -> bool {
    id.len() <= 128
        && id.contains('.')
        && !id.starts_with(['-', '.'])
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !id.eq_ignore_ascii_case("com.eavesy.desktop")
}

/// The session's app from the hook's environment. macOS sets
/// `__CFBundleIdentifier` for anything started from an app; `TERM_PROGRAM` is
/// the fallback for terminals that don't pass it on.
pub fn from_env(bundle: Option<&str>, term_program: Option<&str>) -> Option<String> {
    if let Some(bundle) = bundle.map(str::trim).filter(|id| valid_bundle(id)) {
        return Some(bundle.to_string());
    }
    let term = term_program.map(str::trim)?;
    KNOWN.iter().find(|(_, _, program)| *program == Some(term)).map(|(id, _, _)| id.to_string())
}

/// What the card calls the app.
pub fn name(bundle: &str) -> String {
    match KNOWN.iter().find(|(id, _, _)| id.eq_ignore_ascii_case(bundle)) {
        Some((_, name, _)) => name.to_string(),
        // `com.example.SomeTerm` reads as "SomeTerm".
        None => bundle.rsplit('.').next().unwrap_or(bundle).to_string(),
    }
}

/// The `open` arguments that bring the session's app forward.
pub fn open_args(bundle: &str, cwd: Option<&str>) -> Option<Vec<String>> {
    if !valid_bundle(bundle) {
        return None;
    }
    let mut args = vec!["-b".to_string(), bundle.to_string()];
    // An absolute path starts with `/`, so `open` can't read it as a flag.
    if let Some(cwd) = cwd.filter(|cwd| OPENS_FOLDERS.contains(&bundle) && cwd.starts_with('/') && Path::new(cwd).is_dir()) {
        args.push(cwd.to_string());
    }
    Some(args)
}

/// Brings the session's app to the front.
pub fn bring_forward(bundle: &str, cwd: Option<&str>) -> Result<(), String> {
    let args = open_args(bundle, cwd).ok_or("Eavesy doesn't know which app that session is in.")?;
    std::process::Command::new("/usr/bin/open")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Couldn't open {}: {error}", name(bundle)))
}

/// `/Users/me/Developer/x` reads as `~/Developer/x`.
pub fn short_path(cwd: &str) -> String {
    match dirs::home_dir().map(|home| home.to_string_lossy().into_owned()) {
        Some(home) if !home.is_empty() && (cwd == home || cwd.starts_with(&format!("{home}/"))) => format!("~{}", &cwd[home.len()..]),
        _ => cwd.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_id_wins_and_term_program_fills_in() {
        assert_eq!(from_env(Some("com.googlecode.iterm2"), Some("Apple_Terminal")).as_deref(), Some("com.googlecode.iterm2"));
        assert_eq!(from_env(None, Some("ghostty")).as_deref(), Some("com.mitchellh.ghostty"));
        assert_eq!(from_env(Some("com.eavesy.desktop"), Some("vscode")).as_deref(), Some("com.microsoft.VSCode"));
        assert_eq!(from_env(None, Some("tmux")), None);
        assert_eq!(from_env(None, None), None);
    }

    #[test]
    fn odd_bundle_ids_are_refused() {
        assert!(valid_bundle("com.apple.Terminal"));
        assert!(!valid_bundle("-a"));
        assert!(!valid_bundle("Terminal"));
        assert!(!valid_bundle("com.apple.Terminal; rm -rf"));
        assert!(!valid_bundle("com.eavesy.desktop"));
        assert_eq!(open_args("--args", None), None);
    }

    #[test]
    fn names_read_well() {
        assert_eq!(name("com.googlecode.iterm2"), "iTerm");
        assert_eq!(name("com.example.SomeTerm"), "SomeTerm");
    }

    #[test]
    fn only_editors_get_the_folder() {
        let dir = std::env::temp_dir();
        let dir = dir.to_str().unwrap();
        assert_eq!(open_args("com.apple.Terminal", Some(dir)).unwrap(), ["-b", "com.apple.Terminal"]);
        assert_eq!(open_args("com.microsoft.VSCode", Some(dir)).unwrap(), ["-b", "com.microsoft.VSCode", dir]);
        assert_eq!(open_args("com.microsoft.VSCode", Some("relative/path")).unwrap(), ["-b", "com.microsoft.VSCode"]);
    }
}
