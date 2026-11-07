//! Compatibilidad del reproductor integrado mediante ffmpeg (opcional).
//!
//! La vista web sólo reproduce MP4/WebM con H.264/HEVC y AAC/MP3/Opus. La mayoría de torrents son
//! MKV con audio AC3/DTS, así que, si ffmpeg está instalado, se reempaqueta al vuelo a HLS (fMP4):
//! el video se copia sin recomprimir cuando se puede y el audio se pasa a AAC estéreo. Saltar a un
//! minuto que aún no se ha convertido reinicia la conversión desde ese punto (`start`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::error::{Result, msg};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Índice dentro de su tipo (0:a:N).
    pub index: usize,
    pub codec: String,
    pub language: Option<String>,
    pub title: Option<String>,
    pub channels: Option<u32>,
    pub default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub duration: Option<f64>,
    pub container: String,
    pub video_codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub audio: Vec<Track>,
    pub subtitles: Vec<Track>,
    /// La vista web lo puede reproducir tal cual.
    pub direct: bool,
    /// Hace falta recomprimir el video (no basta con copiarlo).
    pub transcode_video: bool,
}

pub fn find_tool(name: &str, manual: Option<&str>) -> Option<PathBuf> {
    if let Some(m) = manual.map(str::trim).filter(|m| !m.is_empty()) {
        let p = PathBuf::from(m);
        // Se acepta la ruta a ffmpeg y se busca ffprobe al lado.
        let p = if name != "ffmpeg" { p.with_file_name(format!("{name}{}", std::env::consts::EXE_SUFFIX)) } else { p };
        return p.is_file().then_some(p);
    }
    let exe = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Ok(p) = which::which(&exe) {
        return Some(p);
    }
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin").join(&exe),
        PathBuf::from("/usr/local/bin").join(&exe),
        PathBuf::from("/usr/bin").join(&exe),
    ];
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin").join(&exe));
        candidates.push(home.join(r"scoop\apps\ffmpeg\current\bin").join(&exe));
    }
    for var in ["ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            candidates.push(PathBuf::from(&base).join(r"ffmpeg\bin").join(&exe));
            candidates.push(PathBuf::from(&base).join(r"Microsoft\WinGet\Links").join(&exe));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

pub async fn probe(ffprobe: &Path, url: &str, file_name: &str) -> Result<Probe> {
    let mut cmd = Command::new(ffprobe);
    cmd.args(["-v", "error", "-probesize", "4000000", "-analyzeduration", "8000000"]);
    // Sin saltos al final del archivo (índice del MKV): con pocos pares tardaría minutos.
    if url.starts_with("http") {
        cmd.args(["-seekable", "0"]);
    }
    cmd.args(["-print_format", "json", "-show_format", "-show_streams", url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(90), cmd.output())
        .await
        .map_err(|_| msg("El análisis del video tardó demasiado (aún hay pocos pares)."))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(msg(format!("ffprobe no pudo leer el video: {}", err.lines().last().unwrap_or("error desconocido"))));
    }
    let v: Value = serde_json::from_slice(&out.stdout)?;
    Ok(parse_probe(&v, file_name))
}

fn parse_probe(v: &Value, file_name: &str) -> Probe {
    let mut p = Probe {
        duration: v["format"]["duration"].as_str().and_then(|d| d.parse().ok()),
        container: v["format"]["format_name"].as_str().unwrap_or("").to_owned(),
        ..Default::default()
    };
    let (mut a, mut s) = (0, 0);
    for st in v["streams"].as_array().into_iter().flatten() {
        let codec = st["codec_name"].as_str().unwrap_or("").to_owned();
        let tags = &st["tags"];
        let track = |index| Track {
            index,
            codec: codec.clone(),
            language: tags["language"].as_str().filter(|l| *l != "und").map(str::to_owned),
            title: tags["title"].as_str().map(str::to_owned),
            channels: st["channels"].as_u64().map(|c| c as u32),
            default: st["disposition"]["default"].as_u64() == Some(1),
        };
        match st["codec_type"].as_str() {
            Some("video") if p.video_codec.is_none() && st["disposition"]["attached_pic"].as_u64() != Some(1) => {
                p.video_codec = Some(codec.clone());
                p.pix_fmt = st["pix_fmt"].as_str().map(str::to_owned);
                p.width = st["width"].as_u64().map(|w| w as u32);
                p.height = st["height"].as_u64().map(|h| h as u32);
            }
            Some("audio") => {
                p.audio.push(track(a));
                a += 1;
            }
            Some("subtitle") => {
                p.subtitles.push(track(s));
                s += 1;
            }
            _ => {}
        }
    }
    let ext = Path::new(file_name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let ten_bit = p.pix_fmt.as_deref().is_some_and(|f| f.contains("10") || f.contains("12"));
    let vcodec = p.video_codec.as_deref().unwrap_or("");
    let hevc_ok = cfg!(target_os = "macos");
    let video_ok = match vcodec {
        "h264" => !ten_bit,
        "hevc" => hevc_ok,
        "vp9" | "av1" => !cfg!(target_os = "macos"),
        _ => false,
    };
    let audio_ok = p.audio.first().is_none_or(|t| matches!(t.codec.as_str(), "aac" | "mp3" | "opus" | "vorbis" | "flac"));
    p.transcode_video = !video_ok;
    p.direct = matches!(ext.as_str(), "mp4" | "m4v" | "webm" | "mov") && video_ok && audio_ok && p.audio.len() <= 1;
    p
}

/// Una conversión a HLS en marcha (sólo hay una: la del reproductor abierto). Se usa
/// `std::process` porque se lanza y se detiene desde comandos síncronos (hilo principal).
struct Session {
    id: String,
    dir: PathBuf,
    child: std::process::Child,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn no_window_std(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

pub struct Remuxer {
    root: PathBuf,
    current: Mutex<Option<Session>>,
}

impl Remuxer {
    pub fn new(root: PathBuf) -> Self {
        let _ = std::fs::remove_dir_all(&root);
        Remuxer { root, current: Mutex::new(None) }
    }

    /// Lanza ffmpeg desde `start` segundos y devuelve el identificador de la sesión HLS.
    pub fn start(&self, ffmpeg: &Path, input: &str, start: f64, audio: usize, transcode_video: bool, hevc: bool) -> Result<String> {
        self.stop();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = self.root.join(&id);
        std::fs::create_dir_all(&dir)?;
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
        if input.starts_with("http") {
            cmd.args(["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30"]);
        }
        if start > 0.5 {
            cmd.args(["-ss", &format!("{start:.3}")]);
        } else if input.starts_with("http") {
            // Desde el principio se lee en orden: nada de saltar al índice del final.
            cmd.args(["-seekable", "0"]);
        }
        cmd.args(["-i", input, "-map", "0:v:0", "-map", &format!("0:a:{audio}?")]);
        if transcode_video {
            cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-profile:v", "high"]);
            cmd.args(["-force_key_frames", "expr:gte(t,n_forced*4)"]);
        } else {
            cmd.args(["-c:v", "copy"]);
            if hevc {
                cmd.args(["-tag:v", "hvc1"]);
            }
        }
        cmd.args(["-c:a", "aac", "-ac", "2", "-b:a", "192k", "-sn", "-dn"]);
        cmd.args([
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_list_size",
            "0",
            "-hls_playlist_type",
            "event",
            "-hls_segment_type",
            "fmp4",
            "-hls_flags",
            "independent_segments+temp_file",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-hls_segment_filename",
        ]);
        cmd.arg(dir.join("seg%05d.m4s"));
        cmd.arg(dir.join("index.m3u8"));
        cmd.current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        no_window_std(&mut cmd);
        let child = cmd.spawn().map_err(|e| msg(format!("No se pudo iniciar ffmpeg: {e}")))?;
        *self.current.lock() = Some(Session { id: id.clone(), dir, child });
        Ok(id)
    }

    pub fn stop(&self) {
        if let Some(s) = self.current.lock().take() {
            let dir = s.dir.clone();
            drop(s); // mata ffmpeg
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                let _ = std::fs::remove_dir_all(dir);
            });
        }
    }

    /// Carpeta de la sesión si sigue activa.
    pub fn dir_of(&self, id: &str) -> Option<PathBuf> {
        self.current.lock().as_ref().filter(|s| s.id == id).map(|s| s.dir.clone())
    }
}

impl Drop for Remuxer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mkv_with_ac3_is_not_direct() {
        let v: Value = serde_json::json!({
            "format": {"duration": "5400.5", "format_name": "matroska,webm"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p", "width": 1920, "height": 1080},
                {"codec_type": "audio", "codec_name": "ac3", "channels": 6, "tags": {"language": "spa"}},
                {"codec_type": "audio", "codec_name": "aac", "channels": 2, "tags": {"language": "eng"}},
                {"codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "spa"}}
            ]
        });
        let p = parse_probe(&v, "Movie.mkv");
        assert!(!p.direct);
        assert!(!p.transcode_video);
        assert_eq!(p.audio.len(), 2);
        assert_eq!(p.audio[0].language.as_deref(), Some("spa"));
        assert_eq!(p.duration, Some(5400.5));
    }

    /// Como desde un comando síncrono de Tauri: sin runtime de tokio en el hilo.
    #[test]
    fn remux_runs_outside_tokio() {
        let (Some(ffmpeg), Some(ffprobe)) = (find_tool("ffmpeg", None), find_tool("ffprobe", None)) else { return };
        let dir = std::env::temp_dir().join(format!("movwatch-remux-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mkv = dir.join("in.mkv");
        let ok = std::process::Command::new(&ffmpeg)
            .args(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=12", "-f", "lavfi", "-i", "sine=duration=12"])
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3", "-shortest"])
            .arg(&mkv)
            .status()
            .unwrap();
        assert!(ok.success());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let probe = rt.block_on(probe(&ffprobe, mkv.to_str().unwrap(), "in.mkv")).unwrap();
        assert!(!probe.direct && !probe.transcode_video);
        assert_eq!(probe.audio[0].codec, "ac3");
        let remuxer = Remuxer::new(dir.join("hls"));
        let id = remuxer.start(&ffmpeg, mkv.to_str().unwrap(), 4.0, 0, false, false).unwrap();
        let list = remuxer.dir_of(&id).unwrap().join("index.m3u8");
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !std::fs::read_to_string(&list).map(|t| t.contains("#EXT-X-ENDLIST")).unwrap_or(false) {
            assert!(std::time::Instant::now() < deadline, "ffmpeg no terminó");
            std::thread::sleep(Duration::from_millis(100));
        }
        let text = std::fs::read_to_string(&list).unwrap();
        assert!(text.matches(".m4s").count() >= 2, "{text}");
        remuxer.stop();
        assert!(remuxer.dir_of(&id).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn plain_mp4_is_direct() {
        let v: Value = serde_json::json!({
            "format": {"duration": "100", "format_name": "mov,mp4,m4a,3gp,3g2,mj2"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "pix_fmt": "yuv420p"},
                {"codec_type": "audio", "codec_name": "aac", "channels": 2}
            ]
        });
        assert!(parse_probe(&v, "Movie.mp4").direct);
    }
}
