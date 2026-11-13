// Toolpath planning: turn the document into an ordered list of cut and travel segments in bed millimetres.
//
// Work comes in units: a fill sweep (one area, or near areas swept together) or one cut path. Each unit gets all of
// its layer's passes before the next (passes are repeated geometry, see PROTOCOL.md). Fills always come before the
// cuts around them, so a part is engraved while it's still held by the sheet. Two orders:
//  - layer by layer: every fill (layers in order), then every cut (layers in order);
//  - object by object: a part (the outermost closed cut path and everything inside it, on any layer) gets its fills
//    and then its cuts before the head moves to the next part, nearest first.
// "auto" plans both and keeps the quicker one by the time estimate (object by object also when layer by layer would
// cut a shape before the shapes inside it on a later layer). Within a group of cuts, open paths that meet end to end
// are joined, then `order.ts` picks the order, start points and directions by travel time. With `innerFirst`, a
// closed path comes after every closed path inside it (so a part is never cut free before its holes). Parts, and
// fill sweeps, are ordered the same way; the last piece heads towards the next part, or home.
import { t } from "../i18n";
import { type Box, type Vec, apply, pathsBox, pointInPolygon } from "../geom/geom";
import { DEFAULT_PROFILE, type Doc, type Layer, type SweepMode } from "../scene/model";
import { type MotionProfile, overscanLength, scanOffsetAt } from "../machine/motion";
import { kerfRings } from "./kerf";
import { estimate } from "./estimate";
import { DEFAULT_FILL, type FillSettings, MAX_FILL_PATHS, fillIslands, fillPaths, tooDenseMessage } from "./fill";
import { regionRings } from "./regions";
import { activeLayers } from "./layers";
import { INNER_FIRST_LIMIT, type OrderTuning, orderItems, travelTime } from "./order";

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** false = travel with the laser off */
  cut: boolean;
  /** index into Toolpath.layers, or -1 for travel */
  layer: number;
  /**
   * Laser-off move inside an engraved row, run at the layer's speed in line with the burns: overscan before and
   * after a row, and the gaps between areas swept together. `layer` is the fill's layer. The machine gets plain moves.
   */
  lead?: boolean;
}

/** How the work is ordered: "auto" picks whichever of the two has less travel. */
export type JobOrder = "auto" | "layer" | "object";

export interface Toolpath {
  /** Layers that are cut (output on and with paths), in layer order. */
  layers: Layer[];
  segments: Segment[];
  /** Where the head starts and returns to (internal bed mm). */
  start: Vec;
  /** The order used (what "auto" chose). */
  order: Exclude<JobOrder, "auto">;
  /** Problems that make the job unusable (e.g. a fill too dense); a job is not built while any remain. */
  errors: string[];
  /** Things worth knowing that don't block the job (e.g. open paths in a fill layer are not filled). */
  warnings: string[];
  /** Fill layers (index into `layers`): how many separate areas each sweep covers, e.g. [3, 1, 1]. */
  sweeps?: number[][];
}

export interface PlanOptions {
  start: Vec;
  innerFirst: boolean;
  /** Default "auto". */
  order?: JobOrder;
  /**
   * Travel speed and acceleration (the order is chosen by time), start speed (auto overscan) and scan offsets
   * (default: the default machine profile).
   */
  motion?: MotionProfile;
  /** Where laser-off overscan moves may go (internal bed mm); missing = anywhere. */
  bounds?: Box;
  /** Search settings for the order (benchmarks and tests). */
  tuning?: OrderTuning;
}

/** What ordering needs besides the work: travel cost, acceleration, home, the layers' speeds. */
interface Ctx {
  cost: (d: number) => number;
  accel: number;
  home: Vec;
  innerFirst: boolean;
  layers: Layer[];
  tuning?: OrderTuning;
}

interface Item {
  pts: Vec[];
  closed: boolean;
  box: Box;
}

