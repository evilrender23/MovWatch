import { getVersion } from "@tauri-apps/api/app";
import "./styles.css";
import * as api from "./api";
import type { WatchEntry } from "./api";
import { router } from "./router";
import { loadList } from "./data";
import { browseRoute, detailRoute, downloadsRoute, homeRoute, listRoute, playerRoute, searchRoute, settingsRoute } from "./routes";
import { copyText, installContextMenu, setGlobalMenu, withMenu } from "./contextmenu";
import { mountCrumbs } from "./shell";
import { errMsg, h, icon, isMac, poster, toast, type IconName } from "./ui";
import { mountUpdater } from "./updater";

// ---------------------------------------------------------------------------
// Distribución (la de Hermes):
//   ┌──────────┬────────────────────────────────────────────┐
//   │ sidebar  │ ┌ barra del panel: ‹  Inicio / Ficha …  ┐ │
//   │ marca    │ │                                        │ │
//   │ buscar   │ │  vista                                 │ │
//   │ nav      │ │                                        │ │
//   │ seguir   │ │                                        │ │
//   │ viendo   │ └────────────────────────────────────────┘ │
//   │ versión  │                                            │
//   └──────────┴────────────────────────────────────────────┘
// ---------------------------------------------------------------------------

// ---- Marca ----
const brand = h(
  "button",
  { class: "brand", title: "Inicio", onclick: () => router.navigate(homeRoute()) },
  h("span", { class: "brand-mark", attrs: { "aria-hidden": "true" } }, icon("play")),
  h("span", { class: "wordmark" }, "Mov", h("span", { class: "wordmark-dim" }, "Watch")),
);

// ---- Búsqueda ----
const searchInput = h("input", {
  type: "search",
  class: "search-input",
  placeholder: "Películas, series…",
  spellcheck: false,
  autocomplete: "off",
  attrs: { "aria-label": "Buscar películas y series" },
  onkeydown: (e) => {
    if (e.key === "Escape") searchInput.blur();
  },
});

const searchForm = h(
  "form",
  {
    class: "search",
    role: "search",
    onsubmit: (e: SubmitEvent) => {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (!query) return;
      searchInput.blur();
      router.navigate(searchRoute(query));
    },
  },
  icon("search", "icon search-icon"),
  searchInput,
  h("kbd", { class: "kbd search-kbd", attrs: { "aria-hidden": "true" } }, isMac ? "⌘K" : "Ctrl K"),
);

// ---- Navegación ----
const navRow = (label: string, name: IconName, onClick: () => void) =>
  h("button", { class: "side-row", onclick: onClick }, icon(name), h("span", { class: "side-row-label" }, label));

const homeBtn = navRow("Inicio", "home", () => router.navigate(homeRoute()));
const moviesBtn = navRow("Películas", "movie", () => router.navigate(browseRoute("movie")));
const seriesBtn = navRow("Series", "series", () => router.navigate(browseRoute("series")));
const listBtn = navRow("Mi lista", "bookmark", () => router.navigate(listRoute()));
const downloadsBtn = navRow("Descargas", "download", () => router.navigate(downloadsRoute()));
const settingsBtn = navRow("Ajustes", "settings", () => router.navigate(settingsRoute()));
const listCount = h("span", { class: "side-row-count" });
listBtn.append(listCount);
const downloadsCount = h("span", { class: "side-row-count side-row-live" });
downloadsBtn.append(downloadsCount);

const refreshListCount = () =>
  loadList().then(
    (list) => {
      listCount.textContent = list.length ? String(list.length) : "";
    },
    () => {},
  );
window.addEventListener(api.LIST_EVENT, () => void refreshListCount());
void refreshListCount();

// Torrents activos: contador y velocidad total en la fila "Descargas".
async function refreshDownloads(): Promise<void> {
  try {
    const list = await api.torrentList();
    const active = list.filter((t) => t.state !== "paused" && !t.finished).length;
    downloadsCount.textContent = list.length ? String(list.length) : "";
    downloadsCount.classList.toggle("is-active", active > 0);
  } catch {
    /* sin torrents */
  }
}
window.addEventListener(api.TORRENTS_EVENT, () => void refreshDownloads());
window.setInterval(() => void refreshDownloads(), 4000);
void refreshDownloads();

// ---- Continuar viendo ----
const libraryList = h("div", { class: "library", role: "list" });
const libraryCount = h("span", { class: "side-count" });
let libraryEntries: WatchEntry[] = [];
let currentId: string | null = null;

const watchOfEntry = (e: WatchEntry) => ({
  id: e.id,
  kind: e.kind,
  title: e.title,
  poster: e.poster,
  background: e.background,
  year: null,
  season: e.season,
  episode: e.episode,
  episodeName: e.episodeName,
});

