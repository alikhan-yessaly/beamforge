// Which layer the Layers editor shows. Follows the canvas selection when every selected path has one colour.
import { effect, signal } from "@preact/signals";
import { doc, selection } from "../scene/store";

export const selectedLayer = signal<string | null>(null);

effect(() => {
  const ids = selection.value;
  if (ids.size === 0) return;
  const colors = new Set<string>();
  for (const o of doc.peek().objects) if (ids.has(o.id)) for (const p of o.paths) colors.add(p.color);
  if (colors.size === 1) selectedLayer.value = [...colors][0]!;
});