/** One piece of work before ordering: a fill sweep or a cut path, on layer `li` (index into Toolpath.layers). */
interface Work {
  li: number;
  fill?: Vec[][];
  item?: Item;
  box: Box;
  /** A point inside the work, for containment. */
  at: Vec;
}

/** A unit in cut order: its paths get all of the layer's passes. */
interface Unit {
  li: number;
  paths: Vec[][];
  /** Fill sweeps: rows of burns, run with overscan and the scan-offset shift. */
  fill?: boolean;
}

/** Per-layer motion details for engraving rows. */
interface RowMotion {
  /** Overscan length, mm. */
  lead: number;
  /** Shift each burn back along its direction by this much (half the scan offset), mm. */
  shift: number;
}

export function planToolpath(doc: Doc, opts: PlanOptions): Toolpath {
  const out: Toolpath = { layers: [], segments: [], start: opts.start, order: "layer", errors: [], warnings: [], sweeps: [] };
  const work: Work[] = [];

  for (const layer of activeLayers(doc).filter((l) => l.output)) {
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
        items.push({ pts, closed: p.closed, box: pathsBox([{ points: pts, closed: p.closed }]) });
        if (p.closed) legacy.push(pts);
      });
    }
    if (items.length === 0 && regions.length === 0) continue;
    const mode = layer.mode ?? "cut";
    const name = t("Layer {color}", { color: layer.color });
    const li = out.layers.length;
    const mine: Work[] = [];
    if (mode !== "fill" && (layer.kerf ?? 0) > 0) items = withKerf(items, layer.kerf!);
    if (mode === "cut" && regions.length) out.warnings.push(t("{layer} is a cut layer: its filled regions are skipped. Set the layer to Fill.", { layer: name }));
    if (mode !== "cut") {
      const groups = mode === "fill" || mode === "fillCut" ? [legacy, ...regions] : regions;
      const f = fillCandidates(groups, { ...DEFAULT_FILL, ...layer.fill }, layer.sweep);
      if (f.error) out.errors.push(`${name}: ${f.error}`);
      out.sweeps![li] = f.sizes ?? [];
      if (mode === "fill" && items.some((i) => !i.closed)) out.warnings.push(t("{layer}: open paths can't be filled and are skipped.", { layer: name }));
      for (const fill of f.cands) {
        const first = fill[0]!;
        mine.push({ li, fill, box: pathsBox(fill.map((points) => ({ points, closed: false }))), at: mid(first[0]!, first[1] ?? first[0]!) });
      }
    }
    if (mode !== "fill") {
      items = joinOpenPaths(items);
      for (const item of items) mine.push({ li, item, box: item.box, at: item.closed ? item.pts[0]! : mid(item.pts[0]!, item.pts[1]!) });
    }
    if (mine.length === 0) continue;
    out.layers.push(layer);
    work.push(...mine);
  }

  const motion = opts.motion ?? DEFAULT_PROFILE;
  const rows: Rows = { motion: rowMotion(out.layers, motion), bounds: opts.bounds };
  const ctx: Ctx = { cost: travelTime(motion), accel: motion.accel, home: opts.start, innerFirst: opts.innerFirst, layers: out.layers, tuning: opts.tuning };
  const rel = relations(work, opts.innerFirst);
  const want = opts.order ?? "auto";
  let units: Unit[];
  if (want === "layer" || (want === "auto" && !rel)) {
    units = byLayer(work, out.layers.length, ctx);
    out.order = "layer";
    if (want === "layer" && rel?.crossLayer) out.warnings.push(t("Layer by layer cuts some shapes before the shapes inside them on a later layer. Move that layer up, or order object by object."));
  } else if (want === "object") {
    units = byObject(work, rel!, out.layers.length, ctx);
    out.order = "object";
  } else {
    const object = byObject(work, rel!, out.layers.length, ctx);
    const layer = rel!.crossLayer ? null : byLayer(work, out.layers.length, ctx);
    const time = (u: Unit[]) => estimate({ ...out, segments: emit(out, u, opts.start, rows) }, motion).total;
    if (layer && time(layer) <= time(object) + 1e-9) [units, out.order] = [layer, "layer"];
    else [units, out.order] = [object, "object"];
  }
  out.segments = emit(out, units, opts.start, rows);
  return out;
}

