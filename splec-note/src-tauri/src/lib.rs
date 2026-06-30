// Splec Note — Tauri backend entry point.
// Phase 0: wire core plugins (store, fs, dialog, window-state) and launch the window.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    // window-state is desktop-only.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::new().build());
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running Splec Note");
}
