//! Hears from the server the moment a note or image is saved on another of the
//! user's devices, so it shows up here at once.
//!
//! Without this the sync loop only asks the server for new captures every
//! `CLOUD_PULL_INTERVAL`. This holds one WebSocket open to the user's hub (the
//! same one the web app's drops use) and, when the server says something
//! changed, asks the loop for a capture pass now. It carries no data itself: a
//! missed or lost message only means the change arrives at the next usual check.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tauri::AppHandle;
use tokio::time::{sleep, Instant};
use tokio_tungstenite::tungstenite::Message;

use crate::settings::{self, Credential};

/// How often a keepalive is sent. The server answers each without waking the hub.
const PING_EVERY: Duration = Duration::from_secs(20);
/// A connection that has sent nothing for this long after a keepalive is dead
/// (the Mac slept, the network changed): connect again.
const PONG_WITHIN: Duration = Duration::from_secs(10);
const CONNECT_LIMIT: Duration = Duration::from_secs(20);
/// Waits between tries while the connection cannot be made.
const RETRY: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
];
/// A connection that lasted this long was a good one: the next try starts from the shortest wait.
const SETTLED: Duration = Duration::from_secs(30);
/// How long to leave a server that has no live endpoint (an older self-hosted
/// one), or one that rejected this Mac's credential.
const UNAVAILABLE_RETRY: Duration = Duration::from_secs(10 * 60);
const NOT_PAIRED_RETRY: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    user_id: String,
    ticket: String,
}

/// The server has no live connection for this Mac: leave it alone for a while.
#[derive(Debug)]
struct Unavailable(String);
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Unavailable {}

/// Keeps the live connection up for the life of the app.
pub async fn run(app: AppHandle) {
    let mut failures = 0_usize;
    loop {
        let Some(credential) = settings::device_credential(&app) else {
            sleep(NOT_PAIRED_RETRY).await;
            continue;
        };
        let started = Instant::now();
        let error = connected(&app, &credential).await.err();
        if started.elapsed() >= SETTLED {
            failures = 0;
        }
        let wait = match &error {
            Some(error) if error.downcast_ref::<Unavailable>().is_some() => {
                tracing::info!("live sync: {error}; trying again in {}s", UNAVAILABLE_RETRY.as_secs());
                UNAVAILABLE_RETRY
            }
            Some(error) => {
                tracing::debug!("live sync: {error:#}");
                retry_wait(failures)
            }
            // The credential changed: connect with the new one now.
            None => Duration::ZERO,
        };
        failures = failures.saturating_add(1);
        sleep(wait).await;
    }
}

fn retry_wait(failures: usize) -> Duration {
    RETRY[failures.min(RETRY.len() - 1)]
}

/// The WebSocket address for a ticket, on the server the credential belongs to.
fn socket_url(base: &str, ticket: &Ticket) -> Result<String> {
    let mut url = reqwest::Url::parse(&crate::base_url::join(base, "/api/drops/live")).context("live sync address")?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        other => return Err(anyhow!("live sync: unsupported scheme {other}")),
    };
    url.set_scheme(scheme).map_err(|()| anyhow!("live sync: could not build the address"))?;
    url.query_pairs_mut().append_pair("u", &ticket.user_id).append_pair("ticket", &ticket.ticket);
    Ok(url.into())
}

/// Whether a message from the hub says the user's captures changed. Anything
/// else (a keepalive answer, a drop meant for browser tabs) is ignored.
fn is_sync_notice(text: &str) -> bool {
    #[derive(Deserialize)]
    struct Event {
        r#type: String,
    }
    serde_json::from_str::<Event>(text).is_ok_and(|event| event.r#type == "sync")
}

async fn ticket(credential: &Credential) -> Result<Ticket> {
    let response = crate::sync::http_client()?
        .post(crate::base_url::join(&credential.base, "/api/devices/live"))
        .bearer_auth(&credential.token)
        .timeout(CONNECT_LIMIT)
        .send()
        .await
        .context("ask for a live sync ticket")?;
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403 | 404 | 405) {
        return Err(Unavailable(format!("the server answered {status}")).into());
    }
    if !status.is_success() {
        return Err(anyhow!("live sync ticket: the server answered {status}"));
    }
    response.json().await.context("decode live sync ticket")
}

