//! EZTV: torrents de episodios, buscados por el identificador de IMDb de la serie.

use futures_util::future::join_all;
use reqwest::Client;
use serde::Deserialize;

use super::{Query, Source, source};
use crate::error::{Result, msg};

pub const NAME: &str = "EZTV";
const API: &str = "https://eztvx.to/api/get-torrents";
const PER_PAGE: u32 = 100;
const MAX_PAGES: u32 = 8;

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    torrents_count: u32,
    #[serde(default)]
    torrents: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    hash: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    title: String,
    magnet_url: Option<String>,
    #[serde(default)]
    seeds: u32,
    #[serde(default)]
    peers: u32,
    #[serde(default)]
    size_bytes: String,
    #[serde(default)]
    season: String,
    #[serde(default)]
    episode: String,
    episode_url: Option<String>,
    date_released_unix: Option<u64>,
}

async fn page(client: &Client, imdb: &str, page: u32) -> Result<Resp> {
    Ok(client
        .get(API)
        .query(&[("imdb_id", imdb), ("limit", &PER_PAGE.to_string()), ("page", &page.to_string())])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

pub async fn search(client: &Client, q: &Query) -> Result<Vec<Source>> {
    let imdb = q.imdb.as_deref().ok_or_else(|| msg("EZTV necesita el IMDb de la serie."))?;
    let imdb = imdb.trim_start_matches("tt");
    let first = page(client, imdb, 1).await?;
    let pages = first.torrents_count.div_ceil(PER_PAGE).clamp(1, MAX_PAGES);
    let rest = join_all((2..=pages).map(|p| page(client, imdb, p))).await;
    let items = first.torrents.into_iter().chain(rest.into_iter().flatten().flat_map(|r| r.torrents));

    let mut out = Vec::new();
    for i in items {
        let (se, ep) = (i.season.parse::<u32>().ok(), i.episode.parse::<u32>().ok());
        if let (Some(ws), Some(we)) = (q.season, q.episode) {
            if se != Some(ws) || ep != Some(we) {
                continue;
            }
        }
        let name = if i.filename.is_empty() { &i.title } else { &i.filename };
        let mut s = source(NAME, name, &i.hash, i.magnet_url, i.seeds, i.peers, i.size_bytes.parse().unwrap_or(0));
        s.url = i.episode_url;
        s.uploaded = i.date_released_unix;
        out.push(s);
    }
    Ok(out)
}
