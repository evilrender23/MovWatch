//! Comandos invocados desde la interfaz (ver `src/api.ts`).

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::catalog::{self, Card, Detail, Kind, SearchResults};
use crate::engine::{Engine, Opened, Status};
use crate::error::{Result, msg};
use crate::media::{self, Probe, Remuxer};
use crate::player::{self, Detected, External};
use crate::providers::{self, ProviderInfo, Query, SearchResult};
use crate::server::Server;
use crate::store::{ListEntry, ListUpdate, ProgressUpdate, Settings, Store, WatchEntry};
use crate::subtitles::{self, Subtitle};
use crate::update::{self, Actualizador, Canal, Estado, VersionInstalada};

pub struct AppState {
    pub http: Client,
    pub engine: Arc<Engine>,
    pub remuxer: Arc<Remuxer>,
    pub server: Server,
    pub store: Store,
    pub actualizador: Actualizador,
    pub temp: PathBuf,
}

// ---- Catálogo ----

#[tauri::command]
pub async fn catalog(state: State<'_, AppState>, kind: Kind, id: String, genre: Option<String>, skip: Option<u32>) -> Result<Vec<Card>> {
    catalog::catalog(&state.http, kind, &id, genre.as_deref(), skip.unwrap_or(0)).await
}

#[tauri::command]
pub async fn search_titles(state: State<'_, AppState>, query: String) -> Result<SearchResults> {
    catalog::search(&state.http, &query).await
}

#[tauri::command]
pub async fn title_detail(state: State<'_, AppState>, kind: Kind, id: String) -> Result<Detail> {
    catalog::detail(&state.http, kind, &id).await
}

// ---- Torrents ----

#[tauri::command]
pub fn providers_list() -> &'static [ProviderInfo] {
    providers::ALL
}

#[derive(Debug, Serialize)]
pub struct Language {
    pub code: &'static str,
    pub name: &'static str,
}

#[tauri::command]
pub fn audio_languages() -> Vec<Language> {
    providers::AUDIO_LANGUAGES.iter().map(|(code, name)| Language { code, name }).collect()
}

#[tauri::command]
pub async fn search_torrents(state: State<'_, AppState>, mut query: Query) -> Result<SearchResult> {
    let settings = state.store.settings();
    if query.providers.is_empty() {
        query.providers = providers::ALL
            .iter()
            .map(|p| p.name.to_owned())
            .filter(|n| !settings.disabled_providers.iter().any(|d| d.eq_ignore_ascii_case(n)))
            .collect();
    }
    if query.providers.is_empty() {
        return Err(msg("Todos los proveedores están desactivados en Ajustes."));
    }
    providers::search(&state.http, &query).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    #[serde(flatten)]
    pub opened: Opened,
    /// URL local del archivo (con rangos).
    pub url: String,
}

#[tauri::command]
pub async fn torrent_open(
    state: State<'_, AppState>,
    magnet: String,
    title: String,
    season: Option<u32>,
    episode: Option<u32>,
    file: Option<usize>,
) -> Result<Playback> {
    let hint = season.zip(episode);
    let opened = state.engine.open(&magnet, &title, hint, file).await?;
    let name = opened.files.get(opened.file).map(|f| f.name.clone()).unwrap_or_default();
    let url = state.server.stream_url(opened.id, opened.file, &name);
    Ok(Playback { opened, url })
}

#[tauri::command]
pub fn torrent_status(state: State<'_, AppState>, id: usize) -> Option<Status> {
    state.engine.status(id)
}

#[tauri::command]
pub fn torrent_list(state: State<'_, AppState>) -> Vec<Status> {
    state.engine.list()
}

#[tauri::command]
pub async fn torrent_pause(state: State<'_, AppState>, id: usize, paused: bool) -> Result<()> {
    state.engine.pause(id, paused).await
}

#[tauri::command]
pub async fn torrent_close(state: State<'_, AppState>, id: usize, delete_files: Option<bool>) -> Result<()> {
    let delete = delete_files.unwrap_or(!state.store.settings().keep_files);
    state.remuxer.stop();
    state.engine.remove(id, delete).await
}

#[tauri::command]
pub fn torrent_reveal(state: State<'_, AppState>, id: usize, file: usize) -> Result<String> {
    let path = state.engine.file_path(id, file).ok_or_else(|| msg("El torrent ya no está abierto."))?;
    let dir = path.parent().map(PathBuf::from).unwrap_or_else(|| state.engine.dir().to_path_buf());
    Ok(dir.to_string_lossy().into_owned())
}

// ---- Compatibilidad (ffmpeg) ----

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
}

fn tools(settings: &Settings) -> (Option<PathBuf>, Option<PathBuf>) {
    let manual = settings.ffmpeg_path.as_deref();
    (media::find_tool("ffmpeg", manual), media::find_tool("ffprobe", manual))
}

