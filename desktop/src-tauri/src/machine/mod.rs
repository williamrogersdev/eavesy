//! What's on this Mac that agent sessions left behind
//! (docs/plans/machine-companion.md, first slice): git worktrees whose work
//! has landed, processes whose Claude Code session ended, and the ports
//! your processes listen on.
//!
//! Read-only until you click. Settings lists the inventory; a confirm card
//! names exactly what goes, and only then are worktrees removed (never
//! forced) and processes sent SIGTERM. Everything is checked again right
//! before it's touched, so the list the card sends back is only a request.
//! Nothing here runs in the background or on its own.

pub mod ports;
pub mod procs;
pub mod prs;
pub mod worktrees;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::assistant::{self, cards::Row, policy::{Facts, Tier}, rules::{Kind, Scope}, Action, Ran};
use procs::{Label, Proc};
use worktrees::{Base, MergedVia, Status};

/// A folder whose Claude Code transcript changed this recently is still in use.
const RECENT_SESSION: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a leftover gets to stop its own helpers before they're asked too.
const HELPER_GRACE: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeRow {
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub status: Status,
    /// False in the quick first pass for a worktree that still needs a closer
    /// look (a squash-merged branch looks unmerged until `machine_worktree_details`
    /// checks, and a merged one might have changes). Missing, locked and in-use
    /// are settled at once.
    pub settled: bool,
}

/// What the closer look found for one worktree.
#[derive(Debug, Serialize, PartialEq)]
pub struct WorktreeDetail {
    pub path: String,
    /// The final status, now that it's been checked.
    pub status: Status,
    pub merged_via: Option<MergedVia>,
    /// Staged, unstaged and untracked files (not ignored ones).
    pub changes: usize,
    pub last_commit_ms: Option<u64>,
    /// The later of the last commit and the last Claude Code session there.
    pub last_activity_ms: Option<u64>,
    /// The default branch it's compared with.
    pub base: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
}

/// How much of a worktree to look at.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Listing, in-use and the ancestry check: enough to show rows.
    Quick,
    /// Exactly what its status needs, settled (removal and the assistant).
    Deep,
}

#[derive(Debug, Serialize)]
pub struct LeftoverRow {
    pub pid: u32,
    pub started_us: u64,
    pub name: String,
    pub exe: String,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    /// Leftovers it started, stopped along with it.
    pub helpers: usize,
    pub ports: Vec<u16>,
}

#[derive(Debug, Serialize)]
pub struct ZombieRow {
    pub pid: u32,
    pub parent_pid: u32,
    pub parent_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PortOwner {
    Leftover,
    Session,
    Other,
}

#[derive(Debug, Serialize)]
pub struct PortRow {
    pub port: u16,
    pub address: String,
    pub pid: u32,
    pub name: String,
    pub cwd: Option<String>,
    pub owner: PortOwner,
}

#[derive(Debug, Serialize, Default)]
pub struct Inventory {
    pub repos: Vec<String>,
    pub worktrees: Vec<WorktreeRow>,
    pub leftovers: Vec<LeftoverRow>,
    pub zombies: Vec<ZombieRow>,
    pub ports: Vec<PortRow>,
}

/// The repos to look in: every checkout directly in `~/Developer`, and the
/// repo of every running Claude Code session.
fn repo_roots(home: &Path, procs: &[Proc]) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(home.join("Developer"))
        .map(|entries| entries.flatten().map(|entry| entry.path()).filter(|path| path.join(".git").is_dir()).collect())
        .unwrap_or_default();
    let uid = procs::own_uid();
    let session_dirs: HashSet<&str> = procs.iter().filter(|proc| proc.uid == uid && procs::is_agent(proc)).filter_map(|proc| proc.cwd.as_deref()).collect();
    // One `git rev-parse` per running session; they don't depend on each other.
    let session_repos: Vec<Option<PathBuf>> = std::thread::scope(|scope| {
        let workers: Vec<_> = session_dirs.iter().map(|dir| scope.spawn(move || session_repo(dir))).collect();
        workers.into_iter().map(|worker| worker.join().unwrap_or(None)).collect()
    });
    candidates.extend(session_repos.into_iter().flatten());
    let mut seen = HashSet::new();
    candidates.into_iter().filter_map(|path| path.canonicalize().ok()).filter(|path| seen.insert(path.clone())).collect()
}

/// The repo a session's folder belongs to, when it's a normal checkout.
fn session_repo(dir: &str) -> Option<PathBuf> {
    let output = std::process::Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let common = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    if common.file_name().is_some_and(|name| name == ".git") { common.parent().map(Path::to_path_buf) } else { None }
}

