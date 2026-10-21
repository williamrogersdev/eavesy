// tauri-nspanel re-exports the legacy `cocoa`/`objc` crates: their APIs are deprecated and
// their `msg_send!` macros trip `unexpected_cfgs`. Moving to objc2 is a separate migration.
#![allow(deprecated, unexpected_cfgs)]

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use crate::{audio, fs_writer, hud, store};

#[tauri::command]
pub async fn capture_screenshot(app: AppHandle) -> Result<String, String> {
    if app.state::<audio::Captures>().is_busy() { return Err("Stop the current recording before taking a screenshot.".into()); }
    let id = uuid::Uuid::new_v4().to_string();
    let folder = fs_writer::recordings_root(&app)?.join(format!("Screenshot-{id}"));
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let path = folder.join("screenshot.png");
    if let Err(error) = take_screenshot(&app, &path).await {
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&folder);
        return Err(error);
    }
    let recording = store::StoredRecording { id: id.clone(), title: "Screenshot".into(), started_at_ms: chrono::Utc::now().timestamp_millis(), duration_sec: 0, source: "screenshot".into(), status: "complete".into(), summary: None, transcript: None, notes: None, has_audio: false, has_video: false, folder_path: Some(folder.to_string_lossy().into_owned()) };
    std::fs::write(folder.join("capture.json"), serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    store::append(&app, recording)?;
    let _ = app.emit("recordings:updated", ());
    // The HUD flashes a preview to copy or open; the clipboard is left as it was.
    hud::set_state(&app, hud::HudState { phase: hud::Phase::Done, session_id: Some(id.clone()), mode: Some("image".into()), started_at_ms: None, message: None, notice: None });
    // With the control closed there is no preview to flash: show it in the panel.
    if hud::hidden_by_user(&app) {
        crate::commands::show_launcher(app.clone());
    }
    Ok(id)
}

async fn take_screenshot(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), tokio::process::Command::new(audio::capture_bin(app)?)
        .arg("--screenshot").arg(path).kill_on_drop(true).output()).await
        .map_err(|_| "Screenshot timed out. Check Screen Recording access.".to_string())?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!("Could not capture screenshot: {}", engine_error(&String::from_utf8_lossy(&output.stdout))));
    }
    if std::fs::metadata(path).map_err(|error| error.to_string())?.len() == 0 { return Err("Screenshot is empty.".into()); }
    Ok(())
}

fn engine_error(stdout: &str) -> String {
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .find(|value| value.get("event").and_then(|e| e.as_str()) == Some("error"))
        .and_then(|value| value.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| {
            let raw = stdout.trim();
            if raw.is_empty() { "the capture engine stopped unexpectedly (check Screen Recording access)".to_string() } else { raw.to_string() }
        })
}

#[tauri::command]
pub async fn paste_clip(app: AppHandle) -> Result<String, String> {
    let clipboard = app.clipboard();
    let image = clipboard.read_image().ok().filter(|image| image.width() > 0 && image.height() > 0);
    let text = if image.is_none() {
        let text = clipboard.read_text().map_err(|_| "The clipboard is empty.".to_string())?;
        if text.trim().is_empty() { return Err("The clipboard is empty.".into()); }
        Some(text)
    } else { None };

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    let title = if image.is_some() { "Pasted image" } else { "Note" };
    let folder = fs_writer::allocate_recording_folder(&fs_writer::recordings_root(&app)?, title, now)?;
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    if let Some(image) = &image {
        let png = encode_png(image.rgba(), image.width(), image.height())?;
        std::fs::write(folder.join("image.png"), png).map_err(|error| error.to_string())?;
    }
    if let Some(text) = &text {
        std::fs::write(folder.join("note.md"), text).map_err(|error| error.to_string())?;
    }
    let recording = store::StoredRecording {
        id: id.clone(),
        title: title.into(),
        started_at_ms: now.timestamp_millis(),
        duration_sec: 0,
        source: if image.is_some() { "image" } else { "note" }.into(),
        status: "complete".into(),
        summary: None,
        transcript: text,
        notes: None,
        has_audio: false,
        has_video: false,
        folder_path: Some(folder.to_string_lossy().into_owned()),
    };
    std::fs::write(folder.join("capture.json"), serde_json::to_vec_pretty(&recording).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    store::append(&app, recording)?;
    let _ = app.emit("recordings:updated", ());
    Ok(id)
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer.write_image_data(rgba).map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())?;
    Ok(out)
}

