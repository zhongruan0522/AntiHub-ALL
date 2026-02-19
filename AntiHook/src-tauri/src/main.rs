#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod health;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            config::get_config_path,
            config::load_config,
            config::save_config,
            health::check_health
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

