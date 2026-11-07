import * as api from "../api";
import type { Detail, Kind, Video, WatchEntry } from "../api";
import { STATUS_LABEL, STATUS_ORDER, cardMenu, listMenuItems, logoOrTitle, removeFromList, saveStatus, watchOf } from "../cards";
import { copyText, openMenuAt, withMenu } from "../contextmenu";
import { cardFromDetail, episodeLabel, getDetail, loadList } from "../data";
import { router, type ViewContext } from "../router";
import { homeRoute, playerRoute, sourcesRoute } from "../routes";
import { setCrumbs } from "../shell";
import { empty, errMsg, errorBox, fact, h, icon, poster, skeleton, toast } from "../ui";

/** Temporada abierta por serie durante la sesión. */
const openSeason = new Map<string, number>();

export function detailView(root: HTMLElement, ctx: ViewContext, kind: Kind, id: string, season?: number): void {
  const home = { label: "Inicio", onClick: () => router.navigate(homeRoute()) };
  setCrumbs(home, kind === "movie" ? "Película" : "Serie");
  const page = h("div", { class: "page detail-page" });
  root.append(page);
  if (season !== undefined) openSeason.set(id, season);

  const load = async () => {
    page.replaceChildren(skeleton("detail", 1, "Cargando ficha…"));
    try {
      const [detail, history] = await Promise.all([getDetail(kind, id), api.historyList().catch((): WatchEntry[] => [])]);
      if (ctx.signal.aborted) return;
      setCrumbs(home, detail.name);
      render(page, ctx.signal, detail, history.find((e) => e.id === id) ?? null);
    } catch (e) {
      if (!ctx.signal.aborted) page.replaceChildren(errorBox(errMsg(e), () => void load()));
    }
  };
  void load();

  // Al volver del reproductor se actualizan los vistos sin recargar la ficha.
  const onHistory = () => {
    if (!ctx.signal.aborted && page.querySelector(".ep-list")) void load();
  };
  window.addEventListener(api.HISTORY_EVENT, onHistory);
  ctx.signal.addEventListener("abort", () => window.removeEventListener(api.HISTORY_EVENT, onHistory), { once: true });
}

