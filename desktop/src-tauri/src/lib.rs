mod telemetry;
mod app_menu;
mod audio;
mod base_url;
mod captions;
mod live_transcript;
mod visual;
mod commands;
mod diagnostics;
mod fs_writer;
mod fs_watcher;
#[cfg(target_os = "macos")]
mod fn_key;
mod shortcut_conflicts;
mod hotkeys;
mod hud;
mod imports;
#[cfg(target_os = "macos")]
mod cf;
mod dictate;
mod dictation;
mod make_room;
mod panel;
mod permissions;
mod placement;
mod recovery;
mod screenshot_watcher;
mod settings;
mod store;
mod sync;
mod sqlite;
mod transcribe;
mod tray;
mod ui;
mod updates;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _error_reporting = telemetry::init();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            hotkeys::show_launcher(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .manage(fs_watcher::WatcherManager::default())
        .manage(screenshot_watcher::ScreenshotWatcher::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(audio::Captures::default())
        .invoke_handler(tauri::generate_handler![
            audio::start_capture,
            live_transcript::live_transcript,
            commands::set_live_captions,
            audio::start_screen_capture,
            audio::stop_capture,
            audio::capture_state,
            audio::check_permissions,
            visual::capture_screenshot,
            visual::capture_media,
            visual::copy_capture_media,
            visual::paste_clip,
            imports::import_files,
            imports::save_note,
            imports::paste_to_composer,
            imports::delete_capture,
            imports::open_recordings_folder,
            screenshot_watcher::get_screenshot_folder,
            screenshot_watcher::set_auto_import_screenshots,
            fs_writer::write_meeting_folder,
            fs_writer::set_root_folder,
            fs_writer::reveal_in_finder,
            commands::copy_text,
            commands::paste_to_frontmost,
            commands::hide_panel,
            commands::list_recordings,
            commands::get_settings,
            commands::set_launcher_position,
            commands::get_setup_status,
            commands::complete_setup,
            commands::set_hotkey,
            commands::hotkey_conflict,
            commands::open_keyboard_settings,
            commands::set_panel_pinned,
            commands::get_hud_state,
            commands::sync_status,
            commands::show_settings,
            commands::pair_device,
            commands::show_launcher,
            commands::dismiss_hud,
            commands::close_hud,
            commands::set_hud_expanded,
            commands::account_info,
            commands::disconnect_account,
            commands::open_web_app,
            commands::show_setup,
            commands::cancel_pairing,
            commands::open_privacy_settings,
            commands::relaunch_app,
            commands::show_notice,
            commands::suspend_hotkeys,
            panel::resize_panel,
            updates::install_update,
            updates::check_for_updates,
            updates::get_app_info,
            permissions::request_microphone,
            permissions::request_speech,
            permissions::request_screen,
            permissions::request_accessibility,
            permissions::request_input_monitoring,
            permissions::request_notifications,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            if let Err(error) = sqlite::initialize(&handle) {
                telemetry::capture("sqlite.initialize", &error);
                return Err(std::io::Error::other(error).into());
            }

            if let Err(e) = panel::install(&handle) {
                telemetry::capture("panel.install", &e);
            }

            #[cfg(not(target_os = "macos"))]
            if let Some(win) = handle.get_webview_window("main") {
                let app_for_blur = handle.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        if !panel::is_pinned() {
                            let _ = panel::hide(&app_for_blur);
                        }
                    }
                });
            }

            if let Some(win) = handle.get_webview_window("hud") {
                let app_for_geometry = handle.clone();
                win.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                        hud::geometry_changed(&app_for_geometry);
                    }
                });
            }

            hud::set_state(&handle, hud::HudState::idle());

            if let Err(e) = app_menu::install(&handle) {
                telemetry::capture("app_menu.install", &e.to_string());
            }

            if let Err(e) = tray::install(&handle) {
                telemetry::capture("tray.install", &e.to_string());
            }

            let settings = settings::load(&handle);

            match fs_writer::recordings_root(&handle).and_then(|root| {
                handle
                    .state::<fs_watcher::WatcherManager>()
                    .replace(handle.clone(), root)
                    .map_err(|error| error.to_string())
            }) {
                Ok(()) => {}
                Err(error) => {
                    telemetry::capture("filesystem.watch.start", &error);
                }
            }
            screenshot_watcher::start(&handle);
            if let Err(e) = hotkeys::register_all(&handle, &settings) {
                telemetry::capture("hotkeys.register", &e);
                use tauri_plugin_notification::NotificationExt;
                let _ = handle
                    .notification()
                    .builder()
                    .title("Eavesy couldn't set your shortcut")
                    .body(format!(
                        "The launcher shortcut ({}) is unavailable — it may already be in use. \
                         Click the Eavesy icon in the menu bar to open it, then pick a new \
                         shortcut in Settings.",
                        settings.toggle_hotkey
                    ))
                    .show();
            }

            if !settings.setup_completed && settings::device_token(&handle).is_none() {
                hotkeys::show_launcher(&handle);
            }

            #[cfg(desktop)]
            updates::check_in_background(&handle);

            tauri::async_runtime::spawn(live_transcript::run(handle.clone()));
            let sync_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sync::run(sync_handle).await {
                    telemetry::capture("sync.run", &format!("{e:?}"));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Eavesy")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                hotkeys::show_launcher(app);
            }
        });
}
