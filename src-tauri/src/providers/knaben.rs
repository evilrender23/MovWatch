//! Knaben: metabuscador con API JSON. Indexa 1337x, The Pirate Bay, Nyaa, el archivo de RARBG y
//! otros, así que cubre los proveedores de torrodle que hoy están tras Cloudflare.

use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::{Category, Query, Source, episode_text, source};
use crate::error::Result;

pub const NAME: &str = "Knaben";

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    hits: Vec<Hit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    title: String,
    hash: Option<String>,
    magnet_url: Option<String>,
    #[serde(default)]
    seeders: u32,
    #[serde(default)]
    peers: u32,
    #[serde(default)]
    bytes: u64,
    details: Option<String>,
    cached_origin: Option<String>,
}

pub async fn search(client: &Client, q: &Query) -> Result<Vec<Source>> {
    let categories: Vec<u32> = match q.category {
        Category::Movie => vec![3_000_000],
        Category::Tv => vec![2_000_000],
        Category::Anime => vec![6_000_000],
        Category::All => vec![],
    };
    let mut body = json!({
        "search_type": "100%",
        "search_field": "title",
        "query": episode_text(q),
        "order_by": "seeders",
        "order_direction": "desc",
        "size": 100,
        "hide_unsafe": true,
        "hide_xxx": true,
    });
    if !categories.is_empty() {
        body["categories"] = json!(categories);
    }
    let resp: Resp = client
        .post("https://api.knaben.org/v1")
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(resp
        .hits
        .into_iter()
        .filter_map(|h| {
            let hash = h.hash.clone().or_else(|| h.magnet_url.as_deref().and_then(super::hash_from_magnet))?;
            let mut s = source(NAME, &h.title, &hash, h.magnet_url, h.seeders, h.peers, h.bytes);
            // "Knaben (1337x)": de dónde lo sacó el metabuscador.
            if let Some(origin) = h.cached_origin.filter(|o| !o.is_empty()) {
                let origin = origin.replace(" (proxy)", "");
                s.provider = format!("{NAME} ({origin})");
            }
            s.url = h.details;
            Some(s)
        })
        .collect())
}