const THREADS: usize = 8;

/// One repo's scan: its rows, plus what the closer look needs again.
struct RepoScan {
    repo: String,
    rows: Vec<WorktreeRow>,
    bases: Vec<Base>,
    linked: Vec<worktrees::Entry>,
}

/// Your processes' folders, and whether a session wrote in `entry` lately.
fn in_use(home: &Path, entry: &worktrees::Entry, cwds: &[&str]) -> bool {
    cwds.iter().any(|cwd| worktrees::inside(cwd, &entry.path)) || worktrees::recent_session(home, &entry.path, RECENT_SESSION)
}

fn exists(entry: &worktrees::Entry) -> bool {
    Path::new(&entry.path).is_dir() && !entry.prunable
}

/// The first pass for one worktree: what's known without `git status` or a
/// merge, and whether that settles it.
fn quick(home: &Path, repo: &Path, bases: &[Base], entry: &worktrees::Entry, cwds: &[&str]) -> (Status, bool) {
    let facts = worktrees::Facts { exists: exists(entry), locked: entry.locked, dirty: false, in_use: in_use(home, entry, cwds), merged: false };
    if !facts.exists || facts.locked || facts.in_use {
        return (worktrees::classify(&facts), true);
    }
    // Ancestry only. Squash merges and uncommitted changes are for `inspect`.
    let merged = entry.head.as_deref().is_some_and(|head| worktrees::merged_by_ancestry(repo, head, bases));
    (if merged { Status::Stale } else { Status::Unmerged }, false)
}

/// The closer look at one worktree. `full` also reads the commit time, the
/// distance from the default branch and the changes of an unmerged one;
/// without it, only what the status needs (see worktrees::classify).
fn inspect(home: &Path, repo: &Path, bases: &[Base], entry: &worktrees::Entry, cwds: &[&str], full: bool) -> WorktreeDetail {
    let path = Path::new(&entry.path);
    let mut facts = worktrees::Facts { exists: exists(entry), locked: entry.locked, dirty: false, in_use: in_use(home, entry, cwds), merged: false };
    let mut detail = WorktreeDetail {
        path: entry.path.clone(),
        status: Status::Missing,
        merged_via: None,
        changes: 0,
        last_commit_ms: None,
        last_activity_ms: None,
        base: None,
        ahead: None,
        behind: None,
    };
    if facts.exists {
        if !facts.locked && !facts.in_use {
            detail.merged_via = entry.head.as_deref().and_then(|head| worktrees::merged_via(repo, head, bases));
            facts.merged = detail.merged_via.is_some();
        }
        // Removal also loses ignored files, so a merged one is read with them;
        // for everything else the plain status is the fast one.
        if facts.merged || full {
            let changes = worktrees::changes(path, facts.merged);
            detail.changes = changes.map_or(0, |changes| changes.changed);
            facts.dirty = facts.merged && changes.is_none_or(|changes| changes.would_lose);
        }
        if full {
            detail.last_commit_ms = worktrees::last_commit_ms(path);
            let session = worktrees::last_session_ms(home, &entry.path);
            detail.last_activity_ms = detail.last_commit_ms.max(session);
            if let Some(base) = bases.first() {
                detail.base = Some(base.name.clone());
                if let Some((ahead, behind)) = worktrees::ahead_behind(path, &base.name) {
                    detail.ahead = Some(ahead);
                    detail.behind = Some(behind);
                }
            }
        }
    }
    detail.status = worktrees::classify(&facts);
    detail
}

/// Runs `work` over `items` on up to `THREADS` threads, keeping their order.
fn parallel<T: Sync, R: Send>(items: &[T], work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let chunk = items.len().div_ceil(THREADS).max(1);
    std::thread::scope(|scope| {
        let work = &work;
        let workers: Vec<_> = items.chunks(chunk).map(|items| scope.spawn(move || items.iter().map(work).collect::<Vec<_>>())).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap_or_default()).collect()
    })
}

