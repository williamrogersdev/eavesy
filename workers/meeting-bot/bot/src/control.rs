//! The container's only port. The Worker's Durable Object uses it to check
//! the bot is alive and to ask it to leave; nothing else can reach it.

use std::sync::{Arc, Mutex};

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

pub async fn serve(port: u16, leave: watch::Sender<bool>, status: Status) {
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            crate::ingest::log(serde_json::json!({ "msg": "control bind", "error": e.to_string() }));
            return;
        }
    };
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let leave = leave.clone();
        let status = status.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            let line = head.lines().next().unwrap_or("");
            let (code, body) = if line.starts_with("POST /leave") {
                let _ = leave.send(true);
                ("200 OK", r#"{"ok":true}"#.to_owned())
            } else if line.starts_with("GET /") {
                ("200 OK", format!(r#"{{"phase":"{}"}}"#, status.get()))
            } else {
                ("404 Not Found", "{}".to_owned())
            };
            let reply = format!(
                "HTTP/1.1 {code}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        });
    }
}
