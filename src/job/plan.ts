// Toolpath planning: turn the document into an ordered list of cut and travel segments in bed millimetres.
//
// Per layer (in layer order, output on): collect that colour's paths, order them, repeat the ordered layer once per
// pass (LightBurn sends passes as repeated geometry, see PROTOCOL.md), and join everything with travel moves.
// Ordering is greedy nearest-neighbour from the head position; a closed path may start at any vertex, an open path
// from either end. With `innerFirst`, a closed path is only eligible once every closed path inside it is done.
import { type Box, type Vec, apply, pathsBox, pointInPolygon } from "../geom/geom";
import type { Doc, Layer } from "../scene/model";
import { DEFAULT_FILL, fillPaths } from "./fill";
import { activeLayers } from "./layers";

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** false = travel with the laser off */
  cut: boolean;
  /** index into Toolpath.layers, or -1 for travel */
  layer: number;
}

export interface Toolpath {
  /** Layers that are cut, in order (output on and with paths). */
  layers: Layer[];
  segments: Segment[];
  /** Where the head starts and returns to (internal bed mm). */
  start: Vec;
  /** Problems that make the job unusable (e.g. a fill too dense); a job is not built while any remain. */
  errors: string[];
  /** Things worth knowing that don't block the job (e.g. open paths in a fill layer are not filled). */
  warnings: string[];
}

export interface PlanOptions {
  start: Vec;
  innerFirst: boolean;
}

interface Item {
  pts: Vec[];
  closed: boolean;
  box: Box;
  /** indices of closed items inside this one (innerFirst) */
  inner: number[];
}

/** Above this many closed paths in a layer, skip the O(n²) containment test. */
const INNER_FIRST_LIMIT = 3000;

export function planToolpath(doc: Doc, opts: PlanOptions): Toolpath {
  const layers = activeLayers(doc).filter((l) => l.output);
  const out: Toolpath = { layers: [], segments: [], start: opts.start, errors: [], warnings: [] };
  let pos = opts.start;

  for (const layer of layers) {
    const items: Item[] = [];
    for (const o of doc.objects) {
      for (const p of o.paths) {
        if (p.color !== layer.color || p.points.length < 2) continue;
        const pts = p.points.map((v) => apply(o.mat, v));
        items.push({ pts, closed: p.closed, box: pathsBox([{ points: pts, closed: p.closed }]), inner: [] });
      }
    }
    if (items.length === 0) continue;
    const mode = layer.mode ?? "cut";
    const name = `Layer ${layer.color}`;
    let order: Vec[][] = [];
    let at = pos;
    if (mode !== "cut") {
      // Fill all closed outlines of the layer together (even-odd: holes stay empty).
      const f = fillPaths(items.filter((i) => i.closed).map((i) => i.pts), { ...DEFAULT_FILL, ...layer.fill });
      if (f.error) out.errors.push(`${name}: ${f.error}`);
      if (mode === "fill" && items.some((i) => !i.closed)) out.warnings.push(`${name}: open paths can't be filled and are skipped.`);
      if ((layer.fill?.pattern ?? DEFAULT_FILL.pattern) === "offset") {
        // Contours come out ring by ring; order them nearest-first, each starting at its nearest vertex.
        const rings: Item[] = f.paths.map((p) => {
          const pts = p.slice(0, -1);
          return { pts, closed: true, box: pathsBox([{ points: pts, closed: true }]), inner: [] };
        });
        order = orderItems(rings, at);
      } else order = f.paths;
      if (order.length) at = order.at(-1)!.at(-1)!;
    }
    if (mode !== "fill") {
      if (opts.innerFirst) markInner(items);
      order = [...order, ...orderItems(items, at)];
    }
    if (order.length === 0) continue;

    const li = out.layers.length;
    out.layers.push(layer);
    for (let pass = 0; pass < layer.passes; pass++) {
      for (const pts of order) {
        travel(out.segments, pos, pts[0]!);
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1]!;
          const b = pts[k]!;
          out.segments.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, cut: true, layer: li });
        }
        pos = pts.at(-1)!;
      }
    }
  }
  if (out.segments.length > 0) travel(out.segments, pos, opts.start);
  return out;
}

