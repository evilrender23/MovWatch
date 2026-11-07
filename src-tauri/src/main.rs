// Sin consola adicional en Windows en las versiones de lanzamiento.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod commands;
mod engine;
mod error;
mod http;
mod media;
mod player;
mod providers;
mod server;
mod store;
mod subtitles;
mod update;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::Manager;

use commands::AppState;

/// Carpeta de descargas: la de Ajustes o `Descargas/MovWatch`.
fn download_dir(app: &tauri::App, settings: &store::Settings) -> PathBuf {
    if let Some(dir) = settings.download_dir.as_deref() {
        return PathBuf::from(dir);
    }
    app.path()
        .download_dir()
        .map(|d| d.join("MovWatch"))
        .or_else(|_| app.path().app_cache_dir().map(|d| d.join("descargas")))
        .unwrap_or_else(|_| std::env::temp_dir().join("MovWatch"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let http = http::scraper_client()?;
            let data_dir = app.path().app_data_dir()?;
            let store = store::Store::open(data_dir);
            let cache = app.path().app_cache_dir()?;
            let downloads = download_dir(app, &store.settings());
            let engine = Arc::new(tauri::async_runtime::block_on(engine::Engine::start(downloads))?);
            let remuxer = Arc::new(media::Remuxer::new(cache.join("hls")));
            let shared = Arc::new(server::Shared { engine: engine.clone(), remuxer: remuxer.clone() });
            let server = tauri::async_runtime::block_on(server::Server::start(shared))?;
            let actualizador = update::Actualizador::default();
            let handle = app.handle().clone();
            actualizador.vigilar(app.handle().clone(), move || handle.state::<AppState>().store.settings().auto_update);
            app.manage(AppState { http, engine, remuxer, server, store, actualizador, temp: cache.join("subtitulos"), lang_cache: Default::default() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::catalog,
            commands::search_titles,
            commands::title_detail,
            commands::providers_list,
            commands::search_torrents,
            commands::audio_languages,
            commands::has_language,
            commands::torrent_open,
            commands::torrent_status,
            commands::torrent_list,
            commands::torrent_pause,
            commands::torrent_close,
            commands::torrent_reveal,
            commands::detect_tools,
            commands::media_probe,
            commands::media_remux,
            commands::media_stop,
            commands::subtitles_list,
            commands::subtitle_vtt,
            commands::play_external,
            commands::detect_players,
            commands::get_settings,
            commands::save_settings,
            commands::download_dir,
            commands::history_list,
            commands::history_progress,
            commands::history_watched,
            commands::history_remove,
            commands::list_all,
            commands::list_save,
            commands::list_remove,
            commands::update_info,
            commands::update_state,
            commands::update_channel,
            commands::update_check,
            commands::update_apply,
        ])
        .build(tauri::generate_context!())
        .expect("no se pudo iniciar MovWatch")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.remuxer.stop();
                // Como torrodle: al salir se cierran los torrents y, salvo que se pida
                // conservarlos, se borra lo descargado.
                let keep = state.store.settings().keep_files;
                let engine = state.engine.clone();
                tauri::async_runtime::block_on(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), engine.shutdown(!keep)).await;
                });
                let _ = std::fs::remove_dir_all(&state.temp);
                state.actualizador.al_salir();
            }
        });
}