function render(page: HTMLElement, signal: AbortSignal, d: Detail, entry: WatchEntry | null): void {
  const card = cardFromDetail(d);
  const watch = watchOf(card);
  const isSeries = d.kind === "series";
  const episodes = d.videos.filter((v) => v.season > 0);
  const watched = new Set(entry?.watched ?? []);

  // ---- Acción principal ----
  const actions = h("div", { class: "actions" });
  if (!isSeries) {
    const resumeAt = entry && entry.duration > 0 && entry.position / entry.duration < 0.9 ? entry.position : 0;
    actions.append(
      h(
        "button",
        { class: "btn btn-primary btn-lg", onclick: () => router.navigate(playerRoute(watch, null, resumeAt)) },
        icon("play"),
        resumeAt ? `Continuar · ${Math.round((resumeAt / Math.max(1, entry!.duration)) * 100)}%` : "Ver ahora",
      ),
      h("button", { class: "btn btn-lg", onclick: () => router.navigate(sourcesRoute(watch)) }, icon("magnet"), "Elegir fuente"),
    );
  } else {
    const next = nextEpisode(episodes, entry);
    if (next) {
      const ep = next.video;
      const w = { ...watch, season: ep.season, episode: ep.episode, episodeName: ep.name };
      actions.append(
        h(
          "button",
          { class: "btn btn-primary btn-lg", onclick: () => router.navigate(playerRoute(w, null, next.resumeAt)) },
          icon("play"),
          `${next.resumeAt ? "Continuar" : entry ? "Siguiente" : "Empezar"} · ${episodeLabel(ep.season, ep.episode)}`,
        ),
      );
    }
  }
  const listBtn = h("button", { class: "btn btn-lg btn-ghost" }, icon("bookmark"), "Mi lista");
  const syncListBtn = () =>
    loadList().then((list) => {
      const e = list.find((x) => x.id === d.id);
      listBtn.replaceChildren(icon(e ? "check" : "bookmark"), e ? STATUS_LABEL[e.status] : "Mi lista");
      listBtn.classList.toggle("is-on", !!e);
    });
  listBtn.onclick = () => openMenuAt(listBtn, listMenuItems(card));
  withMenu(listBtn, () => listMenuItems(card));
  void syncListBtn();
  const onList = () => void syncListBtn();
  window.addEventListener(api.LIST_EVENT, onList);
  signal.addEventListener("abort", () => window.removeEventListener(api.LIST_EVENT, onList), { once: true });
  actions.append(listBtn);
  if (d.trailers[0]) {
    actions.append(h("button", { class: "btn btn-lg btn-ghost", onclick: () => openTrailer(d.trailers[0], d.name) }, icon("film"), "Tráiler"));
  }

  // ---- Cabecera a sangre ----
  const meta = [
    d.rating ? h("span", { class: "hero-rating" }, icon("star"), d.rating) : null,
    d.year ? h("span", null, d.year) : null,
    d.runtime ? h("span", null, d.runtime) : null,
    isSeries && d.status ? h("span", { class: /continuing|returning/i.test(d.status) ? "status status-live" : "status" }, /continuing|returning/i.test(d.status) ? h("i", { class: "live-dot" }) : null, translateStatus(d.status)) : null,
    isSeries ? h("span", null, `${new Set(episodes.map((e) => e.season)).size} temporadas`) : null,
  ].filter(Boolean) as HTMLElement[];

  const titleEl = logoOrTitle(d.logo, d.name);

  const head = h(
    "section",
    { class: "title-hero" },
    poster(d.background ?? d.poster, d.name, "hero-bg"),
    h("div", { class: "hero-shade" }),
    h(
      "div",
      { class: "title-hero-body" },
      poster(d.poster, d.name, "ratio-poster title-poster"),
      h(
        "div",
        { class: "hero-content" },
        h("p", { class: "eyebrow" }, isSeries ? "Serie" : "Película", d.genres.length ? h("span", { class: "eyebrow-dim" }, d.genres.slice(0, 3).join(" · ")) : null),
        titleEl,
        h("div", { class: "hero-meta" }, meta),
        d.description ? h("p", { class: "lede hero-lede" }, d.description) : null,
        actions,
      ),
    ),
  );
  withMenu(head, () => cardMenu(card));

  // ---- Ficha técnica ----
  const credits = h(
    "dl",
    { class: "spec spec-grid" },
    d.director.length ? fact("Dirección", d.director.join(", ")) : null,
    d.writer.length ? fact("Guion", d.writer.slice(0, 3).join(", ")) : null,
    d.cast.length ? fact("Reparto", d.cast.slice(0, 6).join(", ")) : null,
    d.country ? fact("País", d.country) : null,
    d.released ? fact("Estreno", new Date(d.released).toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" })) : null,
    d.awards ? fact("Premios", d.awards) : null,
    fact("IMDb", h("button", { class: "link", onclick: () => copyText(`https://www.imdb.com/title/${d.id}/`) }, d.id)),
  );

  page.replaceChildren(head, h("div", { class: "detail-body" }, isSeries ? episodesSection(d, episodes, watched, entry) : null, h("section", { class: "block" }, h("header", { class: "rule" }, h("h2", { class: "rule-title" }, "Ficha"), h("span", { class: "rule-line" })), credits), listQuick(card)));
}

/** Siguiente episodio: el que se dejó a medias o el siguiente al último visto. */
function nextEpisode(eps: Video[], entry: WatchEntry | null): { video: Video; resumeAt: number } | null {
  if (!eps.length) return null;
  if (!entry || entry.season === null || entry.episode === null) return { video: eps[0], resumeAt: 0 };
  const i = eps.findIndex((v) => v.season === entry.season && v.episode === entry.episode);
  if (i < 0) return { video: eps[0], resumeAt: 0 };
  const done = entry.duration > 0 && entry.position / entry.duration >= 0.9;
  if (!done) return { video: eps[i], resumeAt: entry.position };
  return eps[i + 1] ? { video: eps[i + 1], resumeAt: 0 } : { video: eps[i], resumeAt: 0 };
}

function translateStatus(s: string): string {
  if (/ended/i.test(s)) return "Finalizada";
  if (/continuing|returning/i.test(s)) return "En emisión";
  if (/cancel/i.test(s)) return "Cancelada";
  return s;
}

function episodesSection(d: Detail, eps: Video[], watched: Set<string>, entry: WatchEntry | null): HTMLElement {
  const seasons = [...new Set(eps.map((e) => e.season))].sort((a, b) => a - b);
  if (!seasons.length) return h("section", { class: "block" }, empty("Todavía no hay episodios publicados."));
  let current = openSeason.get(d.id) ?? entry?.season ?? seasons[0];
  if (!seasons.includes(current)) current = seasons[0];
  const list = h("div", { class: "ep-list" });
  const tabs = h("div", { class: "seg seg-scroll", role: "tablist" });
  const count = h("span", { class: "rule-count" });
  const card = cardFromDetail(d);

  const render = () => {
    openSeason.set(d.id, current);
    tabs.replaceChildren(
      ...seasons.map((s) => {
        const seasonEps = eps.filter((e) => e.season === s);
        const done = seasonEps.length > 0 && seasonEps.every((e) => watched.has(e.id));
        return h(
          "button",
          {
            class: s === current ? "seg-btn active" : "seg-btn",
            role: "tab",
            onclick: () => {
              current = s;
              render();
            },
          },
          `T${s}`,
          done ? icon("check", "icon seg-check") : null,
        );
      }),
    );
    const seasonEps = eps.filter((e) => e.season === current);
    count.textContent = String(seasonEps.length);
    const now = Date.now();
    list.replaceChildren(
      ...seasonEps.map((v, i) => {
        const w = { ...watchOf(card), season: v.season, episode: v.episode, episodeName: v.name };
        const isLast = entry?.season === v.season && entry?.episode === v.episode;
        const seen = watched.has(v.id);
        const future = v.released ? new Date(v.released).getTime() > now : false;
        const p = isLast && entry && entry.duration > 0 ? entry.position / entry.duration : seen ? 1 : 0;
        const row = h(
          "button",
          {
            class: ["ep-row", seen ? "watched" : "", isLast ? "last" : "", future ? "future" : ""].filter(Boolean).join(" "),
            style: `--i:${Math.min(i, 20)}`,
            disabled: future,
            onclick: () => router.navigate(playerRoute(w, null, isLast && entry && p < 0.9 ? entry.position : 0)),
          },
          h(
            "div",
            { class: "ep-thumb" },
            poster(v.thumbnail, v.name, "ratio-wide"),
            h("span", { class: "tile-play" }, icon("play")),
            p > 0 ? h("span", { class: "tile-progress" }, h("i", { style: `--p:${p}` })) : null,
          ),
          h(
            "div",
            { class: "ep-text" },
            h(
              "div",
              { class: "ep-line" },
              h("span", { class: "ep-n" }, String(v.episode).padStart(2, "0")),
              h("span", { class: "ep-name" }, v.name),
              seen ? icon("check", "icon ep-seen") : null,
            ),
            v.overview ? h("p", { class: "ep-overview" }, v.overview) : null,
            h(
              "span",
              { class: "ep-date" },
              v.released ? (future ? "Se estrena el " : "") + new Date(v.released).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }) : "",
            ),
          ),
        );
        return withMenu(row, () => [
          { label: `Ver ${episodeLabel(v.season, v.episode)}`, icon: "play", disabled: future, run: () => router.navigate(playerRoute(w, null)) },
          { label: "Elegir fuente…", icon: "magnet", disabled: future, run: () => router.navigate(sourcesRoute(w)) },
          "-",
          {
            label: seen ? "Marcar como no visto" : "Marcar como visto",
            icon: "check",
            disabled: !entry,
            run: async () => {
              try {
                await api.historyWatched(d.id, v.id, !seen);
              } catch (e) {
                toast(errMsg(e), "error");
              }
            },
          },
          { label: "Copiar título del episodio", icon: "copy", run: () => copyText(`${d.name} ${episodeLabel(v.season, v.episode)} ${v.name}`) },
        ]);
      }),
    );
  };
  render();

  return h(
    "section",
    { class: "block episodes" },
    h("header", { class: "rule" }, h("h2", { class: "rule-title" }, "Episodios"), count, h("span", { class: "rule-line" }), tabs),
    list,
  );
}

