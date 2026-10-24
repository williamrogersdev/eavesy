//! Your processes, read with libproc, and which of them an ended Claude Code
//! session left behind. Claude Code runs every command with `CLAUDE_PID` (and
//! `CLAUDECODE=1`) in its environment, so a process that still carries a
//! `CLAUDE_PID` whose `claude` is gone is a leftover.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentTag {
    pub claude_pid: Option<u32>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    /// Microseconds since 1970. With the pid, it names one process: a pid
    /// that was reused has a later start.
    pub started_us: u64,
    pub zombie: bool,
    pub name: String,
    pub exe: String,
    pub cwd: Option<String>,
    /// Only read for your own processes.
    pub tag: Option<AgentTag>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Label {
    /// Its Claude Code session is still running.
    Live,
    /// Its Claude Code session ended.
    Orphan,
}

/// Apps, the system, and daemons every session shares (gpg's, ssh's) are
/// never leftovers, and neither is anything whose executable we can't see.
fn protected(proc: &Proc) -> bool {
    const SYSTEM: &[&str] = &["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/Library/Apple/"];
    const SHARED: &[&str] = &["gpg-agent", "keyboxd", "dirmngr", "scdaemon", "ssh-agent"];
    let exe = proc.exe.as_str();
    exe.is_empty() || SYSTEM.iter().any(|prefix| exe.starts_with(prefix)) || exe.contains(".app/Contents/") || SHARED.contains(&proc.name.as_str())
}

pub fn is_agent(proc: &Proc) -> bool {
    let base = proc.exe.rsplit('/').next().filter(|base| !base.is_empty()).unwrap_or(&proc.name);
    base == "claude"
}

/// Labels your tagged processes. `own_pid` is Eavesy: a development build
/// started from a session inherits its tag, and neither it nor anything it
/// started is ever a leftover.
pub fn classify(procs: &[Proc], own_uid: u32, own_pid: u32) -> HashMap<u32, Label> {
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|proc| (proc.pid, proc)).collect();
    let ancestors = |proc: &Proc| {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut next = proc.ppid;
        while next > 1 && seen.insert(next) {
            let Some(parent) = by_pid.get(&next) else { break };
            chain.push(*parent);
            next = parent.ppid;
        }
        chain
    };
    let mut labels = HashMap::new();
    for proc in procs {
        let Some(tag) = &proc.tag else { continue };
        if proc.uid != own_uid || proc.zombie || proc.pid == own_pid || is_agent(proc) || protected(proc) {
            continue;
        }
        let chain = ancestors(proc);
        if chain.iter().any(|parent| parent.pid == own_pid) {
            continue;
        }
        // Its claude is alive if it's still above it, or if the pid it was
        // given is a claude that started before it did.
        let alive = chain.iter().any(|parent| is_agent(parent))
            || tag.claude_pid.and_then(|pid| by_pid.get(&pid)).is_some_and(|claude| is_agent(claude) && claude.started_us <= proc.started_us);
        labels.insert(proc.pid, if alive { Label::Live } else { Label::Orphan });
    }
    labels
}

/// The leftovers to show: each orphan whose parent isn't one, with the
/// orphans under it (a dev server's own workers) as its helpers.
pub fn orphan_groups(procs: &[Proc], labels: &HashMap<u32, Label>) -> Vec<(u32, Vec<u32>)> {
    let orphan = |pid: u32| labels.get(&pid) == Some(&Label::Orphan);
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|proc| (proc.pid, proc)).collect();
    let root_of = |pid: u32| {
        let mut root = pid;
        let mut seen = HashSet::new();
        while let Some(proc) = by_pid.get(&root) {
            if !orphan(proc.ppid) || !seen.insert(proc.ppid) {
                break;
            }
            root = proc.ppid;
        }
        root
    };
    let mut groups: Vec<(u32, Vec<u32>)> = Vec::new();
    let mut sorted: Vec<&Proc> = procs.iter().filter(|proc| orphan(proc.pid)).collect();
    sorted.sort_by_key(|proc| (proc.started_us, proc.pid));
    for proc in sorted {
        let root = root_of(proc.pid);
        match groups.iter_mut().find(|(pid, _)| *pid == root) {
            Some((_, helpers)) if root != proc.pid => helpers.push(proc.pid),
            Some(_) => {}
            None if root == proc.pid => groups.push((root, Vec::new())),
            None => groups.push((root, vec![proc.pid])),
        }
    }
    groups
}

