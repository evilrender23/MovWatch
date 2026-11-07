import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { SearchResult, Source, SortBy, TorrentQuery } from "../api";
import { copyText, withMenu } from "../contextmenu";
import { episodeLabel, getTorrents, queryFor, rememberSource, type WatchContext } from "../data";
import { router, type ViewContext } from "../router";
import { detailRoute, homeRoute, playerRoute } from "../routes";
import { setCrumbs } from "../shell";
import { empty, errMsg, errorBox, fmtBytes, h, icon, poster, relativeTime, skeleton, toast } from "../ui";

const QUALITIES = ["2160p", "1080p", "720p", "480p"] as const;

/** Filtros recordados durante la sesión. */
const filters = { sort: "smart" as SortBy, quality: null as string | null, spanish: false, hideCam: true };

export function sourcesView(root: HTMLElement, ctx: ViewContext, watch: WatchContext): void {
  const home = { label: "Inicio", onClick: () => router.navigate(homeRoute()) };
  const titleCrumb = { label: watch.title, onClick: () => router.navigate(detailRoute(watch.kind, watch.id, watch.season ?? undefined)) };
  setCrumbs(home, titleCrumb, "Fuentes");
  const sub = watch.season !== null && watch.episode !== null ? `${episodeLabel(watch.season, watch.episode)}${watch.episodeName ? ` · ${watch.episodeName}` : ""}` : watch.year;
  const host = h("div");
  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "sources-head" },
        poster(watch.poster, watch.title, "ratio-poster sources-poster"),
        h(
          "div",
          { class: "page-head-text" },
          h("p", { class: "eyebrow" }, "Elegir fuente"),
          h("h1", { class: "display" }, watch.title),
          sub ? h("p", { class: "alt-title" }, sub) : null,
        ),
      ),
      host,
    ),
  );
  api.getSettings().then(
    (s) => {
      if (ctx.signal.aborted) return;
      host.append(sourcesTable(ctx.signal, queryFor(watch, s.preferSpanish), watch));
    },
    (e: unknown) => host.append(errorBox(errMsg(e))),
  );
}

/**
 * Tabla de torrents con filtros y estado de cada proveedor. `watch` = null en la búsqueda libre:
 * al reproducir se usa el nombre del torrent como título.
 */
