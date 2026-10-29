//! Settings → Connections → Claude Code: adds Eavesy's plugin (the MCP server
//! plus its skill) to Claude Code on this Mac in one click, by running the same
//! `claude plugin` commands you'd type yourself. Both are safe to run again.
//! Signing in still happens in Claude Code (`claude mcp login`), since that's
//! where the OAuth token lives; `claude mcp get` tells us when it's done.

use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::WebviewWindow;

use super::install;

const MARKETPLACE: &str = "williamrogersdev/eavesy";
const MARKETPLACE_NAME: &str = "eavesy";
const PLUGIN: &str = "eavesy@eavesy";
/// Adding the marketplace clones a GitHub repo. Claude Code gives its own cache
/// refresh and its clone 120s each, so this outlasts both. A 120s limit here
/// killed the clone halfway on a slow first run, and only a second click (which
/// found the half-made copy and finished it) got through.
const ADD_TIMEOUT: Duration = Duration::from_secs(270);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Refreshing a plugin list already on disk is a small fetch.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(60);
/// `claude mcp get` checks the server over the network; a slow answer counts as "don't know".
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const SHELL_RETRY: Duration = Duration::from_secs(60);

/// Whether Claude Code on this Mac is signed in to Eavesy, as `claude mcp get` reports it.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Login {
    Connected,
    NeedsSignIn,
    /// Claude Code asked the server and it failed ("✘ Failed to connect").
    Failed,
    /// Couldn't ask: no answer in time, or one we don't recognise.
    Unknown,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeStatus {
    /// Where the `claude` command is, when Eavesy can find it.
    pub cli: Option<String>,
    /// The Eavesy plugin is turned on in your Claude Code settings.
    pub plugin: bool,
    /// The bare MCP server was added for every folder (`claude mcp add --scope user`).
    pub server: bool,
    /// Only checked once Eavesy is added; `None` before that.
    pub sign_in: Option<Login>,
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

/// Status is checked every time you come back to Settings, and a login shell
/// reads all your rc files, so a path it found is kept and a miss is asked
/// again at most once a minute (soon enough to notice a fresh install).
fn from_login_shell() -> Option<PathBuf> {
    static FOUND: Mutex<(Option<PathBuf>, Option<Instant>)> = Mutex::new((None, None));
    let lock = || FOUND.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    {
        let mut found = lock();
        if let Some(path) = found.0.as_ref().filter(|path| path.is_file()) {
            return Some(path.clone());
        }
        if found.1.is_some_and(|asked| asked.elapsed() < SHELL_RETRY) {
            return None;
        }
        // Marked as asked before the shell runs, so a second caller doesn't start another.
        found.1 = Some(Instant::now());
    }
    let path = ask_login_shell();
    lock().0.clone_from(&path);
    path
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
        .env("PATH", child_path(program))
        // From your home folder, so one project's `.mcp.json` doesn't change the answer.
        .current_dir(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
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
                // The readers aren't waited for here: once the group is gone they
                // finish on their own, and this call returns either way.
                // SAFETY: kill(2) on the group this child leads; no memory is touched.
                unsafe { libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                return Err(TOO_LONG.into());
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

const TOO_LONG: &str = "Claude Code took too long to answer. Check your connection and try again.";

/// Eavesy starts from Finder with only the system folders on PATH, which can't
/// find `git` from Homebrew, or `node` for a `claude` installed with npm. So the
/// folder `claude` is in and the usual install folders go first.
fn child_path(program: &Path) -> String {
    let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned()).unwrap_or_default();
    let mut dirs: Vec<String> = program.parent().map(|dir| dir.to_string_lossy().into_owned()).into_iter().collect();
    dirs.extend(["/opt/homebrew/bin".to_string(), "/usr/local/bin".to_string()]);
    dirs.extend([".local/bin", ".bun/bin", ".npm-global/bin"].map(|rel| format!("{home}/{rel}")));
    dirs.extend(std::env::var("PATH").unwrap_or_default().split(':').map(str::to_string));
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(str::to_string));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| !dir.is_empty() && seen.insert(dir.clone()));
    dirs.join(":")
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

/// `~/.claude/plugins/known_marketplaces.json` lists Eavesy's marketplace and its
/// copy is really on disk. A clone stopped halfway leaves neither, so it's added again.
fn marketplace_ready(known: &Value) -> bool {
    known
        .pointer(&format!("/{MARKETPLACE_NAME}/installLocation"))
        .and_then(Value::as_str)
        .is_some_and(|dir| Path::new(dir).join(".claude-plugin").join("marketplace.json").is_file())
}

/// Reads the `Status:` line of `claude mcp get`: "✔ Connected", "! Needs authentication", "✘ Failed to connect".
/// Only those phrases count; anything else is `Unknown`.
fn parse_sign_in(out: &str) -> Login {
    let Some(line) = out.lines().map(str::trim).find_map(|line| line.strip_prefix("Status:")) else {
        return Login::Unknown;
    };
    // Drop the leading mark (✔, !, ✘) and compare the words.
    let words = line.trim_start_matches(|c: char| !c.is_alphanumeric()).trim().to_lowercase();
    if words.starts_with("fail") {
        Login::Failed
    } else if words.starts_with("needs auth") {
        Login::NeedsSignIn
    } else if words == "connected" {
        Login::Connected
    } else {
        Login::Unknown
    }
}

/// How long one `claude mcp get` answer is reused. The sign-in poll asks every
/// few seconds, and each check can take up to `CHECK_TIMEOUT`.
const CHECK_REUSE: Duration = Duration::from_secs(4);

/// The last `claude mcp get` answer: when, for which server, and what it said.
static LAST_CHECK: Mutex<Option<(Instant, String, Login)>> = Mutex::new(None);

/// Asks Claude Code whether it's signed in, at most one check at a time: while
/// one runs, or just after, its answer is reused instead of starting another.
/// That's a deliberate trade: a second caller can wait up to `CHECK_TIMEOUT`
/// behind a slow check rather than start a second `claude` alongside it.
fn check_sign_in(cli: &Path, server: &str) -> Login {
    let fresh = |last: &Option<(Instant, String, Login)>| {
        last.as_ref().filter(|(at, name, _)| name == server && at.elapsed() < CHECK_REUSE).map(|(_, _, login)| *login)
    };
    // Holding the lock for the check makes a second caller wait for this answer, then reuse it.
    let mut last = LAST_CHECK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(login) = fresh(&last) {
        return login;
    }
    let login = run(cli, &["mcp", "get", server], CHECK_TIMEOUT).map_or(Login::Unknown, |out| parse_sign_in(&out));
    *last = Some((Instant::now(), server.to_string(), login));
    login
}

/// What's set up now. `check` also asks Claude Code whether it's signed in, which takes a moment.
fn status(check: bool) -> ClaudeCodeStatus {
    let home = dirs::home_dir();
    let mut status = ClaudeCodeStatus {
        cli: cli_path().map(|path| path.to_string_lossy().into_owned()),
        plugin: install::settings_file().is_some_and(|file| plugin_enabled(&read_json(&file))),
        server: home.is_some_and(|home| server_added(&read_json(&home.join(".claude.json")))),
        sign_in: None,
    };
    if check && (status.plugin || status.server) {
        let server = server_name(&status);
        status.sign_in = Some(status.cli.as_deref().map_or(Login::Unknown, |cli| check_sign_in(Path::new(cli), server)));
    }
    status
}

#[tauri::command(async)]
pub fn claude_code_status(window: WebviewWindow) -> Result<ClaudeCodeStatus, String> {
    crate::assistant::from_ui(&window)?;
    Ok(status(true))
}

/// One step of adding Eavesy, named so a failure says which one broke.
struct Step {
    number: u8,
    what: &'static str,
}

const STEP_MARKETPLACE: Step = Step { number: 1, what: "downloading Eavesy's plugin list from GitHub" };
const STEP_INSTALL: Step = Step { number: 2, what: "installing the Eavesy plugin" };

fn step_failed(step: &Step, said: &str) -> String {
    format!("Step {} of 2 ({}) didn't work. {said}", step.number, step.what)
}

/// A failure worth one more try: the network dropped, a clone broke off, or the
/// plugin list on disk is stale. Our own time limit isn't: the command hung
/// past Claude Code's own limits, and a second wait wouldn't help.
fn worth_retrying(said: &str) -> bool {
    if said == TOO_LONG {
        return false;
    }
    let said = said.to_lowercase();
    [
        // git and the network
        "timed out", "unable to access", "could not resolve host", "early eof", "connection reset", "failed to clone",
        "econnreset", "etimedout", "enotfound", "eai_again",
        // a stale plugin list (fixed by the refresh before the second try)
        "not found in marketplace",
    ]
    .iter()
    .any(|sign| said.contains(sign))
}

/// The pause before a second try, so a dropped connection has a moment to come back.
#[cfg(not(test))]
const RETRY_PAUSE: Duration = Duration::from_secs(2);
#[cfg(test)]
const RETRY_PAUSE: Duration = Duration::from_millis(1);

/// Runs a step, and once more (after `before_retry`) if it failed in a way a
/// second try fixes. A definite error is reported straight away.
fn run_twice(step: &Step, attempt: impl Fn() -> Result<String, String>, before_retry: impl Fn()) -> Result<(), String> {
    let result = match attempt() {
        Err(said) if worth_retrying(&said) => {
            std::thread::sleep(RETRY_PAUSE);
            before_retry();
            attempt()
        }
        other => other,
    };
    result.map(|_| ()).map_err(|said| step_failed(step, &said))
}

/// Adds the marketplace (unless a good copy is already there) and installs the plugin.
/// At worst (a clone that fails late, its retry, then an install, a refresh and
/// a second install: 2 × 270s + 120s + 60s + 120s) this is about fourteen minutes.
fn add_plugin(cli: &Path, plugins_dir: Option<&Path>) -> Result<(), String> {
    if !marketplace_on_disk(plugins_dir) {
        run_twice(&STEP_MARKETPLACE, || run(cli, &["plugin", "marketplace", "add", MARKETPLACE], ADD_TIMEOUT), || {})?;
    }
    run_twice(
        &STEP_INSTALL,
        || run(cli, &["plugin", "install", PLUGIN, "--scope", "user"], INSTALL_TIMEOUT),
        // An old copy of the plugin list may not have the plugin yet ("not found in
        // marketplace"): refresh it so the second try sees it.
        || {
            let _ = run(cli, &["plugin", "marketplace", "update", MARKETPLACE_NAME], UPDATE_TIMEOUT);
        },
    )
}

fn marketplace_on_disk(plugins_dir: Option<&Path>) -> bool {
    plugins_dir.is_some_and(|dir| marketplace_ready(&read_json(&dir.join("known_marketplaces.json"))))
}

fn plugins_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join("plugins"))
}

