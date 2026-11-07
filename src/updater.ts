// Actualizaciones sin releases (como en Mod Engine): la app instalada con instalar.sh /
// instalar.ps1 sabe de qué commit de `main` salió; el backend hace `git fetch`, relanza el
// instalador para compilar la versión nueva en segundo plano y avisa con el evento
// "actualizacion". Al cerrar la app, el instalador cambia a la versión nueva y la reabre.
// Las copias descargadas de GitHub Releases sólo avisan del release nuevo y abren su página.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { errMsg, h, icon, toast } from "./ui";

export interface InstalledVersion {
  commit: string;
  rama: string;
  fecha: string | null;
}

export interface Commit {
  sha: string;
  mensaje: string | null;
  fecha: string | null;
}

export type UpdateState =
  | { estado: "inactiva" }
  | { estado: "buscando" }
  | { estado: "al_dia" }
  | { estado: "nueva"; ultimo: Commit }
  | { estado: "compilando"; paso: number; total: number; texto: string }
  | { estado: "lista"; commit: string }
  | { estado: "release"; version: string; url: string; titulo: string | null }
  | { estado: "error"; mensaje: string };

type Listener = (state: UpdateState) => void;

let current: UpdateState = { estado: "inactiva" };
const listeners = new Set<Listener>();
let card: HTMLElement | null = null;
/** El aviso de "lista" se cerró con "Más tarde": no se vuelve a mostrar solo. */
let dismissed = false;

export const short = (commit: string) => commit.slice(0, 7);

/** Versión instalada; null en una compilación de desarrollo. */
export const installedVersion = () => invoke<InstalledVersion | null>("update_info");

/** Instalador (se actualiza sola), release (avisa de releases nuevos) o desarrollo. */
export type UpdateChannel = "instalador" | "release" | "desarrollo";
export const updateChannel = () => invoke<UpdateChannel>("update_channel");

/** Abre la página del release nuevo para descargarlo. */
export const openRelease = (url: string) => openUrl(url).catch((e: unknown) => toast(errMsg(e), "error"));

/** Busca (y, si `install`, compila) la versión nueva. El resultado llega por onUpdate. */
export const checkForUpdates = (install: boolean) => invoke<void>("update_check", { install });

export const applyUpdate = () => invoke<void>("update_apply");

export function updateState(): UpdateState {
  return current;
}

/** Escucha los cambios de estado; devuelve la función para dejar de escuchar. */
export function onUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(state: UpdateState): void {
  current = state;
  listeners.forEach((fn) => fn(state));
  renderCard();
}

/** Monta el aviso de la barra lateral y se suscribe al estado del backend. */
export function mountUpdater(host: HTMLElement): void {
  card = host;
  void listen<UpdateState>("actualizacion", (event) => set(event.payload)).catch((e: unknown) =>
    console.warn("listen actualizacion", e),
  );
  invoke<UpdateState>("update_state").then(set, (e: unknown) => console.warn("update_state", e));
}

/** Texto corto para un estado (ajustes y aviso). */
export function describe(state: UpdateState): string {
  switch (state.estado) {
    case "buscando":
      return "Buscando actualizaciones…";
    case "al_dia":
      return "Tienes la última versión.";
    case "nueva":
      return `Hay una versión nueva (${short(state.ultimo.sha)}${state.ultimo.mensaje ? `: ${state.ultimo.mensaje}` : ""}).`;
    case "compilando":
      return state.total ? `Compilando la versión nueva · paso ${state.paso} de ${state.total}: ${state.texto}` : "Preparando la versión nueva…";
    case "lista":
      return `La versión ${state.commit} está lista. Se instala al reiniciar la app.`;
    case "release":
      return `Hay una versión nueva: ${state.version}. Descárgala desde GitHub.`;
    case "error":
      return state.mensaje;
    default:
      return "";
  }
}

function renderCard(): void {
  const host = card;
  if (!host) return;
  const state = current;
  if (state.estado === "compilando") {
    // Progreso discreto mientras compila en segundo plano.
    const fraction = state.total ? state.paso / state.total : 0;
    host.replaceChildren(
      h("span", { class: "update-icon" }, icon("download")),
      h(
        "div",
        { class: "update-text" },
        h("strong", { class: "update-title" }, "Actualizando"),
        h("span", { class: "update-desc" }, state.texto || "Preparando…"),
        h("span", { class: "meter" }, h("i", { style: `--p:${fraction}` })),
      ),
    );
    host.hidden = false;
    return;
  }
  if (state.estado === "release" && !dismissed) {
    host.replaceChildren(
      h("span", { class: "update-icon" }, icon("sparkle")),
      h(
        "div",
        { class: "update-text" },
        h("strong", { class: "update-title" }, `Versión ${state.version} disponible`),
        h("span", { class: "update-desc" }, "Descarga el instalador nuevo. Tu lista, historial y ajustes se conservan."),
      ),
      h(
        "div",
        { class: "update-actions" },
        h("button", { class: "btn btn-primary btn-sm", onclick: () => void openRelease(state.url) }, icon("download"), "Descargar"),
        h("button", { class: "btn btn-ghost btn-sm", onclick: () => { dismissed = true; host.hidden = true; } }, "Más tarde"),
      ),
    );
    host.hidden = false;
    return;
  }
  if (state.estado !== "lista" || dismissed) {
    host.hidden = true;
    return;
  }
  const installBtn: HTMLButtonElement = h(
    "button",
    {
      class: "btn btn-primary btn-sm",
      onclick: async () => {
        installBtn.disabled = true;
        try {
          await applyUpdate();
        } catch (e) {
          installBtn.disabled = false;
          toast(`No se pudo reiniciar: ${errMsg(e)}`, "error");
        }
      },
    },
    icon("replay"),
    "Reiniciar y actualizar",
  );
  host.replaceChildren(
    h("span", { class: "update-icon" }, icon("sparkle")),
    h(
      "div",
      { class: "update-text" },
      h("strong", { class: "update-title" }, `Versión ${state.commit} lista`),
      h("span", { class: "update-desc" }, "Se instala al reiniciar. Tu lista, historial y ajustes se conservan."),
    ),
    h(
      "div",
      { class: "update-actions" },
      installBtn,
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          onclick: () => {
            dismissed = true;
            host.hidden = true;
          },
        },
        "Más tarde",
      ),
    ),
  );
  host.hidden = false;
}
