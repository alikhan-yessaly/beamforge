// Arranging objects on the bed (pure): distribute with a set gap, linear/grid copies, and automatic packing
// (bounding boxes, optional rotation for the tightest box, a minimum gap). Every function returns a new Doc.
import { type Box, type Vec, apply, mul, rotate, translate } from "../geom/geom";
import { type Doc, type MachineProfile, type SceneObject, toUser } from "./model";
import { imageFrame, objectBox, pasteObjects } from "./ops";

const width = (b: Box) => b.maxX - b.minX;
const height = (b: Box) => b.maxY - b.minY;
const moved = (o: SceneObject, dx: number, dy: number): SceneObject => (dx || dy ? { ...o, mat: mul(translate(dx, dy), o.mat) } : o);

/**
 * Space the selected objects along x or y so each starts `gap` mm after the previous one ends (in their current
 * order along that axis). The first stays put. A null gap spreads them evenly between the first and the last.
 */
export function distribute(doc: Doc, ids: ReadonlySet<string>, axis: "x" | "y", gap: number | null): Doc {
  const sel = doc.objects.filter((o) => ids.has(o.id));
  if (sel.length < 2 || (gap !== null && !Number.isFinite(gap))) return doc;
  const lo = (b: Box) => (axis === "x" ? b.minX : b.minY);
  const size = (b: Box) => (axis === "x" ? width(b) : height(b));
  const items = sel.map((o) => ({ o, b: objectBox(o) })).sort((a, c) => lo(a.b) - lo(c.b) || size(a.b) - size(c.b));
  let g = gap;
  if (g === null) {
    // Even spacing: the same space between neighbours, with the outer two fixed.
    const first = items[0]!.b, last = items[items.length - 1]!.b;
    const span = (axis === "x" ? last.maxX : last.maxY) - lo(first);
    g = (span - items.reduce((s, it) => s + size(it.b), 0)) / (items.length - 1);
  }
  const target = new Map<string, number>();
  let at = lo(items[0]!.b);
  for (const it of items) {
    target.set(it.o.id, at - lo(it.b));
    at += size(it.b) + g;
  }
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      const d = target.get(o.id);
      return d === undefined ? o : axis === "x" ? moved(o, d, 0) : moved(o, 0, d);
    }),
  };
}

export const MAX_PATTERN_COPIES = 2500;

/**
 * Linear / grid pattern on the bed: `cols` × `rows` copies of the selection as one block, `gapX` / `gapY` mm apart
 * (between the blocks' boxes; negative overlaps them). Returns the doc and the ids of the original and every copy.
 */
export function linearArray(doc: Doc, ids: ReadonlySet<string>, cols: number, rows: number, gapX: number, gapY: number): { doc: Doc; ids: Set<string> } | { error: string } {
  const sel = doc.objects.filter((o) => ids.has(o.id));
  if (!sel.length) return { error: "empty" };
  cols = Math.max(1, Math.round(cols));
  rows = Math.max(1, Math.round(rows));
  if (!Number.isFinite(gapX) || !Number.isFinite(gapY) || cols * rows > MAX_PATTERN_COPIES) return { error: "count" };
  let b = objectBox(sel[0]!);
  for (const o of sel) {
    const ob = objectBox(o);
    b = { minX: Math.min(b.minX, ob.minX), minY: Math.min(b.minY, ob.minY), maxX: Math.max(b.maxX, ob.maxX), maxY: Math.max(b.maxY, ob.maxY) };
  }
  const sx = width(b) + gapX, sy = height(b) + gapY;
  let d = doc;
  const all = new Set(sel.map((o) => o.id));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!r && !c) continue;
      const p = pasteObjects(d, sel, c * sx, r * sy);
      d = p.doc;
      for (const id of p.ids) all.add(id);
    }
  }
  return { doc: d, ids: all };
}