/// One repo's linked worktrees, from its `git worktree list` (the first
/// entry is the main checkout, which is never removed). `cwds` are where your
/// processes run. `only` limits it to those paths.
fn repo_rows(home: &Path, entries: &[worktrees::Entry], cwds: &[&str], mode: Mode, only: Option<&HashSet<String>>) -> Option<RepoScan> {
    let main = entries.first()?;
    let repo = PathBuf::from(&main.path);
    let bases = worktrees::bases(&repo);
    let linked: Vec<worktrees::Entry> = entries.iter().skip(1).filter(|entry| !entry.bare).cloned().collect();
    let wanted: Vec<&worktrees::Entry> = linked.iter().filter(|entry| only.is_none_or(|only| only.contains(&entry.path))).collect();
    let rows = parallel(&wanted, |entry| {
        let (status, settled) = match mode {
            Mode::Quick => quick(home, &repo, &bases, entry, cwds),
            Mode::Deep => (inspect(home, &repo, &bases, entry, cwds, false).status, true),
        };
        WorktreeRow {
            path: entry.path.clone(),
            repo: main.path.clone(),
            branch: entry.branch.as_deref().map(|branch| branch.trim_start_matches("refs/heads/").to_string()),
            status,
            settled,
        }
    });
    Some(RepoScan { repo: main.path.clone(), rows, bases, linked })
}

fn worktree_rows(home: &Path, procs: &[Proc], mode: Mode, only: Option<&HashSet<String>>) -> Vec<RepoScan> {
    let uid = procs::own_uid();
    let cwds: Vec<&str> = procs.iter().filter(|proc| proc.uid == uid && !proc.zombie).filter_map(|proc| proc.cwd.as_deref()).collect();
    let roots = repo_roots(home, procs);
    // Every repo's `git worktree list`, then each repo's rows, at the same time.
    let listed = parallel(&roots, |root| worktrees::list(root));
    let mut seen = HashSet::new();
    // Two roots can be the same repo; scan it once.
    let lists: Vec<&Vec<worktrees::Entry>> = listed.iter().filter(|entries| entries.first().is_some_and(|main| seen.insert(main.path.clone()))).collect();
    parallel(&lists, |entries| repo_rows(home, entries, &cwds, mode, only)).into_iter().flatten().collect()
}

/// What `machine_inventory` last listed, so the later calls (details, sizes,
/// pull requests, reveal) only act on worktrees Eavesy itself showed and never
/// on a path the window made up.
#[derive(Default)]
struct Listed {
    entries: HashMap<String, (String, worktrees::Entry)>,
    bases: HashMap<String, Vec<Base>>,
}

static LISTED: Mutex<Option<Listed>> = Mutex::new(None);

fn remember(scans: &[RepoScan]) {
    let mut listed = Listed::default();
    for scan in scans {
        listed.bases.insert(scan.repo.clone(), scan.bases.clone());
        for entry in &scan.linked {
            listed.entries.insert(entry.path.clone(), (scan.repo.clone(), entry.clone()));
        }
    }
    if let Ok(mut slot) = LISTED.lock() {
        *slot = Some(listed);
    }
}

/// A listed worktree's repo and git entry, or None for a path Eavesy didn't list.
fn listed_entry(path: &str) -> Option<(String, worktrees::Entry)> {
    LISTED.lock().ok()?.as_ref()?.entries.get(path).cloned()
}

fn listed_bases(repo: &str) -> Option<Vec<Base>> {
    LISTED.lock().ok()?.as_ref()?.bases.get(repo).cloned()
}

/// The closer look at listed worktrees. Paths that weren't listed are skipped.
fn details(paths: &[String]) -> Vec<WorktreeDetail> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    let procs = procs::snapshot();
    let uid = procs::own_uid();
    let cwds: Vec<&str> = procs.iter().filter(|proc| proc.uid == uid && !proc.zombie).filter_map(|proc| proc.cwd.as_deref()).collect();
    let wanted: Vec<(String, worktrees::Entry)> = paths.iter().filter_map(|path| listed_entry(path)).collect();
    parallel(&wanted, |(repo, entry)| {
        let bases = listed_bases(repo).unwrap_or_default();
        inspect(&home, Path::new(repo), &bases, entry, &cwds, true)
    })
}

