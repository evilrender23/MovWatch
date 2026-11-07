import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../api";
import type { DetectedPlayers, PlayerKind, ProviderInfo, Settings, Tools } from "../api";
import type { ViewContext } from "../router";
import { setCrumbs } from "../shell";
import { errMsg, h, icon, loadInto, skeleton, toast } from "../ui";
import { checkForUpdates, describe, installedVersion, onUpdate, openRelease, short, updateChannel, updateState, type UpdateState } from "../updater";

const MPV_URL = "https://mpv.io/installation/";
const VLC_URL = "https://www.videolan.org/vlc/";
const FFMPEG_URL = "https://ffmpeg.org/download.html";

const SUB_LANGS: [string, string][] = [
  ["", "Ninguno"],
  ["spa", "Español"],
  ["spl", "Español (Latinoamérica)"],
  ["eng", "Inglés"],
  ["por", "Portugués"],
  ["pob", "Portugués (Brasil)"],
  ["fre", "Francés"],
  ["ger", "Alemán"],
  ["ita", "Italiano"],
  ["cat", "Catalán"],
];

export function settingsView(root: HTMLElement, ctx: ViewContext): void {
  setCrumbs("Ajustes");
  const body = h("div", { class: "settings" });
  root.append(
    h(
      "div",
      { class: "page settings-page" },
      h(
        "header",
        { class: "page-head" },
        h("p", { class: "eyebrow" }, "Preferencias"),
        h("h1", { class: "display" }, "Ajustes"),
        h("p", { class: "lede" }, "Reproducción, subtítulos, proveedores de torrents y descargas. Los cambios se aplican al pulsar Guardar."),
      ),
      body,
    ),
  );
  loadInto(
    body,
    ctx.signal,
    () => Promise.all([api.getSettings(), api.detectPlayers(), api.detectTools(), api.providersList(), api.downloadDir()]),
    ([settings, detected, tools, providers, dir]) => renderForm(body, ctx.signal, settings, detected, tools, providers, dir),
    "Cargando ajustes…",
    () => skeleton("panels", 3, "Cargando ajustes…"),
  );
}

const group = (title: string, desc: string | null, ...rows: (HTMLElement | null)[]) =>
  h(
    "section",
    { class: "set-group" },
    h("header", { class: "set-group-head" }, h("h2", null, title), desc ? h("p", null, desc) : null),
    h("div", { class: "set-rows" }, rows),
  );

const row = (label: string, desc: string | Node | null, control: HTMLElement | null, cls = "") =>
  h(
    "div",
    { class: `set-row ${cls}`.trim() },
    h("div", { class: "set-text" }, h("span", { class: "set-label" }, label), desc ? h("span", { class: "set-desc" }, desc) : null),
    control,
  );

const toggleRow = (label: string, desc: string, input: HTMLInputElement) =>
  h("label", { class: "set-row set-row-toggle" }, h("span", { class: "set-text" }, h("span", { class: "set-label" }, label), h("span", { class: "set-desc" }, desc)), input);

const switchInput = (checked: boolean) => h("input", { type: "checkbox", class: "switch", role: "switch", checked });

