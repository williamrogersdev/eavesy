//! Settings → Connections → Claude Code: adds Eavesy's plugin (the MCP server
//! plus its skill) to Claude Code on this Mac in one click, by running the same
//! `claude plugin` commands you'd type yourself. Both are safe to run again.
//! Signing in still happens in Claude Code (`/mcp`), since that's where the
//! OAuth token lives.

use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::WebviewWindow;

use super::install;

const MARKETPLACE: &str = "williamrogersdev/eavesy";
const PLUGIN: &str = "eavesy@eavesy";
/// Adding the marketplace clones a GitHub repo, which can be slow on a bad network.
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    /// Where the `claude` command is, when Eavesy can find it.
    pub cli: Option<String>,
    /// The Eavesy plugin is turned on in your Claude Code settings.
    pub plugin: bool,
    /// The bare MCP server was added for every folder (`claude mcp add --scope user`).
    pub server: bool,
}

/// Eavesy starts from Finder with a short PATH, so look where Claude Code's
/// installers put it, then ask your login shell.
fn cli_path() -> Option<PathBuf> {
    let home = dirs::home_dir();
    let known = [".local/bin/claude", ".claude/local/claude", ".bun/bin/claude", ".npm-global/bin/claude"]
        .into_iter()
        .filter_map(|rel| home.as_ref().map(|home| home.join(rel)))
        .chain(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    known.into_iter().find(|path| path.is_file()).or_else(|| from_login_shell().clone())
}

/// Asked once per run: status is checked every time you come back to Settings,
/// and a login shell reads all your rc files. Claude Code's installers put it in
/// one of the known places, so a later install is still found without this.
fn from_login_shell() -> &'static Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND.get_or_init(ask_login_shell)
}

fn ask_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").ok().map(PathBuf::from).filter(|shell| shell.is_absolute() && shell.is_file());
    let shell = shell.unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let out = run(&shell, &["-lc", "command -v claude"], Duration::from_secs(5)).ok()?;
    let path = PathBuf::from(out.lines().last()?.trim());
    path.is_absolute().then_some(path).filter(|path| path.is_file())
}

/// Runs `program`, giving up after `timeout`. Ok holds stdout; Err holds what it said went wrong.
fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Its own process group, so a timeout stops any helper it started too.
        .process_group(0)
        .spawn()
        .map_err(|error| format!("Couldn't run {}: {error}", program.display()))?;
    // Read on threads so a full pipe can't stall the command while we wait for it.
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            let _ = sender.send(text);
        });
        receiver
    };
    // A helper the command started can keep the pipe open after it's gone, so don't wait for ever.
    let collect = |receiver: std::sync::mpsc::Receiver<String>| receiver.recv_timeout(Duration::from_secs(3)).unwrap_or_default();
    let stdout = reader(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = reader(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                // SAFETY: kill(2) on the group this child leads; no memory is touched.
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude Code took too long to answer. Check your connection and try again.".into());
            }
        }
    };
    let out = collect(stdout);
    if status.success() {
        return Ok(out);
    }
    let said = collect(stderr);
    let said = if said.trim().is_empty() { out } else { said };
    Err(failure(&said))
}

/// The last few lines of what a failed command said: enough to see why, short enough to read.
fn failure(said: &str) -> String {
    let lines: Vec<&str> = said.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(4)..].join("\n");
    let mut text: String = tail.chars().take(600).collect();
    if text.is_empty() {
        text = "Claude Code couldn't add Eavesy, and didn't say why.".into();
    }
    text
}

fn read_json(file: &Path) -> Value {
    std::fs::read_to_string(file).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or(Value::Null)
}

fn plugin_enabled(settings: &Value) -> bool {
    settings.pointer("/enabledPlugins").and_then(|plugins| plugins.get(PLUGIN)).and_then(Value::as_bool) == Some(true)
}

/// `~/.claude.json` keeps servers added with `--scope user` at the top level.
fn server_added(config: &Value) -> bool {
    config.pointer("/mcpServers/eavesy").is_some()
}

fn status() -> ClaudeCodeStatus {
    let home = dirs::home_dir();
    ClaudeCodeStatus {
        cli: cli_path().map(|path| path.to_string_lossy().into_owned()),
        plugin: install::settings_file().is_some_and(|file| plugin_enabled(&read_json(&file))),
        server: home.is_some_and(|home| server_added(&read_json(&home.join(".claude.json")))),
    }
}

#[tauri::command(async)]
pub fn claude_code_status(window: WebviewWindow) -> Result<ClaudeCodeStatus, String> {
    crate::assistant::from_ui(&window)?;
    Ok(status())
}

#[tauri::command(async)]
pub fn connect_claude_code(window: WebviewWindow) -> Result<ClaudeCodeStatus, String> {
    crate::assistant::from_ui(&window)?;
    let cli = cli_path().ok_or("Eavesy couldn't find Claude Code on this Mac. Install it, or run the commands below yourself.")?;
    run(&cli, &["plugin", "marketplace", "add", MARKETPLACE], TIMEOUT)?;
    run(&cli, &["plugin", "install", PLUGIN, "--scope", "user"], TIMEOUT)?;
    Ok(status())
}

