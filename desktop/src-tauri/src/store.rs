use crate::history::History;
pub use crate::history::{HistoryPage, StoredRecording};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Manager, Runtime};

// A separate history connection keeps record mutations serialized without
// holding the upload database mutex while checking locally edited files.
fn history<R: Runtime>(app: &AppHandle<R>) -> Result<MutexGuard<'static, History>, String> {
    static HISTORIES: Mutex<Vec<(PathBuf, &'static Mutex<History>)>> = Mutex::new(Vec::new());
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut histories = HISTORIES.lock().unwrap_or_else(PoisonError::into_inner);
    let shared = match histories.iter().find(|(path, _)| path == &dir) {
        Some((_, shared)) => *shared,
        None => {
            let shared: &'static Mutex<History> = Box::leak(Box::new(Mutex::new(History::open(
                &dir.join("history.sqlite3"),
                &dir.join("recordings.json"),
            )?)));
            histories.push((dir, shared));
            shared
        }
    };
    drop(histories);
    Ok(shared.lock().unwrap_or_else(PoisonError::into_inner))
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    drop(history(app)?);
    Ok(())
}
pub fn get<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Option<StoredRecording>, String> {
    history(app)?.get(id)
}
pub fn locations<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<(String, Option<String>)>, String> {
    history(app)?.locations()
}
pub fn folders<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<(String, String)>, String> {
    history(app)?.folders()
}
pub fn ids<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    history(app)?.ids()
}
pub fn by_folder<R: Runtime>(
    app: &AppHandle<R>,
    folder: &Path,
) -> Result<Option<StoredRecording>, String> {
    history(app)?.by_folder(folder)
}
pub fn page<R: Runtime>(
    app: &AppHandle<R>,
    offset: usize,
    limit: usize,
    query: &str,
    filter: &str,
) -> Result<HistoryPage, String> {
    history(app)?.page(offset, limit, query, filter)
}
pub fn details<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<(StoredRecording, i64)>, String> {
    let history = history(app)?;
    Ok(history.get(id)?.zip(history.revision(id)?))
}
pub fn append<R: Runtime>(app: &AppHandle<R>, rec: StoredRecording) -> Result<(), String> {
    history(app)?.put(&rec)
}
pub fn remove<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    history(app)?.remove(id)
}

fn mutate<R: Runtime, T>(
    app: &AppHandle<R>,
    id: &str,
    update: impl FnOnce(&mut StoredRecording) -> Result<T, String>,
) -> Result<Option<T>, String> {
    let mut history = history(app)?;
    let Some(mut rec) = history.get(id)? else {
        return Ok(None);
    };
    let before = rec.clone();
    let result = update(&mut rec)?;
    if rec != before {
        history.put(&rec)?;
    }
    Ok(Some(result))
}

pub fn set_transcript<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    transcript: Option<String>,
    status: &str,
) -> Result<(), String> {
    mutate(app, id, |rec| {
        let local = rec
            .folder_path
            .as_deref()
            .map(Path::new)
            .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join("transcript.md")))
            .transpose()?
            .unwrap_or(false);
        if !local {
            rec.transcript = transcript;
        }
        rec.status = status.to_string();
        Ok(())
    })?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn set_result<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    title: &str,
    transcript: String,
    summary: Option<String>,
    notes: Option<String>,
    status: &str,
    transcript_final: bool,
) -> Result<Option<(StoredRecording, bool)>, String> {
    mutate(app, id, |recording| {
        let folder = recording.folder_path.as_deref().map(Path::new);
        let is_local = |name: &str| {
            folder
                .map(|folder| crate::fs_writer::has_local_edit(app, &folder.join(name)))
                .transpose()
                .map(|local| local.unwrap_or(false))
        };
        let transcript_is_local = is_local("transcript.md")?;
        let summary_is_local = is_local("summary.md")?;
        let notes_are_local = is_local("notes.md")?;
        let before = recording.clone();
        recording.title = title.to_string();
        if !transcript_is_local
            && takes_cloud_transcript(
                recording.transcript.as_deref(),
                &transcript,
                status,
                transcript_final,
            )
        {
            recording.transcript = Some(transcript);
        }
        if !summary_is_local {
            recording.summary = summary;
        }
        if !notes_are_local {
            recording.notes = notes;
        }
        recording.status = status.to_string();
        let changed = *recording != before;
        Ok((recording.clone(), changed))
    })
}

fn takes_cloud_transcript(
    current: Option<&str>,
    cloud: &str,
    status: &str,
    transcript_final: bool,
) -> bool {
    let current_words = current.map_or(0, spoken_word_count);
    let cloud_words = spoken_word_count(cloud);
    if cloud_words == 0 && current_words > 0 {
        return false;
    }
    if transcript_final {
        return true;
    }
    match status {
        "transcript_failed" => current_words == 0,
        _ => cloud_words >= current_words,
    }
}

/// Words in a transcript, leaving out markdown headings: a cloud transcript
/// with no lines is still "# Title / ## Transcript", which says nothing.
fn spoken_word_count(text: &str) -> usize {
    text.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .flat_map(str::split_whitespace)
        .filter(|w| w.chars().any(char::is_alphabetic))
        .count()
}

