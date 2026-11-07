// Fábricas de rutas: cada una describe una vista con sus parámetros.
import type { Kind, Source } from "./api";
import type { WatchContext } from "./data";
import type { Route } from "./router";
import { browseView } from "./views/browse";
import { detailView } from "./views/detail";
import { downloadsView } from "./views/downloads";
import { homeView } from "./views/home";
import { listView } from "./views/list";
import { playerView } from "./views/player";
import { searchView } from "./views/search";
import { settingsView } from "./views/settings";
import { sourcesView } from "./views/sources";

export const homeRoute = (): Route => ({ key: "home", section: "home", render: (root, ctx) => homeView(root, ctx) });

export const browseRoute = (kind: Kind): Route => ({
  key: `browse:${kind}`,
  section: kind === "movie" ? "movies" : "series",
  render: (root, ctx) => browseView(root, ctx, kind),
});

export const searchRoute = (query: string): Route => ({
  key: `search:${query}`,
  section: "search",
  render: (root, ctx) => searchView(root, ctx, query),
});

/** `season`: temporada que se abre de entrada en una serie. */
export const detailRoute = (kind: Kind, id: string, season?: number): Route => ({
  key: `detail:${id}`,
  section: "detail",
  render: (root, ctx) => detailView(root, ctx, kind, id, season),
});

/** Lista de torrents de una película o un episodio. */
export const sourcesRoute = (watch: WatchContext): Route => ({
  key: `sources:${watch.id}:${watch.season ?? ""}:${watch.episode ?? ""}`,
  section: "sources",
  render: (root, ctx) => sourcesView(root, ctx, watch),
});

/**
 * Reproductor. Sin `source` busca la mejor fuente y empieza sola (botón "Ver ahora");
 * `watch` es null cuando se abre un torrent suelto desde la búsqueda libre.
 */
export const playerRoute = (watch: WatchContext | null, source: Source | null, resumeAt = 0): Route => ({
  key: `player:${source?.infoHash ?? "auto"}:${watch?.id ?? ""}:${watch?.season ?? ""}:${watch?.episode ?? ""}`,
  section: "player",
  render: (root, ctx) => playerView(root, ctx, watch, source, resumeAt),
});

export const listRoute = (): Route => ({ key: "list", section: "list", render: (root, ctx) => listView(root, ctx) });

export const downloadsRoute = (): Route => ({
  key: "downloads",
  section: "downloads",
  render: (root, ctx) => downloadsView(root, ctx),
});

export const settingsRoute = (): Route => ({
  key: "settings",
  section: "settings",
  render: (root, ctx) => settingsView(root, ctx),
});