fn media_path(app: &AppHandle, id: &str) -> Result<(PathBuf, bool), String> {
    let recording = store::get(app, id)?.ok_or("Capture not found.")?;
    let image = matches!(recording.source.as_str(), "screenshot" | "image");
    if !image && !recording.has_video && !recording.has_audio { return Err("This capture has no saved media.".into()); }
    let path = if let Some(folder) = recording.folder_path {
        let folder = PathBuf::from(folder);
        let known = folder.join(if recording.source == "image" { "image.png" } else if image { "screenshot.png" } else if recording.has_video { "screen.mp4" } else { "audio.m4a" });
        // Imported files keep their own format (image.jpg, audio.mp3, video.mov…).
        if known.is_file() { known } else { imported_media(&folder).unwrap_or(known) }
    } else {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid capture ID.")?;
        app.path().app_data_dir().map_err(|error| error.to_string())?.join("captures").join(format!("{id}.mp4"))
    };
    let path = path.canonicalize().map_err(|_| "Saved capture file is unavailable.")?;
    if !path.is_file() { return Err("Saved capture is not a file.".into()); }
    Ok((path, image))
}

/// The file an import stored under its own extension (`image.jpg`, `audio.mp3`…).
fn imported_media(folder: &std::path::Path) -> Option<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(folder).ok()?.filter_map(|entry| entry.ok().map(|entry| entry.path())).collect();
    entries.sort();
    entries.into_iter().find(|path| {
        let stem = path.file_stem().and_then(|stem| stem.to_str());
        matches!(stem, Some("image" | "screenshot" | "audio" | "video")) && path.is_file() && crate::imports::is_media(path)
    })
}

#[tauri::command]
pub fn capture_media(app: AppHandle, id: String) -> Result<String, String> {
    let (path, _) = media_path(&app, &id)?;
    app.asset_protocol_scope().allow_file(&path).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn copy_capture_media(app: AppHandle, id: String) -> Result<(), String> {
    if store::get(&app, &id)?.is_some_and(|r| r.has_video && r.source == "screen") {
        let text = crate::walkthrough::recording_context(app.clone(), id)?;
        return app.clipboard().write_text(text).map_err(|e| e.to_string());
    }
    let (path, image) = media_path(&app, &id)?;
    let png = path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
    if image && png {
        if std::fs::metadata(&path).map_err(|error| error.to_string())?.len() > 32 * 1024 * 1024 { return Err("Screenshot is too large to copy.".into()); }
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        let image = tauri::image::Image::from_bytes(&bytes).map_err(|error| error.to_string())?;
        return app.clipboard().write_image(&image).map_err(|error| error.to_string());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = sender.send(copy_file(&path)); }).map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn copy_file(path: &std::path::Path) -> Result<(), String> {
    use tauri_nspanel::{cocoa::{base::{id, nil, BOOL, YES}, foundation::NSString}, objc::{class, msg_send, sel, sel_impl}};
    unsafe {
        let string = NSString::alloc(nil).init_str(&path.to_string_lossy());
        let url: id = msg_send![class!(NSURL), fileURLWithPath: string];
        let objects: id = msg_send![class!(NSArray), arrayWithObject: url];
        let clipboard: id = msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![clipboard, clearContents];
        let written: BOOL = msg_send![clipboard, writeObjects: objects];
        let _: () = msg_send![string, release];
        if written == YES { Ok(()) } else { Err("Could not copy the video file.".into()) }
    }
}
#[cfg(not(target_os = "macos"))]
fn copy_file(_path: &std::path::Path) -> Result<(), String> { Err("Video file copying is available on Mac.".into()) }

#[cfg(test)]
mod tests {
    #[test]
    fn engine_errors_show_the_message_not_json() {
        assert_eq!(super::engine_error("{\"event\":\"error\",\"message\":\"Screenshot failed: denied\"}\n"), "Screenshot failed: denied");
        assert_eq!(super::engine_error("plain text"), "plain text");
        assert!(super::engine_error("").contains("Screen Recording"));
    }

    #[test]
    fn pasted_pixels_encode_as_a_png() {
        let png = super::encode_png(&[255, 0, 0, 255, 0, 0, 255, 255], 2, 1).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
