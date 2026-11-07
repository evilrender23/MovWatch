// Contrato entre la interfaz y el backend en Rust (src-tauri/src/commands.rs).
// Todos los comandos rechazan la promesa con un mensaje de error en español (string).
import { invoke } from "@tauri-apps/api/core";

export type Kind = "movie" | "series";

/** Película o serie del catálogo (Cinemeta, por IMDb). */
export interface Card {
  id: string;
  kind: Kind;
  name: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  year: string | null;
  rating: string | null;
  genres: string[];
  description: string | null;
  runtime: string | null;
}

export interface Video {
  /** `tt0944947:1:2` */
  id: string;
  season: number;
  episode: number;
  name: string;
  overview: string | null;
  thumbnail: string | null;
  released: string | null;
}

export interface Detail extends Card {
  cast: string[];
  director: string[];
  writer: string[];
  country: string | null;
  released: string | null;
  awards: string | null;
  status: string | null;
  trailers: string[];
  videos: Video[];
}

export type CatalogId = "top" | "imdbRating" | "year";

// ---- Torrents (los "providers" de torrodle) ----

export type Category = "all" | "movie" | "tv" | "anime";
export type SortBy = "smart" | "seeders" | "leechers" | "size";

export interface TorrentQuery {
  text: string;
  category: Category;
  imdb?: string | null;
  year?: string | null;
  season?: number | null;
  episode?: number | null;
  providers?: string[];
  sort?: SortBy;
  /** Idioma de audio preferido (ISO 639-2); "" = sin preferencia. */
  audioLang?: string;
}

export interface Source {
  provider: string;
  title: string;
  infoHash: string;
  magnet: string;
  seeders: number;
  leechers: number;
  size: number;
  url: string | null;
  quality: string | null;
  tags: string[];
  /** Idiomas de audio indicados en el nombre (ISO 639-2). */
  languages: string[];
  multi: boolean;
  uploaded: number | null;
  score: number;
}

export interface ProviderStatus {
  name: string;
  count: number;
  error: string | null;
  millis: number;
}

export interface SearchResult {
  sources: Source[];
  providers: ProviderStatus[];
}

export interface ProviderInfo {
  name: string;
  site: string;
  categories: Category[];
  description: string;
}

export interface TorrentFile {
  index: number;
  name: string;
  size: number;
  video: boolean;
}

export interface Playback {
  id: number;
  infoHash: string;
  name: string;
  files: TorrentFile[];
  file: number;
  /** URL local (http://127.0.0.1:PUERTO/stream/…) con soporte de rangos. */
  url: string;
}

export interface TorrentStatus {
  id: number;
  name: string;
  title: string;
  infoHash: string;
  state: "initializing" | "live" | "paused" | "error";
  error: string | null;
  file: number;
  fileName: string;
  downloaded: number;
  total: number;
  downSpeed: number;
  upSpeed: number;
  uploaded: number;
  peers: number;
  seeders: number;
  seenPeers: number;
  eta: number | null;
  finished: boolean;
  folder: string;
}

export interface Track {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  channels: number | null;
  default: boolean;
}

export interface Probe {
  duration: number | null;
  container: string;
  videoCodec: string | null;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  audio: Track[];
  subtitles: Track[];
  direct: boolean;
  transcodeVideo: boolean;
}

export interface Subtitle {
  id: string;
  lang: string;
  language: string;
  url: string;
  release: string | null;
  hearingImpaired: boolean;
}

// ---- Ajustes, progreso y lista ----

export type PlayerKind = "builtin" | "mpv" | "vlc";
export type ExternalPlayer = "mpv" | "vlc";

export interface Settings {
  player: PlayerKind;
  mpvPath: string | null;
  vlcPath: string | null;
  ffmpegPath: string | null;
  downloadDir: string | null;
  keepFiles: boolean;
  disabledProviders: string[];
  subtitleLang: string;
  /** Idioma del audio (ISO 639-2: "spa", "fre"…); "" = versión original. */
  audioLang: string;
  /** Mostrar y reproducir sólo fuentes con audio en `audioLang`. */
  onlyAudioLang: boolean;
  autoNext: boolean;
  autoUpdate: boolean;
}

export interface DetectedPlayers {
  mpv: string | null;
  vlc: string | null;
}

export interface Tools {
  ffmpeg: string | null;
  ffprobe: string | null;
}

export interface WatchEntry {
  id: string;
  kind: Kind;
  title: string;
  poster: string | null;
  background: string | null;
  videoId: string;
  season: number | null;
  episode: number | null;
  episodeName: string | null;
  position: number;
  duration: number;
  watched: string[];
  updatedAt: number;
}

export type ProgressUpdate = Omit<WatchEntry, "watched" | "updatedAt">;

