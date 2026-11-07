//! Nyaa: animé. Se lee su RSS (más estable que el HTML que raspaba torrodle para Sukebei).

use std::sync::LazyLock;

use regex::Regex;
use reqwest::Client;

use super::{Query, Source, episode_text, parse_size, source};
use crate::error::Result;

pub const NAME: &str = "Nyaa";

fn tag<'a>(item: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = item.find(&open)? + open.len();
    let end = item[start..].find(&close)? + start;
    Some(item[start..end].trim())
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&#34;", "\"")
}

pub async fn search(client: &Client, q: &Query) -> Result<Vec<Source>> {
    static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<item>(.*?)</item>").unwrap());
    let body = client
        .get("https://nyaa.si/")
        .query(&[("page", "rss"), ("q", episode_text(q).as_str()), ("c", "1_0"), ("f", "0"), ("s", "seeders"), ("o", "desc")])
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let mut out = Vec::new();
    for cap in ITEM.captures_iter(&body) {
        let item = &cap[1];
        let (Some(title), Some(hash)) = (tag(item, "title"), tag(item, "nyaa:infoHash")) else { continue };
        let num = |n: &str| tag(item, n).and_then(|v| v.parse().ok()).unwrap_or(0);
        let size = tag(item, "nyaa:size").map(parse_size).unwrap_or(0);
        let mut s = source(NAME, &unescape(title), hash, None, num("nyaa:seeders"), num("nyaa:leechers"), size);
        s.url = tag(item, "guid").map(unescape);
        out.push(s);
    }
    Ok(out)
}
