import { openPath } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { TorrentStatus } from "../api";
import { copyText, withMenu } from "../contextmenu";
import type { ViewContext } from "../router";
import { setCrumbs } from "../shell";
import { empty, errMsg, fmtBytes, fmtLong, fmtSpeed, h, icon, toast } from "../ui";

const STATE: Record<TorrentStatus["state"], string> = {
  initializing: "Comprobando",
  live: "Descargando",
  paused: "En pausa",
  error: "Error",
};

export function downloadsView(root: HTMLElement, ctx: ViewContext): void {
  setCrumbs("Descargas");
  const list = h("div", { class: "dl-list" });
  const totals = h("div", { class: "dl-totals" });
  const folder = h("code", { class: "dl-folder" });
  api.downloadDir().then((d) => (folder.textContent = d), () => {});
  root.append(
    h(
      "div",
      { class: "page" },
      h(
        "header",
        { class: "page-head page-head-row" },
        h(
          "div",
          { class: "page-head-text" },
          h("p", { class: "eyebrow" }, "Cliente BitTorrent"),
          h("h1", { class: "display" }, "Descargas"),
          h("p", { class: "lede" }, "Torrents abiertos en esta sesión. Al salir de MovWatch se cierran y, salvo que en Ajustes indiques lo contrario, se borran los archivos."),
        ),
        totals,
      ),
      h(
        "div",
        { class: "dl-where" },
        icon("folder"),
        folder,
        h("button", { class: "btn btn-sm btn-quiet", onclick: () => folder.textContent && openPath(folder.textContent).catch((e: unknown) => toast(errMsg(e), "error")) }, "Abrir"),
      ),
      list,
    ),
  );

  const rows = new Map<number, ReturnType<typeof row>>();
  const refresh = async () => {
    let items: TorrentStatus[];
    try {
      items = await api.torrentList();
    } catch (e) {
      list.replaceChildren(empty(errMsg(e)));
      return;
    }
    if (ctx.signal.aborted) return;
    const down = items.reduce((s, t) => s + t.downSpeed, 0);
    const up = items.reduce((s, t) => s + t.upSpeed, 0);
    totals.replaceChildren(
      h("span", { class: "stat" }, icon("arrowDown"), fmtSpeed(down)),
      h("span", { class: "stat" }, icon("arrowUp"), fmtSpeed(up)),
    );
    if (!items.length) {
      rows.clear();
      list.replaceChildren(empty("No hay torrents abiertos.", "Empieza a ver una película o un episodio y aparecerá aquí."));
      return;
    }
    if (list.querySelector(".state")) list.replaceChildren();
    for (const id of [...rows.keys()]) if (!items.some((t) => t.id === id)) rows.get(id)!.el.remove(), rows.delete(id);
    for (const t of items) {
      let r = rows.get(t.id);
      if (!r) {
        r = row(t);
        rows.set(t.id, r);
        list.append(r.el);
      }
      r.update(t);
    }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 1000);
  window.addEventListener(api.TORRENTS_EVENT, refresh);
  ctx.signal.addEventListener("abort", () => {
    window.clearInterval(timer);
    window.removeEventListener(api.TORRENTS_EVENT, refresh);
  });
}

function row(initial: TorrentStatus) {
  let t = initial;
  const title = h("span", { class: "dl-title" });
  const file = h("span", { class: "dl-file" });
  const bar = h("span", { class: "meter dl-meter" }, h("i"));
  const stats = h("span", { class: "dl-stats" });
  const badge = h("span", { class: "dl-state" });
  const pauseBtn = h("button", { class: "icon-btn" });
  const folderBtn = h("button", { class: "icon-btn", title: "Mostrar en la carpeta", attrs: { "aria-label": "Mostrar en la carpeta" } }, icon("folder"));
  const closeBtn = h("button", { class: "icon-btn", title: "Cerrar y borrar", attrs: { "aria-label": "Cerrar" } }, icon("trash"));

  pauseBtn.onclick = async () => {
    try {
      await api.torrentPause(t.id, t.state !== "paused");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  folderBtn.onclick = async () => {
    try {
      await openPath(await api.torrentReveal(t.id, t.file));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const close = async (deleteFiles: boolean) => {
    try {
      await api.torrentClose(t.id, deleteFiles);
      toast(deleteFiles ? "Torrent cerrado y archivos borrados." : "Torrent cerrado; los archivos se conservan.", "ok");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  closeBtn.onclick = () => void close(true);

  const el = h(
    "div",
    { class: "dl-row" },
    h("div", { class: "dl-icon" }, icon("magnet")),
    h("div", { class: "dl-main" }, h("div", { class: "dl-line" }, title, badge), file, bar, stats),
    h("div", { class: "dl-actions" }, pauseBtn, folderBtn, closeBtn),
  );
  withMenu(el, () => [
    { label: t.state === "paused" ? "Reanudar" : "Pausar", icon: t.state === "paused" ? "play" : "pause", run: () => pauseBtn.click() },
    { label: "Mostrar en la carpeta", icon: "folder", run: () => folderBtn.click() },
    { label: "Copiar info-hash", icon: "copy", run: () => copyText(t.infoHash) },
    "-",
    { label: "Cerrar y conservar archivos", icon: "x", run: () => close(false) },
    { label: "Cerrar y borrar archivos", icon: "trash", danger: true, run: () => close(true) },
  ]);

  const update = (next: TorrentStatus) => {
    t = next;
    title.textContent = t.title || t.name || t.infoHash;
    file.textContent = t.fileName;
    const p = t.total ? t.downloaded / t.total : 0;
    (bar.firstChild as HTMLElement).style.setProperty("--p", String(p));
    bar.classList.toggle("done", t.finished);
    const st = t.finished ? "Completado" : STATE[t.state];
    badge.textContent = st;
    badge.className = `dl-state dl-${t.finished ? "done" : t.state}`;
    stats.replaceChildren(
      ...[
      h("span", null, `${Math.floor(p * 1000) / 10} % · ${fmtBytes(t.downloaded)} de ${fmtBytes(t.total)}`),
      t.state === "live" && !t.finished ? h("span", null, icon("arrowDown"), fmtSpeed(t.downSpeed)) : null,
      h("span", null, icon("arrowUp"), fmtSpeed(t.upSpeed)),
      h("span", null, icon("users"), `${t.peers} pares · ${t.seenPeers} vistos`),
      t.eta && t.state === "live" && !t.finished ? h("span", null, `Quedan ${fmtLong(t.eta)}`) : null,
      t.error ? h("span", { class: "dl-error" }, t.error) : null,
      ].filter((x): x is HTMLSpanElement => !!x),
    );
    pauseBtn.replaceChildren(icon(t.state === "paused" ? "play" : "pause"));
    pauseBtn.title = t.state === "paused" ? "Reanudar" : "Pausar";
  };
  update(initial);
  return { el, update };
}
