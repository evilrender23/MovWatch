import * as api from "../api";
import type { Category } from "../api";
import { languageFilter, titleTile } from "../cards";
import { router, type ViewContext } from "../router";
import { homeRoute } from "../routes";
import { setCrumbs } from "../shell";
import { empty, errMsg, errorBox, h, icon, skeleton } from "../ui";
import { sourcesTable } from "./sources";

type Tab = "titles" | "torrents";
let lastTab: Tab = "titles";
let lastCategory: Category = "all";

export function searchView(root: HTMLElement, ctx: ViewContext, query: string): void {
  setCrumbs({ label: "Inicio", onClick: () => router.navigate(homeRoute()) }, "Búsqueda");
  const body = h("div");
  const tabs = h("div", { class: "seg", role: "tablist" });

  const renderTabs = () =>
    tabs.replaceChildren(
      ...(
        [
          ["titles", "Películas y series"],
          ["torrents", "Torrents"],
        ] as [Tab, string][]
      ).map(([t, text]) =>
        h(
          "button",
          {
            class: lastTab === t ? "seg-btn active" : "seg-btn",
            role: "tab",
            onclick: () => {
              if (lastTab === t) return;
              lastTab = t;
              renderTabs();
              show();
            },
          },
          text,
        ),
      ),
    );

  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "page-head page-head-row" },
        h("div", { class: "page-head-text" }, h("p", { class: "eyebrow" }, "Resultados para"), h("h1", { class: "display" }, `“${query}”`)),
        tabs,
      ),
      body,
    ),
  );

  const show = () => (lastTab === "titles" ? showTitles() : showTorrents());

  const showTitles = async () => {
    body.replaceChildren(skeleton("posters", 12, "Buscando…"));
    try {
      const { movies, series } = await api.searchTitles(query);
      if (ctx.signal.aborted || lastTab !== "titles") return;
      if (!movies.length && !series.length) {
        body.replaceChildren(
          empty("No se encontró ninguna película ni serie.", "Prueba con el título original en inglés o busca directamente en Torrents."),
        );
        return;
      }
      const section = (title: string, list: api.Card[]) =>
        list.length
          ? h(
              "section",
              { class: "block" },
              h("header", { class: "rule" }, h("h2", { class: "rule-title" }, title), h("span", { class: "rule-count" }, String(list.length)), h("span", { class: "rule-line" })),
              h("div", { class: "grid grid-posters" }, list.map((c, i) => titleTile(c, i))),
            )
          : null;
      const sections = [section("Películas", movies), section("Series", series)].filter((x): x is HTMLElement => !!x);
      body.replaceChildren(...sections);
      const filter = await languageFilter(() => sections, ctx.signal);
      if (filter && !ctx.signal.aborted && lastTab === "titles") {
        body.prepend(h("div", { class: "filters" }, h("span", { class: "filters-label" }, icon("filter"), "Idioma"), filter.button));
        filter.refresh();
      }
    } catch (e) {
      if (!ctx.signal.aborted) body.replaceChildren(errorBox(errMsg(e), () => void showTitles()));
    }
  };

  // Búsqueda libre por texto en todos los proveedores, como el CLI de torrodle.
  const showTorrents = () => {
    const cat = h("div", { class: "chips" });
    const host = h("div");
    const renderCats = () =>
      cat.replaceChildren(
        ...(
          [
            ["all", "Todo"],
            ["movie", "Películas"],
            ["tv", "Series"],
            ["anime", "Animé"],
          ] as [Category, string][]
        ).map(([c, text]) =>
          h(
            "button",
            {
              class: lastCategory === c ? "chip active" : "chip",
              onclick: () => {
                lastCategory = c;
                renderCats();
                run();
              },
            },
            text,
          ),
        ),
      );
    const run = () => {
      host.replaceChildren();
      host.append(sourcesTable(ctx.signal, { text: query, category: lastCategory }, null));
    };
    renderCats();
    body.replaceChildren(
      h("div", { class: "filters" }, h("span", { class: "filters-label" }, icon("filter"), "Categoría"), cat),
      host,
    );
    run();
  };

  renderTabs();
  void show();
}
