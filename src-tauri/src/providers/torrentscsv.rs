//! Torrents-CSV: índice abierto con API JSON (sólo info-hash; el magnet se construye aquí).

use reqwest::Client;
use serde::Deserialize;

use super::{Query, Source, episode_text, source};
use crate::error::Result;

pub const NAME: &str = "TorrentsCSV";

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    torrents: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    infohash: String,
    name: String,
    #[serde(default)]
    size_bytes: u64,
    #[serde(default)]
    seeders: u32,
    #[serde(default)]
    leechers: u32,
    created_unix: Option<u64>,
}

pub async fn search(client: &Client, q: &Query) -> Result<Vec<Source>> {
    let resp: Resp = client
        .get("https://torrents-csv.com/service/search")
        .query(&[("q", episode_text(q).as_str()), ("size", "50")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .torrents
        .into_iter()
        .map(|i| {
            let mut s = source(NAME, &i.name, &i.infohash, None, i.seeders, i.leechers, i.size_bytes);
            s.uploaded = i.created_unix;
            s
        })
        .collect())
}