function libraryRow(entry: WatchEntry): HTMLElement {
  const remove: HTMLButtonElement = h(
    "button",
    {
      class: "lib-remove",
      attrs: { "aria-label": `Quitar ${entry.title}` },
      onclick: async (e) => {
        e.stopPropagation();
        remove.disabled = true;
        try {
          await api.historyRemove(entry.id);
        } catch (err) {
          remove.disabled = false;
          toast(errMsg(err), "error");
        }
      },
    },
    icon("x"),
  );
  const tag = entry.season !== null && entry.episode !== null ? `${entry.season}×${String(entry.episode).padStart(2, "0")}` : entry.duration > 0 ? `${Math.round((entry.position / entry.duration) * 100)}%` : "";
  const row = h(
    "div",
    {
      class: currentId === entry.id ? "lib-row active" : "lib-row",
      role: "listitem",
      tabIndex: 0,
      title: `${entry.title} (doble clic para continuar)`,
      onclick: () => router.navigate(detailRoute(entry.kind, entry.id, entry.season ?? undefined)),
      ondblclick: () => router.navigate(playerRoute(watchOfEntry(entry), null, entry.position)),
      onkeydown: (e) => {
        if (e.target === e.currentTarget && e.key === "Enter") router.navigate(detailRoute(entry.kind, entry.id));
      },
    },
    poster(entry.poster, entry.title, "lib-thumb"),
    h("span", { class: "lib-title" }, entry.title),
    h("span", { class: "lib-ep" }, tag),
    remove,
  );
  return withMenu(row, () => [
    { label: "Continuar", icon: "play", run: () => router.navigate(playerRoute(watchOfEntry(entry), null, entry.position)) },
    { label: "Ver ficha", icon: "info", run: () => router.navigate(detailRoute(entry.kind, entry.id, entry.season ?? undefined)) },
    "-",
    { label: "Copiar título", icon: "copy", run: () => copyText(entry.title) },
    { label: "Quitar de Continuar viendo", icon: "x", danger: true, run: () => api.historyRemove(entry.id) },
  ]);
}

function renderLibrary(): void {
  libraryCount.textContent = libraryEntries.length ? String(libraryEntries.length) : "";
  if (!libraryEntries.length) {
    libraryList.replaceChildren(h("p", { class: "side-empty" }, "Lo que empieces a ver aparecerá aquí."));
    return;
  }
  libraryList.replaceChildren(...libraryEntries.map(libraryRow));
}

async function loadLibrary(): Promise<void> {
  try {
    const list = await api.historyList();
    libraryEntries = list.sort((a, b) => b.updatedAt - a.updatedAt);
    renderLibrary();
  } catch (e) {
    libraryList.replaceChildren(h("p", { class: "side-empty side-error" }, errMsg(e)));
  }
}
window.addEventListener(api.HISTORY_EVENT, () => void loadLibrary());

// ---- Pie de la barra lateral ----
const version = h("span", { class: "side-version" });
getVersion().then(
  (v) => {
    version.textContent = `v${v}`;
  },
  () => {},
);
const updateCard = h("aside", { class: "update-card", hidden: true, role: "status", attrs: { "aria-label": "Actualización" } });

const sidebar = h(
  "aside",
  { class: "sidebar", attrs: { "aria-label": "Barra lateral" } },
  h("div", { class: "side-top" }, brand),
  searchForm,
  h(
    "nav",
    { class: "side-nav", attrs: { "aria-label": "Principal" } },
    homeBtn,
    moviesBtn,
    seriesBtn,
    h("div", { class: "side-gap" }),
    listBtn,
    downloadsBtn,
    settingsBtn,
  ),
  h(
    "div",
    { class: "side-section" },
    h("div", { class: "side-heading" }, h("span", null, "Continuar viendo"), libraryCount),
    libraryList,
  ),
  updateCard,
  h("footer", { class: "side-foot" }, h("span", null, "basado en torrodle"), version),
);

// ---- Panel principal ----
const backBtn = h(
  "button",
  { class: "icon-btn", title: "Atrás (Alt+←)", disabled: true, attrs: { "aria-label": "Atrás" }, onclick: () => router.back() },
  icon("back"),
);
const crumbs = h("nav", { class: "crumbs", attrs: { "aria-label": "Ubicación" } });
mountCrumbs(crumbs);
const view = h("main", { class: "view", id: "contenido" });
const pane = h("section", { class: "pane" }, h("header", { class: "pane-bar" }, backBtn, crumbs), view);

const app = document.getElementById("app") ?? document.body;
app.classList.add("shell");
installContextMenu();
setGlobalMenu(() => [
  { label: "Atrás", icon: "back", hint: "Alt+←", disabled: !router.canGoBack, run: () => router.back() },
  { label: "Inicio", icon: "home", run: () => router.navigate(homeRoute()) },
  { label: "Descargas", icon: "download", run: () => router.navigate(downloadsRoute()) },
  {
    label: "Buscar…",
    icon: "search",
    hint: isMac ? "⌘K" : "Ctrl+K",
    run: () => {
      searchInput.focus();
      searchInput.select();
    },
  },
]);
window.addEventListener("mw:search", (e) => {
  const query = String((e as CustomEvent<string>).detail ?? "").trim().slice(0, 100);
  if (!query) return;
  searchInput.value = query;
  router.navigate(searchRoute(query));
});
app.append(sidebar, pane);
mountUpdater(updateCard);
void loadLibrary();

router.onChange((route, canGoBack) => {
  backBtn.disabled = !canGoBack;
  for (const [btn, section] of [
    [homeBtn, "home"],
    [moviesBtn, "movies"],
    [seriesBtn, "series"],
    [listBtn, "list"],
    [downloadsBtn, "downloads"],
    [settingsBtn, "settings"],
  ] as const) {
    const on = route.section === section;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  }
  // El reproductor ocupa todo el panel (sin márgenes de página).
  pane.classList.toggle("pane-cinema", route.section === "player");
  if (route.section !== "player") currentId = route.key.startsWith("detail:") ? route.key.slice("detail:".length) : null;
  renderLibrary();
  view.scrollTo(0, 0);
});

window.addEventListener("mw:now-playing", (e) => {
  currentId = (e as CustomEvent<string | null>).detail;
  renderLibrary();
});

// Botón "atrás" del ratón, Alt+← y Ctrl/⌘+K para buscar.
window.addEventListener("mousedown", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    router.back();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    router.back();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

router.mount(view, homeRoute());
