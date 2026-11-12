// Layers: cut settings keyed by path colour. Pure functions over the document.
import { DEFAULT_LAYER, type Doc, type Layer, type LayerMode, type SceneObject, type ScenePath } from "../scene/model";
import { DEFAULT_FILL } from "./fill";
import { closedEntityIds, sketchPaths, textReady } from "../sketch/paths";

/** Colours used by the document's paths, in first-seen order. */
export function colorsInUse(doc: Doc): string[] {
  const seen = new Set<string>();
  for (const o of doc.objects) for (const p of o.paths) seen.add(p.color);
  return [...seen];
}

/**
 * The layers the document uses, in cut order: colours that already have settings keep their stored order,
 * new colours follow with default settings in first-seen order.
 */
export function activeLayers(doc: Doc): Layer[] {
  const used = new Set(colorsInUse(doc));
  const stored = (doc.layers ?? []).filter((l) => used.has(l.color));
  const have = new Set(stored.map((l) => l.color));
  const fresh = [...used].filter((c) => !have.has(c)).map((color) => ({ ...DEFAULT_LAYER, color }));
  return [...stored, ...fresh];
}

/** A view of the document containing only visible paths, without changing its cut settings. */
export function visibleDocument(doc: Doc): Doc {
  const hidden = new Set((doc.layers ?? []).filter((l) => l.show === false).map((l) => l.color));
  if (!hidden.size) return doc;
  return {
    ...doc,
    objects: doc.objects
      .map((o) => ({ ...o, paths: o.paths.filter((p) => !hidden.has(p.color)) }))
      .filter((o) => o.paths.length > 0),
  };
}

/** Write `active` back as the stored order, keeping settings of colours not in use any more at the end. */
function withActive(doc: Doc, active: Layer[]): Doc {
  const keep = new Set(active.map((l) => l.color));
  return { ...doc, layers: [...active, ...(doc.layers ?? []).filter((l) => !keep.has(l.color))] };
}

/** Whether corner power follows power. Older layers without the flag count as linked when the two are equal. */
export const powerLinked = (l: Pick<Layer, "minPower" | "maxPower" | "linkPower">) => l.linkPower ?? l.minPower === l.maxPower;

export function updateLayer(doc: Doc, color: string, patch: Partial<Omit<Layer, "color">>): Doc {
  const active = activeLayers(doc);
  if (!active.some((l) => l.color === color)) return doc;
  const apply = (l: Layer) => {
    const merged = { ...l, ...patch };
    // Setting a corner power different from power explicitly means "not linked".
    if ("minPower" in patch && patch.linkPower === undefined && merged.minPower !== merged.maxPower) merged.linkPower = false;
    if (powerLinked(merged)) merged.minPower = merged.maxPower;
    return clampLayer(merged);
  };
  return withActive(doc, active.map((l) => (l.color === color ? apply(l) : l)));
}

/** Move a layer one step earlier (-1) or later (+1) in the cut order. */
export function moveLayer(doc: Doc, color: string, dir: -1 | 1): Doc {
  const active = activeLayers(doc);
  const i = active.findIndex((l) => l.color === color);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= active.length) return doc;
  const next = [...active];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return withActive(doc, next);
}

/** Keep values in range. Power is the main number: corner power is capped at it, never the other way round. */
export function clampLayer(l: Layer): Layer {
  const pct = (v: number) => Math.min(100, Math.max(0, v));
  const maxPower = pct(l.maxPower);
  return {
    ...l,
    speed: Math.max(0.1, l.speed),
    minPower: Math.min(pct(l.minPower), maxPower),
    maxPower,
    passes: Math.max(1, Math.min(99, Math.round(l.passes))),
  };
}

// ---------- Cut / fill quick actions ----------

/** LightBurn-style layer palette; new layers take the first colour not in use. */
export const PALETTE = [
  "#000000", "#0000ff", "#ff0000", "#00e000", "#d0d000", "#ff8000", "#00e0e0", "#ff00ff", "#b4b4b4", "#0000a0",
  "#a00000", "#00a000", "#a0a000", "#c08000", "#00a0ff", "#a000a0", "#808080", "#7d87b9", "#bb7784", "#4a6fe3",
  "#d33f6a", "#8cd78c", "#f0b98d", "#f6c4e1", "#fa9ed4", "#500a78", "#b45a00", "#004754", "#86fa88", "#ffdb66",
];

