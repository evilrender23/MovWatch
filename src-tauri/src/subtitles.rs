//! Subtítulos de OpenSubtitles.
//!
//! torrodle usaba la API XML-RPC de OpenSubtitles (`oz/osdb`), que se cerró. Aquí se usa el
//! complemento público de OpenSubtitles para Stremio: busca por IMDb (y temporada/episodio), no
//! necesita cuenta y entrega los archivos ya convertidos a UTF-8.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::{Result, msg};

const BASE: &str = "https://opensubtitles-v3.strem.io";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subtitle {
    pub id: String,
    /// Código ISO 639-2 ("spa", "eng", "pob"…).
    pub lang: String,
    /// Nombre del idioma en español.
    pub language: String,
    pub url: String,
    /// Nombre del lanzamiento (para elegir el que coincide con el torrent).
    pub release: Option<String>,
    pub hearing_impaired: bool,
}

#[derive(Deserialize)]
struct Resp {
    #[serde(default)]
    subtitles: Vec<Raw>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    id: String,
    url: String,
    lang: String,
    movie_release_name: Option<String>,
    subtitle_file_name: Option<String>,
    #[serde(default)]
    m: Option<String>,
}

pub fn language_name(code: &str) -> &'static str {
    match code {
        "spa" | "spn" | "es" => "Español",
        "spl" | "ea" => "Español (Latinoamérica)",
        "eng" | "en" => "Inglés",
        "por" | "pt" => "Portugués",
        "pob" | "pb" => "Portugués (Brasil)",
        "fre" | "fra" | "fr" => "Francés",
        "ger" | "deu" | "de" => "Alemán",
        "ita" | "it" => "Italiano",
        "cat" => "Catalán",
        "baq" | "eus" => "Euskera",
        "glg" => "Gallego",
        "dut" | "nld" => "Neerlandés",
        "rus" => "Ruso",
        "pol" => "Polaco",
        "tur" => "Turco",
        "ara" => "Árabe",
        "heb" => "Hebreo",
        "chi" | "zho" => "Chino (simplificado)",
        "zht" => "Chino (tradicional)",
        "jpn" => "Japonés",
        "kor" => "Coreano",
        "hin" => "Hindi",
        "swe" => "Sueco",
        "nor" => "Noruego",
        "dan" => "Danés",
        "fin" => "Finés",
        "cze" | "ces" => "Checo",
        "hun" => "Húngaro",
        "rum" | "ron" => "Rumano",
        "gre" | "ell" => "Griego",
        "bul" => "Búlgaro",
        "hrv" => "Croata",
        "srp" => "Serbio",
        "slv" => "Esloveno",
        "ind" => "Indonesio",
        "vie" => "Vietnamita",
        "tha" => "Tailandés",
        "ukr" => "Ucraniano",
        _ => "Otro idioma",
    }
}

/// `video_id`: `tt1375666` (película) o `tt0944947:1:2` (episodio).
pub async fn list(client: &Client, video_id: &str) -> Result<Vec<Subtitle>> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^tt\d+(:\d+:\d+)?$").unwrap());
    if !ID.is_match(video_id) {
        return Err(msg("Identificador no válido para buscar subtítulos."));
    }
    let kind = if video_id.contains(':') { "series" } else { "movie" };
    let resp: Resp = client
        .get(format!("{BASE}/subtitles/{kind}/{video_id}.json"))
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut seen = HashMap::new();
    let mut out: Vec<Subtitle> = resp
        .subtitles
        .into_iter()
        .filter(|r| seen.insert(r.id.clone(), ()).is_none())
        .map(|r| Subtitle {
            language: language_name(&r.lang).to_owned(),
            release: r.movie_release_name.or(r.subtitle_file_name),
            hearing_impaired: r.m.as_deref() == Some("h"),
            id: r.id,
            url: r.url,
            lang: r.lang,
        })
        .collect();
    out.sort_by(|a, b| a.language.cmp(&b.language));
    Ok(out)
}

/// Descarga un subtítulo (SRT, VTT o ASS sencillo) y lo devuelve en WebVTT.
pub async fn fetch_vtt(client: &Client, url: &str) -> Result<String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(msg("Dirección de subtítulo no válida."));
    }
    let bytes = client.get(url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?.bytes().await?;
    let text = decode(&bytes);
    Ok(to_vtt(&text))
}

/// UTF-8 si es válido; si no, Windows-1252 / Latin-1 (habitual en subtítulos en español).
fn decode(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_owned(),
        Err(_) => bytes.iter().map(|&b| cp1252(b)).collect(),
    }
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–',
        '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }
}

/// SRT → WebVTT (los VTT se devuelven tal cual; los ASS se reducen a texto).
pub fn to_vtt(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    if text.trim_start().starts_with("WEBVTT") {
        return text;
    }
    if text.contains("[Events]") {
        return ass_to_vtt(&text);
    }
    static TIME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})").unwrap());
    let mut out = String::from("WEBVTT\n\n");
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        let Some(pos) = lines.iter().position(|l| TIME.is_match(l)) else { continue };
        let c = TIME.captures(lines[pos]).unwrap();
        let ms = |i: usize| format!("{:0<3}", &c[i]);
        out.push_str(&format!(
            "{:0>2}:{}:{}.{} --> {:0>2}:{}:{}.{}\n",
            &c[1], &c[2], &c[3], ms(4), &c[5], &c[6], &c[7], ms(8)
        ));
        for l in &lines[pos + 1..] {
            out.push_str(&strip_braces(l));
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

fn strip_braces(l: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{[^}]*\}").unwrap());
    RE.replace_all(l, "").into_owned()
}

fn ass_to_vtt(text: &str) -> String {
    let mut out = String::from("WEBVTT\n\n");
    let fmt_time = |t: &str| -> Option<String> {
        let (h, rest) = t.trim().split_once(':')?;
        let (m, rest) = rest.split_once(':')?;
        let (s, cs) = rest.split_once('.')?;
        Some(format!("{:0>2}:{:0>2}:{:0>2}.{:0<3}", h, m, s, cs))
    };
    for line in text.lines().filter(|l| l.starts_with("Dialogue:")) {
        let parts: Vec<&str> = line["Dialogue:".len()..].splitn(10, ',').collect();
        if parts.len() < 10 {
            continue;
        }
        let (Some(a), Some(b)) = (fmt_time(parts[1]), fmt_time(parts[2])) else { continue };
        let body = strip_braces(parts[9]).replace("\\N", "\n").replace("\\n", "\n");
        out.push_str(&format!("{a} --> {b}\n{body}\n\n"));
    }
    out
}

/// Guarda un subtítulo como `.srt`/`.vtt` temporal para pasarlo a mpv o VLC.
pub async fn save_temp(client: &Client, url: &str, dir: &std::path::Path) -> Result<PathBuf> {
    let vtt = fetch_vtt(client, url).await?;
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("sub-{}.vtt", uuid::Uuid::new_v4()));
    std::fs::write(&path, vtt)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_to_vtt() {
        let srt = "1\r\n00:00:01,500 --> 00:00:03,000\r\nHola {\\i1}mundo{\\i0}\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,250\r\nAdiós\r\n";
        let vtt = to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT"));
        assert!(vtt.contains("00:00:01.500 --> 00:00:03.000\nHola mundo"));
        assert!(vtt.contains("00:00:04.000 --> 00:00:05.250\nAdiós"));
    }

    #[test]
    fn latin1_is_decoded() {
        assert_eq!(decode(b"Espa\xf1a"), "España");
    }
}
