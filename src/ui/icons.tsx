// Icon buttons (Lucide). Every icon-only control carries its name in `title` (tooltip) and `aria-label`.
import type { LucideIcon } from "lucide-preact";
import { type ComponentChildren, h, render } from "preact";

export const ICON_SIZE = 16;
const STROKE = 1.75;

interface IconButtonProps {
  icon: LucideIcon;
  /** Tooltip and accessible name; include the shortcut if there is one, e.g. "Undo (⌘Z)". */
  label: string;
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  /** Pressed state for toggles. */
  pressed?: boolean;
  class?: string;
  size?: number;
  /** Optional visible text after the icon (kept for a few controls where a word is the clearest face). */
  children?: ComponentChildren;
}

export function IconButton(p: IconButtonProps) {
  const Icon = p.icon;
  return (
    <button
      type="button"
      class={`ib${p.pressed ? " on" : ""}${p.class ? ` ${p.class}` : ""}`}
      title={p.label}
      aria-label={p.label}
      aria-pressed={p.pressed}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <Icon size={p.size ?? ICON_SIZE} strokeWidth={STROKE} aria-hidden="true" />
      {p.children}
    </button>
  );
}

/** An on/off setting shown as an icon that swaps between two glyphs. */
export function IconToggle(p: { on: boolean; onIcon: LucideIcon; offIcon?: LucideIcon; label: string; onChange: (on: boolean) => void; disabled?: boolean; class?: string }) {
  return (
    <IconButton
      icon={p.on ? p.onIcon : (p.offIcon ?? p.onIcon)}
      label={`${p.label}: ${p.on ? "on" : "off"}`}
      pressed={p.on}
      disabled={p.disabled}
      class={p.class}
      onClick={() => p.onChange(!p.on)}
    />
  );
}

/** Icon as a DOM node, for the plain-DOM machine panel. */
export function iconNode(icon: LucideIcon, size = ICON_SIZE): Element {
  const host = document.createElement("span");
  render(h(icon, { size, strokeWidth: STROKE, "aria-hidden": "true" }), host);
  return host.firstElementChild!;
}

/** Turn a plain-DOM button into an icon button with a tooltip (keeps its click handler). */
export function iconify(btn: HTMLButtonElement, icon: LucideIcon, label: string, size = ICON_SIZE): HTMLButtonElement {
  btn.replaceChildren(iconNode(icon, size));
  btn.classList.add("ib");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  return btn;
}
