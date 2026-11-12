// The Fill tool: click inside a closed shape to engrave that area with the colour picked in the palette (the shapes
// directly inside it stay empty); click a filled area with the same colour to clear it. Esc or I leaves the tool.
import { t } from "../i18n";
import { signal } from "@preact/signals";
import { type Vec, apply, invert } from "../geom/geom";
import { PALETTE, activeLayers, colorsInUse, toggleRegionFill } from "../job/layers";
import { regionAt, regionRings } from "../job/regions";
import { commit, doc, notify } from "../scene/store";
import { selectedLayer } from "./layerSelect";

/** The active Fill tool and its colour, or null when the tool is off. */
export const fillTool = signal<{ color: string } | null>(null);
/** The region under the cursor while the tool is on. */
export const fillHover = signal<{ objectId: string; index: number } | null>(null);

let lastColor: string | null = null;

/** A sensible colour to start with: the last one used, an existing fill layer, or a colour not in use yet. */
function defaultColor(): string {
  const d = doc.value;
  const layers = activeLayers(d);
  if (lastColor && !layers.some((l) => l.color === lastColor && (l.mode ?? "cut") === "cut")) return lastColor;
  const fill = layers.find((l) => (l.mode ?? "cut") === "fill");
  if (fill) return fill.color;
  const taken = new Set([...colorsInUse(d), ...(d.layers ?? []).map((l) => l.color)]);
  return PALETTE.find((c) => !taken.has(c)) ?? PALETTE[1]!;
}

export function startFillTool(): void {
  fillTool.value = { color: defaultColor() };
  notify(t("Fill: pick a colour below, then click inside a shape to engrave it. Click again to clear. Esc ends."));
}

export function stopFillTool(): void {
  fillTool.value = null;
  fillHover.value = null;
}

export const toggleFillTool = () => (fillTool.value ? stopFillTool() : startFillTool());

export function setFillColor(color: string): void {
  if (fillTool.value) fillTool.value = { color };
}

/** The innermost closed shape under a bed point: topmost object first. */
export function regionUnder(bed: Vec): { objectId: string; index: number } | null {
  const objs = doc.value.objects;
  for (let k = objs.length - 1; k >= 0; k--) {
    const o = objs[k]!;
    const i = regionAt(o.paths, apply(invert(o.mat), bed));
    if (i >= 0) return { objectId: o.id, index: i };
  }
  return null;
}

/** The hovered region's rings in bed coordinates (for the canvas preview). */
export function hoverRings(): Vec[][] | null {
  const h = fillHover.value;
  const o = h ? doc.value.objects.find((x) => x.id === h.objectId) : null;
  if (!h || !o || !o.paths[h.index]) return null;
  return regionRings(o.paths, h.index).map((r) => r.map((p) => apply(o.mat, p)));
}

export function fillClick(bed: Vec): void {
  const tool = fillTool.value;
  if (!tool) return;
  const r = regionUnder(bed);
  if (!r) {
    notify(t("Click inside a closed shape."));
    return;
  }
  const res = toggleRegionFill(doc.value, r.objectId, r.index, tool.color);
  if ("error" in res) {
    notify(res.error, "warn");
    return;
  }
  commit(res.doc);
  lastColor = tool.color;
  if (res.created) selectedLayer.value = tool.color;
}
