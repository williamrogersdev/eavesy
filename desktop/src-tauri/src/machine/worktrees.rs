//! Git worktrees, and which ones are safe to remove: the branch's work is
//! already in the default branch, nothing is uncommitted, no ignored file is
//! more than build output, and no session is using it. Removal is `git
//! worktree remove` without `--force`, so git also refuses modified or
//! untracked files on its own. It does delete ignored files, which is why
//! `dirty` counts any ignored file that can't be rebuilt (`.env`, say).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub head: Option<String>,
    /// `refs/heads/…`, or None when detached.
    pub branch: Option<String>,
    pub locked: bool,
    pub prunable: bool,
    pub bare: bool,
}

/// `git worktree list --porcelain`. The first entry is the main checkout.
pub fn parse_porcelain(text: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut current: Option<Entry> = None;
    for line in text.lines() {
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        match key {
            "worktree" => {
                entries.extend(current.take());
                current = Some(Entry { path: value.to_string(), ..Entry::default() });
            }
            _ => {
                let Some(entry) = current.as_mut() else { continue };
                match key {
                    "HEAD" => entry.head = Some(value.to_string()),
                    "branch" => entry.branch = Some(value.to_string()),
                    "locked" => entry.locked = true,
                    "prunable" => entry.prunable = true,
                    "bare" => entry.bare = true,
                    _ => {}
                }
            }
        }
    }
    entries.extend(current);
    entries
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Safe to remove.
    Stale,
    /// The folder is gone; `git worktree prune` tidies the entry.
    Missing,
    Locked,
    /// Has staged, unstaged or untracked files.
    Dirty,
    /// A process is running in it, or a Claude Code session was active there.
    InUse,
    /// Its commits aren't in the default branch.
    Unmerged,
}

#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub exists: bool,
    pub locked: bool,
    pub dirty: bool,
    pub in_use: bool,
    /// Its HEAD is in the default branch, or merging it would change nothing
    /// there (a squash-merged PR).
    pub merged: bool,
}

/// The first reason it can't go, in the order the facts are cheapest to
/// find out, so `dirty` (a `git status`) is only needed for the last step.
pub fn classify(facts: &Facts) -> Status {
    if !facts.exists {
        Status::Missing
    } else if facts.locked {
        Status::Locked
    } else if facts.in_use {
        Status::InUse
    } else if !facts.merged {
        Status::Unmerged
    } else if facts.dirty {
        Status::Dirty
    } else {
        Status::Stale
    }
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    // No fsmonitor: a scan must not start git daemons of its own.
    let output = Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim_end().to_string())
}

pub fn list(repo: &Path) -> Vec<Entry> {
    git(repo, &["worktree", "list", "--porcelain"]).map(|text| parse_porcelain(&text)).unwrap_or_default()
}

/// A branch a worktree's work counts as landed in, and its tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Base {
    pub name: String,
    pub tree: String,
}

/// The remote's default branch and its local copy, without fetching. Two
/// names for the same commit are checked once.
pub fn bases(repo: &Path) -> Vec<Base> {
    let remote = git(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    let local = remote.as_deref().and_then(|r| r.strip_prefix("origin/")).map(str::to_string);
    let mut names: Vec<String> = remote.into_iter().chain(local).collect();
    if names.is_empty() {
        names = ["main", "master"].iter().map(|name| name.to_string()).collect();
    }
    let mut commits = Vec::new();
    let mut bases = Vec::new();
    for name in names {
        let Some(commit) = git(repo, &["rev-parse", "--verify", "--quiet", &format!("{name}^{{commit}}")]) else { continue };
        if commits.contains(&commit) {
            continue;
        }
        let Some(tree) = git(repo, &["rev-parse", &format!("{commit}^{{tree}}")]) else { continue };
        commits.push(commit);
        bases.push(Base { name, tree });
    }
    bases
}

/// True when HEAD's changes are all in one of `bases` already.
pub fn merged(repo: &Path, head: &str, bases: &[Base]) -> bool {
    bases.iter().any(|base| {
        if git(repo, &["merge-base", "--is-ancestor", head, &base.name]).is_some() {
            return true;
        }
        // A squash merge leaves the branch's commits outside the base, but
        // merging them in would give back the base's own tree.
        git(repo, &["merge-tree", "--write-tree", &base.name, head]).is_some_and(|out| out.lines().next() == Some(base.tree.as_str()))
    })
}

/// Ignored folders and files that a build or an install makes again.
const REBUILDABLE: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".vite",
    ".wrangler", ".vercel", ".netlify", ".parcel-cache", ".cache", ".tanstack", ".vinxi", ".expo", "coverage",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", ".gradle", "DerivedData", ".build", ".DS_Store",
];