/// One connection, from ticket to close. `Ok` means this Mac's credential
/// changed while connected; any other end is an error.
async fn connected(app: &AppHandle, credential: &Credential) -> Result<()> {
    let ticket = ticket(credential).await?;
    let url = socket_url(&credential.base, &ticket)?;
    let (mut socket, _) = tokio::time::timeout(CONNECT_LIMIT, tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| anyhow!("live sync: connecting took too long"))?
        // The error can quote the address, which holds the ticket: keep its kind only.
        .map_err(|error| anyhow!("live sync: could not connect ({})", error_kind(&error)))?;
    tracing::info!("live sync: connected");
    // Whatever was saved elsewhere while this Mac was not listening.
    crate::capture_sync::nudge_now();

    let mut next_ping = Instant::now() + PING_EVERY;
    let mut pong_due: Option<Instant> = None;
    loop {
        let deadline = pong_due.map_or(next_ping, |due| due.min(next_ping));
        tokio::select! {
            message = socket.next() => {
                let message = message
                    .ok_or_else(|| anyhow!("live sync: the server closed the connection"))?
                    .map_err(|error| anyhow!("live sync: connection lost ({})", error_kind(&error)))?;
                // Anything arriving shows the connection is alive.
                pong_due = None;
                match message {
                    Message::Text(text) if is_sync_notice(text.as_str()) => crate::capture_sync::nudge_now(),
                    Message::Close(_) => return Err(anyhow!("live sync: the server closed the connection")),
                    _ => {}
                }
            }
            () = tokio::time::sleep_until(deadline) => {
                let now = Instant::now();
                if pong_due.is_some_and(|due| now >= due) {
                    return Err(anyhow!("live sync: no answer from the server"));
                }
                if now >= next_ping {
                    if settings::device_credential(app).is_none_or(|now| now.token != credential.token || now.base != credential.base) {
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                    socket
                        .send(Message::Text("ping".into()))
                        .await
                        .map_err(|error| anyhow!("live sync: connection lost ({})", error_kind(&error)))?;
                    next_ping = now + PING_EVERY;
                    pong_due = Some(now + PONG_WITHIN);
                }
            }
        }
    }
}

/// A WebSocket error without its details, which can include the address.
fn error_kind(error: &tokio_tungstenite::tungstenite::Error) -> &'static str {
    use tokio_tungstenite::tungstenite::Error;
    match error {
        Error::ConnectionClosed | Error::AlreadyClosed => "closed",
        Error::Io(_) => "network",
        Error::Tls(_) => "tls",
        Error::Http(_) => "refused",
        Error::Protocol(_) => "protocol",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket() -> Ticket {
        Ticket { user_id: "usr_a b&c".into(), ticket: "t-1".into() }
    }

    #[test]
    fn the_socket_address_is_on_the_credentials_server() {
        assert_eq!(socket_url("https://eavesy.com", &ticket()).unwrap(), "wss://eavesy.com/api/drops/live?u=usr_a+b%26c&ticket=t-1");
        assert_eq!(socket_url("http://localhost:3000", &ticket()).unwrap(), "ws://localhost:3000/api/drops/live?u=usr_a+b%26c&ticket=t-1");
        assert!(socket_url("ftp://eavesy.com", &ticket()).is_err());
    }

    #[test]
    fn only_a_sync_notice_asks_for_a_pass() {
        assert!(is_sync_notice(r#"{"type":"sync","what":"captures"}"#));
        assert!(!is_sync_notice(r#"{"type":"drop","drop":{"id":"drp_1"},"origin":null}"#));
        assert!(!is_sync_notice(r#"{"type":"delete","id":"drp_1","origin":null}"#));
        assert!(!is_sync_notice("pong"));
        assert!(!is_sync_notice(""));
    }

    #[test]
    fn retries_slow_down_and_then_hold() {
        assert_eq!(retry_wait(0), Duration::from_secs(1));
        assert_eq!(retry_wait(4), Duration::from_secs(30));
        assert_eq!(retry_wait(400), Duration::from_secs(30));
    }
}
