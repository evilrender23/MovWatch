//! Buscadores de torrents (los "providers" de torrodle, puestos al día).
//!
//! torrodle consultaba 1337x, RARBG, The Pirate Bay, YTS, Torrentz2, LimeTorrents y Sukebei
//! raspando HTML. RARBG y Torrentz2 cerraron, 1337x está tras Cloudflare y LimeTorrents cambia de
//! dominio cada pocos meses, así que aquí se usan APIs estables que devuelven JSON o RSS:
//!
//! | Proveedor    | Qué busca                  | Cómo                                   |
//! |--------------|----------------------------|----------------------------------------|
//! | YTS          | Películas (MP4 ligeros)    | API `list_movies.json` (por IMDb)      |
//! | ThePirateBay | Todo                       | API de apibay.org                      |
//! | EZTV         | Episodios de series        | API `get-torrents` (por IMDb)          |
//! | Nyaa         | Animé                      | RSS                                    |
//! | Knaben       | Metabuscador (1337x, …)    | API JSON                               |
//! | TorrentsCSV  | Índice abierto             | API JSON                               |
//!
//! Todos se consultan a la vez; los resultados se unen por info-hash (sumando los nombres de los
//! proveedores que lo encontraron) y se ordenan.

mod eztv;
mod knaben;
mod nyaa;
mod torrentscsv;
mod tpb;
mod yts;

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::future::join_all;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Trackers públicos que se añaden a los magnets que no traen ninguno (YTS, TorrentsCSV).
pub const TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "udp://explodie.org:6969/announce",
    "udp://tracker.tiny-vps.com:6969/announce",
    "https://tracker.gbitt.info:443/announce",
    "udp://tracker.dler.org:6969/announce",
    "udp://opentracker.io:6969/announce",
    "udp://tracker.qu.ax:6969/announce",
    "http://tracker.opentrackr.org:1337/announce",
];

/// Tiempo máximo por proveedor: uno lento no debe bloquear a los demás.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    #[default]
    All,
    Movie,
    Tv,
    Anime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SortBy {
    /// Puntuación propia: semillas, calidad y (si se pide) audio en español.
    #[default]
    Smart,
    Seeders,
    Leechers,
    Size,
}

/// Lo que se busca. `imdb` y `season`/`episode` permiten búsquedas exactas en YTS y EZTV.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub text: String,
    pub category: Category,
    pub imdb: Option<String>,
    pub year: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    /// Nombres de proveedores; vacío = todos.
    pub providers: Vec<String>,
    pub sort: SortBy,
    /// Subir en la lista los torrents con audio en español.
    pub prefer_spanish: bool,
}

/// Un torrent encontrado (el `Source` de torrodle con más datos).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// Proveedores que lo devolvieron, p. ej. "YTS · ThePirateBay".
    pub provider: String,
    pub title: String,
    /// Info-hash en hexadecimal y minúsculas.
    pub info_hash: String,
    pub magnet: String,
    pub seeders: u32,
    pub leechers: u32,
    /// Bytes; 0 = desconocido.
    pub size: u64,
    /// Página del torrent en el proveedor.
    pub url: Option<String>,
    /// "2160p", "1080p", "720p", "480p"…
    pub quality: Option<String>,
    /// Etiquetas legibles: "HEVC", "HDR", "WEB-DL", "Español", "Temporada completa"…
    pub tags: Vec<String>,
    /// Segundos desde UNIX_EPOCH.
    pub uploaded: Option<u64>,
    /// Puntuación usada para el orden "inteligente".
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub name: String,
    pub count: usize,
    pub error: Option<String>,
    pub millis: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub sources: Vec<Source>,
    pub providers: Vec<ProviderStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub name: &'static str,
    pub site: &'static str,
    pub categories: &'static [Category],
    pub description: &'static str,
}

