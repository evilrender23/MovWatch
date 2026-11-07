//! Catálogo de películas y series (pósters, fondos, sinopsis, reparto, temporadas y episodios).
//!
//! torrodle sólo buscaba torrents por texto. Para que la app se pueda explorar como un servicio de
//! streaming se usa Cinemeta, el catálogo público de Stremio basado en IMDb: no necesita clave y
//! devuelve los identificadores de IMDb con los que YTS, EZTV y OpenSubtitles buscan con exactitud.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Result, msg};

const BASE: &str = "https://v3-cinemeta.strem.io";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Movie,
    Series,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Movie => "movie",
            Kind::Series => "series",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub logo: Option<String>,
    pub year: Option<String>,
    pub rating: Option<String>,
    pub genres: Vec<String>,
    pub description: Option<String>,
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    /// `tt0944947:1:2`
    pub id: String,
    pub season: u32,
    pub episode: u32,
    pub name: String,
    pub overview: Option<String>,
    pub thumbnail: Option<String>,
    pub released: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    #[serde(flatten)]
    pub card: Card,
    pub cast: Vec<String>,
    pub director: Vec<String>,
    pub writer: Vec<String>,
    pub country: Option<String>,
    pub released: Option<String>,
    pub awards: Option<String>,
    /// En emisión / Finalizada (series).
    pub status: Option<String>,
    /// Identificadores de YouTube de los tráileres.
    pub trailers: Vec<String>,
    /// Episodios ordenados por temporada y número (vacío en películas).
    pub videos: Vec<Video>,
}

fn s(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(t) if !t.trim().is_empty() => Some(t.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn list(v: &Value, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_owned)).filter(|x| !x.is_empty()).collect(),
        Some(Value::String(t)) => t.split(',').map(|x| x.trim().to_owned()).filter(|x| !x.is_empty()).collect(),
        _ => Vec::new(),
    }
}

/// Las imágenes de metahub vienen en tamaño pequeño o mediano; se piden más grandes.
fn bigger(url: Option<String>, from: &str, to: &str) -> Option<String> {
    url.map(|u| u.replace(from, to))
}

fn card(v: &Value, fallback: Kind) -> Option<Card> {
    let id = s(v, "imdb_id").or_else(|| s(v, "id"))?;
    if !id.starts_with("tt") {
        return None;
    }
    let kind = match v.get("type").and_then(Value::as_str) {
        Some("series") => Kind::Series,
        Some("movie") => Kind::Movie,
        _ => fallback,
    };
    Some(Card {
        name: s(v, "name")?,
        poster: bigger(s(v, "poster"), "/poster/small/", "/poster/medium/"),
        background: bigger(s(v, "background"), "/background/medium/", "/background/large/"),
        logo: s(v, "logo"),
        year: s(v, "releaseInfo").or_else(|| s(v, "year")),
        rating: s(v, "imdbRating").filter(|r| r != "0" && r != "0.0"),
        genres: { let g = list(v, "genres"); if g.is_empty() { list(v, "genre") } else { g } },
        description: s(v, "description"),
        runtime: s(v, "runtime"),
        id,
        kind,
    })
}

async fn get(client: &Client, url: &str) -> Result<Value> {
    Ok(client.get(url).timeout(Duration::from_secs(20)).send().await?.error_for_status()?.json().await?)
}

/// Catálogo: `top` (populares), `imdbRating` (mejor valoradas) o `year` (por año; `genre` = año).
pub async fn catalog(client: &Client, kind: Kind, id: &str, genre: Option<&str>, skip: u32) -> Result<Vec<Card>> {
    let id = match id {
        "top" | "imdbRating" | "year" => id,
        _ => return Err(msg("Catálogo desconocido.")),
    };
    let mut extra = Vec::new();
    if let Some(g) = genre.filter(|g| !g.is_empty()) {
        extra.push(format!("genre={}", urlencode(g)));
    }
    if skip > 0 {
        extra.push(format!("skip={skip}"));
    }
    let url = if extra.is_empty() {
        format!("{BASE}/catalog/{}/{id}.json", kind.as_str())
    } else {
        format!("{BASE}/catalog/{}/{id}/{}.json", kind.as_str(), extra.join("&"))
    };
    let v = get(client, &url).await?;
    Ok(metas(&v, kind))
}

fn metas(v: &Value, kind: Kind) -> Vec<Card> {
    v.get("metas").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| card(m, kind)).collect()).unwrap_or_default()
}

fn urlencode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[derive(Debug, Serialize)]
pub struct SearchResults {
    pub movies: Vec<Card>,
    pub series: Vec<Card>,
}

pub async fn search(client: &Client, query: &str) -> Result<SearchResults> {
    let q = urlencode(query.trim());
    let (mu, su) = (format!("{BASE}/catalog/movie/top/search={q}.json"), format!("{BASE}/catalog/series/top/search={q}.json"));
    let (movies, series) = tokio::join!(get(client, &mu), get(client, &su));
    match (movies, series) {
        (Err(e), Err(_)) => Err(e),
        (m, s) => Ok(SearchResults {
            movies: m.map(|v| metas(&v, Kind::Movie)).unwrap_or_default(),
            series: s.map(|v| metas(&v, Kind::Series)).unwrap_or_default(),
        }),
    }
}

pub async fn detail(client: &Client, kind: Kind, id: &str) -> Result<Detail> {
    if !id.starts_with("tt") || !id[2..].chars().all(|c| c.is_ascii_digit()) {
        return Err(msg("Identificador de IMDb no válido."));
    }
    let v = get(client, &format!("{BASE}/meta/{}/{id}.json", kind.as_str())).await?;
    let m = v.get("meta").filter(|m| !m.is_null()).ok_or_else(|| msg("No se encontró la ficha."))?;
    let card = card(m, kind).ok_or_else(|| msg("Ficha incompleta."))?;
    let mut videos: Vec<Video> = m
        .get("videos")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let season = x.get("season")?.as_u64()? as u32;
                    let episode = x.get("episode").or_else(|| x.get("number"))?.as_u64()? as u32;
                    Some(Video {
                        id: s(x, "id").unwrap_or_else(|| format!("{id}:{season}:{episode}")),
                        season,
                        episode,
                        name: s(x, "name").or_else(|| s(x, "title")).unwrap_or_else(|| format!("Episodio {episode}")),
                        overview: s(x, "overview").or_else(|| s(x, "description")),
                        thumbnail: s(x, "thumbnail"),
                        released: s(x, "released").or_else(|| s(x, "firstAired")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    videos.sort_by_key(|v| (v.season == 0, v.season, v.episode));
    let trailers = m
        .get("trailers")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|t| s(t, "source")).collect())
        .unwrap_or_default();
    Ok(Detail {
        cast: list(m, "cast"),
        director: list(m, "director"),
        writer: list(m, "writer"),
        country: s(m, "country"),
        released: s(m, "released"),
        awards: s(m, "awards"),
        status: s(m, "status"),
        trailers,
        videos,
        card,
    })
}
