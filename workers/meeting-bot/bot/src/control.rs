//! The container's only port: it tells the Durable Object the bot is up and
//! which phase it is in, and nothing else. Asking the bot to leave is a
//! SIGTERM (the Container's `stop()`), never a request, so whoever can reach
//! this port can only read the phase.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

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
const HEAD_TIMEOUT: Duration = Duration::from_secs(2);
/// Connections handled at once; past that, new ones are closed straight away.
const MAX_CONNECTIONS: usize = 16;

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
pub fn route(head: &str, status: &Status) -> (&'static str, String) {
    if head.lines().next().unwrap_or("").starts_with("GET /") {
        ("200 OK", serde_json::json!({ "phase": status.get() }).to_string())
    } else {
        ("404 Not Found", "{}".to_owned())
    }
}

pub async fn serve(port: u16, status: Status) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            crate::ingest::log(serde_json::json!({ "msg": "control bind", "error": e.to_string() }));
            return;
        }
    };
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let Ok(slot) = slots.clone().try_acquire_owned() else { continue }; // dropping the stream closes it
        let status = status.clone();
        tokio::spawn(async move {
            let _slot = slot;
            let Some(head) = read_head(&mut stream).await else { return };
            let (code, body) = route(&head, &status);
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
            client.write_all(b"GET /sta").await.unwrap();
            tokio::time::sleep(Duration::from_millis(20)).await;
            client.write_all(b"tus HTTP/1.1\r\nhost: x\r\n\r\n").await.unwrap();
        });
        assert!(read_head(&mut server).await.unwrap().starts_with("GET /status HTTP/1.1"));
    }

    #[test]
    fn only_reads_the_phase() {
        let status = Status::default();
        status.set("InCall".into());
        assert_eq!(route("GET / HTTP/1.1\r\n\r\n", &status), ("200 OK", r#"{"phase":"InCall"}"#.to_owned()));
        assert_eq!(route("POST /leave HTTP/1.1\r\n\r\n", &status).0, "404 Not Found");
    }
}