/// The session tag from a `KERN_PROCARGS2` buffer: argc, the executable
/// path, the arguments, then the environment, all NUL-separated.
pub fn parse_procargs(buf: &[u8]) -> Option<AgentTag> {
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?).max(0) as usize;
    let mut parts = buf[4..].split(|byte| *byte == 0);
    parts.next()?; // the executable path
    // NULs pad the path; then come argc arguments.
    let mut parts = parts.skip_while(|part| part.is_empty()).skip(argc);
    let mut tag = AgentTag::default();
    let mut tagged = false;
    for var in parts.by_ref() {
        if var.is_empty() {
            break;
        }
        let Ok(var) = std::str::from_utf8(var) else { continue };
        let Some((key, value)) = var.split_once('=') else { continue };
        match key {
            "CLAUDECODE" => tagged |= value == "1",
            "CLAUDE_PID" => {
                tag.claude_pid = value.parse().ok();
                tagged |= tag.claude_pid.is_some();
            }
            "CLAUDE_CODE_SESSION_ID" if !value.is_empty() => tag.session_id = Some(value.chars().take(64).collect()),
            _ => {}
        }
    }
    tagged.then_some(tag)
}

#[cfg(target_os = "macos")]
mod sys {
    use super::{parse_procargs, AgentTag, Proc};
    use std::ffi::CStr;
    use std::mem::{size_of, zeroed};

    fn c_string(bytes: &[libc::c_char]) -> String {
        let bytes: Vec<u8> = bytes.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    pub fn all_pids() -> Vec<u32> {
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Vec::new();
        }
        // Room for processes started since the count.
        let mut pids = vec![0 as libc::c_int; count as usize + 64];
        let bytes = (pids.len() * size_of::<libc::c_int>()) as libc::c_int;
        let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(n.max(0) as usize);
        pids.into_iter().filter(|pid| *pid > 0).map(|pid| pid as u32).collect()
    }

    pub fn read(pid: u32, own_uid: u32) -> Option<Proc> {
        let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
        let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
        let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
        if got != size {
            return None;
        }
        let name = {
            let long = c_string(&info.pbi_name);
            if long.is_empty() { c_string(&info.pbi_comm) } else { long }
        };
        let own = info.pbi_uid == own_uid;
        let zombie = info.pbi_status == libc::SZOMB;
        Some(Proc {
            pid,
            ppid: info.pbi_ppid,
            uid: info.pbi_uid,
            started_us: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
            zombie,
            name,
            exe: exe(pid).unwrap_or_default(),
            cwd: if own && !zombie { cwd(pid) } else { None },
            tag: if own && !zombie { tag(pid) } else { None },
        })
    }

    fn exe(pid: u32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let n = unsafe { libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
    }

    fn cwd(pid: u32) -> Option<String> {
        let mut info: libc::proc_vnodepathinfo = unsafe { zeroed() };
        let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        let got = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) };
        if got != size {
            return None;
        }
        let path = unsafe { CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()) }.to_string_lossy().into_owned();
        (!path.is_empty()).then_some(path)
    }

    fn tag(pid: u32) -> Option<AgentTag> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let mut size: libc::size_t = 0;
        if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size];
        if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
            return None;
        }
        buf.truncate(size);
        parse_procargs(&buf)
    }
}

pub fn own_uid() -> u32 {
    unsafe { libc::getuid() }
}

