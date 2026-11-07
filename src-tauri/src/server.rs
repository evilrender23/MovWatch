//! Servidor HTTP local (127.0.0.1) que sirve el video mientras se descarga, como el
//! `client.Serve()` de torrodle, pero con peticiones por rangos para poder saltar a cualquier
//! minuto, y la conversión HLS de `media.rs`.
//!
//! - `GET /stream/{torrent}/{archivo}`: el archivo del torrent, con `Range`.
//! - `GET /hls/{sesión}/{archivo}`: lista y segmentos que va escribiendo ffmpeg.

use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::Path as FsPath;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::engine::Engine;
use crate::media::Remuxer;

pub struct Shared {
    pub engine: Arc<Engine>,
    pub remuxer: Arc<Remuxer>,
}

pub struct Server {
    pub port: u16,
}

impl Server {
    pub async fn start(shared: Arc<Shared>) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let port = listener.local_addr()?.port();
        let app = Router::new()
            .route("/stream/{id}/{file}", get(stream))
            .route("/stream/{id}/{file}/{name}", get(stream_named))
            .route("/hls/{session}/{name}", get(hls))
            .with_state(shared);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("servidor local detenido: {e}");
            }
        });
        Ok(Server { port })
    }

    pub fn stream_url(&self, id: usize, file: usize, name: &str) -> String {
        // El nombre al final ayuda a mpv/VLC a mostrar el título y adivinar el formato.
        let name = FsPath::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("video");
        let name = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
        format!("http://127.0.0.1:{}/stream/{id}/{file}/{name}", self.port)
    }

    pub fn raw_stream_url(&self, id: usize, file: usize) -> String {
        format!("http://127.0.0.1:{}/stream/{id}/{file}", self.port)
    }

    pub fn hls_url(&self, session: &str) -> String {
        format!("http://127.0.0.1:{}/hls/{session}/index.m3u8", self.port)
    }
}

fn mime_for(name: &str) -> &'static str {
    match FsPath::new(name).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("ts" | "m2ts") => "video/mp2t",
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("m4s") => "video/iso.segment",
        _ => "application/octet-stream",
    }
}

/// `bytes=inicio-fin` → (inicio, fin) inclusivos dentro de `len`.
fn parse_range(value: Option<&HeaderValue>, len: u64) -> Option<Result<(u64, u64), ()>> {
    let v = value?.to_str().ok()?.trim();
    let spec = v.strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let r = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 {
            return Some(Err(()));
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
        if start >= len || end < start {
            return Some(Err(()));
        }
        (start, end)
    };
    Some(Ok(r))
}

async fn stream_named(state: State<Arc<Shared>>, Path((id, file, _name)): Path<(usize, usize, String)>, headers: HeaderMap) -> Response {
    serve_file(state, id, file, headers).await
}

async fn stream(state: State<Arc<Shared>>, Path((id, file)): Path<(usize, usize)>, headers: HeaderMap) -> Response {
    serve_file(state, id, file, headers).await
}

async fn serve_file(State(app): State<Arc<Shared>>, id: usize, file: usize, headers: HeaderMap) -> Response {
    let (mut reader, len) = match app.engine.stream(id, file).await {
        Ok(s) => s,
        Err(e) => return (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    };
    let name = app.engine.file_name(id, file).unwrap_or_default();
    let (status, start, end) = match parse_range(headers.get(header::RANGE), len) {
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
        Some(Ok((s, e))) => (StatusCode::PARTIAL_CONTENT, s, e),
        Some(Err(())) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Body::empty())
                .unwrap();
        }
    };
    if start > 0 {
        if let Err(e) = reader.seek(SeekFrom::Start(start)).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }
    let count = if len == 0 { 0 } else { end - start + 1 };
    let body = Body::from_stream(ReaderStream::with_capacity(reader.take(count), 256 * 1024));
    let mut res = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime_for(&name))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, count)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if status == StatusCode::PARTIAL_CONTENT {
        res = res.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    res.body(body).unwrap()
}