/** World-space outline points of an object (its paths and picture frame), for rotation fitting. */
function worldPoints(o: SceneObject): Vec[] {
  const pts: Vec[] = [];
  const add = (ps: readonly Vec[]) => {
    const step = Math.max(1, Math.floor(ps.length / 400));
    for (let i = 0; i < ps.length; i += step) pts.push(apply(o.mat, ps[i]!));
  };
  for (const p of o.paths) add(p.points);
  if (o.image) add(imageFrame(o.image).points);
  return pts;
}

function rotatedSize(pts: Vec[], rad: number): { w: number; h: number } {
  const c = Math.cos(rad), s = Math.sin(rad);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { w: maxX - minX, h: maxY - minY };
}

/** The turn (degrees, 0–179) that gives the object the smallest bounding box, preferring the current one on ties. */
export function bestFitAngle(o: SceneObject): number {
  const pts = worldPoints(o);
  if (pts.length < 2) return 0;
  const area = (deg: number) => {
    const r = rotatedSize(pts, (deg * Math.PI) / 180);
    return r.w * r.h;
  };
  let best = 0, bestArea = area(0);
  for (let deg = 1; deg < 180; deg++) {
    const a = area(deg);
    if (a < bestArea * 0.995) [best, bestArea] = [deg, a];
  }
  // Refine to a tenth of a degree around the winner.
  for (let deg = best - 1; deg <= best + 1; deg += 0.1) {
    const a = area(deg);
    if (a < bestArea * 0.9999) [best, bestArea] = [deg, a];
  }
  return Math.round(best * 10) / 10;
}

interface Item { o: SceneObject; w: number; h: number }
interface Placed { o: SceneObject; x: number; y: number; turned: boolean }

/** Skyline bottom-left packing of w × h boxes into a W-wide strip of height H; each may turn 90° when allowed. */
function skyline(items: Item[], W: number, H: number, turn: boolean): { placed: Placed[]; left: Item[] } {
  let sky: { x: number; y: number; w: number }[] = [{ x: 0, y: 0, w: W }];
  const placed: Placed[] = [], left: Item[] = [];
  const fitAt = (i: number, w: number): number | null => {
    if (sky[i]!.x + w > W + 1e-9) return null;
    let y = 0, rest = w;
    for (let j = i; rest > 1e-9; j++) {
      const s = sky[j];
      if (!s) return null;
      y = Math.max(y, s.y);
      rest -= s.w;
    }
    return y;
  };
  for (const it of items) {
    let best: { i: number; y: number; w: number; h: number; turned: boolean } | null = null;
    for (const [w, h, turned] of turn && Math.abs(it.w - it.h) > 1e-6 ? ([[it.w, it.h, false], [it.h, it.w, true]] as const) : ([[it.w, it.h, false]] as const)) {
      for (let i = 0; i < sky.length; i++) {
        const y = fitAt(i, w);
        if (y === null || y + h > H + 1e-9) continue;
        if (!best || y + h < best.y + best.h - 1e-9 || (Math.abs(y + h - best.y - best.h) <= 1e-9 && sky[i]!.x < sky[best.i]!.x)) best = { i, y, w, h, turned };
      }
    }
    if (!best) {
      left.push(it);
      continue;
    }
    const x = sky[best.i]!.x;
    placed.push({ o: it.o, x, y: best.y, turned: best.turned });
    // Raise the skyline under the new box.
    const top = best.y + best.h, end = x + best.w;
    const next: typeof sky = [];
    for (const s of sky) {
      const sEnd = s.x + s.w;
      if (sEnd <= x + 1e-9 || s.x >= end - 1e-9) next.push(s);
      else {
        if (s.x < x) next.push({ x: s.x, y: s.y, w: x - s.x });
        if (sEnd > end) next.push({ x: end, y: s.y, w: sEnd - end });
      }
    }
    next.push({ x, y: top, w: best.w });
    next.sort((a, b) => a.x - b.x);
    sky = next.reduce<typeof sky>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && Math.abs(last.y - s.y) < 1e-9 && Math.abs(last.x + last.w - s.x) < 1e-9) last.w += s.w;
      else acc.push({ ...s });
      return acc;
    }, []);
  }
  return { placed, left };
}

