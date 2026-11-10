# MovWatch

Películas y series por torrent, al instante, con la estética de Hermes Desktop. Explora un catálogo
con pósters, fondos y fichas; busca torrents en varios proveedores a la vez y míralos **mientras se
descargan**, con subtítulos.

MovWatch es la puesta al día, con interfaz gráfica, de [torrodle](https://github.com/tnychn/torrodle)
(tnychn, MIT), un CLI en Go de 2019 que hoy ya no funciona: la mitad de sus proveedores cerraron o
están tras Cloudflare y la API de subtítulos que usaba se apagó.

## Qué cambia respecto a torrodle

| torrodle (Go, CLI) | MovWatch (Rust + Tauri) |
|---|---|
| Búsqueda por texto en la terminal | Catálogo navegable (Cinemeta/IMDb) + búsqueda libre de torrents |
| 1337x, RARBG, TPB, YTS, Torrentz2, LimeTorrents, Sukebei raspando HTML | YTS, The Pirate Bay (apibay), EZTV, Nyaa, Knaben (incluye 1337x) y Torrents‑CSV por API |
| Resultados sin unir | Unidos por info‑hash, con calidad, códec, HDR, idioma y puntuación propia |
| `go-peerflix` (anacrolix): baja todo el torrent | `librqbit`: baja sólo el archivo elegido, con prioridad para lo que pide el reproductor |
| Sirve el archivo más grande | Elige el episodio correcto dentro de packs de temporada |
| Abre mpv/VLC | Reproductor integrado (directo o vía ffmpeg → HLS), o mpv/VLC |
| OpenSubtitles XML‑RPC (cerrada) | OpenSubtitles por IMDb, convertidos a WebVTT, con desfase ajustable |
| Borra todo al salir | Igual por defecto, o conserva los archivos (Ajustes) |

## Funciones

- **Inicio** con destacado rotativo, Continuar viendo, populares, estrenos y mejor valoradas.
- **Películas / Series** con géneros, orden por popularidad, nota o año, y carga incremental.
- **Ficha** a sangre: logo, sinopsis, reparto, tráiler, temporadas y episodios con miniatura y progreso.
- **Fuentes**: tabla de torrents con calidad, etiquetas (HEVC, HDR, REMUX, Español…), tamaño,
  semillas y estado de cada proveedor. Filtros por calidad, audio en español y sin CAM/TS.
- **Ver ahora**: elige sola la mejor fuente (semillas, calidad, idioma) y empieza a reproducir.
- **Reproductor**: controles propios, línea de tiempo con lo descargado y lo cargado, pistas de
  audio, subtítulos automáticos en tu idioma, siguiente episodio, pantalla completa y atajos.
- **Descargas**: velocidad, pares, progreso y ETA de cada torrent; pausar, reanudar, abrir carpeta.
- **Mi lista** (Viendo, Pendiente, Completada, En pausa, Abandonada) y menús contextuales en todo.
- Actualizaciones como en Anime Watcher: desde `main` con el instalador, o avisos de GitHub Releases.

## Reproducción integrada

La vista web reproduce MP4/WebM. La mayoría de torrents son MKV con audio AC3/DTS: si tienes
**ffmpeg** instalado, MovWatch los reempaqueta al vuelo a HLS (vídeo copiado sin pérdida, audio a
AAC) y puedes saltar a cualquier minuto. Sin ffmpeg, esos archivos se abren en mpv o VLC.

```sh
brew install ffmpeg        # macOS
winget install ffmpeg      # Windows
sudo apt install ffmpeg    # Debian/Ubuntu
sudo pacman -S ffmpeg      # Arch
```

En Linux la vista web (WebKitGTK) reproduce con GStreamer y necesita sus complementos *base* y
*good*; sin ellos el reproductor integrado se queda cargando. El instalador los añade solo. A mano:
`gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav` en Arch,
`gstreamer1.0-plugins-{base,good,bad} gstreamer1.0-libav` en Debian/Ubuntu.

## Instalación

Igual que Anime Watcher: compila desde `main` y se actualiza sola.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/evilrender23/MovWatch/main/instalar.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/evilrender23/MovWatch/main/instalar.ps1 | iex
```

## Desarrollo

Requisitos: Rust 1.85+, Node 20.19+.

```sh
npm ci
npx tauri dev
cd src-tauri && cargo test                       # pruebas sin red
cargo test -- --ignored --nocapture             # proveedores reales y streaming de Sintel (CC‑BY)
```

Estructura del backend (`src-tauri/src`):

- `providers/` — buscadores de torrents (YTS, TPB, EZTV, Nyaa, Knaben, Torrents‑CSV) y puntuación.
- `catalog.rs` — catálogo y fichas (Cinemeta).
- `engine.rs` — cliente BitTorrent (librqbit) y elección del archivo.
- `server.rs` — servidor local con rangos HTTP y segmentos HLS.
- `media.rs` — ffprobe/ffmpeg para compatibilidad.
- `subtitles.rs` — OpenSubtitles y conversión SRT/ASS → WebVTT.
- `store.rs`, `update.rs`, `player.rs` — ajustes, progreso, lista, actualizaciones y mpv/VLC.

## Aviso

MovWatch no aloja ni indexa contenido: consulta índices públicos de terceros. Descargar material
protegido por derechos de autor puede ser ilegal en tu país. Úsalo con contenido que tengas derecho
a ver (dominio público, Creative Commons, etc.).

## Licencia

MIT, como torrodle. Ver [LICENSE](LICENSE).