/// One `git status --porcelain --ignored` line that removing the worktree
/// would lose: a change, an untracked file, or an ignored file that isn't
/// build output.
pub fn would_lose(line: &str) -> bool {
    let Some(path) = line.strip_prefix("!! ") else { return !line.trim().is_empty() };
    let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or(path);
    !(REBUILDABLE.contains(&name) || name.ends_with(".tsbuildinfo") || name.ends_with(".pyc"))
}

pub fn dirty(worktree: &Path) -> bool {
    // A status that fails is treated as dirty: never remove what we can't read.
    git(worktree, &["status", "--porcelain", "--untracked-files=normal", "--ignored=matching"]).is_none_or(|out| out.lines().any(would_lose))
}

/// Claude Code keeps each folder's transcripts in `~/.claude/projects/<slug>`,
/// the path with everything but letters and digits turned into `-`.
pub fn transcript_dir(home: &Path, worktree: &str) -> PathBuf {
    let slug: String = worktree.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    home.join(".claude").join("projects").join(slug)
}

/// A Claude Code session wrote to this folder's transcripts recently.
pub fn recent_session(home: &Path, worktree: &str, within: std::time::Duration) -> bool {
    let Ok(entries) = std::fs::read_dir(transcript_dir(home, worktree)) else { return false };
    let cutoff = std::time::SystemTime::now() - within;
    entries.flatten().any(|entry| entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|time| time > cutoff))
}

