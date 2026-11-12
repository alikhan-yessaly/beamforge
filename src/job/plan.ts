// Toolpath planning: turn the document into an ordered list of cut and travel segments in bed millimetres.
//
// Per layer (in layer order, output on): collect that colour's paths, order them, and cut each shape with all of the
// layer's passes before moving on (passes are repeated geometry, see PROTOCOL.md); join everything with travel.
// Open paths that meet end to end are joined first. Ordering is greedy nearest-neighbour from the head, then 2-opt;
// a closed path may start at any vertex, an open path from either end. With `innerFirst`, a closed path is only
// eligible once every closed path inside it is done (so a part is never cut free before its holes).
import { t } from "../i18n";
import { type Box, type Vec, apply, pathsBox, pointInPolygon } from "../geom/geom";
import type { Doc, Layer } from "../scene/model";
import { DEFAULT_FILL, type FillSettings, MAX_FILL_PATHS, fillIslands, fillPaths, tooDenseMessage } from "./fill";
import { regionRings } from "./regions";
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
    let items: Item[] = [];
    // Fill regions for this colour: the layer's own closed shapes (one even-odd group, as before) and every
    // region tagged with it by the Fill tool (its outline minus the closed paths directly inside it).
    const legacy: Vec[][] = [];
    const regions: Vec[][][] = [];
    for (const o of doc.objects) {
      o.paths.forEach((p, i) => {
        if (p.fill === layer.color && p.closed && p.points.length >= 3) regions.push(regionRings(o.paths, i).map((r) => r.map((v) => apply(o.mat, v))));
        if (p.color !== layer.color || p.points.length < 2) return;
        const pts = p.points.map((v) => apply(o.mat, v));
        items.push({ pts, closed: p.closed, box: pathsBox([{ points: pts, closed: p.closed }]), inner: [] });
        if (p.closed) legacy.push(pts);
      });
    }
    if (items.length === 0 && regions.length === 0) continue;
    const mode = layer.mode ?? "cut";
    const name = t("Layer {color}", { color: layer.color });
    // Units are done one after another, each with all of the layer's passes before the next.
    const units: Vec[][][] = [];
    let at = pos;
    if (mode === "cut" && regions.length) out.warnings.push(t("{layer} is a cut layer: its filled regions are skipped. Set the layer to Fill.", { layer: name }));
    if (mode !== "cut") {
      const groups = mode === "fill" || mode === "fillCut" ? [legacy, ...regions] : regions;
      const f = fillUnits(groups, { ...DEFAULT_FILL, ...layer.fill }, at);
      if (f.error) out.errors.push(`${name}: ${f.error}`);
      if (mode === "fill" && items.some((i) => !i.closed)) out.warnings.push(t("{layer}: open paths can't be filled and are skipped.", { layer: name }));
      units.push(...f.units);
      if (units.length) at = units.at(-1)!.at(-1)!.at(-1)!;
    }
    if (mode !== "fill") {
      items = joinOpenPaths(items);
      if (opts.innerFirst) markInner(items);
      for (const pts of orderItems(items, at)) units.push([pts]);
    }
    if (units.length === 0) continue;

    const li = out.layers.length;
    out.layers.push(layer);
    for (const unit of units) {
      for (let pass = 0; pass < layer.passes; pass++) {
        for (const path of unit) {
          // A lone open path is cut back and forth on alternate passes instead of travelling back to its start.
          const pts = unit.length === 1 && pass % 2 === 1 && !samePoint(path[0]!, path.at(-1)!) ? [...path].reverse() : path;
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
  }
  if (out.segments.length > 0) travel(out.segments, pos, opts.start);
  return out;
}

/**
 * Fill units: the filled areas ("islands") grouped into clusters swept together when that's quicker, each cluster
 * hatched separately (all passes before the next), nearest first, entered from its nearer end. Offset contours go
 * island by island.
 *
 * When to sweep two islands as one: they share rows across the scan direction. Together, every shared row jumps the
 * gap between them; apart, the head jumps between them once. So: together when shared rows × gap < that one jump.
 */
export function fillUnits(groups: Vec[][][], s: FillSettings, from: Vec): { units: Vec[][][]; error?: string } {
  const islands = fillIslands(groups);
  if (!islands.length) return { units: [] };
  const clusters = s.pattern === "offset" ? islands.map((i) => [i]) : clusterIslands(islands, s);
  const cand: Vec[][][] = [];
  let total = 0;
  for (const cl of clusters) {
    const f = fillPaths(cl.flat(), s);
    if (f.error) return { units: [], error: f.error };
    total += f.paths.length;
    if (total > MAX_FILL_PATHS) return { units: [], error: tooDenseMessage() };
    if (!f.paths.length) continue;
    if (s.pattern === "offset") {
      const rings: Item[] = f.paths.map((p) => {
        const pts = p.slice(0, -1);
        return { pts, closed: true, box: pathsBox([{ points: pts, closed: true }]), inner: [] };
      });
      cand.push(orderItems(rings, rings[0]!.pts[0]!));
    } else cand.push(f.paths);
  }
  // Nearest cluster next; each may run as hatched or fully reversed, whichever starts nearer.
  const units: Vec[][][] = [];
  const used = new Uint8Array(cand.length);
  let pos = from;
  const d = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
  for (let n = 0; n < cand.length; n++) {
    let best = -1;
    let bestD = Infinity;
    let bestRev = false;
    cand.forEach((c, i) => {
      if (used[i]) return;
      const fwd = d(pos, c[0]![0]!);
      const rev = d(pos, c.at(-1)!.at(-1)!);
      if (fwd < bestD) [best, bestD, bestRev] = [i, fwd, false];
      if (rev < bestD) [best, bestD, bestRev] = [i, rev, true];
    });
    used[best] = 1;
    const c = cand[best]!;
    const unit = bestRev ? [...c].reverse().map((p) => [...p].reverse()) : c;
    units.push(unit);
    pos = unit.at(-1)!.at(-1)!;
  }
  return { units };
}

/** Above this many islands, sweep them all as one (the pairwise test is O(n²)). */
const CLUSTER_LIMIT = 2000;

function clusterIslands(islands: Vec[][][], s: FillSettings): Vec[][][][] {
  if (islands.length > CLUSTER_LIMIT) return [islands];
  const a = (-s.angle * Math.PI) / 180;
  const [c, sn] = [Math.cos(a), Math.sin(a)];
  // Each island's extent in the scan frame (rows run along x).
  const box = islands.map((isl) => {
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of isl[0]!) {
      const x = p.x * c - p.y * sn;
      const y = p.x * sn + p.y * c;
      [x0, x1, y0, y1] = [Math.min(x0, x), Math.max(x1, x), Math.min(y0, y), Math.max(y1, y)];
    }
    return { x0, x1, y0, y1 };
  });
  const parent = islands.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const interval = Math.max(0.01, s.interval);
  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      const [A, B] = [box[i]!, box[j]!];
      const shared = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
      if (shared <= 0) continue;
      const gap = Math.max(0, B.x0 - A.x1, A.x0 - B.x1);
      const jump = Math.hypot((A.x0 + A.x1 - B.x0 - B.x1) / 2, (A.y0 + A.y1 - B.y0 - B.y1) / 2);
      if ((shared / interval) * gap < jump) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Vec[][][]>();
  islands.forEach((isl, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), isl]));
  return [...groups.values()];
}