function travel(segs: Segment[], a: Vec, b: Vec): void {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return;
  segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, cut: false, layer: -1 });
}

function markInner(items: Item[]): void {
  const closed = items.map((it, i) => i).filter((i) => items[i]!.closed && items[i]!.pts.length >= 3);
  if (closed.length > INNER_FIRST_LIMIT) return;
  for (const i of closed) {
    const outer = items[i]!;
    for (const j of closed) {
      if (i === j) continue;
      const inner = items[j]!;
      const b = inner.box;
      const B = outer.box;
      if (b.minX < B.minX || b.minY < B.minY || b.maxX > B.maxX || b.maxY > B.maxY) continue;
      // Equal boxes (duplicate shapes) would each wait for the other: let the lower index count as outer.
      const same = b.minX === B.minX && b.minY === B.minY && b.maxX === B.maxX && b.maxY === B.maxY;
      if (same ? j < i : !pointInPolygon(inner.pts[0]!, outer.pts)) continue;
      outer.inner.push(j);
    }
  }
}

const boxDist = (b: Box, p: Vec) => Math.hypot(Math.max(b.minX - p.x, 0, p.x - b.maxX), Math.max(b.minY - p.y, 0, p.y - b.maxY));

/** Greedy nearest-neighbour order; returns each item's points in cut order (closed paths end where they began). */
function orderItems(items: Item[], from: Vec): Vec[][] {
  const done = new Uint8Array(items.length);
  const ready = (i: number) => items[i]!.inner.every((j) => done[j]);
  const result: Vec[][] = [];
  let pos = from;
  for (let n = 0; n < items.length; n++) {
    let best = -1;
    let bestD = Infinity;
    let bestK = 0;
    for (let i = 0; i < items.length; i++) {
      if (done[i] || !ready(i)) continue;
      const it = items[i]!;
      if (boxDist(it.box, pos) >= bestD) continue;
      const { d, k } = nearestStart(it, pos);
      if (d < bestD) [best, bestD, bestK] = [i, d, k];
    }
    if (best < 0) {
      // Only reachable through a containment cycle; fall back to any remaining item.
      best = done.indexOf(0);
      bestK = 0;
    }
    done[best] = 1;
    const pts = startAt(items[best]!, bestK);
    result.push(pts);
    pos = pts.at(-1)!;
  }
  return result;
}

/** Closed: nearest vertex k. Open: k = 0 (start) or 1 (reverse, start at the end). */
function nearestStart(it: Item, p: Vec): { d: number; k: number } {
  if (!it.closed) {
    const a = it.pts[0]!;
    const b = it.pts.at(-1)!;
    const da = Math.hypot(a.x - p.x, a.y - p.y);
    const db = Math.hypot(b.x - p.x, b.y - p.y);
    return da <= db ? { d: da, k: 0 } : { d: db, k: 1 };
  }
  let d = Infinity;
  let k = 0;
  it.pts.forEach((v, i) => {
    const e = Math.hypot(v.x - p.x, v.y - p.y);
    if (e < d) [d, k] = [e, i];
  });
  return { d, k };
}

function startAt(it: Item, k: number): Vec[] {
  if (!it.closed) return k === 0 ? it.pts : [...it.pts].reverse();
  const pts = it.pts;
  // Drop an explicit closing vertex so the rotation doesn't double it, then close the loop.
  const last = pts.at(-1)!;
  const ring = pts.length > 1 && last.x === pts[0]!.x && last.y === pts[0]!.y ? pts.slice(0, -1) : pts;
  const i = k % ring.length;
  return [...ring.slice(i), ...ring.slice(0, i), ring[i]!];
}
