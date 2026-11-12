import { t } from "../i18n";
import { signal } from "@preact/signals";
import { ModeCut, ModeFill } from "../ui/customIcons";
import { editSketch } from "./sketch/state";
import { PenTool, ClipboardPaste, Copy, CopyPlus, Group, Scissors, Trash2, Ungroup } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { doc, selection } from "../scene/store";
import { actions, clipboard } from "./actions";

export const contextMenu = signal<{ x: number; y: number } | null>(null);

export function ContextMenu() {
  const menu = contextMenu.value;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const element = ref.current;
    if (element) {
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - bounds.width - 4))}px`;
      element.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - bounds.height - 4))}px`;
    }
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) contextMenu.value = null;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { contextMenu.value = null; }
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", key, true); };
  }, [menu]);
  if (!menu) return null;
  const selected = doc.value.objects.filter((o) => selection.value.has(o.id));
  const items = [
    {
      icon: PenTool,
      label: selected.length === 1 && !selected[0]!.sketch ? t("Edit as sketch") : t("Edit sketch"),
      shortcut: t("double-click"),
      enabled: selected.length === 1 && (!!selected[0]!.sketch || (!selected[0]!.children?.length && selected[0]!.paths.length > 0)),
      action: () => void editSketch(selected[0]!),
    },
    { icon: Scissors, label: t("Cut"), shortcut: "⌘/Ctrl X", enabled: selected.length > 0, action: actions.cut },
    { icon: Copy, label: t("Copy"), shortcut: "⌘/Ctrl C", enabled: selected.length > 0, action: actions.copy },
    { icon: ClipboardPaste, label: t("Paste"), shortcut: "⌘/Ctrl V", enabled: clipboard.value.length > 0, action: actions.paste },
    { icon: CopyPlus, label: t("Duplicate"), shortcut: "⌘/Ctrl D", enabled: selected.length > 0, action: actions.duplicate },
    { icon: Trash2, label: t("Delete"), shortcut: "Del", enabled: selected.length > 0, action: actions.delete },
    { icon: ModeCut, label: t("Cut (outline)"), shortcut: "", enabled: selected.length > 0, action: () => actions.setMode("cut") },
    { icon: ModeFill, label: t("Fill (engrave inside)"), shortcut: "", enabled: selected.length > 0, action: () => actions.setMode("fill") },
    { icon: Group, label: t("Group"), shortcut: "⌘/Ctrl G", enabled: selected.length > 1, action: actions.group },
    { icon: Ungroup, label: t("Ungroup one level"), shortcut: "⇧ ⌘/Ctrl G", enabled: selected.some((o) => !!o.children?.length || o.paths.length > 1), action: actions.ungroup },
  ];
  return (
    <div ref={ref} class="ws-context-menu" role="menu" aria-label={t("Object actions")} style={{ left: `${menu.x}px`, top: `${menu.y}px` }}>
      {items.map((item) => (
        <button role="menuitem" disabled={!item.enabled} onClick={() => { contextMenu.value = null; item.action(); }}>
          <item.icon size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{item.label}</span>
          <small>{item.shortcut}</small>
        </button>
      ))}
    </div>
  );
}