pub fn apply_external_edit<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    role: &str,
    content: String,
) -> Result<(), String> {
    mutate(app, id, |rec| {
        match role {
            "summary" => rec.summary = Some(content),
            "transcript" => rec.transcript = Some(content),
            "notes" => rec.notes = Some(content),
            _ => return Err(format!("unsupported recording file role: {role}")),
        };
        Ok(())
    })?;
    Ok(())
}
pub fn set_folder_path<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    folder: &Path,
) -> Result<(), String> {
    mutate(app, id, |rec| {
        rec.folder_path = Some(folder.to_string_lossy().into_owned());
        Ok(())
    })?;
    Ok(())
}
pub fn set_status<R: Runtime>(app: &AppHandle<R>, id: &str, status: &str) -> Result<(), String> {
    mutate(app, id, |rec| {
        rec.status = status.to_string();
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
pub fn load_all<R: Runtime>(app: &AppHandle<R>) -> Vec<StoredRecording> {
    let history = history(app).unwrap();
    {
        let mut rows: Vec<_> = history
            .ids()
            .unwrap()
            .into_iter()
            .filter_map(|id| history.get(&id).unwrap())
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.started_at_ms));
        rows
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_partial_cloud_transcript_does_not_replace_fuller_on_device_text() {
        let on_device = Some("Hello there, this is the whole recording.");
        let partial = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there,";
        assert!(!takes_cloud_transcript(
            on_device,
            partial,
            "processing",
            false
        ));
        let caught_up = "# Recording\n\n## Transcript\n\n[00:00:00] Hello there, this is the whole recording now.";
        assert!(takes_cloud_transcript(
            on_device,
            caught_up,
            "processing",
            false
        ));
        assert!(takes_cloud_transcript(None, partial, "processing", false));
    }

    #[test]
    fn a_finished_cloud_transcript_with_words_replaces_the_on_device_one() {
        let cloud = "# R\n\n## Transcript\n\n[00:00:00] short";
        assert!(takes_cloud_transcript(
            Some("much longer on device text than the cloud"),
            cloud,
            "complete",
            true
        ));
        assert!(takes_cloud_transcript(
            Some("much longer on device text than the cloud"),
            cloud,
            "processing",
            true
        ));
        // Complete but missing parts that never uploaded: it has to catch up first.
        assert!(!takes_cloud_transcript(
            Some("much longer on device text than the cloud"),
            cloud,
            "complete",
            false
        ));
    }

    #[test]
    fn an_empty_cloud_transcript_never_wipes_on_device_words() {
        // What render_transcript writes for a result with no lines.
        let empty = "# Voice memo\n\n## Transcript\n\n";
        let heard = Some("Remind me to call the bank tomorrow.");
        for status in ["complete", "processing", "transcript_failed"] {
            assert!(
                !takes_cloud_transcript(heard, empty, status, true),
                "{status}"
            );
            assert!(
                !takes_cloud_transcript(heard, "   \n", status, false),
                "{status}"
            );
        }
        // With nothing heard on device there is nothing to protect.
        assert!(takes_cloud_transcript(None, empty, "complete", false));
        assert!(takes_cloud_transcript(Some("  "), empty, "complete", false));
    }

    #[test]
    fn a_failed_cloud_transcript_keeps_the_on_device_text() {
        let empty = "# Recording\n\n## Transcript\n\n";
        assert!(!takes_cloud_transcript(
            Some("What the Mac heard."),
            empty,
            "transcript_failed",
            false
        ));
        assert!(takes_cloud_transcript(
            None,
            empty,
            "transcript_failed",
            false
        ));
    }

    #[test]
    fn headings_are_not_spoken_words() {
        assert_eq!(spoken_word_count("# Voice memo\n\n## Transcript\n\n"), 0);
        assert_eq!(spoken_word_count("# T\n\n[00:00:01] hello there\n"), 2);
    }
}

#[cfg(test)]
mod persistence_tests {
    use super::*;
    fn app(root: &Path) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = root.to_string_lossy().into_owned();
        tauri::test::mock_builder().build(context).unwrap()
    }
    fn recording(id: String) -> StoredRecording {
        StoredRecording {
            id,
            title: "Initial".into(),
            started_at_ms: 1,
            duration_sec: 0,
            source: "mixed".into(),
            status: "processing".into(),
            summary: None,
            transcript: None,
            notes: None,
            has_audio: true,
            has_video: false,
            folder_path: None,
        }
    }
    #[test]
    fn concurrent_updates_and_appends_never_lose_other_fields_or_recordings() {
        let root =
            std::env::temp_dir().join(format!("eavesy-store-parallel-{}", uuid::Uuid::new_v4()));
        let fixture = app(&root);
        append(fixture.handle(), recording("shared".into())).unwrap();
        std::thread::scope(|scope| {
            for i in 0..16 {
                let handle = fixture.handle();
                scope.spawn(move || {
                    append(handle, recording(i.to_string())).unwrap();
                    apply_external_edit(
                        handle,
                        "shared",
                        if i % 2 == 0 { "notes" } else { "summary" },
                        "kept".into(),
                    )
                    .unwrap();
                });
            }
        });
        assert_eq!(ids(fixture.handle()).unwrap().len(), 17);
        let shared = get(fixture.handle(), "shared").unwrap().unwrap();
        assert_eq!(shared.notes.as_deref(), Some("kept"));
        assert_eq!(shared.summary.as_deref(), Some("kept"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unchanged_result_does_not_write_or_increment_revision() {
        let root = std::env::temp_dir().join(format!("eavesy-store-poll-{}", uuid::Uuid::new_v4()));
        let fixture = app(&root);
        let handle = fixture.handle();
        append(handle, recording("a".into())).unwrap();
        let poll = || {
            set_result(
                handle,
                "a",
                "Sync",
                "transcript".into(),
                None,
                None,
                "processing",
                false,
            )
            .unwrap()
            .unwrap()
        };
        assert!(poll().1);
        let revision = details(handle, "a").unwrap().unwrap().1;
        assert!(!poll().1);
        assert_eq!(details(handle, "a").unwrap().unwrap().1, revision);
        std::fs::remove_dir_all(root).unwrap();
    }
}