pub const ALL: &[ProviderInfo] = &[
    ProviderInfo {
        name: yts::NAME,
        site: "https://yts.mx",
        categories: &[Category::Movie],
        description: "Películas en MP4 ligeros. Se reproducen sin convertir.",
    },
    ProviderInfo {
        name: tpb::NAME,
        site: "https://thepiratebay.org",
        categories: &[Category::All, Category::Movie, Category::Tv],
        description: "El índice más grande. Calidad muy variable.",
    },
    ProviderInfo {
        name: eztv::NAME,
        site: "https://eztvx.to",
        categories: &[Category::Tv],
        description: "Episodios de series, buscados por IMDb.",
    },
    ProviderInfo {
        name: nyaa::NAME,
        site: "https://nyaa.si",
        categories: &[Category::Anime],
        description: "Animé subtitulado (sólo búsquedas de animé).",
    },
    ProviderInfo {
        name: knaben::NAME,
        site: "https://knaben.org",
        categories: &[Category::All, Category::Movie, Category::Tv, Category::Anime],
        description: "Metabuscador: incluye 1337x, RARBG (archivo) y otros.",
    },
    ProviderInfo {
        name: torrentscsv::NAME,
        site: "https://torrents-csv.com",
        categories: &[Category::All, Category::Movie, Category::Tv, Category::Anime],
        description: "Índice abierto de dominio público.",
    },
];

/// Consulta los proveedores elegidos en paralelo y devuelve los resultados unidos y ordenados.
pub async fn search(client: &Client, q: &Query) -> Result<SearchResult> {
    let wanted = |name: &str| q.providers.is_empty() || q.providers.iter().any(|p| p.eq_ignore_ascii_case(name));
    let q = &normalize(q);

    type Fut<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Source>>> + Send + 'a>>;
    let mut tasks: Vec<(&'static str, Fut)> = Vec::new();
    if wanted(yts::NAME) && matches!(q.category, Category::Movie | Category::All) && q.season.is_none() {
        tasks.push((yts::NAME, Box::pin(yts::search(client, q))));
    }
    if wanted(tpb::NAME) && q.category != Category::Anime {
        tasks.push((tpb::NAME, Box::pin(tpb::search(client, q))));
    }
    if wanted(eztv::NAME) && q.category == Category::Tv && q.imdb.is_some() {
        tasks.push((eztv::NAME, Box::pin(eztv::search(client, q))));
    }
    if wanted(nyaa::NAME) && q.category == Category::Anime {
        tasks.push((nyaa::NAME, Box::pin(nyaa::search(client, q))));
    }
    if wanted(knaben::NAME) {
        tasks.push((knaben::NAME, Box::pin(knaben::search(client, q))));
    }
    if wanted(torrentscsv::NAME) {
        tasks.push((torrentscsv::NAME, Box::pin(torrentscsv::search(client, q))));
    }

    let started = std::time::Instant::now();
    let results = join_all(tasks.into_iter().map(|(name, fut)| async move {
        let t0 = std::time::Instant::now();
        let res = match tokio::time::timeout(PROVIDER_TIMEOUT, fut).await {
            Ok(r) => r,
            Err(_) => Err(crate::error::msg(format!("{name} no respondió a tiempo."))),
        };
        (name, res, t0.elapsed())
    }))
    .await;
    let _ = started;

    let mut statuses = Vec::new();
    let mut merged: HashMap<String, Source> = HashMap::new();
    for (name, res, took) in results {
        let millis = took.as_millis() as u64;
        match res {
            Ok(list) => {
                let list: Vec<Source> = list.into_iter().filter(|s| keep(s, q)).collect();
                statuses.push(ProviderStatus { name: name.into(), count: list.len(), error: None, millis });
                for s in list {
                    merge(&mut merged, s);
                }
            }
            Err(e) => statuses.push(ProviderStatus { name: name.into(), count: 0, error: Some(e.to_string()), millis }),
        }
    }

    let mut sources: Vec<Source> = merged.into_values().collect();
    for s in &mut sources {
        s.score = score(s, q.prefer_spanish);
    }
    sort(&mut sources, q.sort);
    sources.truncate(300);
    Ok(SearchResult { sources, providers: statuses })
}

/// Limpia el texto y deduce la temporada/episodio si vienen escritos ("Serie S01E02").
fn normalize(q: &Query) -> Query {
    let mut q = q.clone();
    q.text = q.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(imdb) = &q.imdb {
        let id = imdb.trim();
        q.imdb = (id.starts_with("tt") && id.len() > 3).then(|| id.to_owned());
    }
    q
}

/// Descarta lo que no corresponde al episodio pedido (si se pidió uno) y lo que no tiene semillas.
fn keep(s: &Source, q: &Query) -> bool {
    if s.seeders == 0 || s.info_hash.len() != 40 {
        return false;
    }
    if let (Some(season), Some(episode)) = (q.season, q.episode) {
        if q.category == Category::Anime {
            return true;
        }
        return match episode_of(&s.title) {
            Some((se, ep)) => se == season && ep == episode,
            // Pack de temporada: sirve si es de esa temporada.
            None => season_pack_of(&s.title) == Some(season),
        };
    }
    true
}

fn merge(map: &mut HashMap<String, Source>, s: Source) {
    match map.get_mut(&s.info_hash) {
        Some(existing) => {
            if !existing.provider.split(" · ").any(|p| p == s.provider) {
                existing.provider = format!("{} · {}", existing.provider, s.provider);
            }
            existing.seeders = existing.seeders.max(s.seeders);
            existing.leechers = existing.leechers.max(s.leechers);
            if existing.size == 0 {
                existing.size = s.size;
            }
            if existing.url.is_none() {
                existing.url = s.url;
            }
            if existing.uploaded.is_none() {
                existing.uploaded = s.uploaded;
            }
            // El magnet con más trackers encuentra pares antes.
            if s.magnet.matches("tr=").count() > existing.magnet.matches("tr=").count() {
                existing.magnet = s.magnet;
            }
        }
        None => {
            map.insert(s.info_hash.clone(), s);
        }
    }
}

pub fn sort(list: &mut [Source], by: SortBy) {
    match by {
        SortBy::Smart => list.sort_by(|a, b| b.score.total_cmp(&a.score)),
        SortBy::Seeders => list.sort_by(|a, b| b.seeders.cmp(&a.seeders)),
        SortBy::Leechers => list.sort_by(|a, b| b.leechers.cmp(&a.leechers)),
        SortBy::Size => list.sort_by(|a, b| b.size.cmp(&a.size)),
    }
}

/// Más semillas es mejor, pero con rendimientos decrecientes; las copias de cámara se hunden.
fn score(s: &Source, prefer_spanish: bool) -> f64 {
    let mut v = ((s.seeders as f64) + 1.0).ln() * 10.0;
    v += match s.quality.as_deref() {
        Some("2160p") => 6.0,
        Some("1080p") => 8.0,
        Some("720p") => 5.0,
        Some("480p") => 1.0,
        _ => 0.0,
    };
    if s.tags.iter().any(|t| t == "CAM" || t == "TS") {
        v -= 40.0;
    }
    if s.provider.contains(yts::NAME) {
        v += 3.0; // MP4: no hace falta convertir.
    }
    if prefer_spanish && s.tags.iter().any(|t| t == "Español" || t == "Dual" || t == "Latino") {
        v += 25.0;
    }
    v
}

// ---------------------------------------------------------------------------
// Utilidades compartidas por los proveedores
// ---------------------------------------------------------------------------

pub fn magnet_from_hash(hash: &str, name: &str) -> String {
    let dn = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC);
    let mut m = format!("magnet:?xt=urn:btih:{}&dn={dn}", hash.to_ascii_lowercase());
    for tr in TRACKERS {
        m.push_str("&tr=");
        m.push_str(&percent_encoding::utf8_percent_encode(tr, percent_encoding::NON_ALPHANUMERIC).to_string());
    }
    m
}

