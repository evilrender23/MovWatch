// Piezas compartidas por las vistas: mosaicos de títulos, estanterías con desplazamiento
// horizontal y las opciones de "Mi lista" en menús contextuales.
import * as api from "./api";
import type { Card, ListEntry, ListStatus, WatchEntry } from "./api";
import { copyText, withMenu, type MenuItem } from "./contextmenu";
import { loadList, peekList, type WatchContext } from "./data";
import { router } from "./router";
import { detailRoute, playerRoute, sourcesRoute } from "./routes";
import { errMsg, h, icon, poster, toast } from "./ui";

export const STATUS_LABEL: Record<ListStatus, string> = {
  watching: "Viendo",
  completed: "Completada",
  on_hold: "En pausa",
  dropped: "Abandonada",
  plan_to_watch: "Pendiente",
};
export const STATUS_ORDER: ListStatus[] = ["watching", "plan_to_watch", "completed", "on_hold", "dropped"];

export const kindLabel = (k: Card["kind"]) => (k === "movie" ? "Película" : "Serie");

export function watchOf(card: Card, extra: Partial<WatchContext> = {}): WatchContext {
  return {
    id: card.id,
    kind: card.kind,
    title: card.name,
    poster: card.poster,
    background: card.background,
    year: card.year,
    season: null,
    episode: null,
    episodeName: null,
    ...extra,
  };
}

/** Mosaico de póster con título, año y nota. */
export function titleTile(card: Card, index = 0, opts: { progress?: number; badge?: string } = {}): HTMLElement {
  const meta = [card.year, card.kind === "series" ? "Serie" : null].filter(Boolean).join(" · ");
  const media = h(
    "div",
    { class: "tile-media" },
    poster(card.poster, card.name, "ratio-poster"),
    card.rating ? h("span", { class: "tile-rating" }, icon("star"), card.rating) : null,
    opts.badge ? h("span", { class: "tile-badge" }, opts.badge) : null,
    opts.progress !== undefined
      ? h("span", { class: "tile-progress" }, h("i", { style: `--p:${Math.max(0.02, Math.min(1, opts.progress))}` }))
      : null,
  );
  const tile = h(
    "button",
    {
      class: "tile",
      style: `--i:${Math.min(index, 18)}`,
      attrs: { "aria-label": card.name },
      onclick: () => router.navigate(detailRoute(card.kind, card.id)),
    },
    media,
    h(
      "div",
      { class: "tile-caption tile-caption-stack" },
      h("span", { class: "tile-title" }, card.name),
      meta ? h("span", { class: "tile-meta" }, meta) : null,
    ),
  );
  return withMenu(tile, () => cardMenu(card));
}

export function cardMenu(card: Card): MenuItem[] {
  return [
    { label: "Ver ficha", icon: "info", run: () => router.navigate(detailRoute(card.kind, card.id)) },
    ...(card.kind === "movie"
      ? ([
          { label: "Ver ahora", icon: "play", run: () => router.navigate(playerRoute(watchOf(card), null)) },
          { label: "Elegir fuente…", icon: "magnet", run: () => router.navigate(sourcesRoute(watchOf(card))) },
        ] as MenuItem[])
      : []),
    "-",
    ...listMenuItems(card),
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(card.name) },
    { label: "Copiar IMDb", icon: "link", run: () => copyText(`https://www.imdb.com/title/${card.id}/`) },
  ];
}

/** Opciones de "Mi lista" para un título (estado actual marcado). */
export function listMenuItems(card: Pick<Card, "id" | "kind" | "name" | "poster" | "year">): MenuItem[] {
  const entry = peekList()?.find((e) => e.id === card.id) ?? null;
  void loadList();
  const items: MenuItem[] = [{ title: entry ? "En mi lista" : "Añadir a mi lista" }];
  for (const st of STATUS_ORDER) {
    items.push({
      label: STATUS_LABEL[st],
      checked: entry?.status === st,
      run: () => saveStatus(card, st, entry),
    });
  }
  if (entry) items.push({ label: "Quitar de mi lista", icon: "trash", danger: true, run: () => removeFromList(card.id, card.name) });
  return items;
}

