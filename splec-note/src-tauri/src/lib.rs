// Splec Note — Tauri backend entry point.
// Wires core plugins (store, fs, dialog, window-state) and the session/backup engine.

mod search;
mod session;

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
            .plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                None,
            ));
    }

    builder
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Splec Note");
}