/// Info-hash (hex) de un magnet; los hash en base32 se convierten a hex.
pub fn hash_from_magnet(magnet: &str) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)xt=urn:btih:([a-z0-9]{32,40})").unwrap());
    let raw = RE.captures(magnet)?.get(1)?.as_str();
    if raw.len() == 40 {
        return Some(raw.to_ascii_lowercase());
    }
    base32_to_hex(raw)
}

fn base32_to_hex(s: &str) -> Option<String> {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits: u64 = 0;
    let mut n = 0;
    let mut out = String::new();
    for c in s.to_ascii_uppercase().bytes() {
        let v = ALPHA.iter().position(|&a| a == c)? as u64;
        bits = (bits << 5) | v;
        n += 5;
        while n >= 8 {
            n -= 8;
            out.push_str(&format!("{:02x}", (bits >> n) & 0xff));
        }
    }
    (out.len() == 40).then_some(out)
}

/// "1.4 GiB", "700 MB", "1,2 GB" → bytes.
pub fn parse_size(text: &str) -> u64 {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)([\d.,]+)\s*([KMGT]?)(i?)B").unwrap());
    let Some(c) = RE.captures(text) else { return 0 };
    let num: f64 = c[1].replace(',', ".").parse().unwrap_or(0.0);
    let base: f64 = if c[3].is_empty() { 1000.0 } else { 1024.0 };
    let exp = match c[2].to_ascii_uppercase().as_str() {
        "K" => 1,
        "M" => 2,
        "G" => 3,
        "T" => 4,
        _ => 0,
    };
    (num * base.powi(exp)) as u64
}

