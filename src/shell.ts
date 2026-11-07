// Barra de ruta ("migas") del panel principal. Cada vista declara dónde está
// con setCrumbs(); el shell (main.ts) monta el contenedor con mountCrumbs().
import { h } from "./ui";

export type Crumb = string | { label: string; onClick: () => void };

let host: HTMLElement | null = null;

export function mountCrumbs(el: HTMLElement): void {
  host = el;
}

export function setCrumbs(...parts: Crumb[]): void {
  if (!host) return;
  const nodes: Node[] = [];
  parts.forEach((part, i) => {
    if (i > 0) nodes.push(h("span", { class: "crumb-sep", attrs: { "aria-hidden": "true" } }, "/"));
    const last = i === parts.length - 1;
    if (typeof part === "string") {
      nodes.push(h("span", { class: last ? "crumb crumb-current" : "crumb" }, part));
    } else {
      nodes.push(h("button", { class: "crumb crumb-link", onclick: part.onClick }, part.label));
    }
  });
  host.replaceChildren(...nodes);
  const lastPart = parts[parts.length - 1];
  document.title = lastPart ? `${typeof lastPart === "string" ? lastPart : lastPart.label} — MovWatch` : "MovWatch";
}