export function sourcesTable(signal: AbortSignal, query: TorrentQuery, watch: WatchContext | null): HTMLElement {
  const box = h("div", { class: "sources" });
  const toolbar = h("div", { class: "src-toolbar" });
  const providersBar = h("div", { class: "src-providers" });
  const list = h("div", { class: "src-list", role: "list" });
  let result: SearchResult | null = null;

  const play = (s: Source) => {
    if (watch) rememberSource(`${watch.id}:${watch.season ?? ""}:${watch.episode ?? ""}`, s);
    router.navigate(playerRoute(watch, s));
  };

  const renderToolbar = () => {
    const seg = (items: [string | null, string][], current: string | null, set: (v: string | null) => void) =>
      h(
        "div",
        { class: "seg seg-sm" },
        ...items.map(([v, text]) =>
          h(
            "button",
            {
              class: current === v ? "seg-btn active" : "seg-btn",
              onclick: () => {
                set(v);
                renderToolbar();
                renderList();
              },
            },
            text,
          ),
        ),
      );
    const toggle = (label: string, on: boolean, set: (v: boolean) => void) =>
      h(
        "button",
        {
          class: on ? "chip active" : "chip",
          attrs: { "aria-pressed": String(on) },
          onclick: () => {
            set(!on);
            renderToolbar();
            renderList();
          },
        },
        on ? icon("check") : null,
        label,
      );
    toolbar.replaceChildren(
      seg([[null, "Todas"], ...QUALITIES.map((q): [string, string] => [q, q === "2160p" ? "4K" : q])], filters.quality, (v) => (filters.quality = v)),
      seg(
        [
          ["smart", "Recomendadas"],
          ["seeders", "Semillas"],
          ["size", "Tamaño"],
        ],
        filters.sort,
        (v) => (filters.sort = (v ?? "smart") as SortBy),
      ),
      h("span", { class: "src-spacer" }),
      toggle("Audio en español", filters.spanish, (v) => (filters.spanish = v)),
      toggle("Ocultar CAM/TS", filters.hideCam, (v) => (filters.hideCam = v)),
      h(
        "button",
        { class: "icon-btn", attrs: { "aria-label": "Volver a buscar" }, title: "Volver a buscar", onclick: () => void load(true) },
        icon("replay"),
      ),
    );
  };

  const visible = (): Source[] => {
    if (!result) return [];
    let out = result.sources.filter((s) => {
      if (filters.quality && s.quality !== filters.quality) return false;
      if (filters.spanish && !s.tags.some((t) => t === "Español" || t === "Latino" || t === "Dual")) return false;
      if (filters.hideCam && s.tags.some((t) => t === "CAM" || t === "TS")) return false;
      return true;
    });
    out = [...out];
    if (filters.sort === "seeders") out.sort((a, b) => b.seeders - a.seeders);
    else if (filters.sort === "size") out.sort((a, b) => b.size - a.size);
    else out.sort((a, b) => b.score - a.score);
    return out;
  };

  const renderProviders = () => {
    if (!result) return;
    providersBar.replaceChildren(
      h("span", { class: "filters-label" }, "Proveedores"),
      ...result.providers.map((p) =>
        h(
          "span",
          { class: p.error ? "prov prov-error" : "prov", title: p.error ?? `${p.count} resultados en ${(p.millis / 1000).toFixed(1)} s` },
          h("i", { class: "prov-dot" }),
          p.name,
          h("span", { class: "prov-count" }, p.error ? "error" : String(p.count)),
        ),
      ),
    );
  };

  const renderList = () => {
    const items = visible();
    if (!result) return;
    if (!items.length) {
      list.replaceChildren(
        empty(
          result.sources.length ? "Ninguna fuente coincide con los filtros." : "No se encontraron torrents.",
          result.sources.length ? "Quita algún filtro de arriba." : "Prueba más tarde o busca el título original en la búsqueda libre.",
        ),
      );
      return;
    }
    const best = items[0];
    list.replaceChildren(...items.slice(0, 150).map((s, i) => row(s, i, s === best && filters.sort === "smart")));
  };

  const row = (s: Source, i: number, recommended: boolean) => {
    const health = s.seeders >= 50 ? "good" : s.seeders >= 10 ? "ok" : "low";
    const el = h(
      "button",
      { class: "src-row", role: "listitem", style: `--i:${Math.min(i, 20)}`, onclick: () => play(s) },
      h("span", { class: `src-q q-${(s.quality ?? "sd").toLowerCase()}` }, s.quality === "2160p" ? "4K" : (s.quality ?? "SD")),
      h(
        "span",
        { class: "src-main" },
        h("span", { class: "src-title" }, recommended ? h("span", { class: "src-best" }, icon("bolt"), "Recomendada") : null, s.title),
        h(
          "span",
          { class: "src-tags" },
          ...s.tags.filter((t) => t !== "MP4" || s.provider.includes("YTS")).slice(0, 6).map((t) => h("span", { class: `tag${t === "Español" || t === "Latino" || t === "Dual" ? " tag-es" : t === "CAM" || t === "TS" ? " tag-bad" : ""}` }, t)),
          h("span", { class: "src-provider" }, s.provider),
          s.uploaded ? h("span", { class: "src-date" }, relativeTime(s.uploaded * 1000)) : null,
        ),
      ),
      h("span", { class: "src-size" }, fmtBytes(s.size)),
      h("span", { class: `src-peers health-${health}` }, h("i", { class: "health-dot" }), h("b", null, String(s.seeders)), h("span", null, ` / ${s.leechers}`)),
      h("span", { class: "src-play" }, icon("play")),
    );
    return withMenu(el, () => [
      { label: "Reproducir", icon: "play", run: () => play(s) },
      "-",
      { label: "Copiar magnet", icon: "magnet", run: () => copyText(s.magnet) },
      { label: "Copiar info-hash", icon: "copy", run: () => copyText(s.infoHash) },
      { label: "Abrir página del torrent", icon: "external", disabled: !s.url, run: () => void (s.url && openUrl(s.url).catch((e: unknown) => toast(errMsg(e), "error"))) },
      { label: "Abrir en otra app de torrents", icon: "external", run: () => openUrl(s.magnet).catch((e: unknown) => toast(errMsg(e), "error")) },
    ]);
  };

  const load = async (refresh = false) => {
    list.replaceChildren(skeleton("panels", 6, "Buscando en los proveedores…"));
    providersBar.replaceChildren(h("span", { class: "filters-label" }, "Buscando en YTS, The Pirate Bay, EZTV, Knaben…"));
    try {
      result = await getTorrents({ ...query, sort: "smart" }, refresh);
      if (signal.aborted) return;
      if (filters.spanish && !result.sources.some((s) => s.tags.includes("Español"))) filters.spanish = false;
      renderToolbar();
      renderProviders();
      renderList();
    } catch (e) {
      if (!signal.aborted) list.replaceChildren(errorBox(errMsg(e), () => void load(true)));
    }
  };

  renderToolbar();
  box.append(toolbar, providersBar, h("div", { class: "src-head" }, h("span", null, "Calidad"), h("span", null, "Torrent"), h("span", null, "Tamaño"), h("span", null, "Semillas / pares"), h("span")), list);
  void load();
  return box;
}

/** Elige la mejor fuente automáticamente (botón "Ver ahora"). */
export async function bestSource(watch: WatchContext, preferSpanish: boolean): Promise<Source> {
  const res = await getTorrents({ ...queryFor(watch, preferSpanish), sort: "smart" });
  const ok = res.sources.filter((s) => !s.tags.some((t) => t === "CAM" || t === "TS") && s.seeders >= 3);
  const pick = ok[0] ?? res.sources[0];
  if (!pick) {
    const failed = res.providers.filter((p) => p.error).map((p) => p.name);
    throw new Error(
      failed.length === res.providers.length
        ? "Ningún proveedor respondió. Comprueba tu conexión."
        : "No se encontraron torrents para este título.",
    );
  }
  return pick;
}
