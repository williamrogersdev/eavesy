//! Compare against frozen 0.5.4 using synthetic data only. Run in release mode.
#![allow(dead_code)]
#[path = "next-history-baseline.rs"]
mod baseline;
#[path = "../src-tauri/src/history.rs"]
mod history;
#[path = "history-legacy.rs"]
mod store;
#[path = "../src-tauri/src/work_queue.rs"]
mod work_queue;
use std::{hint::black_box, time::Instant};
fn measure<T>(name: &str, n: usize, reps: usize, mut f: impl FnMut() -> T) {
    f();
    let mut times = Vec::new();
    for _ in 0..reps {
        let at = Instant::now();
        black_box(f());
        times.push(at.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::json!({"operation":name,"n":n,"reps":reps,"median_ms":times[reps/2],"min_ms":times[0],"max_ms":times[reps-1]})
    );
}
fn old_queue<T: Sync, R: Send>(
    items: &[T],
    width: usize,
    work: impl Fn(&T) -> Result<R, String> + Sync,
) -> Result<Vec<R>, String> {
    let mut results = Vec::new();
    for batch in items.chunks(width.max(1)) {
        let batch_results: Vec<Result<R, String>> = std::thread::scope(|scope| {
            let workers: Vec<_> = batch
                .iter()
                .map(|item| scope.spawn(|| work(item)))
                .collect();
            workers
                .into_iter()
                .map(|w| {
                    w.join()
                        .unwrap_or_else(|_| Err("transcription worker panicked".into()))
                })
                .collect()
        });
        for result in batch_results {
            results.push(result?);
        }
    }
    Ok(results)
}
fn main() {
    use sha2::{Digest, Sha256};
    let sources: std::collections::BTreeMap<_, _> = [
        (
            "desktop/src-tauri/src/history.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/src/history.rs"))
            ),
        ),
        (
            "desktop/src-tauri/src/history_search_index.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/src/history_search_index.rs"))
            ),
        ),
        (
            "desktop/src-tauri/src/work_queue.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/src/work_queue.rs"))
            ),
        ),
        (
            "desktop/bench/next-performance.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("next-performance.rs"))
            ),
        ),
        (
            "desktop/bench/next-history-baseline.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("next-history-baseline.rs"))
            ),
        ),
        (
            "desktop/bench/history-legacy.rs",
            format!("{:x}", Sha256::digest(include_bytes!("history-legacy.rs"))),
        ),
        (
            "desktop/src-tauri/Cargo.toml",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/Cargo.toml"))
            ),
        ),
        (
            "desktop/src-tauri/Cargo.lock",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/Cargo.lock"))
            ),
        ),
        (
            "desktop/bench/next-runner/Cargo.toml",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("next-runner/Cargo.toml"))
            ),
        ),
        (
            "desktop/bench/next-runner/Cargo.lock",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("next-runner/Cargo.lock"))
            ),
        ),
        (
            "desktop/src-tauri/src/transcribe.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/src/transcribe.rs"))
            ),
        ),
        (
            "desktop/src-tauri/src/history_search.rs",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../src-tauri/src/history_search.rs"))
            ),
        ),
        (
            "web/src/lib/launcher/data.ts",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!("../../web/src/lib/launcher/data.ts"))
            ),
        ),
        (
            "web/src/components/launcher/use-history-page.ts",
            format!(
                "{:x}",
                Sha256::digest(include_bytes!(
                    "../../web/src/components/launcher/use-history-page.ts"
                ))
            ),
        ),
    ]
    .into_iter()
    .collect();
    println!(
        "{}",
        serde_json::json!({"operation":"source_snapshot","sources_sha256":sources})
    );

    let root = std::env::temp_dir().join(format!("eavesy-next-bench-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    for n in [100, 500, 2000] {
        let dir = root.join(n.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("recordings.json");
        let rows: Vec<_> = (0..n)
            .map(|i| store::StoredRecording {
                id: i.to_string(),
                title: "Synthetic meeting".into(),
                started_at_ms: i as i64,
                duration_sec: 3600,
                source: "mixed".into(),
                status: "complete".into(),
                summary: Some("Summary text. ".repeat(150)),
                transcript: Some(format!(
                    "{} {}",
                    "Synthetic transcript sentence about product decisions. ".repeat(1900),
                    if i == 0 { "unique_oldest" } else { "" }
                )),
                notes: Some("Notes. ".repeat(150)),
                has_audio: true,
                has_video: false,
                folder_path: None,
            })
            .collect();
        store::seed(&legacy, &rows);
        drop(rows);
        let mut old = baseline::History::open(&dir.join("old.sqlite3"), &legacy).unwrap();
        let path = dir.join("new.sqlite3");
        let mut new = history::History::open(&path, &legacy).unwrap();
        let at = Instant::now();
        new.prepare_search().unwrap();
        println!(
            "{}",
            serde_json::json!({"operation":"one_time_index_build","n":n,"elapsed_ms":at.elapsed().as_secs_f64()*1000.0})
        );
        for (label, q) in [
            ("empty", ""),
            ("common", "decisions"),
            ("absent", "zzneverfoundzz"),
            ("rare_oldest", "unique_oldest"),
            ("title", "Synthetic"),
            ("multi_absent", "product decisions zzneverfoundzz"),
            ("short_absent", "zx"),
        ] {
            assert_eq!(
                serde_json::to_value(old.page(0, 50, q, "all").unwrap()).unwrap(),
                serde_json::to_value(new.page(0, 50, q, "all").unwrap()).unwrap()
            );
            measure(&format!("before_search_{label}"), n, 7, || {
                old.page(0, 50, q, "all").unwrap()
            });
            // Include opening a new read connection, as production now does.
            measure(&format!("after_search_{label}"), n, 7, || {
                history::History::read_only(&path)
                    .unwrap()
                    .page_while(0, 50, q, "all", || false)
                    .unwrap()
            });
        }
        measure("before_title_update", n, 7, || {
            let mut r = old.get("0").unwrap().unwrap();
            r.title.push('x');
            old.put(&r).unwrap();
        });
        measure("after_title_update", n, 7, || {
            let mut r = new.get("0").unwrap().unwrap();
            r.title.push('x');
            new.put(&r).unwrap();
        });
        measure("before_transcript_update", n, 7, || {
            let mut r = old.get("0").unwrap().unwrap();
            r.transcript.as_mut().unwrap().push_str(" word");
            old.put(&r).unwrap();
        });
        measure("after_transcript_update", n, 7, || {
            let mut r = new.get("0").unwrap().unwrap();
            r.transcript.as_mut().unwrap().push_str(" word");
            new.put(&r).unwrap();
        });
        drop(new);
        drop(old);
        println!(
            "{}",
            serde_json::json!({"operation":"database_bytes","n":n,"before":std::fs::metadata(dir.join("old.sqlite3")).unwrap().len(),"after":std::fs::metadata(&path).unwrap().len()})
        );
    }
    for (name, times) in [
        ("uniform", vec![40; 18]),
        ("variable", [120, 20, 20].repeat(6)),
    ] {
        let work = |ms: &u64| {
            std::thread::sleep(std::time::Duration::from_millis(*ms));
            Ok(*ms)
        };
        assert_eq!(
            old_queue(&times, 3, work).unwrap(),
            work_queue::run(&times, 3, work).unwrap()
        );
        measure(&format!("before_queue_{name}"), 18, 7, || {
            old_queue(&times, 3, work).unwrap()
        });
        measure(&format!("after_queue_{name}"), 18, 7, || {
            work_queue::run(&times, 3, work).unwrap()
        });
    }
    std::fs::remove_dir_all(root).unwrap();
}