const JOIN = 1e-3; // mm: open paths whose ends are this close are cut as one
const samePoint = (a: Vec, b: Vec, eps = 1e-9) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/** Join open paths that meet end to end (e.g. a DXF of separate lines) so they are cut in one go; closed loops close. */
function joinOpenPaths(items: Item[]): Item[] {
  const open = items.filter((i) => !i.closed);
  if (open.length < 2) return items;
  const key = (p: Vec) => `${Math.round(p.x / JOIN)},${Math.round(p.y / JOIN)}`;
  const byEnd = new Map<string, number[]>();
  open.forEach((it, i) => {
    for (const p of [it.pts[0]!, it.pts.at(-1)!]) byEnd.set(key(p), [...(byEnd.get(key(p)) ?? []), i]);
  });
  const used = new Uint8Array(open.length);
  const joined: Item[] = [];
  const next = (end: Vec, self: number) => (byEnd.get(key(end)) ?? []).find((j) => j !== self && !used[j]);
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let pts = [...open[i]!.pts];
    // Grow forwards, then backwards.
    for (const dir of [1, -1]) {
      if (dir === -1) pts.reverse();
      for (;;) {
        const end = pts.at(-1)!;
        const j = next(end, -1);
        if (j === undefined) break;
        used[j] = 1;
        const q = open[j]!.pts;
        const add = samePoint(q[0]!, end, JOIN) ? q : [...q].reverse();
        pts = [...pts, ...add.slice(1)];
      }
    }
    const closed = pts.length > 3 && samePoint(pts[0]!, pts.at(-1)!, JOIN);
    if (closed) pts = pts.slice(0, -1);
    joined.push({ pts, closed, box: pathsBox([{ points: pts, closed }]), inner: [] });
  }
  return [...items.filter((i) => i.closed), ...joined];
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