/** Overscan and scan-offset shift for each fill layer of the toolpath. */
function rowMotion(layers: Layer[], m: MotionProfile): RowMotion[] {
  return layers.map((l) => ({
    lead: overscanLength(l.overscan, l.speed, m),
    shift: (l.scanOffset ?? scanOffsetAt(l.speed, m.scanOffsets)) / 2,
  }));
}

/** Kerf-compensated cut items: closed outlines grow by kerf/2, holes inside them shrink; open paths stay. */
function withKerf(items: Item[], kerf: number): Item[] {
  const closed = items.filter((i) => i.closed && i.pts.length >= 3);
  const grown = kerfRings(closed.map((i) => i.pts), kerf).flat();
  return [...items.filter((i) => !(i.closed && i.pts.length >= 3)), ...grown.map((pts) => ({ pts, closed: true, box: pathsBox([{ points: pts, closed: true }]) }))];
}

const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const boxIn = (b: Box, B: Box, eps = 1e-6) => b.minX >= B.minX - eps && b.minY >= B.minY - eps && b.maxX <= B.maxX + eps && b.maxY <= B.maxY + eps;
const sameBox = (b: Box, B: Box) => b.minX === B.minX && b.minY === B.minY && b.maxX === B.maxX && b.maxY === B.maxY;

/**
 * Parts and cross-layer containment. A part is an outermost closed cut path and every piece of work inside it;
 * work outside every closed cut path is a part of its own. Null when there are too many closed paths to compare.
 */
function relations(work: Work[], innerFirst: boolean): { part: number[]; crossLayer: boolean } | null {
  const closed = work.map((_, i) => i).filter((i) => work[i]!.item?.closed && work[i]!.item!.pts.length >= 3);
  if (closed.length > INNER_FIRST_LIMIT) return null;
  // w lies inside closed cut c.
  const inside = (w: number, c: number) => {
    if (w === c) return false;
    const [W, C] = [work[w]!, work[c]!];
    if (!boxIn(W.box, C.box)) return false;
    // Duplicate outlines: the lower index counts as the outer one.
    if (W.item?.closed && sameBox(W.box, C.box)) return w > c;
    return pointInPolygon(W.at, C.item!.pts);
  };
  const roots = closed.filter((c) => !closed.some((o) => inside(c, o)));
  let crossLayer = false;
  if (innerFirst) {
    // A closed cut on an earlier layer around a closed cut on a later one: layer by layer would cut it first.
    for (const a of closed) for (const b of closed) if (work[b]!.li > work[a]!.li && inside(b, a)) crossLayer = true;
  }
  const part = work.map((_, w) => {
    if (roots.includes(w)) return w;
    const r = roots.find((c) => inside(w, c));
    return r ?? w;
  });
  return { part, crossLayer };
}

/** A run of work for one layer, ordered as a whole: its fill sweeps or its cuts. */
type Group = { fill: boolean; ws: Work[] };

/**
 * Order groups one after another from `from`; the last one heads towards `to`. A group followed by a single closed
 * cut (an outline after the shapes inside it) heads for that outline's vertex nearest where the outline is followed
 * by, since the outline starts and ends there.
 */
function runGroups(units: Unit[], groups: Group[], from: Vec, to: Vec | undefined, ctx: Ctx): Vec {
  const list = groups.filter((g) => g.ws.length);
  const targets: (Vec | undefined)[] = list.map(() => undefined);
  targets[list.length - 1] = to;
  for (let k = list.length - 2; k >= 0; k--) {
    const next = list[k + 1]!;
    const after = targets[k + 1];
    const only = !next.fill && next.ws.length === 1 && next.ws[0]!.item!.closed ? next.ws[0]!.item!.pts : null;
    if (only && after) targets[k] = only.reduce((b, v) => (Math.hypot(v.x - after.x, v.y - after.y) < Math.hypot(b.x - after.x, b.y - after.y) ? v : b));
  }
  let pos = from;
  list.forEach((g, k) => {
    pos = g.fill ? pushFills(units, g.ws, pos, ctx, targets[k]) : pushCuts(units, g.ws, pos, ctx, targets[k]);
  });
  return pos;
}

