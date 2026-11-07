import type { Card, CatalogId, Kind } from "../api";
import { titleTile } from "../cards";
import { getCatalog } from "../data";
import type { ViewContext } from "../router";
import { setCrumbs } from "../shell";
import { empty, errMsg, errorBox, h, icon, skeleton } from "../ui";

/** Géneros de Cinemeta (en inglés en la API) con su nombre en español. */
const GENRES: [string, string][] = [
  ["Action", "Acción"],
  ["Adventure", "Aventura"],
  ["Animation", "Animación"],
  ["Comedy", "Comedia"],
  ["Crime", "Crimen"],
  ["Documentary", "Documental"],
  ["Drama", "Drama"],
  ["Family", "Familia"],
  ["Fantasy", "Fantasía"],
  ["History", "Historia"],
  ["Horror", "Terror"],
  ["Mystery", "Misterio"],
  ["Romance", "Romance"],
  ["Sci-Fi", "Ciencia ficción"],
  ["Thriller", "Suspense"],
  ["War", "Bélica"],
  ["Western", "Wéstern"],
];

/** Filtros recordados por tipo durante la sesión. */
const state: Record<Kind, { sort: CatalogId; genre: string | null }> = {
  movie: { sort: "top", genre: null },
  series: { sort: "top", genre: null },
};

export function browseView(root: HTMLElement, ctx: ViewContext, kind: Kind): void {
  const label = kind === "movie" ? "Películas" : "Series";
  setCrumbs(label);
  const s = state[kind];
  const grid = h("div", { class: "grid grid-posters" });
  const body = h("div");
  const moreBtn: HTMLButtonElement = h("button", { class: "btn", onclick: () => void loadMore() }, icon("plus"), "Cargar más");
  const footer = h("div", { class: "browse-more", hidden: true }, moreBtn);
  const count = h("span", { class: "rule-count" });

  const years = Array.from({ length: 12 }, (_, i) => String(new Date().getFullYear() - i));
  const sortTabs = h("div", { class: "seg", role: "tablist" });
  const chips = h("div", { class: "chips chips-wrap" });

  const renderFilters = () => {
    sortTabs.replaceChildren(
      ...(
        [
          ["top", "Populares"],
          ["imdbRating", "Mejor valoradas"],
          ["year", "Por año"],
        ] as [CatalogId, string][]
      ).map(([id, text]) =>
        h(
          "button",
          {
            class: s.sort === id ? "seg-btn active" : "seg-btn",
            role: "tab",
            onclick: () => {
              if (s.sort === id) return;
              s.sort = id;
              s.genre = id === "year" ? years[0] : null;
              renderFilters();
              void reload();
            },
          },
          text,
        ),
      ),
    );
    const options: [string | null, string][] = s.sort === "year" ? years.map((y) => [y, y]) : [[null, "Todos"], ...GENRES];
    chips.replaceChildren(
      ...options.map(([value, text]) =>
        h(
          "button",
          {
            class: s.genre === value ? "chip active" : "chip",
            onclick: () => {
              if (s.genre === value) return;
              s.genre = value;
              renderFilters();
              void reload();
            },
          },
          text,
        ),
      ),
    );
  };

  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "page-head page-head-row" },
        h("div", { class: "page-head-text" }, h("p", { class: "eyebrow" }, "Catálogo"), h("h1", { class: "display" }, label)),
        sortTabs,
      ),
      h("div", { class: "filters" }, chips),
      h("section", { class: "block" }, h("header", { class: "rule" }, h("h2", { class: "rule-title" }, "Títulos"), count, h("span", { class: "rule-line" })), body, footer),
    ),
  );

  let items: Card[] = [];
  let gen = 0;
  const seen = new Set<string>();

  const append = (list: Card[]) => {
    const fresh = list.filter((c) => !seen.has(c.id));
    fresh.forEach((c) => seen.add(c.id));
    items = items.concat(fresh);
    grid.append(...fresh.map((c, i) => titleTile(c, i)));
    count.textContent = String(items.length);
    footer.hidden = list.length < 20;
  };

  const reload = async () => {
    const my = ++gen;
    items = [];
    seen.clear();
    grid.replaceChildren();
    footer.hidden = true;
    body.replaceChildren(skeleton("posters", 18, "Cargando…"));
    try {
      const list = await getCatalog(kind, s.sort, s.genre, 0);
      if (my !== gen || ctx.signal.aborted) return;
      body.replaceChildren(list.length ? grid : empty("No hay títulos con este filtro."));
      append(list);
    } catch (e) {
      if (my === gen && !ctx.signal.aborted) body.replaceChildren(errorBox(errMsg(e), () => void reload()));
    }
  };

  const loadMore = async () => {
    const my = gen;
    moreBtn.disabled = true;
    try {
      const list = await getCatalog(kind, s.sort, s.genre, items.length);
      if (my !== gen || ctx.signal.aborted) return;
      append(list);
      if (!list.length) footer.hidden = true;
    } catch (e) {
      footer.prepend(h("p", { class: "muted" }, errMsg(e)));
    } finally {
      moreBtn.disabled = false;
    }
  };

  renderFilters();
  void reload();
}
