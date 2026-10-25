//! Pull requests for a repo's branches, from the GitHub CLI when it's there.
//! One `gh pr list` per repo, asked for after the worktrees are on screen, so
//! a Mac without `gh` (or a repo without a GitHub remote) just shows no PR
//! state instead of failing.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How long `gh` gets before it's given up on: it's a network call.
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Pr {
    pub number: u64,
    pub state: PrState,
    pub branch: String,
    pub url: String,
}

#[derive(Debug, Serialize, Default)]
pub struct Prs {
    /// False when `gh` isn't installed, isn't signed in, or the repo has no
    /// GitHub remote.
    pub available: bool,
    pub prs: Vec<Pr>,
}

#[derive(Deserialize)]
struct Raw {
    number: u64,
    state: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    url: String,
}

/// `gh pr list --json number,state,headRefName,url`.
pub fn parse(json: &str) -> Option<Vec<Pr>> {
    let raw: Vec<Raw> = serde_json::from_str(json).ok()?;
    Some(
        raw.into_iter()
            .filter_map(|pr| {
                let state = match pr.state.as_str() {
                    "OPEN" => PrState::Open,
                    "MERGED" => PrState::Merged,
                    "CLOSED" => PrState::Closed,
                    _ => return None,
                };
                Some(Pr { number: pr.number, state, branch: pr.head_ref_name, url: pr.url })
            })
            .collect(),
    )
}

/// Eavesy starts from Finder with a short PATH, so look where Homebrew puts it.
fn gh_path() -> &'static str {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].into_iter().find(|path| Path::new(path).is_file()).unwrap_or("gh")
}

pub fn list(repo: &Path) -> Prs {
    let spawned = Command::new(gh_path())
        // A repo with more PRs than this loses its oldest ones: their branches just show as git sees them.
        .args(["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName,url"])
        .current_dir(repo)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else { return Prs::default() };
    // Read on a thread so a full pipe can't stall `gh` while we wait for it.
    let mut stdout = child.stdout.take();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(out) = stdout.as_mut() {
            let _ = std::io::Read::read_to_string(out, &mut text);
        }
        let _ = sender.send(text);
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // A helper `gh` started can keep the pipe open after `gh` is gone, so don't
    // wait on the reader for ever; a reader that's late is left to finish alone.
    let text = receiver.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    match status.filter(|status| status.success()).and_then(|_| parse(&text)) {
        Some(prs) => Prs { available: true, prs },
        None => Prs::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_gh_json() {
        let json = r#"[{"number":12,"state":"MERGED","headRefName":"feat/x","url":"https://github.com/o/r/pull/12"},{"number":13,"state":"OPEN","headRefName":"fix/y","url":"https://github.com/o/r/pull/13"},{"number":14,"state":"CLOSED","headRefName":"z","url":"u"},{"number":15,"state":"WEIRD","headRefName":"w","url":"u"}]"#;
        let prs = parse(json).unwrap();
        assert_eq!(prs.iter().map(|pr| (pr.number, pr.state)).collect::<Vec<_>>(), vec![(12, PrState::Merged), (13, PrState::Open), (14, PrState::Closed)]);
        assert_eq!(prs[0].branch, "feat/x");
        assert!(parse("not json").is_none());
    }
}