export type ListStatus = "watching" | "completed" | "on_hold" | "dropped" | "plan_to_watch";

export interface ListEntry {
  id: string;
  kind: Kind;
  title: string;
  poster: string | null;
  year: string | null;
  status: ListStatus;
  score: number | null;
  notes: string;
  addedAt: number;
  updatedAt: number;
}

export type ListUpdate = Omit<ListEntry, "addedAt" | "updatedAt">;

// ---- Eventos en `window` ----

/** Cambió "Continuar viendo". */
export const HISTORY_EVENT = "mw:history-changed";
/** Cambió la lista personal. */
export const LIST_EVENT = "mw:list-changed";
/** Se abrió o cerró un torrent. */
export const TORRENTS_EVENT = "mw:torrents-changed";
const emit = (name: string) => window.dispatchEvent(new Event(name));

// ---- Llamadas ----

export const catalog = (kind: Kind, id: CatalogId, genre?: string | null, skip = 0) =>
  invoke<Card[]>("catalog", { kind, id, genre: genre ?? null, skip });
export const searchTitles = (query: string) => invoke<{ movies: Card[]; series: Card[] }>("search_titles", { query });
export const titleDetail = (kind: Kind, id: string) => invoke<Detail>("title_detail", { kind, id });

export const providersList = () => invoke<ProviderInfo[]>("providers_list");
export interface Language {
  code: string;
  name: string;
}
export const audioLanguages = () => invoke<Language[]>("audio_languages");
/** ¿Hay torrents con audio en `lang` para este título? */
export const hasLanguage = (card: Pick<Card, "id" | "kind" | "name" | "year">, lang: string) =>
  invoke<boolean>("has_language", { id: card.id, kind: card.kind, title: card.name, year: card.year, lang });
export const searchTorrents = (query: TorrentQuery) => invoke<SearchResult>("search_torrents", { query });
export const torrentOpen = async (
  magnet: string,
  title: string,
  season?: number | null,
  episode?: number | null,
  file?: number | null,
) => {
  const p = await invoke<Playback>("torrent_open", { magnet, title, season: season ?? null, episode: episode ?? null, file: file ?? null });
  emit(TORRENTS_EVENT);
  return p;
};
export const torrentStatus = (id: number) => invoke<TorrentStatus | null>("torrent_status", { id });
export const torrentList = () => invoke<TorrentStatus[]>("torrent_list");
export const torrentPause = (id: number, paused: boolean) => invoke<void>("torrent_pause", { id, paused });
export const torrentClose = async (id: number, deleteFiles?: boolean) => {
  await invoke<void>("torrent_close", { id, deleteFiles: deleteFiles ?? null });
  emit(TORRENTS_EVENT);
};
export const torrentReveal = (id: number, file: number) => invoke<string>("torrent_reveal", { id, file });

export const detectTools = () => invoke<Tools>("detect_tools");
export const mediaProbe = (id: number, file: number) => invoke<Probe | null>("media_probe", { id, file });
export const mediaRemux = (req: { id: number; file: number; start: number; audio: number; transcodeVideo: boolean; hevc: boolean }) =>
  invoke<string>("media_remux", { req });
export const mediaStop = () => invoke<void>("media_stop");

export const subtitlesList = (videoId: string) => invoke<Subtitle[]>("subtitles_list", { videoId });
export const subtitleVtt = (url: string) => invoke<string>("subtitle_vtt", { url });

export const playExternal = (url: string, title: string, player: ExternalPlayer, subtitleUrl?: string | null) =>
  invoke<string>("play_external", { url, title, player, subtitleUrl: subtitleUrl ?? null });
export const detectPlayers = () => invoke<DetectedPlayers>("detect_players");

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<void>("save_settings", { settings });
export const downloadDir = () => invoke<string>("download_dir");

export const historyList = () => invoke<WatchEntry[]>("history_list");
export const historyProgress = async (update: ProgressUpdate) => {
  const entry = await invoke<WatchEntry>("history_progress", { update });
  emit(HISTORY_EVENT);
  emit(LIST_EVENT);
  return entry;
};
export const historyWatched = async (id: string, videoId: string, watched: boolean) => {
  await invoke<void>("history_watched", { id, videoId, watched });
  emit(HISTORY_EVENT);
};
export const historyRemove = async (id: string) => {
  await invoke<void>("history_remove", { id });
  emit(HISTORY_EVENT);
};

export const listAll = () => invoke<ListEntry[]>("list_all");
export const listSave = async (update: ListUpdate) => {
  const entry = await invoke<ListEntry>("list_save", { update });
  emit(LIST_EVENT);
  return entry;
};
export const listRemove = async (id: string) => {
  await invoke<void>("list_remove", { id });
  emit(LIST_EVENT);
};
