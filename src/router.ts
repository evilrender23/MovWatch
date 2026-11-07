// Enrutador mínimo basado en una pila de vistas.
// Cada vista renderiza en un contenedor y puede devolver una función de limpieza;
// al salir de la vista se aborta su `signal` y se ejecuta la limpieza.

import { errMsg, errorBox } from "./ui";

export type Cleanup = () => void;

export interface ViewContext {
  /** Se aborta cuando la vista deja de estar activa. */
  signal: AbortSignal;
}

export type Section = "home" | "movies" | "series" | "search" | "detail" | "sources" | "player" | "settings" | "list" | "downloads";

export interface Route {
  /** Identifica la vista y sus parámetros (p. ej. `detail:<url>`). */
  key: string;
  section: Section;
  render(root: HTMLElement, ctx: ViewContext): Cleanup | void;
}

type Listener = (route: Route, canGoBack: boolean) => void;

const MAX_STACK = 50;

class Router {
  private stack: Route[] = [];
  private root: HTMLElement | null = null;
  private active: { ctrl: AbortController; cleanup: Cleanup | void } | null = null;
  private listeners: Listener[] = [];

  mount(root: HTMLElement, initial: Route): void {
    this.root = root;
    this.stack = [initial];
    this.show();
  }

  get canGoBack(): boolean {
    return this.stack.length > 1;
  }

  /**
   * Abre una vista. Si ya es la actual se vuelve a renderizar; si es la anterior
   * en la pila se vuelve a ella (evita ciclos detalle → reproductor → detalle).
   */
  navigate(route: Route): void {
    const n = this.stack.length;
    if (n > 0 && this.stack[n - 1].key === route.key) {
      this.stack[n - 1] = route;
    } else if (n > 1 && this.stack[n - 2].key === route.key) {
      this.stack.pop();
      this.stack[n - 2] = route;
    } else {
      this.stack.push(route);
      if (this.stack.length > MAX_STACK) this.stack.splice(0, this.stack.length - MAX_STACK);
    }
    this.show();
  }

  /** Sustituye la vista actual sin añadir historial (p. ej. siguiente episodio). */
  replace(route: Route): void {
    if (this.stack.length === 0) this.stack.push(route);
    else this.stack[this.stack.length - 1] = route;
    this.show();
  }

  back(): void {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    this.show();
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener);
  }

  private teardown(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    active.ctrl.abort();
    try {
      active.cleanup?.();
    } catch (e) {
      console.error("Error al cerrar la vista", e);
    }
  }

  private show(): void {
    const root = this.root;
    const route = this.stack[this.stack.length - 1];
    if (!root || !route) return;
    this.teardown();
    root.replaceChildren();
    window.scrollTo(0, 0);
    const ctrl = new AbortController();
    const active: { ctrl: AbortController; cleanup: Cleanup | void } = { ctrl, cleanup: undefined };
    this.active = active;
    try {
      active.cleanup = route.render(root, { signal: ctrl.signal });
    } catch (e) {
      console.error(e);
      root.replaceChildren(errorBox(errMsg(e), () => this.show()));
    }
    for (const listener of this.listeners) listener(route, this.canGoBack);
  }
}

export const router = new Router();