function renderForm(
  body: HTMLElement,
  signal: AbortSignal,
  settings: Settings,
  detected: DetectedPlayers,
  tools: Tools,
  providers: ProviderInfo[],
  dir: string,
): void {
  let player: PlayerKind = settings.player;

  const detectedCode = () => h("code", { class: "detected" });
  const [detectedMpv, detectedVlc, detectedFfmpeg] = [detectedCode(), detectedCode(), detectedCode()];
  const showDetected = (d: DetectedPlayers, t: Tools) => {
    for (const [el, path] of [
      [detectedMpv, d.mpv],
      [detectedVlc, d.vlc],
      [detectedFfmpeg, t.ffmpeg && t.ffprobe ? t.ffmpeg : null],
    ] as const) {
      el.textContent = path ?? "No detectado";
      el.title = path ?? "";
      el.classList.toggle("missing", !path);
    }
  };
  showDetected(detected, tools);

  const option = (value: PlayerKind, title: string, desc: string, status: HTMLElement | null) =>
    h(
      "label",
      { class: "choice" },
      h("input", { type: "radio", name: "player", value, checked: settings.player === value, onchange: () => (player = value) }),
      h("span", { class: "choice-dot", attrs: { "aria-hidden": "true" } }),
      h("span", { class: "set-text" }, h("span", { class: "set-label" }, title), h("span", { class: "set-desc" }, desc)),
      status,
    );

  const pathInput = (value: string | null, placeholder: string) =>
    h("input", { type: "text", class: "input input-mono", value: value ?? "", placeholder, spellcheck: false, autocomplete: "off" });
  const mpvInput = pathInput(settings.mpvPath, "Automática");
  const vlcInput = pathInput(settings.vlcPath, "Automática");
  const ffmpegInput = pathInput(settings.ffmpegPath, "Automática");
  const dirInput = pathInput(settings.downloadDir, dir);
  const keepFiles = switchInput(settings.keepFiles);
  const preferSpanish = switchInput(settings.preferSpanish);
  const autoNext = switchInput(settings.autoNext);
  const autoUpdate = switchInput(settings.autoUpdate);
  const subLang = h("select", { class: "select" }, ...SUB_LANGS.map(([v, t]) => h("option", { value: v, selected: settings.subtitleLang === v }, t)));

  const providerSwitches = providers.map((p) => {
    const input = switchInput(!settings.disabledProviders.includes(p.name));
    return { p, input };
  });

  const saveBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-primary",
      onclick: async () => {
        const next: Settings = {
          player,
          mpvPath: mpvInput.value.trim() || null,
          vlcPath: vlcInput.value.trim() || null,
          ffmpegPath: ffmpegInput.value.trim() || null,
          downloadDir: dirInput.value.trim() || null,
          keepFiles: keepFiles.checked,
          disabledProviders: providerSwitches.filter((x) => !x.input.checked).map((x) => x.p.name),
          subtitleLang: subLang.value,
          preferSpanish: preferSpanish.checked,
          autoNext: autoNext.checked,
          autoUpdate: autoUpdate.checked,
        };
        saveBtn.disabled = true;
        try {
          await api.saveSettings(next);
          toast(next.downloadDir !== settings.downloadDir ? "Ajustes guardados. La nueva carpeta se usará al reiniciar." : "Ajustes guardados.", "ok");
          settings = next;
          Promise.all([api.detectPlayers(), api.detectTools()]).then(
            ([d, t]) => !signal.aborted && showDetected(d, t),
            () => {},
          );
        } catch (e) {
          toast(errMsg(e), "error");
        } finally {
          saveBtn.disabled = false;
        }
      },
    },
    icon("save"),
    "Guardar cambios",
  );

  const openBtn = (url: string, text = "Descargar") =>
    h("button", { class: "btn btn-sm btn-quiet", onclick: () => openUrl(url).catch((e: unknown) => toast(errMsg(e), "error")) }, icon("external"), text);

  body.append(
    group(
      "Reproductor",
      "Dónde se abren las películas y los episodios. En todos los casos se ven mientras se descargan.",
      h(
        "div",
        { class: "choices", role: "radiogroup", attrs: { "aria-label": "Reproductor" } },
        option("builtin", "Integrado", "Dentro de la app, con subtítulos y elección de audio.", null),
        option("mpv", "mpv", "Reproduce cualquier formato sin convertir.", detectedMpv),
        option("vlc", "VLC", "Reproductor clásico.", detectedVlc),
      ),
    ),
    group(
      "Compatibilidad",
      "Casi todos los torrents son MKV con audio AC3/DTS, que la vista web no reproduce. Con ffmpeg instalado se reempaquetan al vuelo sin perder calidad.",
      row("ffmpeg y ffprobe", null, detectedFfmpeg),
      row("Ruta de ffmpeg", "Vacía para detectarlo solo. ffprobe se busca en la misma carpeta.", ffmpegInput, "set-row-field"),
      row("Descargar ffmpeg", h("code", null, "brew install ffmpeg · winget install ffmpeg"), openBtn(FFMPEG_URL)),
    ),
    group(
      "Idioma",
      null,
      row("Subtítulos automáticos", "Se cargan solos (de OpenSubtitles) si el torrent no tiene audio en español.", subLang),
      toggleRow("Priorizar audio en español", "Sube en la lista los torrents en castellano, latino o dual, y elige esa pista de audio.", preferSpanish),
    ),
    group(
      "Reproducción",
      null,
      toggleRow("Siguiente episodio automático", "Al terminar un episodio, empieza el siguiente.", autoNext),
    ),
    group(
      "Proveedores",
      "Se consultan todos a la vez. Desactiva los que no quieras usar.",
      ...providerSwitches.map(({ p, input }) =>
        h(
          "label",
          { class: "set-row set-row-toggle" },
          h("span", { class: "set-text" }, h("span", { class: "set-label" }, p.name, h("code", null, p.site.replace(/^https?:\/\//, ""))), h("span", { class: "set-desc" }, p.description)),
          input,
        ),
      ),
    ),
    group(
      "Descargas",
      "Como torrodle, lo descargado se borra al salir salvo que decidas conservarlo.",
      row("Carpeta", "Se aplica al reiniciar la app.", dirInput, "set-row-field"),
      toggleRow("Conservar los archivos", "No borrar las películas y episodios al cerrar el torrent o la app.", keepFiles),
    ),
    h("div", { class: "settings-save" }, saveBtn),
    updatesGroup(signal, autoUpdate),
    group(
      "Reproductores externos",
      "Opcionales. La app los detecta sola o usa la ruta que indiques.",
      row("Ejecutable de mpv", null, mpvInput, "set-row-field"),
      row("Ejecutable de VLC", null, vlcInput, "set-row-field"),
      row("mpv", h("code", null, MPV_URL), openBtn(MPV_URL)),
      row("VLC", h("code", null, VLC_URL), openBtn(VLC_URL)),
    ),
    group(
      "Acerca de",
      null,
      row("MovWatch", "Interfaz gráfica y motor reescritos en Rust a partir de torrodle (tnychn, MIT).", openBtn("https://github.com/tnychn/torrodle", "torrodle")),
    ),
  );
}

function updatesGroup(signal: AbortSignal, autoUpdate: HTMLInputElement): HTMLElement {
  const version = h("code", null, "…");
  const branch = h("span", { class: "set-desc" });
  getVersion().then(
    (v) => (version.textContent = v),
    () => {},
  );
  const status = h("p", { class: "set-status", attrs: { "aria-live": "polite" } });
  const meter = h("span", { class: "meter set-meter", hidden: true }, h("i"));
  const checkBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-sm",
      onclick: () => {
        checkBtn.disabled = true;
        checkForUpdates(true).catch((e: unknown) => {
          status.className = "set-status set-status-error";
          status.textContent = errMsg(e);
          checkBtn.disabled = false;
        });
      },
    },
    icon("replay"),
    "Buscar",
  );
  const downloadBtn: HTMLButtonElement = h("button", { class: "btn btn-sm btn-primary", hidden: true }, icon("download"), "Descargar");
  const show = (state: UpdateState) => {
    if (signal.aborted) return;
    downloadBtn.hidden = state.estado !== "release";
    if (state.estado === "release") downloadBtn.onclick = () => void openRelease(state.url);
    status.className = state.estado === "error" ? "set-status set-status-error" : "set-status";
    status.textContent = describe(state);
    const busy = state.estado === "buscando" || state.estado === "compilando";
    checkBtn.disabled = busy || state.estado === "lista";
    meter.hidden = state.estado !== "compilando";
    if (state.estado === "compilando") (meter.firstChild as HTMLElement).style.setProperty("--p", String(state.total ? state.paso / state.total : 0));
  };
  Promise.all([installedVersion(), updateChannel()]).then(
    ([info, channel]) => {
      if (signal.aborted) return;
      if (channel === "release") {
        branch.textContent = "Descargada de GitHub Releases: avisa cuando hay una versión nueva.";
        autoUpdate.disabled = true;
        show(updateState());
        return;
      }
      if (!info) {
        branch.textContent = "Compilación de desarrollo: no se actualiza sola.";
        checkBtn.disabled = true;
        autoUpdate.disabled = true;
        return;
      }
      const date = info.fecha ? new Date(info.fecha).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" }) : "";
      branch.textContent = `Commit ${short(info.commit)} · rama ${info.rama}${date ? ` · ${date}` : ""}`;
      show(updateState());
    },
    (e: unknown) => (branch.textContent = errMsg(e)),
  );
  const stop = onUpdate(show);
  signal.addEventListener("abort", stop, { once: true });
  return group(
    "Actualizaciones",
    "Instalada con el comando de instalación, se compila desde main y se actualiza sola al reiniciar. Descargada de GitHub Releases, avisa de cada versión nueva.",
    h(
      "div",
      { class: "set-row" },
      h("div", { class: "set-text" }, h("span", { class: "set-label" }, "Versión instalada ", version), branch),
      h("div", { class: "set-actions" }, downloadBtn, checkBtn),
    ),
    toggleRow("Actualizar automáticamente", "Se aplica al pulsar Guardar cambios.", autoUpdate),
    h("div", { class: "set-status-wrap" }, status, meter),
  );
}