export async function saveStatus(
  card: Pick<Card, "id" | "kind" | "name" | "poster" | "year">,
  status: ListStatus,
  entry: ListEntry | null = peekList()?.find((e) => e.id === card.id) ?? null,
): Promise<void> {
  try {
    await api.listSave({
      id: card.id,
      kind: card.kind,
      title: card.name,
      poster: card.poster,
      year: card.year,
      status,
      score: entry?.score ?? null,
      notes: entry?.notes ?? "",
    });
    toast(`«${card.name}»: ${STATUS_LABEL[status]}.`, "ok");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function removeFromList(id: string, name: string): Promise<void> {
  try {
    await api.listRemove(id);
    toast(`«${name}» ya no está en tu lista.`, "ok");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Mosaico ancho de "Continuar viendo" (fondo + barra de progreso). */
export function resumeTile(entry: WatchEntry, index = 0): HTMLElement {
  const p = entry.duration > 0 ? entry.position / entry.duration : 0;
  const sub =
    entry.season !== null && entry.episode !== null
      ? `T${entry.season} · E${entry.episode}${entry.episodeName ? ` · ${entry.episodeName}` : ""}`
      : entry.duration > 0
        ? `Quedan ${Math.max(1, Math.round((entry.duration - entry.position) / 60))} min`
        : "Película";
  const watch: WatchContext = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    poster: entry.poster,
    background: entry.background,
    year: null,
    season: entry.season,
    episode: entry.episode,
    episodeName: entry.episodeName,
  };
  const tile = h(
    "button",
    {
      class: "tile tile-wide",
      style: `--i:${Math.min(index, 18)}`,
      onclick: () => router.navigate(playerRoute(watch, null, entry.position)),
    },
    h(
      "div",
      { class: "tile-media" },
      poster(entry.background ?? entry.poster, entry.title, "ratio-wide"),
      h("span", { class: "tile-play" }, icon("play")),
      h("span", { class: "tile-progress" }, h("i", { style: `--p:${Math.max(0.02, Math.min(1, p))}` })),
    ),
    h("div", { class: "tile-caption tile-caption-stack" }, h("span", { class: "tile-title" }, entry.title), h("span", { class: "tile-meta" }, sub)),
  );
  return withMenu(tile, () => [
    { label: "Continuar", icon: "play", run: () => router.navigate(playerRoute(watch, null, entry.position)) },
    { label: "Empezar desde el principio", icon: "replay", run: () => router.navigate(playerRoute(watch, null, 0)) },
    { label: "Elegir otra fuente…", icon: "magnet", run: () => router.navigate(sourcesRoute(watch)) },
    { label: "Ver ficha", icon: "info", run: () => router.navigate(detailRoute(entry.kind, entry.id, entry.season ?? undefined)) },
    "-",
    { label: "Quitar de Continuar viendo", icon: "x", danger: true, run: () => api.historyRemove(entry.id) },
  ]);
}

/** Logo del título (imagen) o, si no hay o falla, el nombre en grande. */
export function logoOrTitle(logo: string | null, name: string): HTMLElement {
  const title = () => h("h1", { class: "display hero-title" }, name);
  if (!logo) return title();
  const img = h("img", { class: "hero-logo", src: logo, alt: name, referrerPolicy: "no-referrer" });
  img.addEventListener("error", () => img.replaceWith(title()), { once: true });
  return img;
}

/** Estantería horizontal con título, contador y flechas. */
export function shelf(title: string, items: HTMLElement[], opts: { note?: string; action?: HTMLElement; wide?: boolean } = {}): HTMLElement {
  const track = h("div", { class: `shelf-track${opts.wide ? " shelf-wide" : ""}` }, items);
  const scroll = (dir: number) => track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: "smooth" });
  const prev = h("button", { class: "icon-btn", attrs: { "aria-label": "Anterior" }, onclick: () => scroll(-1) }, icon("back"));
  const next = h("button", { class: "icon-btn", attrs: { "aria-label": "Siguiente" }, onclick: () => scroll(1) }, icon("next"));
  const sync = () => {
    prev.disabled = track.scrollLeft < 4;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
  };
  track.addEventListener("scroll", sync, { passive: true });
  requestAnimationFrame(sync);
  return h(
    "section",
    { class: "block shelf" },
    h(
      "header",
      { class: "rule" },
      h("h2", { class: "rule-title" }, title),
      h("span", { class: "rule-count" }, String(items.length)),
      h("span", { class: "rule-line", attrs: { "aria-hidden": "true" } }),
      opts.note ? h("span", { class: "rule-note" }, opts.note) : null,
      opts.action ?? null,
      h("div", { class: "rule-tools" }, prev, next),
    ),
    track,
  );
}
