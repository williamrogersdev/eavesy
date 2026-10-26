mod agents;
mod assistant;
mod translation;
mod telemetry;
mod app_menu;
mod audio;
mod audio_upload;
mod base_url;
mod captions;
mod capture_sync;
mod live_transcript;
mod live_edit;
mod visual;
mod commands;
mod diagnostics;
mod fs_writer;
mod fs_watcher;
mod work_queue;
mod history_search;
#[cfg(target_os = "macos")]
mod fn_key;
mod front_window;
mod shortcut_conflicts;
mod hotkeys;
mod hud;
mod imports;
mod install_location;
mod stray_copies;
#[cfg(target_os = "macos")]
mod cf;
mod cloud_pull;
mod dictate;
mod dictation;
mod machine;
mod make_room;
mod moments;
mod panel;
mod permissions;
mod placement;
mod projects;
mod recovery;
mod screenshot_watcher;
mod settings;
mod settings_window;
mod sounds;
mod history;
mod store;
mod sync;
mod sqlite;
mod standby;
mod transcribe;
mod walkthrough;
mod walkthrough_agent;
mod learning;
mod paste_learning;
mod tray;
mod ui;
mod updates;
mod vocabulary;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Claude Code hooks run this binary; they must not start the app.
    if agents::hook::maybe_run() { return; }
    if walkthrough_agent::maybe_run() { return; }
    let _error_reporting = telemetry::init();
    #[cfg(target_os = "macos")]
    match install_location::open_existing_installation() {
        Ok(true) => return,
        Ok(false) => {}
        Err(message) => {
            install_location::show_launch_error(&message);
            return;
        }
    }
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
            agents::agents_state,
            agents::agents_send,
            agents::agents_later,
            agents::agents_dismiss,
            agents::agents_repeat,
            agents::agents_edit,
            agents::set_agent_voice,
            agents::set_agent_hold,
            agents::remote::agents_answer,
            agents::remote::set_agent_messages,
            machine::machine_inventory,
            machine::machine_clean,
            machine::machine_worktree_details,
            machine::machine_worktree_size,
            machine::machine_repo_prs,
            machine::machine_open_worktree,
            machine::machine_open_pr,
            assistant::assistant_state,
            assistant::set_assistant_mode,
            assistant::set_trusted_agent_folders,
            assistant::assistant_card_decide,
            assistant::assistant_activity,
            assistant::thread::assistant_thread,
            assistant::thread::assistant_send,
            assistant::thread::assistant_repeat,
            assistant::style::set_assistant_style,
            assistant::style::set_assistant_voice,
            assistant::style::assistant_voices,
            assistant::memory::assistant_memory,
            assistant::memory::assistant_forget,
            assistant::memory::assistant_forget_all,
            assistant::memory::set_assistant_memory,
            assistant::memory::open_assistant_memory,
            assistant::memory::assistant_undo_merge,
            assistant::memory::assistant_keep_merge,
            assistant::thread::set_assistant_off_record,
            assistant::thread::assistant_dont_remember,
            assistant::thread::assistant_taught,
            assistant::rules::assistant_rules,
            assistant::rules::add_assistant_rule,
            assistant::rules::remove_assistant_rule,
            assistant::rules::add_assistant_instruction,
            assistant::rules::remove_assistant_instruction,
            assistant::rules::accept_assistant_rule_change,
            assistant::rules::discard_assistant_rule_change,
            assistant::rules::open_assistant_rules,
            assistant::voice::hud_assistant,
            assistant::voice::assistant_talk,
            assistant::thread::assistant_clear,
            commands::set_capture_sounds,
            commands::set_hud_look,
            commands::set_dictation_in_panel,
            commands::ack_dictation_text,
            audio::start_screen_capture,
            audio::stop_capture,
            audio::cancel_capture,
            audio::capture_state,
            audio::check_permissions,
            visual::capture_screenshot,
            visual::capture_media,
            visual::copy_capture_media,
            walkthrough::recording_context,
            walkthrough::retry_walkthrough,
            walkthrough::recording_moments,
            moments::toggle_marking,
            moments::set_marking_tool,
            moments::stop_marking,
            moments::mark_element,
            moments::mark_area,
            moments::undo_mark,
            moments::marking_state,
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
            translation::translation_request,
            commands::paste_to_frontmost,
            learning::dictionary_request,
            learning::correct_recording,
            commands::hide_panel,
            commands::list_recordings,
            commands::cancel_history_search,
            commands::get_recording,
            commands::get_settings,
            commands::set_launcher_position,
            commands::get_setup_status,
            commands::complete_setup,
            commands::set_hotkey,
            commands::check_hotkey,
            commands::check_all_hotkeys,
            commands::get_hotkey_defaults,
            commands::reset_hotkey,
            commands::reset_all_hotkeys,
            commands::fn_status,
            commands::open_keyboard_settings,
            commands::set_panel_pinned,
            commands::get_hud_state,
            commands::save_preview_transcript,
            commands::focus_preview_editor,
            commands::release_preview_editor,
            commands::update_live_preview_edit,
            commands::sync_status,
            commands::show_settings,
            settings_window::close_settings_window,
            commands::pair_device,
            commands::show_launcher,
            commands::dismiss_hud,
            commands::peek_hud,
            commands::restyle_dictation,
            commands::replace_dictation,
            commands::hud_painted,
            commands::close_hud,
            commands::account_info,
            projects::list_projects,
            projects::account_call,
            projects::agent_transcript,
            projects::set_project_choice,
            front_window::front_window,
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
            assistant::init(&handle);

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

            install_location::refresh_icon();
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
            walkthrough::recover(&handle);
            // A spare capture engine, so the first dictation does not wait for one.
            audio::prepare_standby(&handle);
            audio::prepare_speech_model(&handle);
            let (settings, moved) = hotkeys::migrate_defaults(&handle, settings);
            let failures = hotkeys::register_all(&handle, &settings);
            let notes: Vec<String> = moved.into_iter().collect();
            if let Some(body) = hotkeys::startup_notice(&failures, &notes) {
                if !failures.is_empty() { telemetry::capture("hotkeys.register", &body); }
                use tauri_plugin_notification::NotificationExt;
                let title = match failures.len() {
                    0 => "Eavesy changed a shortcut",
                    1 => "Eavesy couldn't set a shortcut",
                    _ => "Eavesy couldn't set your shortcuts",
                };
                let _ = handle.notification().builder().title(title).body(body).show();
            }
            hotkeys::notice_app_conflicts(&handle);

            let location = install_location::label();
            telemetry::track(
                "app_launched",
                serde_json::json!({
                    "install_location": location,
                    "previous_version": telemetry::previous_version(location),
                    "setup_completed": settings.setup_completed,
                    "paired": settings::device_token(&handle).is_some(),
                }),
            );

            if !settings.setup_completed && settings::device_token(&handle).is_none() {
                hotkeys::show_launcher(&handle);
            }

            #[cfg(target_os = "macos")]
            install_location::offer_move_on_launch(&handle);
            #[cfg(target_os = "macos")]
            stray_copies::clean_up_in_background();
            #[cfg(desktop)]
            updates::check_in_background(&handle);
            vocabulary::refresh(&handle);
            agents::start(&handle);

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