/** Every fill, layers in order, then every cut, layers in order. */
function byLayer(work: Work[], nLayers: number, ctx: Ctx): Unit[] {
  const groups: Group[] = [];
  for (let li = 0; li < nLayers; li++) groups.push({ fill: true, ws: work.filter((w) => w.li === li && w.fill) });
  for (let li = 0; li < nLayers; li++) groups.push({ fill: false, ws: work.filter((w) => w.li === li && w.item) });
  const units: Unit[] = [];
  runGroups(units, groups, ctx.home, ctx.home, ctx);
  return units;
}

/**
 * Part by part: its fills (layers in order), then its cuts (layers in order, outlines around later layers last).
 * The parts are ordered as closed shapes (their outline, or their box) by travel time, round from home and back.
 */
function byObject(work: Work[], rel: { part: number[] }, nLayers: number, ctx: Ctx): Unit[] {
  const parts = new Map<number, Work[]>();
  work.forEach((w, i) => parts.set(rel.part[i]!, [...(parts.get(rel.part[i]!) ?? []), w]));
  const keys = [...parts.keys()];
  const stand = keys.map((k) => {
    const root = work[k]!;
    const box = unionBox(parts.get(k)!.map((w) => w.box));
    const pts = root.item?.closed ? root.item.pts : [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
    return { pts, closed: true, box };
  });
  const seq = orderItems(stand, ctx.home, { cost: ctx.cost, innerFirst: false, to: ctx.home, tuning: ctx.tuning });
  const units: Unit[] = [];
  let pos = ctx.home;
  seq.forEach((s, n) => {
    const ws = parts.get(keys[s.i]!)!;
    const groups: Group[] = [];
    for (let li = 0; li < nLayers; li++) groups.push({ fill: true, ws: ws.filter((w) => w.li === li && w.fill) });
    const cuts = ws.filter((w) => w.item);
    // A closed cut with a closed cut of a later layer inside it waits until the end of the part.
    const later = (w: Work) => w.item!.closed && ctx.innerFirst && cuts.some((o) => o.li > w.li && o.item!.closed && boxIn(o.box, w.box) && !sameBox(o.box, w.box) && pointInPolygon(o.at, w.item!.pts));
    const deferred = cuts.filter(later);
    for (let li = 0; li < nLayers; li++) groups.push({ fill: false, ws: cuts.filter((w) => w.li === li && !deferred.includes(w)) });
    groups.push({ fill: false, ws: deferred });
    // Head for where the next part will start.
    pos = runGroups(units, groups, pos, seq[n + 1]?.pts[0] ?? ctx.home, ctx);
  });
  return units;
}

function unionBox(boxes: Box[]): Box {
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}

/** Fill sweeps by travel time; each may run as generated or fully reversed. */
function pushFills(units: Unit[], ws: Work[], from: Vec, ctx: Ctx, to?: Vec): Vec {
  if (!ws.length) return from;
  const ordered = orderFills(ws.map((w) => w.fill!), from, ctx, to);
  for (const paths of ordered) units.push({ li: ws[0]!.li, paths, fill: true });
  return ordered.at(-1)!.at(-1)!.at(-1)!;
}

function pushCuts(units: Unit[], ws: Work[], from: Vec, ctx: Ctx, to?: Vec): Vec {
  if (!ws.length) return from;
  const items = ws.map((w) => ({ ...w.item!, speed: ctx.layers[w.li]!.speed }));
  const order = orderItems(items, from, { cost: ctx.cost, innerFirst: ctx.innerFirst, to, accel: ctx.accel, tuning: ctx.tuning });
  for (const o of order) units.push({ li: ws[o.i]!.li, paths: [o.pts] });
  return order.at(-1)!.pts.at(-1)!;
}

interface Rows {
  motion: RowMotion[];
  bounds?: Box;
}

/** Turn units into segments, each unit with all of its layer's passes, joined by travel; back to `start` at the end. */
function emit(out: Toolpath, units: Unit[], start: Vec, rows?: Rows): Segment[] {
  const segs: Segment[] = [];
  let pos = start;
  for (const unit of units) {
    const passes = out.layers[unit.li]!.passes;
    const rm = rows?.motion[unit.li];
    for (let pass = 0; pass < passes; pass++) {
      if (unit.fill && rm) {
        pos = emitRows(segs, pos, unit, rm, rows?.bounds);
        continue;
      }
      for (const path of unit.paths) {
        // A lone open path is cut back and forth on alternate passes instead of travelling back to its start.
        const pts = unit.paths.length === 1 && pass % 2 === 1 && !samePoint(path[0]!, path.at(-1)!) ? [...path].reverse() : path;
        travel(segs, pos, pts[0]!);
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1]!;
          const b = pts[k]!;
          segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, cut: true, layer: unit.li });
        }
        pos = pts.at(-1)!;
      }
    }
  }
  if (segs.length > 0) travel(segs, pos, start);
  return segs;
}

