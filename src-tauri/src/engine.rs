//! Cliente BitTorrent para ver mientras se descarga.
//!
//! torrodle embebía `go-peerflix` (anacrolix/torrent): añadía el magnet, elegía el archivo más
//! grande, priorizaba el 5 % inicial y lo servía por HTTP. Aquí se usa librqbit, que hace lo mismo
//! con mejores garantías: sólo se descarga el archivo elegido (no toda la temporada) y las piezas
//! que pide el reproductor tienen prioridad, así que se puede saltar a cualquier minuto.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use librqbit::api::TorrentIdOrHash;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, ListenerOptions, Session, SessionOptions};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::error::{Result, msg};
use crate::providers::episode_of;

/// Tiempo para encontrar pares y descargar los metadatos del magnet.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(120);

pub const VIDEO_EXT: &[&str] = &["mp4", "m4v", "mkv", "webm", "avi", "mov", "ts", "m2ts", "wmv", "mpg", "mpeg", "flv", "ogv"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFile {
    pub index: usize,
    pub name: String,
    pub size: u64,
    pub video: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub id: usize,
    pub info_hash: String,
    pub name: String,
    pub files: Vec<TorrentFile>,
    /// Archivo que se va a reproducir.
    pub file: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: usize,
    pub name: String,
    pub title: String,
    pub info_hash: String,
    /// "initializing", "live", "paused", "error".
    pub state: String,
    pub error: Option<String>,
    pub file: usize,
    pub file_name: String,
    /// Bytes descargados y totales del archivo elegido.
    pub downloaded: u64,
    pub total: u64,
    /// Bytes por segundo.
    pub down_speed: f64,
    pub up_speed: f64,
    pub uploaded: u64,
    pub peers: u32,
    pub seeders: u32,
    pub seen_peers: u32,
    /// Segundos para terminar, si se puede estimar.
    pub eta: Option<u64>,
    pub finished: bool,
    pub folder: String,
}

/// Datos que la app recuerda de cada torrent abierto.
#[derive(Debug, Clone, Default)]
struct Meta {
    title: String,
    file: usize,
}

pub struct Engine {
    session: Arc<Session>,
    dir: PathBuf,
    meta: Mutex<HashMap<usize, Meta>>,
}

impl Engine {
    pub async fn start(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let opts = SessionOptions {
            listen: Some(ListenerOptions { enable_upnp_port_forwarding: true, ..Default::default() }),
            peer_limit: Some(200),
            client_name_and_version: Some(concat!("MovWatch/", env!("CARGO_PKG_VERSION")).into()),
            ..Default::default()
        };
        let session = Session::new_with_opts(dir.clone(), opts)
            .await
            .map_err(|e| msg(format!("No se pudo iniciar el cliente de torrents: {e:#}")))?;
        Ok(Engine { session, dir, meta: Mutex::new(HashMap::new()) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Añade el magnet (o reutiliza el torrent si ya estaba), elige el archivo de video y empieza
    /// a descargar sólo ese archivo. `hint` = (temporada, episodio) para packs de temporada.
    pub async fn open(&self, magnet: &str, title: &str, hint: Option<(u32, u32)>, file: Option<usize>) -> Result<Opened> {
        if !magnet.starts_with("magnet:") {
            return Err(msg("El enlace no es un magnet."));
        }
        let add = self.session.add_torrent(
            AddTorrent::from_url(magnet),
            Some(AddTorrentOptions { paused: true, overwrite: true, ..Default::default() }),
        );
        let resp = tokio::time::timeout(RESOLVE_TIMEOUT, add)
            .await
            .map_err(|_| msg("No se encontraron pares para este torrent en 2 minutos. Prueba con otra fuente con más semillas."))?
            .map_err(|e| msg(format!("No se pudo abrir el torrent: {e:#}")))?;
        let (id, handle) = match resp {
            AddTorrentResponse::Added(id, h) | AddTorrentResponse::AlreadyManaged(id, h) => (id, h),
            AddTorrentResponse::ListOnly(_) => return Err(msg("Respuesta inesperada del cliente de torrents.")),
        };

        let files: Vec<TorrentFile> = handle
            .with_metadata(|m| {
                m.file_infos
                    .iter()
                    .enumerate()
                    .map(|(index, f)| {
                        let name = f.relative_filename.to_string_lossy().into_owned();
                        TorrentFile { video: is_video(&name) && !is_sample(&name, f.len), index, name, size: f.len }
                    })
                    .collect()
            })
            .map_err(|e| msg(format!("El torrent no tiene metadatos: {e:#}")))?;
        let chosen = match file {
            Some(i) if i < files.len() => i,
            _ => pick_file(&files, hint).ok_or_else(|| msg("Este torrent no contiene ningún archivo de video."))?,
        };

        // Comprobación inicial de lo que ya haya en disco (rápida si no hay nada).
        tokio::time::timeout(RESOLVE_TIMEOUT, handle.wait_until_initialized())
            .await
            .map_err(|_| msg("El torrent tardó demasiado en prepararse."))?
            .map_err(|e| msg(format!("No se pudo preparar el torrent: {e:#}")))?;
        let only: HashSet<usize> = [chosen].into_iter().collect();
        self.session
            .update_only_files(&handle, &only)
            .await
            .map_err(|e| msg(format!("No se pudo elegir el archivo: {e:#}")))?;
        if handle.is_paused() {
            self.session.unpause(&handle).await.map_err(|e| msg(format!("No se pudo empezar la descarga: {e:#}")))?;
        }
        self.meta.lock().insert(id, Meta { title: title.to_owned(), file: chosen });

        Ok(Opened {
            id,
            info_hash: handle.info_hash().as_string(),
            name: handle.name().unwrap_or_else(|| title.to_owned()),
            files,
            file: chosen,
        })
    }

    /// Lector con búsqueda del archivo (las piezas que pide tienen prioridad) y su tamaño.
    pub async fn stream(
        &self,
        id: usize,
        file: usize,
    ) -> Result<(impl tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin + Send + 'static, u64)> {
        let handle = self.session.get(TorrentIdOrHash::Id(id)).ok_or_else(|| msg("El torrent ya no está abierto."))?;
        let len = handle
            .with_metadata(|m| m.file_infos.get(file).map(|f| f.len))
            .ok()
            .flatten()
            .ok_or_else(|| msg("El archivo no existe en el torrent."))?;
        let s = handle.stream(file).await.map_err(|e| msg(format!("No se pudo leer el archivo: {e:#}")))?;
        Ok((s, len))
    }

    pub fn file_name(&self, id: usize, file: usize) -> Option<String> {
        let handle = self.session.get(TorrentIdOrHash::Id(id))?;
        handle
            .with_metadata(|m| m.file_infos.get(file).map(|f| f.relative_filename.to_string_lossy().into_owned()))
            .ok()
            .flatten()
    }

    /// Ruta en disco del archivo (para abrirlo con un reproductor externo cuando ya está completo).
    pub fn file_path(&self, id: usize, file: usize) -> Option<PathBuf> {
        let handle = self.session.get(TorrentIdOrHash::Id(id))?;
        let rel = handle.with_metadata(|m| m.file_infos.get(file).map(|f| f.relative_filename.clone())).ok().flatten()?;
        Some(handle.output_folder().join(rel))
    }

    pub fn status(&self, id: usize) -> Option<Status> {
        let handle = self.session.get(TorrentIdOrHash::Id(id))?;
        let meta = self.meta.lock().get(&id).cloned().unwrap_or_default();
        Some(status_of(id, &handle, &meta))
    }

    pub fn list(&self) -> Vec<Status> {
        let meta = self.meta.lock().clone();
        let mut out: Vec<Status> = self.session.with_torrents(|it| {
            it.map(|(id, h)| status_of(id, h, &meta.get(&id).cloned().unwrap_or_default())).collect()
        });
        out.sort_by(|a, b| b.id.cmp(&a.id));
        out
    }

    pub async fn pause(&self, id: usize, paused: bool) -> Result<()> {
        let handle = self.session.get(TorrentIdOrHash::Id(id)).ok_or_else(|| msg("El torrent ya no está abierto."))?;
        let res = if paused { self.session.pause(&handle).await } else { self.session.unpause(&handle).await };
        res.map_err(|e| msg(format!("{e:#}")))
    }

    pub async fn remove(&self, id: usize, delete_files: bool) -> Result<()> {
        self.meta.lock().remove(&id);
        self.session
            .delete(TorrentIdOrHash::Id(id), delete_files)
            .await
            .map_err(|e| msg(format!("No se pudo cerrar el torrent: {e:#}")))
    }

    /// Al salir: cierra todos los torrents (y borra lo descargado si no se quiere conservar).
    pub async fn shutdown(&self, delete_files: bool) {
        let ids: Vec<usize> = self.session.with_torrents(|it| it.map(|(id, _)| id).collect());
        for id in ids {
            let _ = self.session.delete(TorrentIdOrHash::Id(id), delete_files).await;
        }
        self.session.stop().await;
    }
}

fn status_of(id: usize, handle: &librqbit::ManagedTorrent, meta: &Meta) -> Status {
    let stats = serde_json::to_value(handle.stats()).unwrap_or(Value::Null);
    let num = |v: &Value| v.as_f64().unwrap_or(0.0);
    let file = meta.file;
    let (file_name, file_len) = handle
        .with_metadata(|m| {
            m.file_infos
                .get(file)
                .map(|f| (f.relative_filename.to_string_lossy().into_owned(), f.len))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let downloaded = stats["file_progress"].get(file).and_then(Value::as_u64).unwrap_or(0);
    let live = &stats["live"];
    let mib = 1024.0 * 1024.0;
    let down_speed = num(&live["download_speed"]["mbps"]) * mib;
    let peers = &live["snapshot"]["peer_stats"];
    let remaining = file_len.saturating_sub(downloaded);
    Status {
        id,
        name: handle.name().unwrap_or_default(),
        title: meta.title.clone(),
        info_hash: handle.info_hash().as_string(),
        state: stats["state"].as_str().unwrap_or("initializing").to_owned(),
        error: stats["error"].as_str().map(str::to_owned),
        file,
        file_name,
        downloaded,
        total: file_len,
        down_speed,
        up_speed: num(&live["upload_speed"]["mbps"]) * mib,
        uploaded: stats["uploaded_bytes"].as_u64().unwrap_or(0),
        peers: peers["live"].as_u64().unwrap_or(0) as u32,
        seeders: peers["live_seeders"].as_u64().unwrap_or(0) as u32,
        seen_peers: peers["seen"].as_u64().unwrap_or(0) as u32,
        eta: (down_speed > 1024.0 && remaining > 0).then(|| (remaining as f64 / down_speed) as u64),
        finished: file_len > 0 && downloaded >= file_len,
        folder: handle.output_folder().to_string_lossy().into_owned(),
    }
}

pub fn is_video(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXT.iter().any(|v| v.eq_ignore_ascii_case(e)))
}

fn is_sample(name: &str, len: u64) -> bool {
    let lower = name.to_ascii_lowercase();
    (lower.contains("sample") || lower.contains("trailer")) && len < 400 * 1024 * 1024
}

/// El episodio pedido si está en el nombre; si no, el video más grande (como torrodle).
fn pick_file(files: &[TorrentFile], hint: Option<(u32, u32)>) -> Option<usize> {
    let videos = || files.iter().filter(|f| f.video);
    if let Some((season, episode)) = hint {
        if let Some(f) = videos().filter(|f| episode_of(&f.name) == Some((season, episode))).max_by_key(|f| f.size) {
            return Some(f.index);
        }
    }
    videos()
        .max_by_key(|f| f.size)
        .or_else(|| files.iter().filter(|f| is_video(&f.name)).max_by_key(|f| f.size))
        .map(|f| f.index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(index: usize, name: &str, size: u64) -> TorrentFile {
        TorrentFile { index, name: name.into(), size, video: is_video(name) && !is_sample(name, size) }
    }

    #[test]
    fn picks_episode_from_season_pack() {
        let files = [
            f(0, "Show.S01/Show.S01E01.mkv", 900),
            f(1, "Show.S01/Show.S01E02.mkv", 800),
            f(2, "Show.S01/Show.S01E03.mkv", 1000),
            f(3, "Show.S01/info.nfo", 1),
        ];
        assert_eq!(pick_file(&files, Some((1, 2))), Some(1));
        assert_eq!(pick_file(&files, None), Some(2));
    }

    #[test]
    fn ignores_samples() {
        let files = [f(0, "Movie/sample.mkv", 50 << 20), f(1, "Movie/movie.mp4", 30 << 20)];
        assert_eq!(pick_file(&files, None), Some(1));
    }
}
