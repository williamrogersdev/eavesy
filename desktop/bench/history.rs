//! Release benchmark of production indexed history against f63092a JSON history.
//! PROFILE_ALLOC=1 measures cumulative allocations separately. Synthetic data only.
#![allow(dead_code)]
#[path = "history-alloc.rs"]
mod alloc;
#[global_allocator]
static METER: alloc::Meter = alloc::Meter;
#[path = "../src-tauri/src/history.rs"]
mod history;
#[path = "history-legacy.rs"]
mod store;
use std::{hint::black_box, path::Path, time::Instant};
fn measure<T>(name: &str, n: usize, reps: usize, mut f: impl FnMut() -> T) {
    if std::env::var_os("PROFILE_ALLOC").is_some() {
        f();
        alloc::BYTES.store(0, std::sync::atomic::Ordering::Relaxed);
        alloc::CALLS.store(0, std::sync::atomic::Ordering::Relaxed);
        alloc::ENABLED.store(true, std::sync::atomic::Ordering::Relaxed);
        black_box(f());
        alloc::ENABLED.store(false, std::sync::atomic::Ordering::Relaxed);
        println!(
            "{}",
            serde_json::json!({"operation":name,"n":n,"allocated_bytes":alloc::BYTES.load(std::sync::atomic::Ordering::Relaxed),"allocation_calls":alloc::CALLS.load(std::sync::atomic::Ordering::Relaxed)})
        );
        return;
    }
    f();
    let mut times = Vec::new();
    for _ in 0..reps {
        let at = Instant::now();
        black_box(f());
        times.push(at.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{}",
        serde_json::json!({"operation":name,"n":n,"reps":reps,"median_ms":times[times.len()/2],"min_ms":times[0],"max_ms":times[times.len()-1]})
    );
}
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RecordingDto {
    pub id: String,
    pub title: String,
    pub started_at_ms: i64,
    pub duration_sec: i64,
    pub source: String,
    pub status: String,
    pub summary: Option<String>,
    pub transcript: Option<String>,
    pub has_audio: bool,
    pub has_video: bool,
}

fn response(path: &Path) -> Vec<RecordingDto> {
    store::load(path)
        .into_iter()
        .map(|r| RecordingDto {
            id: r.id,
            title: r.title,
            started_at_ms: r.started_at_ms,
            duration_sec: r.duration_sec,
            source: r.source,
            status: r.status,
            summary: r.summary,
            transcript: r.transcript,
            has_audio: r.has_audio,
            has_video: r.has_video,
        })
        .collect()
}
fn fixtures(root: &Path, n: usize) -> Vec<store::StoredRecording> {
    (0..n)
        .map(|i| {
            let folder = root.join(format!("meeting-{i}"));
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("meeting.json"), format!("{{\"id\":\"{i}\"}}")).unwrap();
            store::StoredRecording {
                id: i.to_string(),
                title: "Synthetic meeting".into(),
                started_at_ms: i as i64,
                duration_sec: 3600,
                source: "mixed".into(),
                status: "complete".into(),
                summary: Some("Summary text. ".repeat(150)),
                transcript: Some(
                    "Synthetic transcript sentence about product decisions. ".repeat(1900),
                ),
                notes: Some("Notes. ".repeat(150)),
                has_audio: true,
                has_video: false,
                folder_path: Some(folder.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

fn main() {
    let root = std::env::temp_dir().join(format!("eavesy-history-bench-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    for n in [10, 100, 500] {
        let dir = root.join(n.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let rows = fixtures(&dir, n);
        let path = dir.join("recordings.json");
        store::seed(&path, &rows);
        drop(rows);
        let at = Instant::now();
        let mut history = history::History::open(&dir.join("history.sqlite3"), &path).unwrap();
        println!(
            "{}",
            serde_json::json!({"operation":"one_time_migration","n":n,"elapsed_ms":at.elapsed().as_secs_f64()*1000.0,"legacy_bytes":std::fs::metadata(&path).unwrap().len()})
        );
        // These two cases isolate startup history access, excluding common hashing,
        // filesystem reconciliation, and Tauri setup in both implementations.
        measure("before_startup_history_work", n, 3, || {
            let all = store::load(&path);
            for _ in &all {
                for _ in 0..3 {
                    black_box(store::load(&path));
                }
            }
        });
        measure("after_startup_history_work", n, 7, || {
            for (id, folder) in history.folders().unwrap() {
                let rec = history.get(&id).unwrap().unwrap();
                for name in ["summary.md", "transcript.md", "notes.md"] {
                    black_box((Path::new(&folder).join(name), &rec));
                }
            }
        });
        measure("before_one_title_update", n, 7, || {
            store::update(&path, "0")
        });
        measure("after_one_title_update", n, 7, || {
            let mut rec = history.get("0").unwrap().unwrap();
            let before = rec.clone();
            rec.title.push('x');
            if rec != before {
                history.put(&rec).unwrap();
            }
        });
        measure("before_full_history_json", n, 9, || {
            serde_json::to_vec(&response(&path)).unwrap()
        });
        measure("after_first_history_page_json", n, 9, || {
            serde_json::to_vec(&history.page(0, 50, "", "all").unwrap()).unwrap()
        });
        measure("after_search_full_history", n, 7, || {
            history.page(0, 50, "decisions", "all").unwrap()
        });
        println!(
            "{}",
            serde_json::json!({"n":n,"before_response_bytes":serde_json::to_vec(&response(&path)).unwrap().len(),"after_response_bytes":serde_json::to_vec(&history.page(0,50,"","all").unwrap()).unwrap().len()})
        );
        assert_eq!(history.ids().unwrap().len(), n);
    }
    std::fs::remove_dir_all(root).unwrap();
}