const dirOf = (p: Vec[]): Vec | null => {
  if (p.length !== 2) return null;
  const [dx, dy] = [p[1]!.x - p[0]!.x, p[1]!.y - p[0]!.y];
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? { x: dx / len, y: dy / len } : null;
};

/** Longest t ≤ len such that p + t·d stays inside the box (0 when p is outside). */
function reach(p: Vec, d: Vec, len: number, b?: Box): number {
  if (!b) return len;
  let t = len;
  if (d.x > 1e-12) t = Math.min(t, (b.maxX - p.x) / d.x);
  if (d.x < -1e-12) t = Math.min(t, (b.minX - p.x) / d.x);
  if (d.y > 1e-12) t = Math.min(t, (b.maxY - p.y) / d.y);
  if (d.y < -1e-12) t = Math.min(t, (b.minY - p.y) / d.y);
  return Math.max(0, t);
}

/**
 * One pass of a fill unit. Straight burns (lines, dots) are shifted back along their direction by half the scan
 * offset. Burns that continue one another along a row are joined by lead moves (the head keeps going); each row
 * gets `lead` mm of overscan before its first burn and after its last, inside `bounds`.
 */
function emitRows(segs: Segment[], from: Vec, unit: Unit, rm: RowMotion, bounds?: Box): Vec {
  const li = unit.li;
  const burns = unit.paths.map((p) => {
    const d = dirOf(p);
    if (!d || !rm.shift) return { pts: p, d };
    const [sx, sy] = [-d.x * rm.shift, -d.y * rm.shift];
    return { pts: p.map((v) => ({ x: v.x + sx, y: v.y + sy })), d };
  });
  const inLine = (a: (typeof burns)[number], b: (typeof burns)[number]) => {
    if (!a.d || !b.d || a.d.x * b.d.x + a.d.y * b.d.y < 0.999999) return false;
    const [e, s] = [a.pts.at(-1)!, b.pts[0]!];
    const [dx, dy] = [s.x - e.x, s.y - e.y];
    return Math.abs(dx * a.d.y - dy * a.d.x) < 1e-6 && dx * a.d.x + dy * a.d.y > -1e-9;
  };
  const lead = (a: Vec, b: Vec) => {
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 1e-6) segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, cut: false, layer: li, lead: true });
  };
  let pos = from;
  burns.forEach((b, k) => {
    const first = b.pts[0]!;
    const rowStart = k === 0 || !inLine(burns[k - 1]!, b);
    if (rowStart) {
      if (b.d && rm.lead > 0) {
        const back = { x: -b.d.x, y: -b.d.y };
        const t = reach(first, back, rm.lead, bounds);
        const at = { x: first.x + back.x * t, y: first.y + back.y * t };
        travel(segs, pos, at);
        lead(at, first);
      } else travel(segs, pos, first);
    } else lead(pos, first);
    for (let i = 1; i < b.pts.length; i++) {
      const [p, q] = [b.pts[i - 1]!, b.pts[i]!];
      segs.push({ x0: p.x, y0: p.y, x1: q.x, y1: q.y, cut: true, layer: li });
    }
    pos = b.pts.at(-1)!;
    const rowEnd = k === burns.length - 1 || !inLine(b, burns[k + 1]!);
    if (rowEnd && b.d && rm.lead > 0) {
      const t = reach(pos, b.d, rm.lead, bounds);
      const at = { x: pos.x + b.d.x * t, y: pos.y + b.d.y * t };
      lead(pos, at);
      pos = at;
    }
  });
  return pos;
}