/// The name Claude Code knows Eavesy by. With both added it keeps your own
/// `eavesy` server and hides the plugin's copy of it.
fn server_name(status: &ClaudeCodeStatus) -> &'static str {
    if status.server { "eavesy" } else { "plugin:eavesy:eavesy" }
}

/// What the Terminal window runs: `claude mcp login` needs a real terminal,
/// and opens your browser to approve Claude Code.
fn sign_in_script(cli: &str, server: &str) -> String {
    format!(
        "#!/bin/sh\nclear\n{} mcp login {}\necho\necho 'You can close this window.'\n",
        crate::machine::shell_quote(cli),
        crate::machine::shell_quote(server),
    )
}

/// Opens Terminal signed in to nothing but `claude mcp login` for Eavesy.
#[tauri::command(async)]
pub fn sign_in_claude_code(window: WebviewWindow) -> Result<(), String> {
    crate::assistant::from_ui(&window)?;
    let status = status();
    let cli = status.cli.clone().ok_or("Eavesy couldn't find Claude Code on this Mac.")?;
    if !status.plugin && !status.server {
        return Err("Add Eavesy to Claude Code first.".into());
    }
    let file = write_script(&sign_in_script(&cli, server_name(&status))).map_err(|error| format!("Couldn't write the sign-in script: {error}"))?;
    let opened = Command::new("open").args(["-a", "Terminal"]).arg(&file).stdin(Stdio::null()).status().map_err(|error| error.to_string())?;
    if opened.success() { Ok(()) } else { Err("macOS couldn't open Terminal.".into()) }
}

/// A fresh folder only you can open, made new each time, so nothing else can
/// have put a file (or a link) where Terminal will run it.
fn write_script(script: &str) -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("eavesy-sign-in-{}", uuid::Uuid::new_v4().simple()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    let file = dir.join("Sign in to Eavesy.command");
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&file)?;
    out.write_all(script.as_bytes())?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_plugin_counts_only_when_turned_on() {
        assert!(plugin_enabled(&json!({ "enabledPlugins": { "eavesy@eavesy": true } })));
        assert!(!plugin_enabled(&json!({ "enabledPlugins": { "eavesy@eavesy": false } })));
        assert!(!plugin_enabled(&json!({ "enabledPlugins": { "other@x": true } })));
        assert!(!plugin_enabled(&Value::Null));
    }

    #[test]
    fn a_server_in_one_project_only_is_not_counted() {
        assert!(server_added(&json!({ "mcpServers": { "eavesy": { "type": "http" } } })));
        assert!(!server_added(&json!({ "projects": { "/x": { "mcpServers": { "eavesy": {} } } } })));
    }

    #[test]
    fn sign_in_uses_your_own_server_when_you_have_one() {
        let both = ClaudeCodeStatus { cli: None, plugin: true, server: true };
        let plugin = ClaudeCodeStatus { cli: None, plugin: true, server: false };
        assert_eq!(server_name(&both), "eavesy");
        assert_eq!(server_name(&plugin), "plugin:eavesy:eavesy");
        assert!(sign_in_script("/Users/o'neil/.local/bin/claude", "eavesy").contains(r"'/Users/o'\''neil/.local/bin/claude' mcp login 'eavesy'"));
    }

    #[test]
    fn a_failed_command_says_why() {
        let error = run(Path::new("/bin/sh"), &["-c", "echo nope >&2; exit 1"], Duration::from_secs(5)).unwrap_err();
        assert_eq!(error, "nope");
        let error = run(Path::new("/bin/sh"), &["-c", "printf 'Error: clone failed\\nfatal: auth\\n' >&2; exit 1"], Duration::from_secs(5)).unwrap_err();
        assert_eq!(error, "Error: clone failed\nfatal: auth");
        assert!(failure("").contains("didn't say why"));
        assert_eq!(run(Path::new("/bin/sh"), &["-c", "echo ok"], Duration::from_secs(5)).unwrap().trim(), "ok");
    }

    #[test]
    fn a_hung_command_is_stopped_with_its_helpers() {
        let started = Instant::now();
        // The background sleep holds the pipes open; killing the group closes them.
        assert!(run(Path::new("/bin/sh"), &["-c", "sleep 30 & sleep 30"], Duration::from_millis(200)).is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn the_script_goes_in_a_new_private_folder() {
        let one = write_script("echo hi").unwrap();
        let two = write_script("echo hi").unwrap();
        assert_ne!(one.parent(), two.parent());
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(one.parent().unwrap()).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o700);
        assert_eq!(std::fs::read_to_string(&one).unwrap(), "echo hi");
        for file in [one, two] {
            let _ = std::fs::remove_dir_all(file.parent().unwrap());
        }
    }
}