fn gather(mode: Mode) -> (Vec<Proc>, Inventory, Vec<RepoScan>) {
    let procs = procs::snapshot();
    let uid = procs::own_uid();
    let labels = procs::classify(&procs, uid, std::process::id());
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|proc| (proc.pid, proc)).collect();
    let listeners = ports::listening(uid);
    let groups = procs::orphan_groups(&procs, &labels);

    let leftovers = groups
        .iter()
        .filter_map(|(root, helpers)| {
            let proc = by_pid.get(root)?;
            let group: HashSet<u32> = helpers.iter().copied().chain([*root]).collect();
            let mut ports: Vec<u16> = listeners.iter().filter(|l| group.contains(&l.pid)).map(|l| l.port).collect();
            ports.dedup();
            Some(LeftoverRow {
                pid: proc.pid,
                started_us: proc.started_us,
                name: proc.name.clone(),
                exe: proc.exe.clone(),
                cwd: proc.cwd.clone(),
                session_id: proc.tag.as_ref().and_then(|tag| tag.session_id.clone()),
                helpers: helpers.len(),
                ports,
            })
        })
        .collect();
    let zombies = procs
        .iter()
        .filter(|proc| proc.uid == uid && proc.zombie)
        .map(|proc| ZombieRow { pid: proc.pid, parent_pid: proc.ppid, parent_name: by_pid.get(&proc.ppid).map(|parent| parent.name.clone()) })
        .collect();
    let ports = listeners
        .iter()
        .map(|listener| {
            let proc = by_pid.get(&listener.pid);
            PortRow {
                port: listener.port,
                address: listener.address.clone(),
                pid: listener.pid,
                name: proc.map(|proc| proc.name.clone()).unwrap_or_default(),
                cwd: proc.and_then(|proc| proc.cwd.clone()),
                owner: match labels.get(&listener.pid) {
                    Some(Label::Orphan) => PortOwner::Leftover,
                    Some(Label::Live) => PortOwner::Session,
                    None => PortOwner::Other,
                },
            }
        })
        .collect();
    let scans = dirs::home_dir().map(|home| worktree_rows(&home, &procs, mode, None)).unwrap_or_default();
    let repos = scans.iter().map(|scan| scan.repo.clone()).collect();
    let worktrees = scans.iter().flat_map(|scan| scan.rows.iter().cloned()).collect();
    (procs, Inventory { repos, worktrees, leftovers, zombies, ports }, scans)
}

/// The inventory, for the assistant's `machine_overview` tool. Blocking, and
/// every status is settled.
pub fn inventory() -> Inventory {
    gather(Mode::Deep).1
}

impl Inventory {
    pub fn stale_worktrees(&self) -> usize {
        self.worktrees.iter().filter(|row| row.status == Status::Stale).count()
    }
}

/// The quick first pass: worktrees, processes and ports, with each worktree's
/// status settled only where it's cheap to know (`WorktreeRow::settled`). The
/// rest comes from `machine_worktree_details`.
#[tauri::command]
pub async fn machine_inventory() -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (_, inventory, scans) = gather(Mode::Quick);
        remember(&scans);
        inventory
    })
    .await
    .map_err(|error| error.to_string())
}

/// The closer look at some worktrees from the last `machine_inventory`: the
/// final status, changes, last activity and distance from the default branch.
/// Read-only; a path that wasn't listed is skipped.
#[tauri::command]
pub async fn machine_worktree_details(paths: Vec<String>) -> Result<Vec<WorktreeDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || details(&paths)).await.map_err(|error| error.to_string())
}

/// How much disk a listed worktree takes, in bytes. `du` can take a while on
/// `node_modules`, so Settings asks for one at a time and nothing waits on it.
#[tauri::command]
pub async fn machine_worktree_size(path: String) -> Result<Option<u64>, String> {
    if listed_entry(&path).is_none() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || worktrees::size_bytes(Path::new(&path))).await.map_err(|error| error.to_string())
}