/**
 * Fill sweeps for a layer: the filled areas ("islands") grouped into clusters swept together when that's quicker,
 * each cluster hatched separately. Offset contours go island by island.
 *
 * When to sweep two islands as one: they share rows across the scan direction. Together, every shared row jumps the
 * gap between them; apart, the head jumps between them once. So: together when shared rows × gap < that one jump.
 * (Inside a sweep, the hatch applies the same rule to the parts of an area, see `fill.ts`.)
 */
export function fillCandidates(groups: Vec[][][], s: FillSettings, sweep: SweepMode = "quick"): { cands: Vec[][][]; sizes?: number[]; error?: string } {
  const islands = fillIslands(groups);
  if (!islands.length) return { cands: [] };
  const clusters = s.pattern === "offset" || sweep === "separate" ? islands.map((i) => [i]) : clusterIslands(islands, s, sweep === "together");
  const cands: Vec[][][] = [];
  const sizes: number[] = [];
  let total = 0;
  for (const cl of clusters) {
    const f = fillPaths(cl.flat(), s, undefined, sweep);
    if (f.error) return { cands: [], error: f.error };
    total += f.paths.length;
    if (total > MAX_FILL_PATHS) return { cands: [], error: tooDenseMessage() };
    if (f.paths.length) {
      cands.push(f.paths);
      sizes.push(cl.length);
    }
  }
  return { cands, sizes };
}

/** Sweeps in travel-time order (`order.ts`, each as an open path from its first to its last point). */
function orderFills(cand: Vec[][][], from: Vec, ctx: Pick<Ctx, "cost" | "tuning">, to?: Vec): Vec[][][] {
  const items = cand.map((c) => {
    const pts = [c[0]![0]!, c.at(-1)!.at(-1)!];
    return { pts, closed: false, box: pathsBox([{ points: pts, closed: false }]) };
  });
  return orderItems(items, from, { cost: ctx.cost, innerFirst: false, to, tuning: ctx.tuning }).map((o) =>
    o.reversed ? [...cand[o.i]!].reverse().map((p) => [...p].reverse()) : cand[o.i]!,
  );
}

/** Fill units for one layer's areas, in travel-time order from `from` (each with all passes before the next). */
export function fillUnits(groups: Vec[][][], s: FillSettings, from: Vec, motion: MotionProfile = DEFAULT_PROFILE): { units: Vec[][][]; error?: string } {
  const c = fillCandidates(groups, s);
  if (c.error) return { units: [], error: c.error };
  return { units: c.cands.length ? orderFills(c.cands, from, { cost: travelTime(motion) }) : [] };
}

/** Above this many islands, sweep them all as one (the pairwise test is O(n²)). */
const CLUSTER_LIMIT = 2000;

function clusterIslands(islands: Vec[][][], s: FillSettings, together = false): Vec[][][][] {
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
      if (together || (shared / interval) * gap < jump) parent[find(i)] = find(j);
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
    joined.push({ pts, closed, box: pathsBox([{ points: pts, closed }]) });
  }
  return [...items.filter((i) => i.closed), ...joined];
}

function travel(segs: Segment[], a: Vec, b: Vec): void {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return;
  segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, cut: false, layer: -1 });
}
