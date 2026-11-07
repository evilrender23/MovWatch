//! YTS (antes YIFY): películas en MP4 ligeros. El dominio cambia a menudo; se prueban varios.

use reqwest::Client;
use serde::Deserialize;

use super::{Query, Source, episode_text, source};
use crate::error::{Result, msg};

pub const NAME: &str = "YTS";

const APIS: &[&str] = &[
    "https://movies-api.accel.li/api/v2",
    "https://yts.mx/api/v2",
    "https://yts.am/api/v2",
];

#[derive(Deserialize)]
struct Resp {
    status: String,
    #[serde(default)]
    status_message: String,
    data: Option<Data>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(default)]
    movies: Vec<Movie>,
}

#[derive(Deserialize)]
struct Movie {
    url: Option<String>,
    title_long: String,
    #[serde(default)]
    torrents: Vec<Torrent>,
    date_uploaded_unix: Option<u64>,
}

#[derive(Deserialize)]
struct Torrent {
    hash: String,
    quality: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    video_codec: Option<String>,
    #[serde(default)]
    seeds: u32,
    #[serde(default)]
    peers: u32,
    #[serde(default)]
    size_bytes: u64,
    date_uploaded_unix: Option<u64>,
}

pub async fn search(client: &Client, q: &Query) -> Result<Vec<Source>> {
    let term = q.imdb.clone().unwrap_or_else(|| episode_text(q));
    let mut last_err = None;
    for api in APIS {
        let req = client
            .get(format!("{api}/list_movies.json"))
            .query(&[("query_term", term.as_str()), ("limit", "50"), ("sort_by", "seeds")]);
        let resp: Resp = match async { req.send().await?.error_for_status()?.json::<Resp>().await }.await {
            Ok(r) => r,
            Err(e) => {
                last_err = Some(crate::error::Error::from(e));
                continue;
            }
        };
        if resp.status != "ok" {
            return Err(msg(format!("YTS: {}", resp.status_message)));
        }
        let mut out = Vec::new();
        for m in resp.data.map(|d| d.movies).unwrap_or_default() {
            for t in m.torrents {
                let codec = t.video_codec.as_deref().unwrap_or("");
                let title = format!("{} {} {} {} YIFY", m.title_long, t.quality, t.kind, codec);
                let mut s = source(NAME, &title, &t.hash, None, t.seeds, t.peers, t.size_bytes);
                s.title = format!("{} [{} {}]", m.title_long, t.quality, t.kind.to_uppercase());
                s.url = m.url.clone();
                s.uploaded = t.date_uploaded_unix.or(m.date_uploaded_unix);
                out.push(s);
            }
        }
        return Ok(out);
    }
    Err(last_err.unwrap_or_else(|| msg("YTS no responde.")))
}
