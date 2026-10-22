//! Just enough of the Chrome DevTools Protocol to drive one page: commands
//! with replies, and a stream of the events we subscribe to.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Cdp {
    next_id: AtomicU64,
    pending: Pending,
    out: mpsc::UnboundedSender<Message>,
}

#[derive(Debug)]
pub struct Event {
    pub method: String,
    pub params: Value,
}

impl Cdp {
    /// Connects to a page target's websocket. Events arrive on the returned receiver.
    pub async fn connect(ws_url: &str) -> Result<(Self, mpsc::UnboundedReceiver<Event>), String> {
        let (socket, _) = tokio_tungstenite::connect_async(ws_url)
            .await
            .map_err(|e| format!("cdp connect: {e}"))?;
        let (mut sink, mut stream) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let pending: Pending = Arc::default();

        tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                let Message::Text(text) = msg else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let reply = match value.get("error") {
                        Some(err) => Err(err.to_string()),
                        None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    if let Some(tx) = reader_pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(reply);
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let params = value.get("params").cloned().unwrap_or(Value::Null);
                    let _ = events_tx.send(Event { method: method.to_owned(), params });
                }
            }
            // The browser went away: fail whatever is still waiting.
            reader_pending.lock().unwrap().clear();
        });

        Ok((Self { next_id: AtomicU64::new(1), pending, out }, events_rx))
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let msg = json!({ "id": id, "method": method, "params": params }).to_string();
        self.out.send(Message::Text(msg.into())).map_err(|_| "cdp closed".to_owned())?;
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("cdp closed".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("cdp timeout: {method}"))
            }
        }
    }

    /// Evaluates an expression in the page and returns its JSON value.
    pub async fn eval(&self, expression: &str) -> Result<Value, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(format!("page exception: {exception}"));
        }
        Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }
}