/// (temporada, episodio) escrito en el nombre: S01E02, s1e2, 1x02.
pub fn episode_of(title: &str) -> Option<(u32, u32)> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:\bS(\d{1,2})[ ._-]?E(\d{1,3})\b|\b(\d{1,2})x(\d{2,3})\b)").unwrap());
    let c = RE.captures(title)?;
    let pick = |a: usize, b: usize| Some((c.get(a)?.as_str().parse().ok()?, c.get(b)?.as_str().parse().ok()?));
    pick(1, 2).or_else(|| pick(3, 4))
}

/// Temporada de un pack completo: "S02", "Season 2", "Temporada 2" (sin episodio).
pub fn season_pack_of(title: &str) -> Option<u32> {
    if episode_of(title).is_some() {
        return None;
    }
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\b(?:S(\d{1,2})(?:\b|[ ._-])|(?:season|temporada)[ ._-]?(\d{1,2})\b)").unwrap());
    let c = RE.captures(title)?;
    c.get(1).or_else(|| c.get(2))?.as_str().parse().ok()
}

pub fn quality_of(title: &str) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(2160p|4k|uhd|1080p|720p|576p|480p|360p)\b").unwrap());
    let q = RE.captures(title)?.get(1)?.as_str().to_ascii_lowercase();
    Some(match q.as_str() {
        "4k" | "uhd" => "2160p".into(),
        "576p" => "480p".into(),
        _ => q,
    })
}

pub fn tags_of(title: &str) -> Vec<String> {
    static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (r"(?i)\b(x265|h\.?265|hevc)\b", "HEVC"),
            (r"(?i)\b(x264|h\.?264|avc)\b", "H.264"),
            (r"(?i)\bav1\b", "AV1"),
            (r"(?i)\b(hdr10\+?|hdr)\b", "HDR"),
            (r"(?i)\b(dv|dovi|dolby[ ._-]?vision)\b", "Dolby Vision"),
            (r"(?i)\b10[ ._-]?bit\b", "10 bits"),
            (r"(?i)\bremux\b", "REMUX"),
            (r"(?i)\b(blu[ ._-]?ray|bdrip|brrip|bdremux)\b", "BluRay"),
            (r"(?i)\bweb[ ._-]?dl\b", "WEB-DL"),
            (r"(?i)\bweb[ ._-]?rip\b", "WEBRip"),
            (r"(?i)\bhdtv\b", "HDTV"),
            (r"(?i)\b(hd)?cam(rip)?\b", "CAM"),
            (r"(?i)\b(hd)?ts\b|\btelesync\b", "TS"),
            (r"(?i)\b(atmos)\b", "Atmos"),
            (r"(?i)\b(5\.1|7\.1)\b", "5.1"),
            (r"(?i)\b(castellano|spanish|español|espanol|esp|spa)\b", "Español"),
            (r"(?i)\b(latino|lat)\b", "Latino"),
            (r"(?i)\b(dual|multi)\b", "Dual"),
            (r"(?i)\b(subs?|subtitulad[oa]|vose)\b", "Subtítulos"),
            (r"(?i)\byify\b|\byts\b", "MP4"),
        ]
        .into_iter()
        .map(|(re, t)| (Regex::new(re).unwrap(), t))
        .collect()
    });
    let mut out: Vec<String> = Vec::new();
    for (re, tag) in RULES.iter() {
        if re.is_match(title) && !out.iter().any(|t| t == tag) {
            out.push((*tag).to_owned());
        }
    }
    if season_pack_of(title).is_some() {
        out.push("Temporada completa".into());
    }
    out
}

