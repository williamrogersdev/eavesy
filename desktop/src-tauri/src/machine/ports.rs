//! The TCP ports your processes are listening on, from `lsof`.

use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub pid: u32,
    pub port: u16,
    pub address: String,
}

/// `lsof -F pn` output: a `p<pid>` line, then one `n<address>:<port>` line
/// per socket. The same port on IPv4 and IPv6 is listed once.
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut listeners: Vec<Listener> = Vec::new();
    let mut pid = None;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse().ok();
        } else if let (Some(value), Some(pid)) = (line.strip_prefix('n'), pid) {
            let Some((address, port)) = value.rsplit_once(':') else { continue };
            let Ok(port) = port.parse() else { continue };
            if !listeners.iter().any(|known| known.pid == pid && known.port == port) {
                listeners.push(Listener { pid, port, address: address.to_string() });
            }
        }
    }
    listeners.sort_by_key(|listener| (listener.port, listener.pid));
    listeners
}

pub fn listening(uid: u32) -> Vec<Listener> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-u", &uid.to_string(), "-Fpn"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    // lsof exits 1 when nothing matches.
    output.map(|output| parse_lsof(&String::from_utf8_lossy(&output.stdout))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lsof_fields() {
        let text = "p812\nf23\nn*:5173\nf24\nn[::1]:5173\np90\nf5\nn127.0.0.1:3000\nf6\nn[::1]:x\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                Listener { pid: 90, port: 3000, address: "127.0.0.1".into() },
                Listener { pid: 812, port: 5173, address: "*".into() },
            ]
        );
    }
}
