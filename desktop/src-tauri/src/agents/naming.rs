//! A name Eavesy can say for a session: its project folder, plus the branch
//! when another waiting session is in a folder of the same name.

use std::path::Path;

const MAX_NAME: usize = 40;

/// `others` are the (session id, name) pairs already in the queue.
pub fn name(session_id: &str, cwd: Option<&str>, others: &[(String, String)]) -> String {
    let folder = cwd
        .map(Path::new)
        .and_then(Path::file_name)
        .map(|name| speakable(&name.to_string_lossy()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "a Claude session".to_string());
    let clash = others.iter().any(|(id, other)| id != session_id && (other == &folder || other.starts_with(&format!("{folder} on "))));
    if !clash {
        return folder;
    }
    match cwd.and_then(|cwd| branch(Path::new(cwd))) {
        Some(branch) => truncate(format!("{folder} on {}", speakable(short_branch(&branch)))),
        None => folder,
    }
}

/// `claude/voice-reply-for-me-0971e9` reads as "voice reply for me".
fn short_branch(branch: &str) -> &str {
    let last = branch.rsplit('/').next().unwrap_or(branch);
    match last.rsplit_once('-') {
        Some((rest, suffix)) if suffix.len() == 6 && suffix.chars().all(|c| c.is_ascii_hexdigit()) => rest,
        _ => last,
    }
}

fn speakable(raw: &str) -> String {
    truncate(raw.replace(['-', '_'], " ").split_whitespace().collect::<Vec<_>>().join(" "))
}

fn truncate(text: String) -> String {
    text.chars().take(MAX_NAME).collect()
}

/// The checked-out branch, following a worktree's `.git` file.
pub fn branch(dir: &Path) -> Option<String> {
    let dot_git = dir.join(".git");
    let git_dir = if dot_git.is_file() {
        let pointer = std::fs::read_to_string(&dot_git).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        dir.join(target)
    } else {
        dot_git
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lone_session_is_its_folder() {
        assert_eq!(name("a", Some("/Users/me/Developer/eavesy-public"), &[]), "eavesy public");
        assert_eq!(name("a", None, &[]), "a Claude session");
    }

    #[test]
    fn a_clash_adds_the_branch() {
        let dir = std::env::temp_dir().join(format!("eavesy-naming-{}", uuid::Uuid::new_v4().simple())).join("eavesy");
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/HEAD"), "ref: refs/heads/claude/voice-reply-for-me-0971e9\n").unwrap();
        let others = vec![("b".to_string(), "eavesy".to_string())];
        assert_eq!(name("a", dir.to_str(), &others), "eavesy on voice reply for me");
        assert_eq!(name("b", dir.to_str(), &others), "eavesy", "its own entry isn't a clash");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn worktrees_point_at_their_git_dir() {
        let root = std::env::temp_dir().join(format!("eavesy-naming-{}", uuid::Uuid::new_v4().simple()));
        let git_dir = root.join("repo/.git/worktrees/wt");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/fix-hud\n").unwrap();
        let wt = root.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        assert_eq!(branch(&wt).as_deref(), Some("fix-hud"));
        let _ = std::fs::remove_dir_all(root);
    }
}