#[tauri::command]
pub fn detect_tools(state: State<'_, AppState>) -> Tools {
    let (ffmpeg, ffprobe) = tools(&state.store.settings());
    let show = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    Tools { ffmpeg: show(ffmpeg), ffprobe: show(ffprobe) }
}

/// Analiza el archivo con ffprobe. `None` si ffprobe no está instalado.
#[tauri::command]
pub async fn media_probe(state: State<'_, AppState>, id: usize, file: usize) -> Result<Option<Probe>> {
    let (_, ffprobe) = tools(&state.store.settings());
    let Some(ffprobe) = ffprobe else { return Ok(None) };
    let name = state.engine.file_name(id, file).unwrap_or_default();
    let url = state.server.raw_stream_url(id, file);
    media::probe(&ffprobe, &url, &name).await.map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemuxRequest {
    pub id: usize,
    pub file: usize,
    pub start: f64,
    pub audio: usize,
    pub transcode_video: bool,
    pub hevc: bool,
}

/// Inicia la conversión a HLS desde `start` y devuelve la URL de la lista.
#[tauri::command]
pub fn media_remux(state: State<'_, AppState>, req: RemuxRequest) -> Result<String> {
    let (ffmpeg, _) = tools(&state.store.settings());
    let ffmpeg = ffmpeg.ok_or_else(|| msg("Para este formato hace falta ffmpeg. Instálalo o indica su ruta en Ajustes."))?;
    let input = state.server.raw_stream_url(req.id, req.file);
    let session = state.remuxer.start(&ffmpeg, &input, req.start.max(0.0), req.audio, req.transcode_video, req.hevc)?;
    Ok(state.server.hls_url(&session))
}

#[tauri::command]
pub fn media_stop(state: State<'_, AppState>) {
    state.remuxer.stop();
}

// ---- Subtítulos ----

#[tauri::command]
pub async fn subtitles_list(state: State<'_, AppState>, video_id: String) -> Result<Vec<Subtitle>> {
    subtitles::list(&state.http, &video_id).await
}

/// Devuelve el subtítulo en WebVTT (la interfaz lo carga como `blob:`).
#[tauri::command]
pub async fn subtitle_vtt(state: State<'_, AppState>, url: String) -> Result<String> {
    subtitles::fetch_vtt(&state.http, &url).await
}

// ---- Reproductores externos ----

#[tauri::command]
pub async fn play_external(
    state: State<'_, AppState>,
    url: String,
    title: String,
    player: External,
    subtitle_url: Option<String>,
) -> Result<String> {
    let settings = state.store.settings();
    let manual = match player {
        External::Mpv => settings.mpv_path.as_deref(),
        External::Vlc => settings.vlc_path.as_deref(),
    };
    let sub = match subtitle_url {
        Some(u) => Some(subtitles::save_temp(&state.http, &u, &state.temp).await?),
        None => None,
    };
    player::launch(player, manual, &url, &title, sub.as_deref())
}

#[tauri::command]
pub fn detect_players(state: State<'_, AppState>) -> Detected {
    let settings = state.store.settings();
    player::detect(settings.mpv_path.as_deref(), settings.vlc_path.as_deref())
}

// ---- Ajustes, progreso y lista ----

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.store.settings()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<()> {
    state.store.save_settings(settings)
}

#[tauri::command]
pub fn download_dir(state: State<'_, AppState>) -> String {
    state.engine.dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn history_list(state: State<'_, AppState>) -> Vec<WatchEntry> {
    state.store.history()
}

#[tauri::command]
pub fn history_progress(state: State<'_, AppState>, update: ProgressUpdate) -> Result<WatchEntry> {
    state.store.progress(update)
}

#[tauri::command]
pub fn history_watched(state: State<'_, AppState>, id: String, video_id: String, watched: bool) -> Result<()> {
    state.store.set_watched(&id, &video_id, watched)
}

#[tauri::command]
pub fn history_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.remove(&id)
}

#[tauri::command]
pub fn list_all(state: State<'_, AppState>) -> Vec<ListEntry> {
    state.store.list()
}

#[tauri::command]
pub fn list_save(state: State<'_, AppState>, update: ListUpdate) -> Result<ListEntry> {
    state.store.list_save(update)
}

#[tauri::command]
pub fn list_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.list_remove(&id)
}

// ---- Actualizaciones ----

/// Commit, rama y fecha de esta copia; `None` en una compilación de desarrollo.
#[tauri::command]
pub fn update_info() -> Option<VersionInstalada> {
    update::version_instalada()
}

#[tauri::command]
pub fn update_channel() -> Canal {
    update::canal()
}

#[tauri::command]
pub fn update_state(state: State<'_, AppState>) -> Estado {
    state.actualizador.estado()
}

#[tauri::command]
pub fn update_check(state: State<'_, AppState>, install: bool) {
    state.actualizador.buscar_ahora(install);
}

#[tauri::command]
pub fn update_apply(app: tauri::AppHandle, state: State<'_, AppState>) {
    state.actualizador.aplicar();
    app.exit(0);
}