/// Pull requests for one listed repo's branches, when `gh` can say.
#[tauri::command]
pub async fn machine_repo_prs(repo: String) -> Result<prs::Prs, String> {
    if listed_bases(&repo).is_none() {
        return Ok(prs::Prs::default());
    }
    tauri::async_runtime::spawn_blocking(move || prs::list(Path::new(&repo))).await.map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpenHow {
    /// Show it in Finder.
    Reveal,
    /// A Terminal window in it.
    Terminal,
}

/// What `open` is asked to do for a listed worktree.
fn open_args(how: OpenHow, path: &str) -> Vec<String> {
    match how {
        OpenHow::Reveal => vec!["-R".into(), path.into()],
        OpenHow::Terminal => vec!["-a".into(), "Terminal".into(), path.into()],
    }
}

/// `https://github.com/owner/repo/pull/12` and nothing else: the one kind of
/// link a pull request chip opens.
fn is_pr_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    let name = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    matches!(parts.as_slice(), [owner, repo, "pull", number] if name(owner) && name(repo) && !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}

/// Opens a pull request's page in the browser.
#[tauri::command]
pub async fn machine_open_pr(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Opening a pull request only works from Settings.".into());
    }
    if !is_pr_url(&url) {
        return Err("That isn't a GitHub pull request link.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let status = std::process::Command::new("open").arg(&url).stdin(std::process::Stdio::null()).status().map_err(|error| error.to_string())?;
        if status.success() { Ok(()) } else { Err("macOS couldn't open it.".to_string()) }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Shows a worktree in Finder or opens Terminal in it. Only for a worktree
/// the inventory listed, and only from Settings.
#[tauri::command]
pub async fn machine_open_worktree(window: tauri::WebviewWindow, path: String, how: OpenHow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Opening a worktree only works from Settings.".into());
    }
    if listed_entry(&path).is_none() || !Path::new(&path).is_dir() {
        return Err("That worktree isn't there any more.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let status = std::process::Command::new("open").args(open_args(how, &path)).stdin(std::process::Stdio::null()).status().map_err(|error| error.to_string())?;
        if status.success() { Ok(()) } else { Err("macOS couldn't open it.".to_string()) }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Clone, Debug, Deserialize)]
pub struct ProcessRef {
    pub pid: u32,
    pub started_us: u64,
}

#[derive(Debug, Serialize)]
pub struct Outcome {
    /// The worktree path, or the process's pid.
    pub target: String,
    pub ok: bool,
    pub message: Option<String>,
    /// How to bring a removed worktree back.
    pub restore: Option<String>,
}

/// `'…'` for a shell, so a path or branch with a quote in it stays one word.
pub(crate) fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Nothing of yours runs in the worktree, no session wrote there lately, and
/// it holds nothing removal would lose.
fn safe_to_remove_now(home: &Path, procs: &[Proc], worktree: &str) -> bool {
    let uid = procs::own_uid();
    let running = procs.iter().filter(|proc| proc.uid == uid && !proc.zombie).filter_map(|proc| proc.cwd.as_deref()).any(|cwd| worktrees::inside(cwd, worktree));
    !running && !worktrees::recent_session(home, worktree, RECENT_SESSION) && !worktrees::dirty(Path::new(worktree))
}

fn clean(worktree_paths: Vec<String>, processes: Vec<ProcessRef>) -> Vec<Outcome> {
    let procs = procs::snapshot();
    // Only the worktrees asked for are looked at, so a few don't wait on a scan of them all.
    let asked: HashSet<String> = worktree_paths.iter().cloned().collect();
    let scans = if asked.is_empty() { Vec::new() } else { dirs::home_dir().map(|home| worktree_rows(&home, &procs, Mode::Deep, Some(&asked))).unwrap_or_default() };
    let rows: Vec<WorktreeRow> = scans.into_iter().flat_map(|scan| scan.rows).collect();
    let labels = procs::classify(&procs, procs::own_uid(), std::process::id());
    let groups = procs::orphan_groups(&procs, &labels);
    let started: HashMap<u32, u64> = procs.iter().map(|proc| (proc.pid, proc.started_us)).collect();
    let mut outcomes = Vec::new();

    let mut helpers_to_stop = Vec::new();
    for wanted in processes {
        let target = wanted.pid.to_string();
        let group = groups.iter().find(|(root, _)| *root == wanted.pid && started.get(root) == Some(&wanted.started_us));
        let Some((root, helpers)) = group else {
            outcomes.push(Outcome { target, ok: false, message: Some("It isn't a leftover any more.".into()), restore: None });
            continue;
        };
        let result = procs::terminate(*root, wanted.started_us);
        tracing::info!(pid = root, ok = result.is_ok(), "machine: asked a leftover process to stop");
        if result.is_ok() {
            helpers_to_stop.extend(helpers.iter().filter_map(|pid| started.get(pid).map(|start| (*pid, *start))));
        }
        outcomes.push(Outcome { target, ok: result.is_ok(), message: result.err(), restore: None });
    }
    if !helpers_to_stop.is_empty() {
        std::thread::sleep(HELPER_GRACE);
        for (pid, start) in helpers_to_stop {
            // Most stop with their parent; a helper that's gone is fine.
            let _ = procs::terminate(pid, start);
        }
    }

    let home = dirs::home_dir().unwrap_or_default();
    for path in worktree_paths {
        let row = rows.iter().find(|row| row.path == path);
        // Stopping processes and removing the ones before it took time, so
        // look again, right before it goes. A process that starts in it in
        // the milliseconds between this check and git's own is the one window
        // left; git still refuses changes and untracked files then.
        let still_stale = row.is_some_and(|row| row.status == Status::Stale) && safe_to_remove_now(&home, &procs::snapshot(), &path);
        let Some(row) = row.filter(|_| still_stale) else {
            outcomes.push(Outcome { target: path, ok: false, message: Some("It isn't safe to remove any more.".into()), restore: None });
            continue;
        };
        let result = worktrees::remove(Path::new(&row.repo), &row.path);
        tracing::info!(ok = result.is_ok(), "machine: removed a stale worktree");
        let restore = row.branch.as_ref().map(|branch| format!("git -C {} worktree add {} {}", shell_quote(&row.repo), shell_quote(&row.path), shell_quote(branch)));
        outcomes.push(Outcome { target: path, ok: result.is_ok(), restore: restore.filter(|_| result.is_ok()), message: result.err() });
    }
    outcomes
}

/// Called by the confirm card in Settings, and refused from any other
/// window. It's a Tauri command, so only Eavesy's own webviews can call it;
/// the agents socket (agents/mod.rs) only reads hook messages.
#[tauri::command]
pub async fn machine_clean(window: tauri::WebviewWindow, worktrees: Vec<String>, processes: Vec<ProcessRef>) -> Result<serde_json::Value, String> {
    if window.label() != "settings" {
        return Err("Cleaning up only works from Settings.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let action = Clean { worktrees, processes, labels: HashMap::new(), folders: HashMap::new() };
        let rows: Vec<String> = action.rows().into_iter().map(|row| row.id).collect();
        assistant::run_clicked(&action, &rows).detail
    })
    .await
    .map_err(|error| error.to_string())
}

/// Removing worktrees and stopping leftovers, as a tool on the action core. It's
/// tier 3 and not undoable: a stopped process can't be restarted for you, and a
/// removed worktree comes back only by hand with its restore line.
pub struct Clean {
    pub worktrees: Vec<String>,
    pub processes: Vec<ProcessRef>,
    /// What each row says on a card, by row id (C1: names, folders, ports).
    pub labels: HashMap<String, String>,
    /// The folder each leftover process runs in, by row id, from the inventory, so a
    /// rule you accepted can cover it (C3).
    pub folders: HashMap<String, PathBuf>,
}

impl Clean {
    /// For a request from Eavesy's conversation: keeps only worktrees that are stale and
    /// processes that are leftovers right now, and labels each row so the card and the
    /// check (C7) can see what it is. Blocking.
    pub fn described(worktrees: &[String], processes: &[ProcessRef]) -> Result<Clean, String> {
        let inventory = inventory();
        let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned()).unwrap_or_default();
        let short = |path: &str| match path.strip_prefix(&home) {
            Some(rest) if !home.is_empty() => format!("~{rest}"),
            _ => path.to_string(),
        };
        let mut labels = HashMap::new();
        let mut folders = HashMap::new();
        let worktrees: Vec<String> = inventory
            .worktrees
            .iter()
            .filter(|row| row.status == Status::Stale && worktrees.contains(&row.path))
            .map(|row| {
                let branch = row.branch.as_deref().map(|branch| format!(" · {branch}, merged")).unwrap_or_default();
                labels.insert(format!("worktree:{}", row.path), format!("Remove worktree {}{branch}", short(&row.path)));
                row.path.clone()
            })
            .collect();
        let processes: Vec<ProcessRef> = inventory
            .leftovers
            .iter()
            .filter(|row| processes.iter().any(|asked| asked.pid == row.pid && asked.started_us == row.started_us))
            .map(|row| {
                let process = ProcessRef { pid: row.pid, started_us: row.started_us };
                let folder = row.cwd.as_deref().map(|cwd| format!(" in {}", short(cwd))).unwrap_or_default();
                let ports = if row.ports.is_empty() {
                    String::new()
                } else {
                    format!(" · port {}", row.ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", "))
                };
                let helpers = if row.helpers > 0 { format!(" · with {} helper{}", row.helpers, plural(row.helpers)) } else { String::new() };
                labels.insert(Clean::process_row(&process), format!("Stop {} (pid {}){folder}{ports}{helpers}", row.name, row.pid));
                if let Some(cwd) = &row.cwd {
                    folders.insert(Clean::process_row(&process), PathBuf::from(cwd));
                }
                process
            })
            .collect();
        if worktrees.is_empty() && processes.is_empty() {
            return Err("None of those are finished worktrees or leftover processes right now.".into());
        }
        Ok(Clean { worktrees, processes, labels, folders })
    }

    fn process_row(process: &ProcessRef) -> String { format!("process:{}:{}", process.pid, process.started_us) }
}

impl assistant::Action for Clean {
    fn tool(&self) -> &'static str { "machine.clean" }

    fn facts(&self) -> Facts {
        Facts {
            tier: Tier::Click,
            undoable: false,
            // On Auto's safe list (C8): every row is checked again right before it goes.
            safe_listed: true,
            irreversible: false,
            grants_power: false,
            remote_allowed: false,
            items: self.worktrees.len() + self.processes.len(),
            always_allowed: false,
            you_only: false,
        }
    }

    fn title(&self) -> String {
        match (self.worktrees.len(), self.processes.len()) {
            (w, 0) => format!("Remove {w} finished worktree{}", plural(w)),
            (0, p) => format!("Stop {p} leftover process{}", if p == 1 { "" } else { "es" }),
            (w, p) => format!("Remove {w} worktree{} and stop {p} leftover process{}", plural(w), if p == 1 { "" } else { "es" }),
        }
    }

    fn rows(&self) -> Vec<Row> {
        let label = |id: String, fallback: String| Row { label: self.labels.get(&id).cloned().unwrap_or(fallback), id };
        let worktrees = self.worktrees.iter().map(|path| label(format!("worktree:{path}"), path.clone()));
        let processes = self.processes.iter().map(|process| label(Clean::process_row(process), format!("process {}", process.pid)));
        worktrees.chain(processes).collect()
    }

    fn scopes(&self) -> Vec<Scope> {
        let worktrees = self.worktrees.iter().map(|path| Scope { kind: Kind::RemoveWorktrees, path: Some(PathBuf::from(path)) });
        let processes = self.processes.iter().map(|process| Scope { kind: Kind::StopLeftovers, path: self.folders.get(&Clean::process_row(process)).cloned() });
        worktrees.chain(processes).collect()
    }

    fn run(&self, rows: &[String]) -> Ran {
        let worktrees = self.worktrees.iter().filter(|path| rows.contains(&format!("worktree:{path}"))).cloned().collect();
        let processes = self.processes.iter().filter(|process| rows.contains(&Clean::process_row(process))).cloned().collect();
        let outcomes = clean(worktrees, processes);
        let done = outcomes.iter().filter(|outcome| outcome.ok).count();
        Ran {
            summary: format!("{done} of {} done", outcomes.len()),
            detail: serde_json::to_value(&outcomes).unwrap_or_default(),
        }
    }
}

fn plural(n: usize) -> &'static str { if n == 1 { "" } else { "s" } }

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::{Command, Stdio};

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    /// A merged, clean worktree is stale until a process runs in it or a
    /// session writes a transcript for it.
    #[test]
    fn a_running_process_or_a_recent_session_keeps_a_worktree() {
        let root = std::env::temp_dir().join(format!("eavesy-in-use-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo")).unwrap();
        let root = root.canonicalize().unwrap();
        let (repo, worktree, home) = (root.join("repo"), root.join("wt"), root.join("home"));
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(&repo, &["worktree", "add", "-q", "-b", "wt", &worktree.to_string_lossy()]);
        let entries = super::worktrees::list(&repo);
        let status = |cwds: &[&str]| super::repo_rows(&home, &entries, cwds, super::Mode::Deep, None).unwrap().rows[0].status;
        assert_eq!(status(&[]), super::Status::Stale);
        // The quick pass says the same for a merged, idle worktree, but hasn't
        // checked it for changes yet; with a process in it, it's settled.
        let quick = |cwds: &[&str]| { let row = super::repo_rows(&home, &entries, cwds, super::Mode::Quick, None).unwrap().rows.remove(0); (row.status, row.settled) };
        assert_eq!(quick(&[]), (super::Status::Stale, false));
        let busy = worktree.to_string_lossy().into_owned();
        assert_eq!(quick(&[busy.as_str()]), (super::Status::InUse, true));
        let inside = worktree.join("web").to_string_lossy().into_owned();
        assert_eq!(status(&[inside.as_str()]), super::Status::InUse);
        // The check right before removal says the same.
        let path = worktree.to_string_lossy().into_owned();
        let mut proc = super::procs::Proc { uid: super::procs::own_uid(), cwd: Some(inside.clone()), ..Default::default() };
        assert!(!super::safe_to_remove_now(&home, std::slice::from_ref(&proc), &path));
        proc.cwd = Some(root.to_string_lossy().into_owned());
        assert!(super::safe_to_remove_now(&home, std::slice::from_ref(&proc), &path));
        std::fs::write(worktree.join(".env"), "TOKEN=x\n").unwrap();
        assert!(!super::safe_to_remove_now(&home, &[], &path), "an untracked .env");
        std::fs::remove_file(worktree.join(".env")).unwrap();

        let transcripts = super::worktrees::transcript_dir(&home, &path);
        std::fs::create_dir_all(&transcripts).unwrap();
        std::fs::write(transcripts.join("s.jsonl"), "{}\n").unwrap();
        assert_eq!(status(&[]), super::Status::InUse);
        assert!(!super::safe_to_remove_now(&home, &[], &path));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The closer look: a squash merge is found, changes and distance from the
    /// default branch are counted, and a path that wasn't listed is refused.
    #[test]
    fn details_fill_in_what_the_quick_pass_left_out() {
        let root = std::env::temp_dir().join(format!("eavesy-details-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo")).unwrap();
        let root = root.canonicalize().unwrap();
        let (repo, home) = (root.join("repo"), root.join("home"));
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "one"]);
        for name in ["squashed", "ahead"] {
            git(&repo, &["worktree", "add", "-q", "-b", name, &root.join(name).to_string_lossy()]);
        }
        let (squashed, ahead) = (root.join("squashed"), root.join("ahead"));
        std::fs::write(squashed.join("b.txt"), "two\n").unwrap();
        git(&squashed, &["add", "."]);
        git(&squashed, &["commit", "-qm", "two"]);
        git(&repo, &["merge", "-q", "--squash", "squashed"]);
        git(&repo, &["commit", "-qm", "squash"]);
        std::fs::write(repo.join("c.txt"), "later\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "later"]);
        std::fs::write(ahead.join("d.txt"), "mine\n").unwrap();
        git(&ahead, &["add", "."]);
        git(&ahead, &["commit", "-qm", "mine"]);
        std::fs::write(ahead.join("e.txt"), "untracked\n").unwrap();

        let entries = super::worktrees::list(&repo);
        let scan = super::repo_rows(&home, &entries, &[], super::Mode::Quick, None).unwrap();
        // The quick pass can't tell a squash merge from unmerged work.
        let quick: Vec<_> = scan.rows.iter().map(|row| (row.branch.as_deref().unwrap(), row.status, row.settled)).collect();
        assert!(quick.contains(&("squashed", super::Status::Unmerged, false)));
        super::remember(std::slice::from_ref(&scan));

        let found = super::details(&[squashed.to_string_lossy().into_owned(), ahead.to_string_lossy().into_owned(), "/not/listed".into()]);
        assert_eq!(found.len(), 2, "the unlisted path is skipped");
        let squashed_detail = &found[0];
        assert_eq!(squashed_detail.status, super::Status::Stale);
        assert_eq!(squashed_detail.merged_via, Some(super::MergedVia::Squash));
        assert_eq!(squashed_detail.base.as_deref(), Some("main"));
        assert_eq!((squashed_detail.ahead, squashed_detail.behind), (Some(1), Some(2)));
        assert!(squashed_detail.last_commit_ms.is_some());
        let ahead_detail = &found[1];
        assert_eq!(ahead_detail.status, super::Status::Unmerged);
        assert_eq!(ahead_detail.merged_via, None);
        // Unmerged work with an untracked file: counted even though it isn't removable anyway.
        assert_eq!(ahead_detail.changes, 1);
        assert_eq!((ahead_detail.ahead, ahead_detail.behind), (Some(1), Some(2)));
        assert!(super::worktrees::size_bytes(&ahead).is_some_and(|bytes| bytes > 0));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_github_pull_request_links_open() {
        assert!(super::is_pr_url("https://github.com/eavesy/eavesy/pull/248"));
        assert!(!super::is_pr_url("https://github.com/eavesy/eavesy/issues/248"));
        assert!(!super::is_pr_url("https://github.com/eavesy/eavesy/pull/248/files"));
        assert!(!super::is_pr_url("https://evil.example/https://github.com/a/b/pull/1"));
        assert!(!super::is_pr_url("file:///etc/passwd"));
        assert!(!super::is_pr_url("-a Calculator"));
    }

    #[test]
    fn open_asks_finder_or_terminal() {
        assert_eq!(super::open_args(super::OpenHow::Reveal, "/r/wt"), vec!["-R", "/r/wt"]);
        assert_eq!(super::open_args(super::OpenHow::Terminal, "/r/wt"), vec!["-a", "Terminal", "/r/wt"]);
    }

    #[test]
    fn restore_lines_quote_for_the_shell() {
        assert_eq!(super::shell_quote("/r/it's here"), "'/r/it'\\''s here'");
        assert_eq!(super::shell_quote("main"), "'main'");
    }

    /// Prints this Mac's inventory without touching anything:
    /// `cargo test --lib machine::tests::print_inventory -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_inventory() {
        let inventory = super::gather(super::Mode::Deep).1;
        println!("{}", serde_json::to_string_pretty(&inventory).unwrap());
    }
}