export interface ArrangeOptions {
  /** Minimum space between objects and from the bed edge, mm. */
  gap: number;
  /** Turn each object to its tightest bounding box, and let the packer turn it a further 90°. */
  rotate: boolean;
  /** Pack into this rectangle (internal bed mm, e.g. a scrap) instead of the whole bed. */
  area?: Box;
}

/** A rectangle given in user coordinates (x, y of its corner nearest home, measured from home) as an internal box, clipped to the bed. */
export function userArea(profile: MachineProfile, a: { x: number; y: number; w: number; h: number }): Box {
  const p = toUser(profile, { x: a.x, y: a.y }), q = toUser(profile, { x: a.x + a.w, y: a.y + a.h });
  return {
    minX: Math.max(0, Math.min(p.x, q.x)),
    minY: Math.max(0, Math.min(p.y, q.y)),
    maxX: Math.min(profile.bedW, Math.max(p.x, q.x)),
    maxY: Math.min(profile.bedH, Math.max(p.y, q.y)),
  };
}

/** The inverse of userArea: an internal box as user x, y (nearest home), w, h. */
export function areaFromBox(profile: MachineProfile, b: Box): { x: number; y: number; w: number; h: number } {
  const p = toUser(profile, { x: b.minX, y: b.minY }), q = toUser(profile, { x: b.maxX, y: b.maxY });
  return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
}

/**
 * Pack the selected objects onto the bed (or into `area`), starting at the home corner, at least `gap` mm apart
 * and from the edges (bounding boxes). Objects that don't fit stay where they were; `left` counts them.
 */
export function autoArrange(doc: Doc, ids: ReadonlySet<string>, profile: MachineProfile, opt: ArrangeOptions): { doc: Doc; left: number } {
  const gap = Number.isFinite(opt.gap) ? Math.max(0, opt.gap) : 0;
  const sel = doc.objects.filter((o) => ids.has(o.id));
  if (!sel.length) return { doc, left: 0 };
  // Optionally turn each object to its tightest box first (about its own centre).
  const turned = new Map<string, SceneObject>();
  for (const o of sel) {
    let r = o;
    if (opt.rotate) {
      const deg = bestFitAngle(o);
      if (deg) {
        const b = objectBox(o), c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
        r = { ...o, mat: mul(translate(c.x, c.y), mul(rotate((deg * Math.PI) / 180), mul(translate(-c.x, -c.y), o.mat))) };
      }
      // Stand long parts upright or lay them flat consistently: the packer decides the final 90°.
    }
    turned.set(o.id, r);
  }
  // Each box grows by the gap; the usable bed shrinks by one gap at the far edges (the near edges keep the gap too).
  const items: Item[] = sel
    .map((o) => {
      const b = objectBox(turned.get(o.id)!);
      return { o: turned.get(o.id)!, w: width(b) + gap, h: height(b) + gap };
    })
    .sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
  const A = opt.area ?? { minX: 0, minY: 0, maxX: profile.bedW, maxY: profile.bedH };
  const W = A.maxX - A.minX - gap, H = A.maxY - A.minY - gap;
  const { placed, left } = W > 0 && H > 0 ? skyline(items, W, H, opt.rotate) : { placed: [], left: items };
  const flipX = profile.origin.endsWith("right"), flipY = profile.origin.startsWith("bottom");
  const out = new Map<string, SceneObject>();
  for (const p of placed) {
    let o = p.o;
    if (p.turned) {
      const b = objectBox(o), c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      o = { ...o, mat: mul(translate(c.x, c.y), mul(rotate(Math.PI / 2), mul(translate(-c.x, -c.y), o.mat))) };
    }
    const b = objectBox(o);
    // Packing space starts at the home corner: mirror the coordinates for right / bottom origins.
    const x = flipX ? A.maxX - gap - p.x - width(b) : A.minX + gap + p.x;
    const y = flipY ? A.maxY - gap - p.y - height(b) : A.minY + gap + p.y;
    out.set(o.id, moved(o, x - b.minX, y - b.minY));
  }
  return { doc: { ...doc, objects: doc.objects.map((o) => out.get(o.id) ?? o) }, left: left.length };
}
