//! UI generations cancel SQL work even when IPC requests arrive out of order.
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

#[derive(serde::Deserialize, Clone)]
pub struct Request {
    pub client: String,
    pub generation: u64,
}
pub struct Token {
    latest: Arc<AtomicU64>,
    generation: u64,
}
impl Token {
    pub fn cancelled(&self) -> bool {
        self.latest.load(Ordering::Acquire) > self.generation
    }
    pub fn callback(&self) -> impl Fn() -> bool + Send + std::panic::RefUnwindSafe + 'static {
        let latest = self.latest.clone();
        let generation = self.generation;
        move || latest.load(Ordering::Acquire) > generation
    }
}
type Clients = HashMap<String, (Arc<AtomicU64>, Instant)>;
static CLIENTS: std::sync::LazyLock<Mutex<Clients>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn register(request: &Request) -> Result<Token, String> {
    if request.client.is_empty() || request.client.len() > 128 || request.generation == u64::MAX {
        return Err("Invalid history search generation".into());
    }
    let mut clients = CLIENTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    clients.retain(|_, (epoch, at)| {
        Arc::strong_count(epoch) > 1 || at.elapsed() < Duration::from_secs(600)
    });
    if clients.len() >= 256 && !clients.contains_key(&request.client) {
        // Only discard inactive clients. An in-flight token must retain its epoch.
        if let Some(oldest) = clients
            .iter()
            .filter(|(_, (epoch, _))| Arc::strong_count(epoch) == 1)
            .min_by_key(|(_, (_, at))| *at)
            .map(|(id, _)| id.clone())
        {
            clients.remove(&oldest);
        }
    }
    let (latest, at) = clients
        .entry(request.client.clone())
        .or_insert_with(|| (Arc::new(AtomicU64::new(0)), Instant::now()));
    *at = Instant::now();
    latest.fetch_max(request.generation, Ordering::AcqRel);
    Ok(Token {
        latest: latest.clone(),
        generation: request.generation,
    })
}
pub fn cancel(request: Request) -> Result<(), String> {
    let token = register(&request)?;
    token
        .latest
        .fetch_max(request.generation + 1, Ordering::AcqRel);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_handles_reordered_requests_and_isolates_clients() {
        let client = uuid::Uuid::new_v4().to_string();
        let first = Request {
            client: client.clone(),
            generation: 1,
        };
        cancel(first.clone()).unwrap();
        assert!(register(&first).unwrap().cancelled());
        let second = Request {
            client,
            generation: 2,
        };
        let active = register(&second).unwrap();
        cancel(first.clone()).unwrap();
        assert!(!active.cancelled());
        assert!(register(&first).unwrap().cancelled());
        let other = register(&Request {
            client: uuid::Uuid::new_v4().to_string(),
            generation: 1,
        })
        .unwrap();
        cancel(second).unwrap();
        assert!(active.cancelled());
        assert!(!other.cancelled());
    }
}
