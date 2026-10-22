//! The container's only port. The Worker's Durable Object uses it to check
//! the bot is alive and to ask it to leave. Cloudflare routes nothing else to
//! a container's ports, and with CONTROL_TOKEN set, /leave also needs it as
//! a bearer token, so the port is safe wherever the image runs.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

#[derive(Clone, Default)]
pub struct Status(Arc<Mutex<String>>);

impl Status {
    pub fn set(&self, phase: String) {
        *self.0.lock().unwrap() = phase;
    }
    fn get(&self) -> String {
        self.0.lock().unwrap().clone()
    }
}

/// Bytes of request head read at most, and how long a client gets to send it.
const MAX_HEAD: usize = 8 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);

/// Reads up to the end of the request head; None if it is too big, too slow or cut off.
async fn read_head(stream: &mut (impl AsyncReadExt + Unpin)) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    tokio::time::timeout(HEAD_TIMEOUT, async {
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 || buf.len() + n > MAX_HEAD {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Some(String::from_utf8_lossy(&buf).into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Routes one request head to a status code and body.
pub fn route(head: &str, token: Option<&str>, leave: &watch::Sender<bool>, status: &Status) -> (&'static str, String) {
    let line = head.lines().next().unwrap_or("");
    if line.starts_with("POST /leave ") {
        let authorized = token.is_none_or(|t| {
            head.lines().any(|h| h.split_once(':').is_some_and(|(k, v)| k.eq_ignore_ascii_case("authorization") && v.trim() == format!("Bearer {t}")))
        });
        if !authorized {
            return ("401 Unauthorized", "{}".to_owned());
        }
        let _ = leave.send(true);
        ("200 OK", r#"{"ok":true}"#.to_owned())
    } else if line.starts_with("GET /") {
        ("200 OK", serde_json::json!({ "phase": status.get() }).to_string())
    } else {
        ("404 Not Found", "{}".to_owned())
    }
}

pub async fn serve(port: u16, token: Option<String>, leave: watch::Sender<bool>, status: Status) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            crate::ingest::log(serde_json::json!({ "msg": "control bind", "error": e.to_string() }));
            return;
        }
    };
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let (leave, status, token) = (leave.clone(), status.clone(), token.clone());
        tokio::spawn(async move {
            let Some(head) = read_head(&mut stream).await else { return };
            let (code, body) = route(&head, token.as_deref(), &leave, &status);
            let reply = format!(
                "HTTP/1.1 {code}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_a_head_split_across_packets() {
        let (mut client, mut server) = tokio::io::duplex(64);
        tokio::spawn(async move {
            client.write_all(b"POST /le").await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            client.write_all(b"ave HTTP/1.1\r\nhost: x\r\n\r\n").await.unwrap();
        });
        assert!(read_head(&mut server).await.unwrap().starts_with("POST /leave HTTP/1.1"));
    }

    #[test]
    fn leave_needs_the_token_when_one_is_set() {
        let (tx, rx) = watch::channel(false);
        let status = Status::default();
        let head = "POST /leave HTTP/1.1\r\nhost: bot\r\n\r\n";
        assert_eq!(route(head, Some("s3cret"), &tx, &status).0, "401 Unauthorized");
        assert!(!*rx.borrow());
        let signed = "POST /leave HTTP/1.1\r\nAuthorization: Bearer s3cret\r\n\r\n";
        assert_eq!(route(signed, Some("s3cret"), &tx, &status).0, "200 OK");
        assert!(*rx.borrow());
        assert_eq!(route("GET /x HTTP/1.1\r\n\r\n", None, &tx, &status).0, "200 OK");
        assert_eq!(route("DELETE / HTTP/1.1\r\n\r\n", None, &tx, &status).0, "404 Not Found");
    }
}
