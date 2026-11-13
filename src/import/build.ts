// Turn parsed vector paths into one scene object, with each source colour snapped to a layer colour.
//
// A stroked path becomes a cut path in its stroke's layer colour. A filled closed area becomes either an
// engraved area (a path on a fill layer, or an area fill under a stroked outline: ScenePath.fill), an outline to
// cut, or is dropped, as the user picks. Pure: the import dialog shows and edits the choices made here.
import { msg } from "../i18n";
import { type Vec, pathsBox, translate } from "../geom/geom";
import { activeLayers } from "../job/layers";
import { PALETTE } from "../job/layers";
import { type Doc, type MachineProfile, type SceneObject, type ScenePath, newId } from "../scene/model";
import type { VecPath, VectorImport } from "./types";

export type FillsAs = "engrave" | "outline" | "ignore";

/** One source colour and the layer colour it goes to (null = skip those paths). */
export interface ColorChoice {
  /** "s:#rrggbb" for strokes, "f:#rrggbb" for fills. */
  key: string;
  kind: "stroke" | "fill";
  source: string;
  /** Number of paths using it. */
  count: number;
  target: string | null;
}

// ---------- Colour distance (CIELAB, so "nearest" matches what people see) ----------

function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIELAB distance with lightness at half weight: layer colours are categories, so hue matters more than shade. */
export function colorDistance(a: string, b: string): number {
  const p = lab(a), q = lab(b);
  return Math.hypot((p[0] - q[0]) * 0.5, p[1] - q[1], p[2] - q[2]);
}

/** Near-white colours are usually backgrounds or paper, not something to cut. */
export const isNearWhite = (hex: string) => lab(hex)[0] > 94;

/** The palette colour nearest to `hex`, preferring ones not in `avoid`. */
export function nearestPalette(hex: string, avoid: ReadonlySet<string> = new Set()): string {
  let best = PALETTE[0]!, bestD = Infinity;
  for (const c of PALETTE) {
    const d = colorDistance(hex, c) + (avoid.has(c) ? 1000 : 0);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ---------- Choices ----------

/**
 * The colours in a file with a default layer colour for each: strokes snap to the nearest palette colour; fills
 * snap to the nearest palette colour that isn't already a cut colour (a layer either cuts or fills). Near-white
 * fills are skipped by default.
 */
export function defaultChoices(vi: VectorImport, doc: Doc): ColorChoice[] {
  const counts = new Map<string, ColorChoice>();
  const add = (kind: "stroke" | "fill", source: string) => {
    const key = `${kind[0]}:${source}`;
    const c = counts.get(key);
    if (c) c.count++;
    else counts.set(key, { key, kind, source, count: 1, target: null });
  };
  for (const p of vi.paths) {
    if (p.stroke) add("stroke", p.stroke);
    if (p.fill && p.closed) add("fill", p.fill);
  }
  const list = [...counts.values()].sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === "stroke" ? -1 : 1));
  const layers = activeLayers(doc);
  const cutNow = new Set(layers.filter((l) => (l.mode ?? "cut") === "cut").map((l) => l.color));
  const fillNow = new Set(layers.filter((l) => (l.mode ?? "cut") !== "cut").map((l) => l.color));
  const strokeTargets = new Set<string>();
  for (const c of list.filter((x) => x.kind === "stroke")) {
    c.target = nearestPalette(c.source, fillNow);
    strokeTargets.add(c.target);
  }
  const avoid = new Set([...cutNow, ...strokeTargets]);
  for (const c of list.filter((x) => x.kind === "fill")) c.target = isNearWhite(c.source) ? null : nearestPalette(c.source, avoid);
  return list;
}

/** Layer colours that would be asked to both cut and fill (the fill-only shapes then get cut instead). */
export function conflicts(choices: ColorChoice[], fills: FillsAs, doc: Doc): Set<string> {
  if (fills !== "engrave") return new Set();
  const cut = new Set(choices.filter((c) => c.kind === "stroke" && c.target).map((c) => c.target!));
  for (const l of activeLayers(doc)) if ((l.mode ?? "cut") === "cut") cut.add(l.color);
  return new Set(choices.filter((c) => c.kind === "fill" && c.target && cut.has(c.target)).map((c) => c.target!));
}

export interface BuiltImport {
  object: SceneObject | null;
  /** Layer colours that must be fill layers (filled shapes engraved without an outline). */
  fillLayers: string[];
  warnings: string[];
}

/**
 * Build the scene object: paths in local mm (origin at the drawing's top-left), scaled by `scale`, centred on
 * the bed. Paths whose colours are all skipped are left out.
 */
export function buildObject(vi: VectorImport, choices: ColorChoice[], opts: { fills: FillsAs; scale?: number; name: string }, profile: MachineProfile, doc: Doc): BuiltImport {
  const target = new Map(choices.map((c) => [c.key, c.target]));
  const clash = conflicts(choices, opts.fills, doc);
  const k = opts.scale ?? 1;
  const out: ScenePath[] = [];
  const fillLayers = new Set<string>();
  for (const p of vi.paths) {
    const pts = p.points;
    if (pts.length < 2) continue;
    const s = p.stroke ? (target.get(`s:${p.stroke}`) ?? null) : null;
    const f = p.fill && p.closed ? (target.get(`f:${p.fill}`) ?? null) : null;
    const closed = p.closed && pts.length >= 3;
    const path = (color: string, fill?: string): ScenePath => ({ color, closed, points: pts, ...(fill ? { fill } : {}) });
    if (s) {
      // Stroked: cut the outline; an engraved fill under it rides along as an area fill.
      const area = f && opts.fills === "engrave" && closed && !clash.has(f) ? f : undefined;
      out.push(path(s, area));
      if (area) fillLayers.add(area);
      continue;
    }
    if (!f || opts.fills === "ignore") continue;
    if (opts.fills === "outline" || clash.has(f)) out.push(path(f));
    else {
      out.push(path(f));
      fillLayers.add(f);
    }
  }
  if (out.length === 0) return { object: null, fillLayers: [], warnings: [...vi.warnings, msg("Nothing to import: every colour is skipped.")] };
  const b = pathsBox(out);
  const local = out.map((p) => ({ ...p, points: p.points.map((v: Vec) => ({ x: (v.x - b.minX) * k, y: (v.y - b.minY) * k })) }));
  const w = (b.maxX - b.minX) * k, h = (b.maxY - b.minY) * k;
  const warnings = [...vi.warnings];
  return {
    object: { id: newId(), name: opts.name, paths: local, mat: translate((profile.bedW - w) / 2, (profile.bedH - h) / 2) },
    fillLayers: [...fillLayers],
    warnings,
  };
}

/** Size of the drawing (mm, before scaling) over the paths the choices keep. */
export function keptSize(vi: VectorImport): { w: number; h: number } {
  const b = pathsBox(vi.paths.filter((p: VecPath) => p.points.length > 1));
  return { w: Math.max(0, b.maxX - b.minX), h: Math.max(0, b.maxY - b.minY) };
}