async fn hls(State(app): State<Arc<Shared>>, Path((session, name)): Path<(String, String)>) -> Response {
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    if !valid(&session) || !valid(&name) || name.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(dir) = app.remuxer.dir_of(&session) else {
        return (StatusCode::GONE, "La conversión ya terminó.").into_response();
    };
    let path = dir.join(&name);
    // ffmpeg tarda en escribir la lista y el primer segmento mientras llegan los datos del torrent.
    let deadline = Instant::now() + Duration::from_secs(if name == "index.m3u8" { 120 } else { 30 });
    loop {
        let ready = if name == "index.m3u8" {
            tokio::fs::read_to_string(&path).await.map(|t| t.contains(".m4s")).unwrap_or(false)
        } else {
            tokio::fs::metadata(&path).await.is_ok()
        };
        if ready {
            break;
        }
        if Instant::now() > deadline || app.remuxer.dir_of(&session).is_none() {
            return (StatusCode::NOT_FOUND, "Segmento no disponible.").into_response();
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, mime_for(&name))
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Body::from(bytes))
            .unwrap(),
        Err(e) => (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        let h = |s: &str| HeaderValue::from_str(s).unwrap();
        assert_eq!(parse_range(Some(&h("bytes=0-1")), 100), Some(Ok((0, 1))));
        assert_eq!(parse_range(Some(&h("bytes=10-")), 100), Some(Ok((10, 99))));
        assert_eq!(parse_range(Some(&h("bytes=-10")), 100), Some(Ok((90, 99))));
        assert_eq!(parse_range(Some(&h("bytes=50-500")), 100), Some(Ok((50, 99))));
        assert_eq!(parse_range(Some(&h("bytes=200-")), 100), Some(Err(())));
        assert_eq!(parse_range(None, 100), None);
    }
}

/// Descarga real de un torrent legal y lectura por rangos a través del servidor local:
/// `cargo test -- --ignored streaming_real --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn streaming_real() {
        let dir = std::env::temp_dir().join(format!("movwatch-live-{}", uuid::Uuid::new_v4()));
        let engine = Arc::new(Engine::start(dir.clone()).await.unwrap());
        let remuxer = Arc::new(Remuxer::new(dir.join("hls")));
        let shared_remuxer = remuxer.clone();
        let server = Server::start(Arc::new(Shared { engine: engine.clone(), remuxer })).await.unwrap();
        // Sintel (Blender Foundation, CC-BY), el torrent de prueba habitual de WebTorrent.
        let magnet = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Fopen.demonii.com%3A1337%2Fannounce";
        let t0 = std::time::Instant::now();
        let opened = engine.open(magnet, "Sintel", None, None).await.unwrap();
        println!("metadatos en {:?}: {} → archivo {} ({:?})", t0.elapsed(), opened.name, opened.file, opened.files[opened.file]);
        let url = server.raw_stream_url(opened.id, opened.file);
        let client = reqwest::Client::new();
        let t1 = std::time::Instant::now();
        let resp = client.get(&url).header("Range", "bytes=0-262143").send().await.unwrap();
        println!("HTTP {} {:?}", resp.status(), resp.headers().get("content-range"));
        assert_eq!(resp.status(), 206);
        let body = resp.bytes().await.unwrap();
        println!("256 KiB iniciales en {:?}; firma: {:02x?}", t1.elapsed(), &body[4..12]);
        assert_eq!(body.len(), 262_144);
        // Salto al final del archivo (como hace el reproductor al buscar el índice del MP4).
        let len = opened.files[opened.file].size;
        let resp = client.get(&url).header("Range", format!("bytes={}-", len - 65536)).send().await.unwrap();
        assert_eq!(resp.status(), 206);
        assert_eq!(resp.bytes().await.unwrap().len(), 65536);
        println!("estado: {:?}", engine.status(opened.id).map(|s| (s.downloaded, s.peers, s.down_speed)));

        // ffprobe + conversión HLS desde el minuto 5 (si ffmpeg está instalado).
        if let (Some(ffmpeg), Some(ffprobe)) = (crate::media::find_tool("ffmpeg", None), crate::media::find_tool("ffprobe", None)) {
            let probe = crate::media::probe(&ffprobe, &url, &opened.files[opened.file].name).await.unwrap();
            println!("probe: {:?} {:?} {}x{:?} audio={} directo={}", probe.duration, probe.video_codec, probe.width.unwrap_or(0), probe.height, probe.audio.len(), probe.direct);
            let session = shared_remuxer.start(&ffmpeg, &url, 300.0, 0, false, false).unwrap();
            let hls = server.hls_url(&session);
            let t2 = std::time::Instant::now();
            let list = client.get(&hls).send().await.unwrap().text().await.unwrap();
            println!("lista HLS en {:?}:\n{}", t2.elapsed(), list.lines().take(8).collect::<Vec<_>>().join("\n"));
            assert!(list.contains(".m4s"));
            let seg = list.lines().find(|l| l.ends_with(".m4s")).unwrap();
            let seg_url = hls.replace("index.m3u8", seg);
            let bytes = client.get(&seg_url).send().await.unwrap().bytes().await.unwrap();
            println!("segmento {seg}: {} bytes", bytes.len());
            assert!(bytes.len() > 10_000);
            shared_remuxer.stop();
        }
        engine.shutdown(true).await;
        let _ = std::fs::remove_dir_all(dir);
    }
}
