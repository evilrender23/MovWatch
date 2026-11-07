//! The Pirate Bay a través de la API JSON de apibay.org (la web ya no tiene la tabla que
//! raspaba torrodle).

use reqwest::Client;
use serde::Deserialize;

use super::{Category, Query, Source, episode_text, season_pack_of, source};
use crate::error::Result;

pub const NAME: &str = "ThePirateBay";

#[derive(Deserialize)]
struct Item {
    id: String,
    name: String,
    info_hash: String,
    seeders: String,
    leechers: String,
    size: String,
    added: Option<String>,
}

fn category(c: Category) -> &'static str {
    match c {
        Category::Movie => "201,202,207,209,211",
        Category::Tv => "205,208,212",
        Category::Anime | Category::All => "0",
    }
}

/// Torrents asociados a un IMDb en apibay (encuentra también los títulos traducidos u originales,
/// p. ej. «L'Avare» para «The Miser»).
pub async fn by_imdb(client: &Client, imdb: &str) -> Result<Vec<Source>> {
    query(client, imdb, "0").await
}

async fn query(client: &Client, text: &str, cat: &str) -> Result<Vec<Source>> {
    let items: Vec<Item> = client
        .get("https://apibay.org/q.php")
        .query(&[("q", text), ("cat", cat)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(items
        .into_iter()
        .filter(|i| i.id != "0" && i.info_hash.chars().any(|c| c != '0'))
        .map(|i| {
            let mut s = source(
                NAME,
                &i.name,
                &i.info_hash,
                None,
                i.seeders.parse().unwrap_or(0),
                i.leechers.parse().unwrap_or(0),
                i.size.parse().unwrap_or(0),
            );
            s.url = Some(format!("https://thepiratebay.org/description.php?id={}", i.id));
            s.uploaded = i.added.and_then(|a| a.parse().ok());
            s
        })
        .collect())
}

pub async fn search(client: &Client, q: &Query) -> Result<Vec<Source>> {
    let cat = category(q.category);
    let mut out = query(client, &episode_text(q), cat).await?;
    // Las películas también por IMDb (nombres en otros idiomas). En series el IMDb es el de la
    // serie: se filtran luego por temporada/episodio en `keep`.
    if let Some(imdb) = &q.imdb {
        if let Ok(more) = by_imdb(client, imdb).await {
            out.extend(more);
        }
    }
    // Para un episodio también sirven los packs de la temporada entera.
    if let (Some(season), Some(_)) = (q.season, q.episode) {
        if let Ok(packs) = query(client, &format!("{} S{season:02}", q.text), cat).await {
            out.extend(packs.into_iter().filter(|s| season_pack_of(&s.title) == Some(season)));
        }
    }
    Ok(out)
}
