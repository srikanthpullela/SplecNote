// Splec Note — Tauri backend entry point.
// Wires core plugins (store, fs, dialog, window-state) and the session/backup engine.

mod search;
mod session;

#[cfg(target_os = "macos")]
mod menu;

use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent};

/// Files the OS asked us to open (via "Open With" / double-click) before the
/// webview was ready to receive them. Drained by the frontend on startup.
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

/// Drain and return any files queued by macOS file-open events.
#[tauri::command]
fn take_pending_open_files(state: tauri::State<'_, PendingOpen>) -> Vec<String> {
    let mut pending = state.0.lock().unwrap();
    std::mem::take(&mut *pending)
}

/// Convert the URLs from a macOS open-document event into local file paths.
fn urls_to_paths(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .map(|u| {
            u.to_file_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| u.as_str().to_string())
        })
        .filter(|p| !p.is_empty())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    // window-state and autostart are desktop-only.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri_plugin_autostart::MacosLauncher;
        builder = builder
            .plugin(tauri_plugin_window_state::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                None,
            ));
    }

    // Native menu bar (macOS): required for standard Edit shortcuts (Cmd+A/C/V)
    // to reach the webview, and provides the full app menu.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|app| menu::build(app))
            .on_menu_event(|app, event| menu::on_event(app, event.id().0.as_str()));
    }

    builder
        .manage(PendingOpen::default())
        .invoke_handler(tauri::generate_handler![
            session::session_paths,
            session::read_text_file,
            session::write_text_file,
            session::stat_file,
            session::autosave_backup,
            session::read_backup,
            session::delete_backup,
            session::write_session,
            session::load_session,
            session::cleanup_backups,
            search::find_in_files,
            take_pending_open_files,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Splec Note")
        .run(|app_handle, event| {
            // macOS delivers "Open With Splec Note" / double-click as an
            // open-documents Apple Event. Queue the paths (for cold launch,
            // before the webview is ready) and also emit them live (for when
            // the app is already running).
            if let RunEvent::Opened { urls } = event {
                let paths = urls_to_paths(&urls);
                if !paths.is_empty() {
                    if let Some(state) = app_handle.try_state::<PendingOpen>() {
                        state.0.lock().unwrap().extend(paths.clone());
                    }
                    let _ = app_handle.emit("splec-open-files", paths);
                }
            }
        });
}