#[tauri::command(async)]
pub fn connect_claude_code(window: WebviewWindow) -> Result<ClaudeCodeStatus, String> {
    crate::assistant::from_ui(&window)?;
    let cli = cli_path().ok_or("Eavesy couldn't find Claude Code on this Mac. Install Claude Code, then try again.")?;
    let plugins_dir = plugins_dir();
    // Turned on, with its plugin list really on disk, means there's nothing to repair.
    if !(status(false).plugin && marketplace_on_disk(plugins_dir.as_deref())) {
        add_plugin(&cli, plugins_dir.as_deref())?;
        // A sign-in answer from before the plugin went in is stale now.
        *LAST_CHECK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
    Ok(status(true))
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
    let status = status(false);
    let cli = status.cli.clone().ok_or("Eavesy couldn't find Claude Code on this Mac.")?;
    if !status.plugin && !status.server {
        return Err("Add Eavesy to Claude Code first.".into());
    }
    let file = write_script(&sign_in_script(&cli, server_name(&status))).map_err(|error| format!("Couldn't write the sign-in script: {error}"))?;
    let opened = Command::new("open").args(["-a", "Terminal"]).arg(&file).stdin(Stdio::null()).status().map_err(|error| error.to_string())?;
    if opened.success() { Ok(()) } else { Err("macOS couldn't open Terminal.".into()) }
}

const SCRIPT_DIR_PREFIX: &str = "eavesy-sign-in-";
const SCRIPT_KEEP: Duration = Duration::from_secs(600);

/// A fresh folder only you can open, made new each time, so nothing else can
/// have put a file (or a link) where Terminal will run it. Terminal reads the
/// file after `open` returns, so only folders from earlier sign-ins that are
/// well past that are cleared.
fn write_script(script: &str) -> std::io::Result<PathBuf> {
    let temp = std::env::temp_dir();
    for entry in std::fs::read_dir(&temp).into_iter().flatten().flatten() {
        let old = entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|at| at.elapsed().unwrap_or_default() > SCRIPT_KEEP);
        if old && entry.file_name().to_string_lossy().starts_with(SCRIPT_DIR_PREFIX) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let dir = temp.join(format!("{SCRIPT_DIR_PREFIX}{}", uuid::Uuid::new_v4().simple()));
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
        let both = ClaudeCodeStatus { cli: None, plugin: true, server: true, sign_in: None };
        let plugin = ClaudeCodeStatus { cli: None, plugin: true, server: false, sign_in: None };
        assert_eq!(server_name(&both), "eavesy");
        assert_eq!(server_name(&plugin), "plugin:eavesy:eavesy");
        assert!(sign_in_script("/Users/o'neil/.local/bin/claude", "eavesy").contains(r"'/Users/o'\''neil/.local/bin/claude' mcp login 'eavesy'"));
    }

    #[test]
    fn sign_in_is_read_from_claude_mcp_get() {
        let get = |status: &str| format!("plugin:eavesy:eavesy:\n  Scope: User\n  Status: {status}\n  Type: http\n  URL: https://mcp.eavesy.com\n");
        assert_eq!(parse_sign_in(&get("✔ Connected")), Login::Connected);
        assert_eq!(parse_sign_in(&get("! Needs authentication")), Login::NeedsSignIn);
        assert_eq!(parse_sign_in(&get("✘ Failed to connect")), Login::Failed);
        assert_eq!(parse_sign_in(&get("✘ Failed to authenticate")), Login::Failed);
        assert_eq!(parse_sign_in(&get("✘ Disconnected")), Login::Unknown);
        assert_eq!(parse_sign_in(&get("✔ Connected (needs re-authentication soon)")), Login::Unknown);
        assert_eq!(parse_sign_in("No MCP server named \"eavesy\"."), Login::Unknown);
        assert_eq!(serde_json::to_value(Login::Failed).unwrap(), json!("failed"));
        assert_eq!(serde_json::to_value(Login::NeedsSignIn).unwrap(), json!("needsSignIn"));
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("eavesy-connect-test-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_half_cloned_marketplace_is_added_again() {
        let dir = temp_dir("ready");
        let known = json!({ "eavesy": { "installLocation": dir.to_string_lossy() } });
        assert!(!marketplace_ready(&known), "listed, but the clone never finished");
        std::fs::create_dir_all(dir.join(".claude-plugin")).unwrap();
        std::fs::write(dir.join(".claude-plugin/marketplace.json"), "{}").unwrap();
        assert!(marketplace_ready(&known));
        assert!(!marketplace_ready(&json!({ "other": { "installLocation": dir.to_string_lossy() } })));
        assert!(!marketplace_ready(&Value::Null));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A stand-in `claude` that logs each call and fails the first try of `fail_first`.
    fn fake_cli(dir: &Path, fail_first: &str) -> PathBuf {
        let cli = dir.join("claude");
        let script = format!(
            "#!/bin/sh\necho \"$*\" >> '{log}'\ncase \"$*\" in\n  '{fail_first}'*)\n    if [ ! -f '{seen}' ]; then touch '{seen}'; echo 'fatal: early EOF' >&2; exit 1; fi;;\nesac\nexit 0\n",
            log = dir.join("log").display(),
            seen = dir.join("seen").display(),
        );
        std::fs::write(&cli, script).unwrap();
        std::fs::set_permissions(&cli, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        cli
    }

    #[test]
    fn a_dropped_clone_is_tried_again_and_then_installs() {
        let dir = temp_dir("retry");
        let cli = fake_cli(&dir, "plugin marketplace add");
        add_plugin(&cli, Some(&dir)).unwrap();
        let log = std::fs::read_to_string(dir.join("log")).unwrap();
        assert_eq!(log.lines().collect::<Vec<_>>(), [
            "plugin marketplace add williamrogersdev/eavesy",
            "plugin marketplace add williamrogersdev/eavesy",
            "plugin install eavesy@eavesy --scope user",
        ]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_marketplace_already_there_is_not_added_again() {
        let dir = temp_dir("skip");
        let copy = dir.join("copy");
        std::fs::create_dir_all(copy.join(".claude-plugin")).unwrap();
        std::fs::write(copy.join(".claude-plugin/marketplace.json"), "{}").unwrap();
        std::fs::write(dir.join("known_marketplaces.json"), json!({ "eavesy": { "installLocation": copy.to_string_lossy() } }).to_string()).unwrap();
        // A stale plugin list: the first install fails, so the list is refreshed and install runs again.
        let cli = fake_cli(&dir, "plugin install");
        add_plugin(&cli, Some(&dir)).unwrap();
        let log = std::fs::read_to_string(dir.join("log")).unwrap();
        assert_eq!(log.lines().collect::<Vec<_>>(), [
            "plugin install eavesy@eavesy --scope user",
            "plugin marketplace update eavesy",
            "plugin install eavesy@eavesy --scope user",
        ]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_step_that_keeps_failing_is_named() {
        let tries = std::cell::Cell::new(0);
        let error = run_twice(&STEP_MARKETPLACE, || { tries.set(tries.get() + 1); Err("fatal: unable to access GitHub".into()) }, || {}).unwrap_err();
        assert_eq!(tries.get(), 2, "a network failure gets a second try");
        assert!(error.starts_with("Step 1 of 2 (downloading Eavesy's plugin list from GitHub) didn't work."), "{error}");
        assert!(error.ends_with("fatal: unable to access GitHub"));
    }

    #[test]
    fn a_definite_error_or_a_hang_is_not_tried_again() {
        for said in ["Error: Plugin manifest is invalid", TOO_LONG] {
            let tries = std::cell::Cell::new(0);
            let refreshed = std::cell::Cell::new(false);
            let error = run_twice(&STEP_INSTALL, || { tries.set(tries.get() + 1); Err(said.into()) }, || refreshed.set(true)).unwrap_err();
            assert_eq!(tries.get(), 1, "{said}");
            assert!(!refreshed.get());
            assert!(error.starts_with("Step 2 of 2"));
        }
        assert!(worth_retrying("Plugin \"eavesy\" not found in marketplace \"eavesy\""));
        assert!(worth_retrying("fatal: unable to access 'https://github.com/williamrogersdev/eavesy.git/': Could not resolve host"));
        // Definite errors that only mention network-ish words.
        assert!(!worth_retrying("Error: manifest field \"fetch\" is invalid"));
        assert!(!worth_retrying("Error: plugin declares connection settings it can't use"));
        assert!(!worth_retrying("Cloning repository (timeout: 120s)\nError: marketplace.json is not valid JSON"));
    }

    #[test]
    fn commands_can_find_tools_outside_the_finder_path() {
        let path = child_path(Path::new("/Users/you/.npm-global/bin/claude"));
        let dirs: Vec<&str> = path.split(':').collect();
        assert_eq!(dirs[0], "/Users/you/.npm-global/bin");
        assert!(dirs.contains(&"/opt/homebrew/bin") && dirs.contains(&"/usr/bin"));
        let unique: std::collections::HashSet<&str> = dirs.iter().copied().collect();
        assert_eq!(unique.len(), dirs.len());
    }

    #[test]
    fn a_command_finds_tools_next_to_it() {
        // Like an npm `claude` whose `#!/usr/bin/env node` needs `node` from its own folder.
        let dir = temp_dir("path");
        let helper = dir.join("eavesy-helper-only-here");
        std::fs::write(&helper, "#!/bin/sh\necho found\n").unwrap();
        std::fs::set_permissions(&helper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let cli = dir.join("claude");
        std::fs::write(&cli, "#!/bin/sh\neavesy-helper-only-here\n").unwrap();
        std::fs::set_permissions(&cli, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert_eq!(run(&cli, &[], Duration::from_secs(5)).unwrap().trim(), "found");
        let _ = std::fs::remove_dir_all(dir);
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
        let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(one.parent().unwrap()).unwrap().permissions());
        assert_eq!(mode & 0o777, 0o700);
        assert_eq!(std::fs::read_to_string(&one).unwrap(), "echo hi");
        let two = write_script("echo hi").unwrap();
        assert_ne!(one.parent(), two.parent());
        assert!(one.exists(), "a sign-in Terminal may not have read yet is kept");
        for file in [one, two] {
            let _ = std::fs::remove_dir_all(file.parent().unwrap());
        }
    }
}
