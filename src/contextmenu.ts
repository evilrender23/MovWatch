// Menú contextual propio (clic derecho), con el aspecto de la app y opciones según lo que
// haya debajo del ratón: un animé, un episodio, el reproductor, un campo de texto, texto
// seleccionado… Sustituye al menú del navegador (Recargar, Inspeccionar, etc.).
//
// Uso: withMenu(elemento, () => [ ...opciones ]). La función se llama en el momento del clic,
// así que las opciones reflejan el estado actual (en tu lista, visto, en pausa…).
import { h, icon, toast, type IconName } from "./ui";

export interface MenuAction {
  label: string;
  icon?: IconName;
  /** Atajo que se muestra a la derecha (sólo informativo). */
  hint?: string;
  /** Marca de opción activa (p. ej. el estado actual en la lista). */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  run: () => void | Promise<void>;
}

/** Una opción, un separador ("-") o un título de grupo ({ title }). */
export type MenuItem = MenuAction | "-" | { title: string };

/** Recibe el elemento exacto pulsado (para menús delegados, p. ej. una rejilla). */
type Provider = (target: Element) => MenuItem[];

const providers = new WeakMap<Element, Provider>();
let globalProvider: Provider = () => [];
let open: { el: HTMLElement; restore: Element | null } | null = null;

/** Asocia opciones de menú contextual a un elemento (y a todo lo que contiene). */
export function withMenu<T extends Element>(el: T, provider: Provider): T {
  providers.set(el, provider);
  return el;
}

/** Opciones que se añaden siempre al final (navegación). */
export function setGlobalMenu(provider: Provider): void {
  globalProvider = provider;
}

const isAction = (item: MenuItem): item is MenuAction => typeof item === "object" && "run" in item;

// ---- Secciones automáticas ----

function editableTarget(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  const el = target instanceof Element ? target.closest("input, textarea") : null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && /^(text|search|url|email|number|password|)$/.test(el.type)) return el;
  return null;
}

function editItems(field: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  const hasSelection = (field.selectionStart ?? 0) !== (field.selectionEnd ?? 0);
  const mod = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const exec = (cmd: string) => () => {
    field.focus();
    document.execCommand(cmd);
  };
  return [
    { label: "Deshacer", icon: "replay", hint: `${mod}Z`, run: exec("undo") },
    "-",
    { label: "Cortar", hint: `${mod}X`, disabled: !hasSelection || field.readOnly, run: exec("cut") },
    { label: "Copiar", icon: "copy", hint: `${mod}C`, disabled: !hasSelection, run: exec("copy") },
    {
      label: "Pegar",
      icon: "paste",
      hint: `${mod}V`,
      disabled: field.readOnly,
      run: async () => {
        field.focus();
        try {
          const text = await navigator.clipboard.readText();
          document.execCommand("insertText", false, text);
        } catch {
          toast(`Usa ${mod}V para pegar.`, "info");
        }
      },
    },
    { label: "Seleccionar todo", hint: `${mod}A`, run: () => field.select() },
    ...(field.value ? ["-" as const, { label: "Borrar", icon: "x" as const, run: () => {
      field.focus();
      field.select();
      document.execCommand("delete");
    } }] : []),
  ];
}

function selectionItems(text: string): MenuItem[] {
  const short = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  return [
    { label: "Copiar", icon: "copy", run: () => copyText(text, false) },
    {
      label: `Buscar «${short}»`,
      icon: "search",
      run: () => {
        window.dispatchEvent(new CustomEvent("mw:search", { detail: text }));
      },
    },
  ];
}

export async function copyText(text: string, notify = true): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Alternativa para WebViews sin permiso de portapapeles.
    const area = h("textarea", { value: text, style: "position:fixed;opacity:0" });
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  if (notify) toast("Copiado al portapapeles.", "ok");
}

// ---- Construcción ----

function collect(event: MouseEvent): MenuItem[] {
  const sections: MenuItem[][] = [];
  const field = editableTarget(event.target);
  const selected = window.getSelection()?.toString().trim() ?? "";
  if (field) sections.push(editItems(field));
  else if (selected) sections.push(selectionItems(selected));

  // El proveedor más cercano al elemento pulsado que tenga algo que ofrecer.
  const target = event.target instanceof Element ? event.target : null;
  if (!field && target) {
    for (let el: Element | null = target; el; el = el.parentElement) {
      const provider = providers.get(el);
      const items = provider ? provider(target) : [];
      if (items.length) {
        sections.push(items);
        break;
      }
    }
  }
  sections.push(target ? globalProvider(target) : []);

  // Une secciones con separadores y quita separadores sobrantes.
  const items: MenuItem[] = [];
  for (const section of sections.filter((s) => s.length)) {
    if (items.length) items.push("-");
    items.push(...section);
  }
  return items.filter((item, i, all) => item !== "-" || (i > 0 && all[i - 1] !== "-" && i < all.length - 1));
}