/** Order items: greedy nearest neighbour, improved by 2-opt; each item's points in cut order (closed paths end where they began). */
function orderItems(items: Item[], from: Vec): Vec[][] {
  return improve(items, nearestOrder(items, from), from);
}

/** Greedy nearest-neighbour order (item indices) honouring inner-first. */
function nearestOrder(items: Item[], from: Vec): number[] {
  const done = new Uint8Array(items.length);
  const ready = (i: number) => items[i]!.inner.every((j) => done[j]);
  const result: number[] = [];
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
    result.push(best);
    pos = startAt(items[best]!, bestK).at(-1)!;
  }
  return result;
}

/** Above this many items 2-opt is skipped (it's O(n²) per sweep). */
const TWO_OPT_LIMIT = 1500;

/**
 * 2-opt on the travel between items: reverse a run of the order when that shortens the moves into and out of it,
 * as long as every shape still comes after the shapes inside it. Then pick each start point for the final order.
 */
function improve(items: Item[], order: number[], from: Vec): Vec[][] {
  const n = order.length;
  if (n >= 4 && n <= TWO_OPT_LIMIT) {
    // Entry/exit points: closed paths at their nearest-start vertex (fixed for this pass), open ones at either end.
    const rev = new Uint8Array(items.length);
    const ent = (i: number) => (items[i]!.closed ? rep(items[i]!) : rev[i] ? items[i]!.pts.at(-1)! : items[i]!.pts[0]!);
    const ex = (i: number) => (items[i]!.closed ? rep(items[i]!) : rev[i] ? items[i]!.pts[0]! : items[i]!.pts.at(-1)!);
    const d = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
    const pos = new Int32Array(items.length);
    const reindex = () => order.forEach((it, k) => (pos[it] = k));
    reindex();
    const deadline = Date.now() + 150;
    for (let improved = true; improved && Date.now() < deadline; ) {
      improved = false;
      for (let a = 0; a < n - 1; a++) {
        const before = a === 0 ? from : ex(order[a - 1]!);
        for (let b = a + 1; b < n; b++) {
          const after = b === n - 1 ? null : ent(order[b + 1]!);
          const oldCost = d(before, ent(order[a]!)) + (after ? d(ex(order[b]!), after) : 0);
          // Reversed run: enters at the old last item's exit side, leaves at the old first item's entry side.
          const fa = order[b]!;
          const la = order[a]!;
          const newEnt = items[fa]!.closed ? rep(items[fa]!) : rev[fa] ? items[fa]!.pts[0]! : items[fa]!.pts.at(-1)!;
          const newEx = items[la]!.closed ? rep(items[la]!) : rev[la] ? items[la]!.pts.at(-1)! : items[la]!.pts[0]!;
          const newCost = d(before, newEnt) + (after ? d(newEx, after) : 0);
          if (newCost >= oldCost - 1e-9) continue;
          if (!reversible(items, order, pos, a, b)) continue;
          for (let k = a; k <= b; k++) {
            const it = order[k]!;
            if (!items[it]!.closed) rev[it] = rev[it] ? 0 : 1;
          }
          order.splice(a, b - a + 1, ...order.slice(a, b + 1).reverse());
          reindex();
          improved = true;
          break;
        }
      }
    }
    // Final points: open paths in the chosen direction, closed ones from the vertex nearest where the head is.
    const out: Vec[][] = [];
    let at = from;
    for (const i of order) {
      const it = items[i]!;
      const pts = it.closed ? startAt(it, nearestStart(it, at).k) : rev[i] ? [...it.pts].reverse() : it.pts;
      out.push(pts);
      at = pts.at(-1)!;
    }
    return out;
  }
  const out: Vec[][] = [];
  let at = from;
  for (const i of order) {
    const pts = startAt(items[i]!, nearestStart(items[i]!, at).k);
    out.push(pts);
    at = pts.at(-1)!;
  }
  return out;
}

/** A closed path's stand-in point for 2-opt (its first vertex). */
const rep = (it: Item) => it.pts[0]!;

/** Reversing order[a..b] keeps inner-first: no shape in the run has a shape inside it later in the run. */
function reversible(items: Item[], order: number[], pos: Int32Array, a: number, b: number): boolean {
  for (let k = a; k <= b; k++) {
    for (const j of items[order[k]!]!.inner) {
      const pj = pos[j]!;
      if (pj >= a && pj < k) return false; // inner j is before its outer inside the run: reversing puts it after
    }
  }
  return true;
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
