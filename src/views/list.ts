import * as api from "../api";
import type { Card, ListEntry, ListStatus } from "../api";
import { STATUS_LABEL, STATUS_ORDER, titleTile } from "../cards";
import { loadList } from "../data";
import type { ViewContext } from "../router";
import { setCrumbs } from "../shell";
import { empty, errMsg, errorBox, h } from "../ui";

type Tab = "all" | ListStatus;
type KindFilter = "all" | Card["kind"];
let tab: Tab = "all";
let kind: KindFilter = "all";

export function listView(root: HTMLElement, ctx: ViewContext): void {
  setCrumbs("Mi lista");
  const tabs = h("div", { class: "seg" });
  const kinds = h("div", { class: "seg seg-sm" });
  const body = h("div");
  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "page-head page-head-row" },
        h("div", { class: "page-head-text" }, h("p", { class: "eyebrow" }, "Biblioteca"), h("h1", { class: "display" }, "Mi lista")),
        kinds,
      ),
      h("div", { class: "filters" }, tabs),
      body,
    ),
  );

  let entries: ListEntry[] = [];
  const render = () => {
    const ofKind = entries.filter((e) => kind === "all" || e.kind === kind);
    const count = (t: Tab) => ofKind.filter((e) => t === "all" || e.status === t).length;
    tabs.replaceChildren(
      ...(["all", ...STATUS_ORDER] as Tab[]).map((t) =>
        h(
          "button",
          {
            class: `seg-btn${tab === t ? " active" : ""}${t !== "all" ? ` st-${t}` : ""}`,
            onclick: () => {
              tab = t;
              render();
            },
          },
          t !== "all" ? h("i", { class: "dot" }) : null,
          t === "all" ? "Todo" : STATUS_LABEL[t],
          h("span", { class: "tab-count" }, String(count(t))),
        ),
      ),
    );
    kinds.replaceChildren(
      ...(
        [
          ["all", "Todo"],
          ["movie", "Películas"],
          ["series", "Series"],
        ] as [KindFilter, string][]
      ).map(([k, text]) =>
        h(
          "button",
          {
            class: kind === k ? "seg-btn active" : "seg-btn",
            onclick: () => {
              kind = k;
              render();
            },
          },
          text,
        ),
      ),
    );
    const shown = ofKind.filter((e) => tab === "all" || e.status === tab);
    if (!shown.length) {
      body.replaceChildren(
        empty(
          entries.length ? "No hay nada con este filtro." : "Tu lista está vacía.",
          entries.length ? undefined : "Añade películas y series desde su ficha o con clic derecho sobre un póster.",
        ),
      );
      return;
    }
    body.replaceChildren(
      h(
        "div",
        { class: "grid grid-posters" },
        shown.map((e, i) =>
          titleTile(
            { id: e.id, kind: e.kind, name: e.title, poster: e.poster, background: null, logo: null, year: e.year, rating: null, genres: [], description: null, runtime: null },
            i,
            { badge: STATUS_LABEL[e.status] },
          ),
        ),
      ),
    );
  };

  const load = async () => {
    try {
      entries = await loadList();
      if (!ctx.signal.aborted) render();
    } catch (e) {
      if (!ctx.signal.aborted) body.replaceChildren(errorBox(errMsg(e), () => void load()));
    }
  };
  void load();
  const onChange = () => void load();
  window.addEventListener(api.LIST_EVENT, onChange);
  ctx.signal.addEventListener("abort", () => window.removeEventListener(api.LIST_EVENT, onChange), { once: true });
}