pub fn inside(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('/');
    path == dir || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// `git worktree remove`, never forced. Returns git's own message on failure.
pub fn remove(repo: &Path, worktree: &str) -> Result<(), String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["-c", "core.fsmonitor=false", "worktree", "remove", "--", worktree])
        .stdin(Stdio::null())
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.claude/worktrees/x\nHEAD bbb\ndetached\nlocked claude session\n\nworktree /gone\nHEAD ccc\nbranch refs/heads/y\nprunable gitdir file points to non-existent location\n";
        let entries = parse_porcelain(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].branch.as_deref(), Some("refs/heads/main"));
        assert_eq!(entries[1].branch, None);
        assert!(entries[1].locked);
        assert_eq!(entries[1].head.as_deref(), Some("bbb"));
        assert!(entries[2].prunable);
    }

    #[test]
    fn only_a_clean_merged_unused_worktree_is_stale() {
        let stale = Facts { exists: true, merged: true, ..Facts::default() };
        assert_eq!(classify(&stale), Status::Stale);
        assert_eq!(classify(&Facts { dirty: true, ..stale.clone() }), Status::Dirty);
        assert_eq!(classify(&Facts { in_use: true, ..stale.clone() }), Status::InUse);
        assert_eq!(classify(&Facts { locked: true, ..stale.clone() }), Status::Locked);
        assert_eq!(classify(&Facts { merged: false, ..stale.clone() }), Status::Unmerged);
        assert_eq!(classify(&Facts { exists: false, ..stale }), Status::Missing);
    }

    #[test]
    fn ignored_build_output_goes_but_local_files_keep_it() {
        assert!(!would_lose("!! node_modules/"));
        assert!(!would_lose("!! web/node_modules/"));
        assert!(!would_lose("!! desktop/src-tauri/target/"));
        assert!(!would_lose("!! web/tsconfig.tsbuildinfo"));
        assert!(would_lose("!! .env"));
        assert!(would_lose("!! web/.dev.vars"));
        assert!(would_lose("!! desktop/src-tauri/binaries/"));
        assert!(would_lose("?? notes.md"));
        assert!(would_lose(" M src/lib.rs"));
        assert!(!would_lose(""));
    }

    #[test]
    fn a_recent_transcript_means_in_use() {
        let home = std::env::temp_dir().join(format!("eavesy-home-{}", std::process::id()));
        let worktree = "/Users/w/Developer/x/.claude/worktrees/y";
        assert!(!recent_session(&home, worktree, std::time::Duration::from_secs(60)));
        let dir = transcript_dir(&home, worktree);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("s.jsonl"), "{}\n").unwrap();
        assert!(recent_session(&home, worktree, std::time::Duration::from_secs(60)));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn transcript_slug_matches_claude_code() {
        let dir = transcript_dir(Path::new("/Users/w"), "/Users/w/Developer/eavesy/.claude/worktrees/sharp-hodgkin-5cf282");
        assert_eq!(dir, Path::new("/Users/w/.claude/projects/-Users-w-Developer-eavesy--claude-worktrees-sharp-hodgkin-5cf282"));
    }

    #[test]
    fn inside_means_the_folder_or_below_it() {
        assert!(inside("/r/wt", "/r/wt"));
        assert!(inside("/r/wt/web/src", "/r/wt/"));
        assert!(!inside("/r/wt-2", "/r/wt"));
    }

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A real repo in a temporary folder: one squash-merged branch, one
    /// unmerged, one with uncommitted work.
    #[test]
    fn classifies_real_worktrees() {
        let root = std::env::temp_dir().join(format!("eavesy-worktrees-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        // The temp folder may be behind a symlink (/var → /private/var); git reports real paths.
        let repo = repo.canonicalize().unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\n.env\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "one"]);
        for name in ["squashed", "unmerged", "dirty", "locked", "secrets"] {
            run(&repo, &["worktree", "add", "-q", "-b", name, &root.join(name).to_string_lossy()]);
        }
        let squashed = root.canonicalize().unwrap().join("squashed");
        std::fs::write(squashed.join("b.txt"), "two\n").unwrap();
        run(&squashed, &["add", "."]);
        run(&squashed, &["commit", "-qm", "two"]);
        run(&squashed, &["commit", "-q", "--allow-empty", "-m", "three"]);
        run(&repo, &["merge", "-q", "--squash", "squashed"]);
        run(&repo, &["commit", "-qm", "squash of squashed"]);
        // Main moves on after the merge.
        std::fs::write(repo.join("c.txt"), "later\n").unwrap();
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "-qm", "later"]);
        let unmerged = squashed.with_file_name("unmerged");
        std::fs::write(unmerged.join("d.txt"), "mine\n").unwrap();
        run(&unmerged, &["add", "."]);
        run(&unmerged, &["commit", "-qm", "mine"]);
        let dirty_wt = squashed.with_file_name("dirty");
        std::fs::write(dirty_wt.join("e.txt"), "untracked\n").unwrap();
        // Ignored build output doesn't keep a worktree; an ignored .env does.
        std::fs::create_dir_all(squashed.join("node_modules/x")).unwrap();
        std::fs::write(squashed.join("node_modules/x/i.js"), "\n").unwrap();
        let secrets = squashed.with_file_name("secrets");
        std::fs::write(secrets.join(".env"), "TOKEN=x\n").unwrap();

        let locked = squashed.with_file_name("locked");
        run(&repo, &["worktree", "lock", &locked.to_string_lossy()]);

        let entries = list(&repo);
        assert_eq!(entries.len(), 6);
        let bases = bases(&repo);
        assert_eq!(bases.iter().map(|base| base.name.as_str()).collect::<Vec<_>>(), vec!["main"]);
        let facts = |path: &Path| {
            let entry = entries.iter().find(|entry| Path::new(&entry.path) == path).expect("listed");
            Facts { exists: true, locked: entry.locked, dirty: dirty(path), in_use: false, merged: merged(&repo, entry.head.as_deref().unwrap(), &bases) }
        };
        assert_eq!(classify(&facts(&squashed)), Status::Stale);
        assert_eq!(classify(&facts(&unmerged)), Status::Unmerged);
        // Its branch has nothing new, so it's merged, but the untracked file wins.
        assert_eq!(classify(&facts(&dirty_wt)), Status::Dirty);
        // git worktree remove would delete an ignored .env, so it counts.
        assert_eq!(classify(&facts(&secrets)), Status::Dirty);
        // Nothing new on its branch and clean, but locked.
        assert_eq!(classify(&facts(&locked)), Status::Locked);
        // Its work is merged, but someone is in it.
        assert_eq!(classify(&Facts { in_use: true, ..facts(&squashed) }), Status::InUse);

        // Git itself refuses untracked files, whatever we decided.
        assert!(remove(&repo, &dirty_wt.to_string_lossy()).is_err());
        assert!(dirty_wt.join("e.txt").exists());
        remove(&repo, &squashed.to_string_lossy()).unwrap();
        assert!(!squashed.exists());
        // The branch and its commits stay, so it can come back.
        run(&repo, &["rev-parse", "--verify", "refs/heads/squashed"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
