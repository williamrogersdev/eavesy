//! Release-only synthetic benchmark; no actual recordings or capture devices.
use super::*;
fn baseline_recording<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    recording: &store::StoredRecording,
) -> Result<()> {
    let Some(role) = file_role(path) else {
        return Ok(());
    };
    let parent = path.parent().context("edited file has no parent folder")?;
    let file_name = path.file_name().context("edited file has no name")?;
    let owned_path =
        Path::new(recording.folder_path.as_deref().unwrap_or_default()).join(file_name);
    let path = owned_path.as_path();

    if !path.is_file() {
        if parent.is_dir() {
            fs_writer::restore_missing_editable_file(Some(app), path, recording, role)
                .map_err(anyhow::Error::msg)?;
            let _ = app.emit("recordings:updated", ());
        }
        return Ok(());
    }

    let bytes = read_bounded(path)?;
    let hash = sha256_hex(&bytes);
    let expected_hash = fs_writer::expected_editable_content(recording, role)
        .map(|content| sha256_hex(content.as_bytes()));
    match sqlite::classify_file_observation(app, path, &hash, expected_hash.as_deref())
        .map_err(anyhow::Error::msg)?
    {
        sqlite::FileObservation::Current => return Ok(()),
        sqlite::FileObservation::Baseline => {
            sqlite::record_file_write(app, path, &recording.id, role, &hash)
                .map_err(anyhow::Error::msg)?;
            return Ok(());
        }
        sqlite::FileObservation::External => {}
    }
    let content = String::from_utf8(bytes).context("edited recording file is not UTF-8")?;
    store::apply_external_edit(app, &recording.id, role, content.clone())
        .map_err(anyhow::Error::msg)?;
    sqlite::enqueue_file_edit(app, &recording.id, role, &content, &hash)
        .map_err(anyhow::Error::msg)?;
    sqlite::record_file_observation(app, path, &recording.id, role, &hash)
        .map_err(anyhow::Error::msg)?;
    let _ = app.emit("recordings:updated", ());
    Ok(())
}

fn baseline_seed<R: Runtime>(app: &AppHandle<R>) {
    for (id, folder) in store::folders(app).unwrap() {
        let r = store::get(app, &id).unwrap().unwrap();
        for file in ["summary.md", "transcript.md", "notes.md"] {
            baseline_recording(app, &Path::new(&folder).join(file), &r).unwrap();
        }
    }
}
fn measure(name: &str, n: usize, mut f: impl FnMut()) {
    let mut ms = Vec::new();
    f();
    for _ in 0..7 {
        let at = std::time::Instant::now();
        f();
        ms.push(at.elapsed().as_secs_f64() * 1000.0);
    }
    ms.sort_by(f64::total_cmp);
    println!(
        "NEXT_BENCH {}",
        serde_json::json!({"operation":name,"n":n,"reps":7,"median_ms":ms[3],"min_ms":ms[0],"max_ms":ms[6]})
    );
}
#[test]
#[ignore = "release-mode synthetic performance benchmark"]
fn next_reconciliation_benchmark() {
    for n in [100, 500, 2000] {
        let root =
            std::env::temp_dir().join(format!("eavesy-next-startup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        let app = tauri::test::mock_builder().build(context).unwrap();
        sqlite::initialize(app.handle()).unwrap();
        for i in 0..n {
            let folder = root.join(format!("meeting-{i}"));
            std::fs::create_dir_all(&folder).unwrap();
            let r = store::StoredRecording {
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
            };
            fs_writer::persist_recording_artifacts(
                Some(app.handle()),
                &folder,
                &r,
                None,
                r.notes.as_deref(),
            )
            .unwrap();
            store::append(app.handle(), r).unwrap();
        }
        assert!(store::prepare_search(app.handle()).unwrap());
        measure("before_reconciliation", n, || {
            reconcile_folder_locations(app.handle(), &root).unwrap();
            baseline_seed(app.handle());
        });
        measure("after_reconciliation_background", n, || {
            reconcile_folder_locations(app.handle(), &root).unwrap();
            seed_existing_files(app.handle());
        });
        let mut times = Vec::new();
        for _ in 0..7 {
            let (tx, rx) = mpsc::channel();
            let at = std::time::Instant::now();
            let worker = spawn_reconciler(
                app.handle().clone(),
                root.clone(),
                rx,
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            );
            times.push(at.elapsed().as_secs_f64() * 1000.0);
            drop(tx);
            worker.join().unwrap();
        }
        times.sort_by(f64::total_cmp);
        println!(
            "NEXT_BENCH {}",
            serde_json::json!({"operation":"after_worker_dispatch","n":n,"reps":7,"median_ms":times[3],"min_ms":times[0],"max_ms":times[6]})
        );
        drop(app);
        std::fs::remove_dir_all(root).unwrap();
    }
}
