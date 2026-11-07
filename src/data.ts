// Cachés en memoria (fichas, catálogos y resultados de torrents) para que navegar entre
// vistas no repita peticiones, y el contexto que el reproductor necesita.
import * as api from "./api";
import type { Card, Detail, Kind, ListEntry, SearchResult, Source, TorrentQuery } from "./api";

const TTL_MS = 15 * 60 * 1000;

function memo<T>() {
  const map = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = map.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = load();
    map.set(key, { at: Date.now(), value });
    value.catch(() => map.delete(key));
    return value;
  };
}

const details = memo<Detail>();
const catalogs = memo<Card[]>();
const torrents = memo<SearchResult>();

export const getDetail = (kind: Kind, id: string) => details(`${kind}:${id}`, () => api.titleDetail(kind, id));
export const getCatalog = (kind: Kind, id: api.CatalogId, genre: string | null = null, skip = 0) =>
  catalogs(`${kind}:${id}:${genre ?? ""}:${skip}`, () => api.catalog(kind, id, genre, skip));
export const getTorrents = (q: TorrentQuery, refresh = false) => {
  const key = JSON.stringify(q);
  if (refresh) return torrents(`${key}:${Date.now()}`, () => api.searchTorrents(q));
  return torrents(key, () => api.searchTorrents(q));
};

/** Lo que el reproductor necesita saber del título que se está viendo. */
export interface WatchContext {
  /** IMDb de la película o la serie. */
  id: string;
  kind: Kind;
  title: string;
  poster: string | null;
  background: string | null;
  year: string | null;
  season: number | null;
  episode: number | null;
  episodeName: string | null;
}

export const videoIdOf = (ctx: Pick<WatchContext, "id" | "season" | "episode">) =>
  ctx.season !== null && ctx.episode !== null ? `${ctx.id}:${ctx.season}:${ctx.episode}` : ctx.id;

export const episodeLabel = (season: number, episode: number) =>
  `T${season} · E${String(episode).padStart(2, "0")}`;

/** Consulta de torrents para una película o un episodio. */
export function queryFor(ctx: WatchContext, audioLang: string): TorrentQuery {
  const series = ctx.kind === "series";
  const year = ctx.year?.match(/\d{4}/)?.[0] ?? null;
  return {
    text: ctx.title,
    category: series ? "tv" : "movie",
    imdb: ctx.id,
    year: series ? null : year,
    season: series ? ctx.season : null,
    episode: series ? ctx.episode : null,
    audioLang,
  };
}

/** Códigos ISO 639-2 equivalentes (ffprobe usa fre/fra, ger/deu…). */
const LANG_ALIASES: Record<string, string[]> = {
  spa: ["spa", "es", "esp", "cas"],
  lat: ["lat", "spa", "es", "es-419"],
  eng: ["eng", "en"],
  fre: ["fre", "fra", "fr"],
  ita: ["ita", "it"],
  ger: ["ger", "deu", "de"],
  por: ["por", "pt"],
  pob: ["pob", "por", "pt", "pt-br"],
  cat: ["cat", "ca"],
  rus: ["rus", "ru"],
  jpn: ["jpn", "ja"],
  kor: ["kor", "ko"],
  hin: ["hin", "hi"],
};
/** Palabras con que suelen titularse las pistas de audio en cada idioma. */
const LANG_WORDS: Record<string, RegExp> = {
  spa: /castellano|españ|espan|spanish/i,
  lat: /latino|latam|latin/i,
  eng: /english|ingl/i,
  fre: /fran[cç]|french|vff|vfq|truefrench/i,
  ita: /italian/i,
  ger: /deutsch|german|alem/i,
  por: /portugu/i,
  pob: /brasil|brazil|dublado/i,
  cat: /catal/i,
  rus: /russ|rus/i,
  jpn: /japan|japon/i,
  kor: /korea|corea/i,
  hin: /hindi/i,
};
/** ¿Esta pista (idioma + título del contenedor) es del idioma pedido? */
export function trackMatches(lang: string, trackLang: string | null, trackTitle: string | null): boolean {
  if (!lang) return false;
  const code = (trackLang ?? "").toLowerCase();
  // En "lat" el título decide (las pistas latinas también se etiquetan "spa").
  if (lang === "lat") return LANG_WORDS.lat.test(trackTitle ?? "") || (code === "lat");
  if (lang === "spa" && LANG_WORDS.lat.test(trackTitle ?? "")) return false;
  return (LANG_ALIASES[lang] ?? [lang]).includes(code) || LANG_WORDS[lang]?.test(trackTitle ?? "") === true;
}
/** ¿La fuente trae audio en ese idioma (según su nombre)? */
export const sourceHasLang = (languages: string[], lang: string) =>
  !!lang && (languages.includes(lang) || (lang === "spa" && languages.includes("lat")) || (lang === "lat" && languages.includes("spa")));

/** Fuente elegida para reproducir (se guarda para "Continuar viendo" en la misma sesión). */
const lastSource = new Map<string, Source>();
export const rememberSource = (videoId: string, s: Source) => lastSource.set(videoId, s);
export const recallSource = (videoId: string) => lastSource.get(videoId) ?? null;

// Lista personal sincronizada con el backend.
let listCache: ListEntry[] | null = null;
let listLoading: Promise<ListEntry[]> | null = null;
export function loadList(): Promise<ListEntry[]> {
  if (listCache) return Promise.resolve(listCache);
  listLoading ??= api.listAll().then(
    (l) => {
      listCache = l;
      listLoading = null;
      return l;
    },
    (e: unknown) => {
      listLoading = null;
      throw e;
    },
  );
  return listLoading;
}
export const peekList = () => listCache;
window.addEventListener(api.LIST_EVENT, () => {
  listCache = null;
});

export function cardFromDetail(d: Detail): Card {
  return {
    id: d.id,
    kind: d.kind,
    name: d.name,
    poster: d.poster,
    background: d.background,
    logo: d.logo,
    year: d.year,
    rating: d.rating,
    genres: d.genres,
    description: d.description,
    runtime: d.runtime,
  };
}
