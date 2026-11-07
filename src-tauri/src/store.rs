//! Ajustes, progreso ("Continuar viendo") y lista personal guardados como JSON en la carpeta de
//! datos de la aplicación (`%APPDATA%\com.evilrender23.movwatch` en Windows).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::catalog::Kind;
use crate::error::Result;

/// Títulos recordados en "Continuar viendo".
const MAX_HISTORY: usize = 200;
/// A partir de esta fracción vista se considera terminado.
const WATCHED_AT: f64 = 0.9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    #[default]
    Builtin,
    Mpv,
    Vlc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub player: PlayerKind,
    pub mpv_path: Option<String>,
    pub vlc_path: Option<String>,
    /// Ruta a ffmpeg (ffprobe se busca al lado); `None` = detección automática.
    pub ffmpeg_path: Option<String>,
    /// Carpeta de descargas; `None` = Descargas/MovWatch.
    pub download_dir: Option<String>,
    /// Conservar los archivos al cerrar el torrent (si no, se borran como en torrodle).
    pub keep_files: bool,
    /// Proveedores desactivados.
    pub disabled_providers: Vec<String>,
    /// Idioma de subtítulos preferido (ISO 639-2), "" = ninguno.
    pub subtitle_lang: String,
    /// Idioma de audio preferido (ISO 639-2: "spa", "fre"…); "" = el original, sin preferencia.
    pub audio_lang: String,
    /// Pasar al siguiente episodio al terminar.
    pub auto_next: bool,
    /// Buscar y compilar versiones nuevas en segundo plano (ver `update.rs`).
    pub auto_update: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            player: PlayerKind::Builtin,
            mpv_path: None,
            vlc_path: None,
            ffmpeg_path: None,
            download_dir: None,
            keep_files: false,
            disabled_providers: Vec::new(),
            subtitle_lang: "spa".into(),
            audio_lang: "spa".into(),
            auto_next: true,
            auto_update: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    /// IMDb de la película o serie.
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    /// Último video: `tt…` o `tt…:temporada:episodio`.
    pub video_id: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_name: Option<String>,
    /// Segundos vistos y duración del último video.
    pub position: f64,
    pub duration: f64,
    /// Videos terminados.
    pub watched: Vec<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressUpdate {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub video_id: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_name: Option<String>,
    pub position: f64,
    pub duration: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListStatus {
    Watching,
    Completed,
    OnHold,
    Dropped,
    PlanToWatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub poster: Option<String>,
    pub year: Option<String>,
    pub status: ListStatus,
    /// 1–10; `None` = sin puntuar.
    pub score: Option<u8>,
    #[serde(default)]
    pub notes: String,
    pub added_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListUpdate {
    pub id: String,
    pub kind: Kind,
    pub title: String,
    pub poster: Option<String>,
    pub year: Option<String>,
    pub status: ListStatus,
    pub score: Option<u8>,
    #[serde(default)]
    pub notes: String,
}

pub struct Store {
    dir: PathBuf,
    settings: Mutex<Settings>,
    history: Mutex<Vec<WatchEntry>>,
    list: Mutex<Vec<ListEntry>>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let settings = load(&dir.join("settings.json")).unwrap_or_default();
        let history = load(&dir.join("history.json")).unwrap_or_default();
        let list = load(&dir.join("list.json")).unwrap_or_default();
        Store { dir, settings: Mutex::new(settings), history: Mutex::new(history), list: Mutex::new(list) }
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn save_settings(&self, settings: Settings) -> Result<()> {
        let settings = Settings {
            mpv_path: clean(settings.mpv_path),
            vlc_path: clean(settings.vlc_path),
            ffmpeg_path: clean(settings.ffmpeg_path),
            download_dir: clean(settings.download_dir),
            ..settings
        };
        let mut current = self.settings.lock().unwrap();
        save(&self.dir, "settings.json", &settings)?;
        *current = settings;
        Ok(())
    }

    pub fn history(&self) -> Vec<WatchEntry> {
        self.history.lock().unwrap().clone()
    }

    /// Guarda por dónde va un video y mueve el título al principio de "Continuar viendo".
    pub fn progress(&self, u: ProgressUpdate) -> Result<WatchEntry> {
        let finished = u.duration > 0.0 && u.position / u.duration >= WATCHED_AT;
        let mut history = self.history.lock().unwrap();
        let mut entry = match history.iter().position(|e| e.id == u.id) {
            Some(i) => history.remove(i),
            None => WatchEntry {
                id: u.id.clone(),
                kind: u.kind,
                title: String::new(),
                poster: None,
                background: None,
                video_id: String::new(),
                season: None,
                episode: None,
                episode_name: None,
                position: 0.0,
                duration: 0.0,
                watched: Vec::new(),
                updated_at: 0,
            },
        };
        entry.kind = u.kind;
        entry.title = u.title.clone();
        if u.poster.is_some() {
            entry.poster = u.poster.clone();
        }
        if u.background.is_some() {
            entry.background = u.background.clone();
        }
        entry.video_id = u.video_id.clone();
        entry.season = u.season;
        entry.episode = u.episode;
        entry.episode_name = u.episode_name.clone();
        entry.position = if u.position.is_finite() { u.position.max(0.0) } else { 0.0 };
        entry.duration = if u.duration.is_finite() { u.duration.max(0.0) } else { 0.0 };
        if finished && !entry.watched.contains(&u.video_id) {
            entry.watched.push(u.video_id.clone());
        }
        entry.updated_at = now_millis();
        history.insert(0, entry.clone());
        history.truncate(MAX_HISTORY);
        save(&self.dir, "history.json", &*history)?;
        drop(history);
        self.sync_list(&u, finished)?;
        Ok(entry)
    }

    /// Marca o desmarca un video como visto sin reproducirlo.
    pub fn set_watched(&self, id: &str, video_id: &str, watched: bool) -> Result<()> {
        let mut history = self.history.lock().unwrap();
        if let Some(e) = history.iter_mut().find(|e| e.id == id) {
            e.watched.retain(|v| v != video_id);
            if watched {
                e.watched.push(video_id.to_owned());
            }
            save(&self.dir, "history.json", &*history)?;
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut history = self.history.lock().unwrap();
        history.retain(|e| e.id != id);
        save(&self.dir, "history.json", &*history)
    }

    pub fn list(&self) -> Vec<ListEntry> {
        self.list.lock().unwrap().clone()
    }

    pub fn list_save(&self, u: ListUpdate) -> Result<ListEntry> {
        let mut list = self.list.lock().unwrap();
        let now = now_millis();
        let added_at = match list.iter().position(|e| e.id == u.id) {
            Some(i) => list.remove(i).added_at,
            None => now,
        };
        let entry = ListEntry {
            id: u.id,
            kind: u.kind,
            title: u.title,
            poster: u.poster,
            year: u.year,
            status: u.status,
            score: u.score.filter(|s| (1..=10).contains(s)),
            notes: u.notes.trim().to_owned(),
            added_at,
            updated_at: now,
        };
        list.insert(0, entry.clone());
        save(&self.dir, "list.json", &*list)?;
        Ok(entry)
    }

    pub fn list_remove(&self, id: &str) -> Result<()> {
        let mut list = self.list.lock().unwrap();
        list.retain(|e| e.id != id);
        save(&self.dir, "list.json", &*list)
    }

    /// Al ver algo: "Planeo verla"/"En pausa" pasan a "Viendo" y una película terminada a
    /// "Completada". No añade títulos que el usuario no haya puesto en su lista.
    fn sync_list(&self, u: &ProgressUpdate, finished: bool) -> Result<()> {
        let mut list = self.list.lock().unwrap();
        let Some(entry) = list.iter_mut().find(|e| e.id == u.id) else { return Ok(()) };
        let before = entry.status;
        if matches!(entry.status, ListStatus::PlanToWatch | ListStatus::OnHold) {
            entry.status = ListStatus::Watching;
        }
        if finished && u.kind == Kind::Movie && entry.status == ListStatus::Watching {
            entry.status = ListStatus::Completed;
        }
        if entry.status != before {
            entry.updated_at = now_millis();
            save(&self.dir, "list.json", &*list)?;
        }
        Ok(())
    }
}

fn clean(path: Option<String>) -> Option<String> {
    path.map(|p| p.trim().trim_matches('"').to_owned()).filter(|p| !p.is_empty())
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn load<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(err) => {
            eprintln!("ignorando {} dañado: {err}", path.display());
            None
        }
    }
}

/// Escritura atómica: archivo temporal + renombrado.
fn save<T: Serialize + ?Sized>(dir: &Path, name: &str, value: &T) -> Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, dir.join(name))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("movwatch-{tag}-{}", uuid::Uuid::new_v4()))
    }

    fn upd(id: &str, video: &str, pos: f64, dur: f64) -> ProgressUpdate {
        ProgressUpdate {
            id: id.into(),
            kind: if video.contains(':') { Kind::Series } else { Kind::Movie },
            title: format!("Título {id}"),
            poster: None,
            background: None,
            video_id: video.into(),
            season: None,
            episode: None,
            episode_name: None,
            position: pos,
            duration: dur,
        }
    }

    #[test]
    fn progress_orders_and_marks_watched() {
        let dir = temp_dir("hist");
        let store = Store::open(dir.clone());
        store.progress(upd("tt1", "tt1", 100.0, 1000.0)).unwrap();
        store.progress(upd("tt2", "tt2:1:1", 950.0, 1000.0)).unwrap();
        store.progress(upd("tt2", "tt2:1:2", 10.0, 1000.0)).unwrap();
        let h = Store::open(dir.clone()).history();
        assert_eq!(h.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["tt2", "tt1"]);
        assert_eq!(h[0].watched, vec!["tt2:1:1".to_string()]);
        assert_eq!(h[0].video_id, "tt2:1:2");
        store.remove("tt1").unwrap();
        assert_eq!(Store::open(dir.clone()).history().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finishing_a_listed_movie_completes_it() {
        let dir = temp_dir("list");
        let store = Store::open(dir.clone());
        store
            .list_save(ListUpdate {
                id: "tt1".into(),
                kind: Kind::Movie,
                title: "A".into(),
                poster: None,
                year: None,
                status: ListStatus::PlanToWatch,
                score: Some(11),
                notes: "  x ".into(),
            })
            .unwrap();
        assert_eq!(store.list()[0].score, None);
        store.progress(upd("tt1", "tt1", 10.0, 100.0)).unwrap();
        assert_eq!(store.list()[0].status, ListStatus::Watching);
        store.progress(upd("tt1", "tt1", 95.0, 100.0)).unwrap();
        assert_eq!(Store::open(dir.clone()).list()[0].status, ListStatus::Completed);
        fs::remove_dir_all(dir).unwrap();
    }
}