/** Settings for a layer created by "Fill selection": typical engraving speed and power, line fill. */
export const NEW_FILL_LAYER: Partial<Layer> = { mode: "fill", speed: 100, minPower: 15, maxPower: 15, linkPower: true, fill: { ...DEFAULT_FILL } };

function recolor(o: SceneObject, pick: (p: ScenePath) => boolean, color: string): { obj: SceneObject; changed: number } {
  if (o.sketch) return recolorSketch(o, pick, color);
  let changed = 0;
  const paths = o.paths.map((p) => {
    if (!pick(p) || p.color === color) return p;
    changed++;
    return { ...p, color };
  });
  const children = o.children?.map((c) => recolor(c, pick, color).obj);
  return { obj: { ...o, paths, ...(children ? { children } : {}) }, changed };
}

/**
 * Move the selected objects' paths to the layer of `color` (palette click). A fill layer takes closed paths only.
 * A colour with no paths yet becomes a layer: with its earlier stored settings if it had some, else `newLayer`
 * on top of the defaults. Returns null when nothing would change.
 */
export function assignColor(
  doc: Doc,
  ids: ReadonlySet<string>,
  color: string,
  newLayer: Partial<Omit<Layer, "color">> = {},
): { doc: Doc; created: boolean } | null {
  const active = activeLayers(doc);
  const inUse = active.find((l) => l.color === color);
  const stored = (doc.layers ?? []).find((l) => l.color === color);
  const mode = (inUse ?? stored)?.mode ?? newLayer.mode ?? "cut";
  const pick = mode === "cut" ? () => true : (p: ScenePath) => p.closed && p.points.length >= 3;
  let changed = 0;
  const objects = doc.objects.map((o) => {
    if (!ids.has(o.id)) return o;
    const r = recolor(o, pick, color);
    changed += r.changed;
    return r.obj;
  });
  if (changed === 0) return null;
  let next: Doc = { ...doc, objects };
  if (!inUse && !stored && Object.keys(newLayer).length) next = updateLayer(next, color, newLayer);
  return { doc: next, created: !inUse };
}

/**
 * Move the selected objects' paths to a layer of the given mode: the first such layer, or a new one (new fill
 * layers go first in the cut order, so engraving happens before cutting). Fill takes closed paths only.
 * Returns null when nothing would change.
 */
export function assignMode(doc: Doc, ids: ReadonlySet<string>, mode: LayerMode): { doc: Doc; color: string; created: boolean } | null {
  const active = activeLayers(doc);
  const existing = active.find((l) => (l.mode ?? "cut") === mode);
  const taken = new Set([...colorsInUse(doc), ...(doc.layers ?? []).map((l) => l.color)]);
  const color = existing?.color ?? PALETTE.find((c) => !taken.has(c)) ?? PALETTE[0]!;
  const settings = mode === "cut" ? { mode } : mode === "fill" ? NEW_FILL_LAYER : { ...NEW_FILL_LAYER, mode };
  const r = assignColor(doc, ids, color, settings);
  if (!r) return null;
  let next = r.doc;
  if (!existing && mode !== "cut") {
    const order = activeLayers(next);
    const i = order.findIndex((l) => l.color === color);
    next = withActive(next, [order[i]!, ...order.filter((_, k) => k !== i)]);
  }
  return { doc: next, color, created: !existing };
}

/** Sketch objects: recolour entities (paths are regenerated from them). Fill picks closed loops only. */
function recolorSketch(o: SceneObject, pick: (p: ScenePath) => boolean, color: string): { obj: SceneObject; changed: number } {
  const s = o.sketch!;
  const closedOnly = !pick({ color: "", closed: false, points: [] });
  const closed = closedOnly ? closedEntityIds(s) : null;
  let changed = 0;
  const entities = s.entities.map((e) => {
    if (e.construction || e.kind === "point" || (closed && !closed.has(e.id)) || (e.color ?? s.color) === color) return e;
    changed++;
    return { ...e, color };
  });
  if (!changed) return { obj: o, changed };
  const sketch = { ...s, entities };
  // A text font not loaded yet: keep the stored outlines and just recolour them (no text may go missing).
  if (!textReady(sketch)) return { obj: { ...o, sketch, paths: o.paths.map((p) => (pick(p) ? { ...p, color } : p)) }, changed };
  return { obj: { ...o, sketch, paths: sketchPaths(sketch) }, changed };
}
