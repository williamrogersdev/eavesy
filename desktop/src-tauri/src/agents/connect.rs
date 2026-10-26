//! Settings → Connections → Claude Code: adds Eavesy's plugin (the MCP server
//! plus its skill) to Claude Code on this Mac in one click, by running the same
//! `claude plugin` commands you'd type yourself. Both are safe to run again.
//! Signing in still happens in Claude Code (`/mcp`), since that's where the
//! OAuth token lives.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    known.into_iter().find(|path| path.is_file()).or_else(from_login_shell)
}

fn from_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = run(Path::new(&shell), &["-lc", "command -v claude"], Duration::from_secs(5)).ok()?;
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
    Err(said.trim().lines().last().unwrap_or("Claude Code couldn't add Eavesy.").to_string())
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
    let dir = std::env::temp_dir().join("eavesy");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let file = dir.join("Sign in to Eavesy.command");
    std::fs::write(&file, sign_in_script(&cli, server_name(&status))).map_err(|error| error.to_string())?;
    std::fs::set_permissions(&file, std::os::unix::fs::PermissionsExt::from_mode(0o700)).map_err(|error| error.to_string())?;
    let opened = Command::new("open").args(["-a", "Terminal"]).arg(&file).stdin(Stdio::null()).status().map_err(|error| error.to_string())?;
    if opened.success() { Ok(()) } else { Err("macOS couldn't open Terminal.".into()) }
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
        assert_eq!(run(Path::new("/bin/sh"), &["-c", "echo ok"], Duration::from_secs(5)).unwrap().trim(), "ok");
    }

    #[test]
    fn a_hung_command_is_stopped() {
        assert!(run(Path::new("/bin/sh"), &["-c", "sleep 5"], Duration::from_millis(200)).is_err());
    }
}