/// Every process on the Mac, with paths and tags for your own.
pub fn snapshot() -> Vec<Proc> {
    #[cfg(target_os = "macos")]
    {
        let uid = own_uid();
        sys::all_pids().into_iter().filter_map(|pid| sys::read(pid, uid)).collect()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

pub fn read_one(pid: u32) -> Option<Proc> {
    #[cfg(target_os = "macos")]
    {
        sys::read(pid, own_uid())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pid;
        None
    }
}

/// Sends SIGTERM, only to the very process that was shown (same pid and
/// start time) and only if it's yours.
pub fn terminate(pid: u32, started_us: u64) -> Result<(), String> {
    let Some(proc) = read_one(pid) else { return Err("it already stopped".into()) };
    if proc.started_us != started_us {
        return Err("it already stopped".into());
    }
    if proc.uid != own_uid() {
        return Err("it isn't yours".into());
    }
    if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: u32 = 501;
    const EAVESY: u32 = 900;

    fn proc(pid: u32, ppid: u32, started_us: u64, exe: &str, claude_pid: Option<u32>) -> Proc {
        Proc {
            pid,
            ppid,
            uid: UID,
            started_us,
            zombie: false,
            name: exe.rsplit('/').next().unwrap().to_string(),
            exe: exe.to_string(),
            cwd: None,
            tag: claude_pid.map(|pid| AgentTag { claude_pid: Some(pid), session_id: None }),
        }
    }

    fn claude(pid: u32, started_us: u64) -> Proc {
        proc(pid, 1, started_us, "/Users/w/Library/Application Support/Claude/claude-code/2.1/claude.app/Contents/MacOS/claude", None)
    }

    #[test]
    fn a_dev_server_whose_claude_exited_is_an_orphan() {
        let procs = [proc(200, 1, 50, "/opt/homebrew/bin/bun", Some(100))];
        assert_eq!(classify(&procs, UID, EAVESY).get(&200), Some(&Label::Orphan));
    }

    #[test]
    fn a_process_under_a_running_claude_is_live() {
        let procs = [claude(100, 10), proc(150, 100, 20, "/bin/zsh", Some(100)), proc(200, 150, 50, "/opt/homebrew/bin/node", Some(100))];
        let labels = classify(&procs, UID, EAVESY);
        assert_eq!(labels.get(&200), Some(&Label::Live));
        assert_eq!(labels.get(&100), None, "claude itself is never labelled");
    }

    #[test]
    fn a_detached_process_whose_claude_still_runs_is_live() {
        let procs = [claude(100, 10), proc(200, 1, 50, "/opt/homebrew/bin/node", Some(100))];
        assert_eq!(classify(&procs, UID, EAVESY).get(&200), Some(&Label::Live));
    }

    #[test]
    fn a_reused_claude_pid_doesnt_keep_it_alive() {
        // Pid 100 is a new claude, started after the server: not its claude.
        let procs = [claude(100, 90), proc(200, 1, 50, "/opt/homebrew/bin/node", Some(100))];
        assert_eq!(classify(&procs, UID, EAVESY).get(&200), Some(&Label::Orphan));
        // And a pid reused by something that isn't claude doesn't either.
        let procs = [proc(100, 1, 10, "/usr/bin/python3", None), proc(200, 1, 50, "/opt/homebrew/bin/node", Some(100))];
        assert_eq!(classify(&procs, UID, EAVESY).get(&200), Some(&Label::Orphan));
    }

    #[test]
    fn never_other_users_apps_system_shared_daemons_zombies_or_eavesy() {
        let mut other = proc(201, 1, 50, "/opt/homebrew/bin/node", Some(100));
        other.uid = 0;
        let app = proc(202, 1, 50, "/Applications/Slack.app/Contents/MacOS/Slack", Some(100));
        let system = proc(203, 1, 50, "/usr/libexec/trustd", Some(100));
        let mut zombie = proc(204, 1, 50, "/opt/homebrew/bin/node", Some(100));
        zombie.zombie = true;
        let eavesy = proc(EAVESY, 1, 50, "/Users/w/eavesy/target/debug/eavesy", Some(100));
        let eavesy_child = proc(205, EAVESY, 60, "/usr/bin/say", Some(100));
        let untagged = proc(206, 1, 50, "/opt/homebrew/bin/node", None);
        let gpg = proc(207, 1, 50, "/opt/homebrew/bin/keyboxd", Some(100));
        let unseen = proc(208, 1, 50, "", Some(100));
        let labels = classify(&[other, app, system, zombie, eavesy, eavesy_child, untagged, gpg, unseen], UID, EAVESY);
        assert!(labels.is_empty(), "{labels:?}");
    }

    #[test]
    fn orphans_group_under_the_first_orphan() {
        let procs = [
            proc(200, 1, 50, "/opt/homebrew/bin/bun", Some(100)),
            proc(201, 200, 51, "/opt/homebrew/bin/esbuild", Some(100)),
            proc(202, 201, 52, "/opt/homebrew/bin/node", Some(100)),
            proc(300, 1, 40, "/usr/local/bin/cargo", Some(101)),
        ];
        let labels = classify(&procs, UID, EAVESY);
        assert_eq!(orphan_groups(&procs, &labels), vec![(300, vec![]), (200, vec![201, 202])]);
    }

    fn procargs(exe: &str, args: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buf = (args.len() as i32).to_ne_bytes().to_vec();
        buf.extend_from_slice(exe.as_bytes());
        buf.extend_from_slice(&[0, 0, 0]);
        for part in args.iter().chain(env) {
            buf.extend_from_slice(part.as_bytes());
            buf.push(0);
        }
        buf.push(0);
        buf.extend_from_slice(b"executable_path=/x\0");
        buf
    }

    #[test]
    fn reads_the_tag_from_the_environment_not_the_arguments() {
        let buf = procargs("/bin/node", &["node", "CLAUDE_PID=1"], &["HOME=/Users/w", "CLAUDECODE=1", "CLAUDE_PID=4242", "CLAUDE_CODE_SESSION_ID=abc"]);
        assert_eq!(parse_procargs(&buf), Some(AgentTag { claude_pid: Some(4242), session_id: Some("abc".into()) }));
        let buf = procargs("/bin/node", &["node", "CLAUDE_PID=1"], &["HOME=/Users/w"]);
        assert_eq!(parse_procargs(&buf), None);
        assert_eq!(parse_procargs(&[1, 0]), None);
    }

    /// The child for the test below: this test binary, so it isn't one of
    /// Apple's own (macOS hides their environments).
    #[test]
    #[ignore]
    fn wait_as_a_leftover() {
        if std::env::var_os("EAVESY_TEST_LEFTOVER").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stops_only_a_child_whose_claude_is_gone() {
        use std::os::unix::process::ExitStatusExt;
        use std::process::Command;
        // A pid that has exited: a finished child's.
        let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
        let gone_pid = gone.id();
        let _ = gone.wait();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "machine::procs::tests::wait_as_a_leftover", "--test-threads=1"])
            .env("EAVESY_TEST_LEFTOVER", "1")
            .env("CLAUDECODE", "1")
            .env("CLAUDE_PID", gone_pid.to_string())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut me = None;
        for _ in 0..200 {
            me = read_one(pid);
            if me.as_ref().and_then(|proc| proc.tag.as_ref()).is_some_and(|tag| tag.claude_pid == Some(gone_pid)) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let mut me = me.expect("the child is listed");
        // A sandbox (Claude Code's own, say) hides other processes'
        // environments; CI runs without one, so there it must be read.
        if me.tag.is_none() && std::env::var_os("CI").is_none() {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("skipped: this sandbox hides process environments");
            return;
        }
        assert_eq!(me.tag.as_ref().and_then(|tag| tag.claude_pid), Some(gone_pid));
        assert_eq!(me.cwd.as_deref(), std::env::current_dir().ok().and_then(|dir| dir.to_str().map(str::to_string)).as_deref());
        // As if this test had exited too, so the child was handed to launchd.
        // (The test itself may run under a claude, which would keep it live.)
        me.ppid = 1;
        let labels = classify(std::slice::from_ref(&me), own_uid(), std::process::id());
        assert_eq!(labels.get(&pid), Some(&Label::Orphan));
        assert!(terminate(pid, me.started_us + 1).is_err(), "a different start time is a different process");
        terminate(pid, me.started_us).unwrap();
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGTERM));
    }
}