function close(): void {
  if (!open) return;
  const { el, restore } = open;
  open = null;
  el.classList.add("leaving");
  window.setTimeout(() => el.remove(), 90);
  if (restore instanceof HTMLElement && document.contains(restore)) restore.focus({ preventScroll: true });
}

function show(items: MenuItem[], x: number, y: number): void {
  close();
  const buttons: HTMLButtonElement[] = [];
  const menu = h("div", { class: "ctx", role: "menu", tabIndex: -1 });
  for (const item of items) {
    if (item === "-") {
      menu.append(h("div", { class: "ctx-sep", role: "separator" }));
    } else if (!isAction(item)) {
      menu.append(h("div", { class: "ctx-title" }, item.title));
    } else {
      const btn = h(
        "button",
        {
          class: ["ctx-item", item.danger ? "danger" : "", item.checked ? "checked" : ""].filter(Boolean).join(" "),
          role: item.checked === undefined ? "menuitem" : "menuitemradio",
          disabled: !!item.disabled,
          attrs: item.checked === undefined ? {} : { "aria-checked": String(item.checked) },
          onclick: () => {
            close();
            void Promise.resolve()
              .then(item.run)
              .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), "error"));
          },
          onmouseenter: () => btn.focus({ preventScroll: true }),
        },
        h("span", { class: "ctx-icon" }, item.checked ? icon("check") : item.icon ? icon(item.icon) : null),
        h("span", { class: "ctx-label" }, item.label),
        item.hint ? h("kbd", { class: "ctx-hint" }, item.hint) : null,
      );
      if (!item.disabled) buttons.push(btn);
      menu.append(btn);
    }
  }

  menu.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      buttons[e.key === "Home" ? 0 : buttons.length - 1]?.focus();
    }
  });

  document.body.append(menu);
  // Dentro de la ventana: se abre hacia arriba/izquierda si no cabe.
  const { innerWidth: vw, innerHeight: vh } = window;
  // offsetWidth/Height: sin la escala de la animación de entrada.
  const rect = { width: menu.offsetWidth, height: menu.offsetHeight };
  const left = x + rect.width > vw - 6 ? Math.max(6, x - rect.width) : x;
  const top = y + rect.height > vh - 6 ? Math.max(6, vh - rect.height - 6) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${left < x ? "right" : "left"} ${top < y ? "bottom" : "top"}`;
  open = { el: menu, restore: document.activeElement };
  menu.focus({ preventScroll: true });
}

/** Abre un menú anclado a un botón (debajo o, si no cabe, encima). Sin las opciones globales. */
export function openMenuAt(anchor: HTMLElement, items: MenuItem[]): void {
  if (!items.some(isAction)) return;
  const r = anchor.getBoundingClientRect();
  show(items, r.left, r.bottom + 4);
  if (!open) return;
  const menu = open.el;
  if (r.bottom + 4 + menu.offsetHeight > window.innerHeight - 6) {
    menu.style.top = `${Math.max(6, r.top - menu.offsetHeight - 4)}px`;
    menu.style.transformOrigin = "left bottom";
  }
}

/** Sustituye el menú del navegador en toda la app. */
export function installContextMenu(): void {
  window.addEventListener("contextmenu", (event) => {
    // En desarrollo, Mayúsculas + clic derecho abre el menú del WebView (Inspeccionar).
    if (import.meta.env.DEV && event.shiftKey) return;
    event.preventDefault();
    // Iframes de los reproductores web: no llega el evento, ni hace falta.
    const items = collect(event);
    if (items.some(isAction)) show(items, event.clientX, event.clientY);
  });
  window.addEventListener("pointerdown", (e) => {
    if (open && !open.el.contains(e.target as Node)) close();
  }, true);
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
  // Sólo el scroll del usuario: el de la app (p. ej. centrar el episodio actual) no lo cierra.
  window.addEventListener("wheel", (e) => {
    if (open && !open.el.contains(e.target as Node)) close();
  }, { capture: true, passive: true });
}
