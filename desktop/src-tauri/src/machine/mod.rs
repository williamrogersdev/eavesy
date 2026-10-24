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
pub mod worktrees;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use procs::{Label, Proc};
use worktrees::Status;

/// A folder whose Claude Code transcript changed this recently is still in use.
const RECENT_SESSION: Duration = Duration::from_secs(24 * 60 * 60);
/// How long a leftover gets to stop its own helpers before they're asked too.
const HELPER_GRACE: Duration = Duration::from_millis(1500);

#[derive(Debug, Serialize)]
pub struct WorktreeRow {
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub status: Status,
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
    for dir in session_dirs {
        let common = std::process::Command::new("git")
            .args(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])
            .stderr(std::process::Stdio::null())
            .output();
        if let Some(output) = common.ok().filter(|output| output.status.success()) {
            let common = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
            if common.file_name().is_some_and(|name| name == ".git") {
                candidates.extend(common.parent().map(Path::to_path_buf));
            }
        }
    }
    let mut seen = HashSet::new();
    candidates.into_iter().filter_map(|path| path.canonicalize().ok()).filter(|path| seen.insert(path.clone())).collect()
}

const THREADS: usize = 8;

/// One repo's linked worktrees. `cwds` are where your processes run.
fn repo_rows(home: &Path, root: &Path, cwds: &[&str]) -> Option<(String, Vec<WorktreeRow>)> {
    let entries = worktrees::list(root);
    // The first entry is the main checkout, which is never removed.
    let main = entries.first()?;
    let repo = PathBuf::from(&main.path);
    let bases = worktrees::bases(&repo);
    let row = |entry: &worktrees::Entry| {
        let path = Path::new(&entry.path);
        let mut facts = worktrees::Facts {
            exists: path.is_dir() && !entry.prunable,
            locked: entry.locked,
            dirty: false,
            in_use: cwds.iter().any(|cwd| worktrees::inside(cwd, &entry.path)) || worktrees::recent_session(home, &entry.path, RECENT_SESSION),
            merged: false,
        };
        // Only find out what decides it (see worktrees::classify).
        if facts.exists && !facts.locked && !facts.in_use {
            facts.merged = entry.head.as_deref().is_some_and(|head| worktrees::merged(&repo, head, &bases));
            facts.dirty = facts.merged && worktrees::dirty(path);
        }
        WorktreeRow {
            path: entry.path.clone(),
            repo: main.path.clone(),
            branch: entry.branch.as_deref().map(|branch| branch.trim_start_matches("refs/heads/").to_string()),
            status: worktrees::classify(&facts),
        }
    };
    let linked: Vec<&worktrees::Entry> = entries.iter().skip(1).filter(|entry| !entry.bare).collect();
    let chunk = linked.len().div_ceil(THREADS).max(1);
    let rows = std::thread::scope(|scope| {
        let workers: Vec<_> = linked.chunks(chunk).map(|entries| scope.spawn(|| entries.iter().map(|entry| row(entry)).collect::<Vec<_>>())).collect();
        workers.into_iter().flat_map(|worker| worker.join().unwrap_or_default()).collect()
    });
    Some((main.path.clone(), rows))
}

fn worktree_rows(home: &Path, procs: &[Proc]) -> (Vec<String>, Vec<WorktreeRow>) {
    let uid = procs::own_uid();
    let cwds: Vec<&str> = procs.iter().filter(|proc| proc.uid == uid && !proc.zombie).filter_map(|proc| proc.cwd.as_deref()).collect();
    let mut repos = Vec::new();
    let mut rows = Vec::new();
    for root in repo_roots(home, procs) {
        let Some((repo, repo_rows)) = repo_rows(home, &root, &cwds) else { continue };
        if !repos.contains(&repo) {
            repos.push(repo);
            rows.extend(repo_rows);
        }
    }
    (repos, rows)
}

fn gather() -> (Vec<Proc>, Inventory) {
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
    let (repos, worktrees) = dirs::home_dir().map(|home| worktree_rows(&home, &procs)).unwrap_or_default();
    (procs, Inventory { repos, worktrees, leftovers, zombies, ports })
}

#[tauri::command]
pub async fn machine_inventory() -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(|| gather().1).await.map_err(|error| error.to_string())
}

#[derive(Debug, Deserialize)]
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

fn clean(worktree_paths: Vec<String>, processes: Vec<ProcessRef>) -> Vec<Outcome> {
    let (procs, inventory) = gather();
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

    for path in worktree_paths {
        let row = inventory.worktrees.iter().find(|row| row.path == path);
        let Some(row) = row.filter(|row| row.status == Status::Stale) else {
            outcomes.push(Outcome { target: path, ok: false, message: Some("It isn't safe to remove any more.".into()), restore: None });
            continue;
        };
        let result = worktrees::remove(Path::new(&row.repo), &row.path);
        tracing::info!(ok = result.is_ok(), "machine: removed a stale worktree");
        let restore = row.branch.as_ref().map(|branch| format!("git -C '{}' worktree add '{}' '{}'", row.repo, row.path, branch));
        outcomes.push(Outcome { target: path, ok: result.is_ok(), restore: restore.filter(|_| result.is_ok()), message: result.err() });
    }
    outcomes
}

/// Called by Settings' confirm card. Only Eavesy's own windows can call it:
/// the agents socket and MCP have no way in.
#[tauri::command]
pub async fn machine_clean(worktrees: Vec<String>, processes: Vec<ProcessRef>) -> Result<Vec<Outcome>, String> {
    tauri::async_runtime::spawn_blocking(move || clean(worktrees, processes)).await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    /// Prints this Mac's inventory without touching anything:
    /// `cargo test --lib machine::tests::print_inventory -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_inventory() {
        let inventory = super::gather().1;
        println!("{}", serde_json::to_string_pretty(&inventory).unwrap());
    }
}
