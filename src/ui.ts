// Utilidades de interfaz: construcción segura del DOM (sin innerHTML), iconos,
// estados de carga/error, imágenes con placeholder y avisos.

export type Child = Node | string | number | null | undefined | false;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "style" | "dataset" | "className" | "children">
> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
};

/** Crea un elemento. Los textos se insertan como nodos de texto, nunca como HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K> | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    const { class: cls, style, dataset, attrs, ...rest } = props;
    if (cls) el.className = cls;
    if (style) el.style.cssText = style;
    if (dataset) Object.assign(el.dataset, dataset);
    if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    Object.assign(el, rest);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "number" ? String(child) : child);
  }
  return el;
}

/** Mensaje legible de un error (el backend rechaza con strings en español). */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  back: "M15 18l-6-6 6-6",
  next: "M9 18l6-6-6-6",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4.2-4.2",
  home: "M3 11l9-7 9 7 M5 9.5V20h5v-6h4v6h5V9.5",
  settings: "M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M9 15a2 2 0 1 0 0 4a2 2 0 1 0 0-4z",
  play: "M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z",
  x: "M6 6l12 12 M18 6L6 18",
  replay: "M3 12a9 9 0 1 0 2.6-6.4 M3 4v5h5",
  list: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  fullscreen: "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5",
  tv: "M3 5h18v12H3z M8 21h8 M12 17v4",
  alert: "M12 9v4 M12 16.5h.01 M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  sort: "M7 4v16 M3 16l4 4 4-4 M17 20V4 M13 8l4-4 4 4",
  save: "M5 12l5 5L20 7",
  check: "M5 12l5 5L20 7",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 11v5 M12 7.5h.01",
  film: "M4 4h16v16H4z M8 4v16 M16 4v16 M4 9h4 M4 15h4 M16 9h4 M16 15h4",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7.5V12l3 2",
  sparkle: "M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z",
  folder: "M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  skip: "M5.5 6.5v11l8.5-5.5z M18 6v12",
  download: "M12 4v11 M7.5 10.5L12 15l4.5-4.5 M5 20h14",
  plus: "M12 5v14 M5 12h14",
  copy: "M9 9h10.5v11H9z M5 15.5V4.5h10.5",
  paste: "M9.5 3.5h5v3h-5z M8 5H5.5v15.5h13V5H16",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  pause: "M8.5 5v14 M15.5 5v14",
  rewind: "M11 7l-6 5 6 5z M19 7l-6 5 6 5z",
  forward: "M13 7l6 5-6 5z M5 7l6 5-6 5z",
  bookmark: "M6.5 4h11a.5.5 0 0 1 .5.5V20l-6-4-6 4V4.5a.5.5 0 0 1 .5-.5z",
  star: "M12 3.8l2.5 5.1 5.6.8-4.05 3.95.96 5.6L12 16.6l-5.01 2.65.96-5.6L3.9 9.7l5.6-.8z",
  trash: "M4 7h16 M9 7V4.5h6V7 M6.5 7l1 13h9l1-13",
  movie: "M4 5h16v14H4z M4 9h16 M8 5l2 4 M13 5l2 4",
  series: "M3 6h18v12H3z M8 21h8 M12 18v3 M9 9.5v5l4.5-2.5z",
  magnet: "M6 4v8a6 6 0 0 0 12 0V4 M6 8h4 M14 8h4 M10 4v8a2 2 0 0 0 4 0V4",
  users: "M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7z M2.5 20c.7-3.4 3.3-5.5 6.5-5.5s5.8 2.1 6.5 5.5 M16 4.3a3.5 3.5 0 0 1 0 6.4 M18 14.8c1.9.8 3.1 2.6 3.5 5.2",
  arrowDown: "M12 5v14 M6 13l6 6 6-6",
  arrowUp: "M12 19V5 M6 11l6-6 6 6",
  cc: "M3 5h18v14H3z M10.5 10.2a2.2 2.2 0 1 0 0 3.6 M17 10.2a2.2 2.2 0 1 0 0 3.6",
  audio: "M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11",
  mute: "M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5",
  shrink: "M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5",
  grid: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
  filter: "M4 5h16l-6 7.5V19l-4 1.5v-8z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  stop: "M7 7h10v10H7z",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, cls = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", name === "play" || name === "stop" ? `${cls} icon-fill` : cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** Par etiqueta/valor para listas de datos (<dl>). */
export function fact(label: string, value: string | Node): HTMLElement {
  return h("div", { class: "fact" }, h("dt", null, label), h("dd", null, value));
}

/** Tecla o atajo de teclado; `title` describe lo que hace. */
export function kbd(key: string, title?: string): HTMLElement {
  return h("kbd", title ? { class: "kbd", title } : { class: "kbd" }, key);
}

function hue(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) >>> 0;
  return n % 360;
}

/**
 * Imagen remota con carga diferida y sin referrer; si falla (o no hay URL)
 * se sustituye por un degradado con la inicial del título.
 */