/// Construye un `Source` rellenando calidad y etiquetas a partir del título.
pub fn source(provider: &str, title: &str, hash: &str, magnet: Option<String>, seeders: u32, leechers: u32, size: u64) -> Source {
    let info_hash = hash.trim().to_ascii_lowercase();
    let magnet = magnet.filter(|m| m.starts_with("magnet:")).unwrap_or_else(|| magnet_from_hash(&info_hash, title));
    Source {
        provider: provider.into(),
        title: title.trim().to_owned(),
        quality: quality_of(title),
        tags: tags_of(title),
        info_hash,
        magnet,
        seeders,
        leechers,
        size,
        url: None,
        uploaded: None,
        score: 0.0,
    }
}

/// Texto de búsqueda para un episodio: "Serie S01E02".
pub fn episode_text(q: &Query) -> String {
    match (q.season, q.episode) {
        (Some(s), Some(e)) if q.category != Category::Anime => format!("{} S{s:02}E{e:02}", q.text),
        (Some(_), Some(e)) => format!("{} {e:02}", q.text),
        _ => match &q.year {
            Some(y) if q.category == Category::Movie && !q.text.contains(y.as_str()) => format!("{} {y}", q.text),
            _ => q.text.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_episode_and_season_packs() {
        assert_eq!(episode_of("Show.Name.S01E02.1080p.WEB"), Some((1, 2)));
        assert_eq!(episode_of("Show Name 2x05 HDTV"), Some((2, 5)));
        assert_eq!(episode_of("Show 1080p"), None);
        assert_eq!(season_pack_of("Show.Name.S03.1080p.BluRay"), Some(3));
        assert_eq!(season_pack_of("Show Name Season 2 Complete"), Some(2));
        assert_eq!(season_pack_of("Show.Name.S03E01.1080p"), None);
    }

    #[test]
    fn parses_sizes_and_quality() {
        assert_eq!(parse_size("1.5 GiB"), 1_610_612_736);
        assert_eq!(parse_size("700 MB"), 700_000_000);
        assert_eq!(quality_of("Movie 2019 4K HDR"), Some("2160p".into()));
        assert!(tags_of("Movie.2019.1080p.x265.HDR.Castellano").contains(&"Español".to_string()));
    }

    #[test]
    fn converts_base32_hashes() {
        let m = "magnet:?xt=urn:btih:EQKYQ43ESQYWF6XRZ4SGZ7XDTQW7LBMI&dn=x";
        assert_eq!(hash_from_magnet(m).unwrap().len(), 40);
        let hex = "magnet:?xt=urn:btih:224BF45881252643DFC2E71ABC7B2660A21C68C4";
        assert_eq!(hash_from_magnet(hex).unwrap(), "224bf45881252643dfc2e71abc7b2660a21c68c4");
    }
}

/// Pruebas contra los proveedores reales: `cargo test -- --ignored proveedores_reales --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn proveedores_reales() {
        let client = crate::http::scraper_client().unwrap();
        let movie = Query { text: "Inception".into(), category: Category::Movie, imdb: Some("tt1375666".into()), year: Some("2010".into()), ..Default::default() };
        let r = search(&client, &movie).await.unwrap();
        for p in &r.providers {
            println!("película  {:<12} {:>4} {:>6} ms {:?}", p.name, p.count, p.millis, p.error);
        }
        for s in r.sources.iter().take(5) {
            println!("  {:>5} {:>6} {:>10} {:?} {:?} {} [{}]", format!("{:.0}", s.score), s.seeders, s.size, s.quality, s.tags, s.title, s.provider);
        }
        assert!(r.sources.len() > 5);

        let ep = Query { text: "Game of Thrones".into(), category: Category::Tv, imdb: Some("tt0944947".into()), season: Some(1), episode: Some(2), ..Default::default() };
        let r = search(&client, &ep).await.unwrap();
        for p in &r.providers {
            println!("episodio  {:<12} {:>4} {:>6} ms {:?}", p.name, p.count, p.millis, p.error);
        }
        for s in r.sources.iter().take(5) {
            println!("  {:>6} {} [{}]", s.seeders, s.title, s.provider);
        }
        assert!(r.sources.iter().any(|s| episode_of(&s.title) == Some((1, 2))));

        let anime = Query { text: "Frieren".into(), category: Category::Anime, ..Default::default() };
        let r = search(&client, &anime).await.unwrap();
        for p in &r.providers {
            println!("animé     {:<12} {:>4} {:>6} ms {:?}", p.name, p.count, p.millis, p.error);
        }
        assert!(!r.sources.is_empty());
    }
}
