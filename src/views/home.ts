import * as api from "../api";
import type { Card, WatchEntry } from "../api";
import { cardMenu, logoOrTitle, resumeTile, shelf, titleTile, watchOf } from "../cards";
import { withMenu } from "../contextmenu";
import { getCatalog } from "../data";
import { router, type ViewContext } from "../router";
import { browseRoute, detailRoute, playerRoute, sourcesRoute } from "../routes";
import { setCrumbs } from "../shell";
import { errorBox, h, icon, poster, skeleton } from "../ui";

/** Cuánto tarda en rotar el destacado. */
const HERO_MS = 9000;

export function homeView(root: HTMLElement, ctx: ViewContext): void {
  const { signal } = ctx;
  setCrumbs("Inicio");

  const hero = h("div", { class: "hero-slot" }, h("div", { class: "hero hero-loading" }));
  const resume = h("div");
  const shelves = h("div", { class: "shelves" }, skeleton("posters", 8, "Cargando catálogo…"));
  root.append(h("div", { class: "page home-page" }, hero, resume, shelves));

  // ---- Continuar viendo ----
  const renderResume = async () => {
    let list: WatchEntry[] = [];
    try {
      list = await api.historyList();
    } catch {
      /* vacío */
    }
    if (signal.aborted) return;
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    resume.replaceChildren(list.length ? shelf("Continuar viendo", list.slice(0, 20).map(resumeTile), { wide: true }) : "");
  };
  void renderResume();
  const onHistory = () => void renderResume();
  window.addEventListener(api.HISTORY_EVENT, onHistory);
  signal.addEventListener("abort", () => window.removeEventListener(api.HISTORY_EVENT, onHistory), { once: true });

  // ---- Catálogos ----
  const load = async () => {
    const year = String(new Date().getFullYear());
    const results = await Promise.allSettled([
      getCatalog("movie", "top"),
      getCatalog("series", "top"),
      getCatalog("movie", "year", year),
      getCatalog("movie", "imdbRating"),
      getCatalog("series", "imdbRating"),
    ]);
    if (signal.aborted) return;
    const [movies, series, fresh, bestMovies, bestSeries] = results.map((r) => (r.status === "fulfilled" ? r.value : []));
    if (!movies.length && !series.length) {
      const err = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      shelves.replaceChildren(errorBox(String(err?.reason ?? "No se pudo cargar el catálogo."), () => void load()));
      hero.replaceChildren();
      return;
    }
    mountHero(hero, signal, [...movies.slice(0, 6), ...series.slice(0, 4)].filter((c) => c.background));
    const more = (kind: Card["kind"]) =>
      h("button", { class: "btn btn-sm btn-quiet", onclick: () => router.navigate(browseRoute(kind)) }, "Ver todo", icon("next"));
    shelves.replaceChildren(
      ...[
        movies.length ? shelf("Películas populares", movies.map((c, i) => titleTile(c, i)), { action: more("movie") }) : null,
        series.length ? shelf("Series populares", series.map((c, i) => titleTile(c, i)), { action: more("series") }) : null,
        fresh.length ? shelf(`Estrenos de ${year}`, fresh.map((c, i) => titleTile(c, i))) : null,
        bestMovies.length ? shelf("Películas mejor valoradas", bestMovies.map((c, i) => titleTile(c, i)), { note: "IMDb" }) : null,
        bestSeries.length ? shelf("Series mejor valoradas", bestSeries.map((c, i) => titleTile(c, i)), { note: "IMDb" }) : null,
      ].filter((x): x is HTMLElement => !!x),
    );
  };
  void load();
}

/** Destacado a sangre: fondo grande, logo o título, sinopsis y acciones. Rota solo. */
function mountHero(slot: HTMLElement, signal: AbortSignal, cards: Card[]): void {
  if (!cards.length) {
    slot.replaceChildren();
    return;
  }
  let index = 0;
  let timer = 0;
  const dots = h("div", { class: "hero-dots", role: "tablist" });
  const frame = h("div", { class: "hero-frame" });

  const show = (i: number) => {
    index = (i + cards.length) % cards.length;
    const card = cards[index];
    const watch = watchOf(card);
    const title = logoOrTitle(card.logo, card.name);
    const meta = [card.year, card.runtime, card.genres.slice(0, 3).join(" · ")].filter(Boolean);
    const content = h(
      "div",
      { class: "hero-content" },
      h("p", { class: "eyebrow" }, card.kind === "movie" ? "Película destacada" : "Serie destacada"),
      title,
      h(
        "div",
        { class: "hero-meta" },
        card.rating ? h("span", { class: "hero-rating" }, icon("star"), card.rating) : null,
        ...meta.map((m) => h("span", null, m as string)),
      ),
      card.description ? h("p", { class: "lede hero-lede" }, card.description) : null,
      h(
        "div",
        { class: "actions" },
        card.kind === "movie"
          ? h("button", { class: "btn btn-primary", onclick: () => router.navigate(playerRoute(watch, null)) }, icon("play"), "Ver ahora")
          : h("button", { class: "btn btn-primary", onclick: () => router.navigate(detailRoute(card.kind, card.id)) }, icon("play"), "Ver episodios"),
        card.kind === "movie"
          ? h("button", { class: "btn", onclick: () => router.navigate(sourcesRoute(watch)) }, icon("magnet"), "Fuentes")
          : null,
        h("button", { class: "btn btn-ghost", onclick: () => router.navigate(detailRoute(card.kind, card.id)) }, icon("info"), "Más información"),
      ),
    );
    const bg = poster(card.background, card.name, "hero-bg");
    const next = h("div", { class: "hero-slide" }, bg, h("div", { class: "hero-shade" }), content);
    frame.replaceChildren(next);
    withMenu(next, () => cardMenu(card));
    for (const [n, d] of [...dots.children].entries()) d.classList.toggle("active", n === index);
  };

  cards.forEach((_, n) =>
    dots.append(
      h("button", {
        class: "hero-dot",
        attrs: { "aria-label": `Destacado ${n + 1}` },
        onclick: () => {
          show(n);
          restart();
        },
      }),
    ),
  );
  const restart = () => {
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      if (!document.hidden && !slot.matches(":hover")) show(index + 1);
    }, HERO_MS);
  };
  signal.addEventListener("abort", () => window.clearInterval(timer), { once: true });
  slot.replaceChildren(h("section", { class: "hero" }, frame, dots));
  show(0);
  restart();
}