export function poster(src: string | null, title: string, cls: string): HTMLDivElement {
  const box = h("div", { class: `media ${cls}` });
  const placeholder = () => {
    box.classList.add("is-ph");
    box.style.setProperty("--ph-hue", String(hue(title)));
    const initial = Array.from(title.trim())[0]?.toUpperCase() ?? "?";
    box.replaceChildren(h("span", { class: "media-ph-letter" }, initial));
  };
  if (!src) {
    placeholder();
    return box;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", placeholder, { once: true });
  img.addEventListener("load", () => box.classList.add("is-loaded"), { once: true });
  img.src = src;
  box.append(img);
  return box;
}

export type SkeletonKind = "wide" | "posters" | "detail" | "panels";

/** Esqueleto con la forma del contenido que se está cargando (evita saltos de diseño). */
export function skeleton(kind: SkeletonKind, count = 8, text = "Cargando…"): HTMLElement {
  const box = h("div", { class: `skeleton skeleton-${kind}`, role: "status", attrs: { "aria-label": text } });
  if (kind === "detail") {
    box.append(
      h(
        "div",
        { class: "skel-detail" },
        h("div", { class: "skel skel-cover" }),
        h(
          "div",
          { class: "skel-lines" },
          h("div", { class: "skel skel-line skel-h1" }),
          h("div", { class: "skel skel-line skel-w60" }),
          h("div", { class: "skel skel-line skel-w40" }),
          h("div", { class: "skel skel-line skel-w80" }),
        ),
      ),
    );
    return box;
  }
  if (kind === "panels") {
    for (let i = 0; i < count; i++) box.append(h("div", { class: "skel skel-panel" }));
    return box;
  }
  const grid = h("div", { class: kind === "wide" ? "grid grid-wide" : "grid grid-posters" });
  for (let i = 0; i < count; i++) {
    grid.append(
      h(
        "div",
        { class: "skel-card" },
        h("div", { class: `skel ${kind === "wide" ? "ratio-wide" : "ratio-poster"}` }),
        h("div", { class: "skel skel-line skel-w80" }),
        kind === "posters" ? h("div", { class: "skel skel-line skel-w40" }) : null,
      ),
    );
  }
  box.append(grid);
  return box;
}

export function spinner(text = "Cargando…"): HTMLElement {
  return h("div", { class: "state state-loading" }, h("div", { class: "spinner" }), h("p", { class: "state-text" }, text));
}

export function errorBox(message: string, retry?: () => void): HTMLElement {
  return h(
    "div",
    { class: "state state-error" },
    icon("alert", "icon state-icon"),
    h("p", { class: "state-text" }, message),
    retry ? h("button", { class: "btn btn-primary", onclick: retry }, icon("replay"), "Reintentar") : null,
  );
}

export function empty(text: string, hint?: string): HTMLElement {
  return h(
    "div",
    { class: "state state-empty" },
    icon("info", "icon state-icon"),
    h("p", { class: "state-text" }, text),
    hint ? h("p", { class: "state-hint" }, hint) : null,
  );
}

/**
 * Carga datos mostrando un estado de carga en `container`; en caso de error muestra
 * el mensaje y un botón "Reintentar". No toca el DOM si la vista ya se abandonó.
 */
export function loadInto<T>(
  container: HTMLElement,
  signal: AbortSignal,
  load: () => Promise<T>,
  render: (data: T) => void,
  loadingText?: string,
  placeholder?: () => HTMLElement,
): void {
  const run = async () => {
    container.replaceChildren(placeholder ? placeholder() : spinner(loadingText));
    let data: T;
    try {
      data = await load();
    } catch (e) {
      if (!signal.aborted) container.replaceChildren(errorBox(errMsg(e), () => void run()));
      return;
    }
    if (signal.aborted) return;
    container.replaceChildren();
    try {
      render(data);
    } catch (e) {
      console.error(e);
      container.replaceChildren(errorBox(errMsg(e), () => void run()));
    }
  };
  void run();
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "ok" | "error" | "info" = "info"): void {
  if (!toastHost) {
    toastHost = h("div", { class: "toasts" });
    document.body.append(toastHost);
  }
  const el = h("div", { class: `toast toast-${kind}`, role: "status" }, message);
  toastHost.append(el);
  window.setTimeout(() => {
    el.classList.add("leaving");
    window.setTimeout(() => el.remove(), 260);
  }, kind === "error" ? 5000 : 3200);
}

// ---- Formato ----

export function fmtBytes(n: number): string {
  if (!n || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function fmtSpeed(bps: number): string {
  return bps > 0 ? `${fmtBytes(bps)}/s` : "0 B/s";
}

/** 5400 → "1:30:00"; 75 → "1:15". */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const hh = Math.floor(sec / 3600);
  const pad = (x: number) => String(x).padStart(2, "0");
  return hh ? `${hh}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 5400 → "1 h 30 min". */
export function fmtLong(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  return new Date(ms).toLocaleDateString("es", { day: "numeric", month: "short" });
}

/** Barra fina de progreso (0–1). */
export function meter(p: number, cls = ""): HTMLElement {
  return h("span", { class: `meter ${cls}`.trim() }, h("i", { style: `--p:${Math.max(0, Math.min(1, p))}` }));
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