/** Estado en la lista personal, editable sin abrir menús. */
function listQuick(card: api.Card): HTMLElement {
  const host = h("section", { class: "block" });
  const render = async () => {
    const list = await loadList().catch(() => []);
    const e = list.find((x) => x.id === card.id) ?? null;
    host.replaceChildren(
      h("header", { class: "rule" }, h("h2", { class: "rule-title" }, "Mi lista"), h("span", { class: "rule-line" })),
      h(
        "div",
        { class: "chips" },
        ...STATUS_ORDER.map((st) =>
          h(
            "button",
            { class: `chip st-${st}${e?.status === st ? " active" : ""}`, onclick: () => void saveStatus(card, st, e) },
            h("i", { class: "dot" }),
            STATUS_LABEL[st],
          ),
        ),
        e ? h("button", { class: "chip", onclick: () => void removeFromList(card.id, card.name) }, icon("x"), "Quitar") : null,
      ),
    );
  };
  void render();
  window.addEventListener(api.LIST_EVENT, () => {
    if (host.isConnected) void render();
  });
  return host;
}

function openTrailer(youtubeId: string, title: string): void {
  const close = () => {
    backdrop.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const frame = h("iframe", {
    class: "trailer-frame",
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?autoplay=1&rel=0`,
    title: `Tráiler de ${title}`,
    allow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
    referrerPolicy: "strict-origin-when-cross-origin",
  });
  frame.setAttribute("allowfullscreen", "");
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onclick: (e: MouseEvent) => e.target === backdrop && close() },
    h("div", { class: "trailer" }, h("button", { class: "icon-btn trailer-close", attrs: { "aria-label": "Cerrar" }, onclick: close }, icon("x")), frame),
  );
  window.addEventListener("keydown", onKey, true);
  document.body.append(backdrop);
}
