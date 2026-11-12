// Sketch → laser paths. Non-construction entities become polylines (arcs and circles sampled to a 0.01 mm chord
// error), and pieces of the same colour that meet end to end are chained, so a rectangle drawn as four lines is
// one closed path (needed for fill and inner-first ordering).
import type { Vec } from "../geom/geom";
import type { ScenePath } from "../scene/model";
import { type Entity, type Sketch, arcAngles, pt } from "./model";

const TOL = 0.01; // mm chord error
const JOIN = 1e-6; // mm: endpoints closer than this connect

export function arcPoints(c: Vec, r: number, a0: number, a1: number): Vec[] {
  const sweep = a1 - a0;
  const step = r > TOL ? 2 * Math.acos(Math.max(-1, 1 - TOL / r)) : Math.PI / 8;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3)));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}

/** Catmull-Rom through points, sampled (closed: wraps around). */
export function splinePoints(pts: Vec[], closed: boolean, perSegment = 16): Vec[] {
  if (pts.length < 2) return pts;
  const n = pts.length;
  const at = (i: number) => (closed ? pts[(i + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!);
  const segs = closed ? n : n - 1;
  const out: Vec[] = [pts[0]!];
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 1; k <= perSegment; k++) {
      const t = k / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  return out;
}

/**
 * Text outlines come from the app's font loader (registered here to keep this module sync and pure). The hook
 * returns null while the font is still loading.
 */
let textOutlines: ((s: Sketch, e: Extract<Entity, { kind: "text" }>) => Vec[][] | null) | null = null;
export function registerTextOutlines(f: typeof textOutlines): void {
  textOutlines = f;
}

/** True when every text entity's font is loaded (so generated paths include the text). */
export const textReady = (s: Sketch) => s.entities.every((e) => e.kind !== "text" || (textOutlines?.(s, e) ?? null) !== null);

/** Polylines of one entity in sketch coords (closed ones repeat their first point at the end). */
export function entityPolylines(s: Sketch, e: Entity): { pts: Vec[]; closed: boolean }[] {
  switch (e.kind) {
    case "line":
      return [{ pts: [pt(s, e.p1), pt(s, e.p2)], closed: false }];
    case "circle": {
      const p = arcPoints(pt(s, e.c), e.r, 0, 2 * Math.PI);
      p[p.length - 1] = { ...p[0]! };
      return [{ pts: p, closed: true }];
    }
    case "arc": {
      const { a0, a1 } = arcAngles(s, e);
      const p = arcPoints(pt(s, e.c), e.r, a0, a1);
      // Pin the ends exactly on the endpoints so chaining is exact.
      p[0] = pt(s, e.start);
      p[p.length - 1] = pt(s, e.end);
      return [{ pts: p, closed: false }];
    }
    case "spline": {
      const p = splinePoints(e.pts.map((id) => pt(s, id)), e.closed);
      return [{ pts: p, closed: e.closed }];
    }
    case "point":
      return [];
    case "text":
      return (textOutlines?.(s, e) ?? []).map((pts) => ({ pts, closed: true }));
    case "ref": {
      const a = pt(s, e.anchor);
      const p = e.points.map((q) => ({ x: a.x + q.x, y: a.y + q.y }));
      if (e.closed && p.length) p.push({ ...p[0]! });
      return [{ pts: p, closed: e.closed }];
    }
  }
}

const same = (a: Vec, b: Vec) => Math.abs(a.x - b.x) < JOIN && Math.abs(a.y - b.y) < JOIN;

/** Join open polylines that meet end to end into longer ones; mark loops closed. */
export function chain(polys: { pts: Vec[]; closed: boolean }[]): { pts: Vec[]; closed: boolean }[] {
  return chainTagged(polys.map((p) => ({ ...p, ids: [] }))).map(({ pts, closed }) => ({ pts, closed }));
}

/** `chain`, keeping track of which tagged pieces (entity ids) each result is made of. */
function chainTagged(polys: { pts: Vec[]; closed: boolean; ids: string[] }[]): { pts: Vec[]; closed: boolean; ids: string[] }[] {
  const done = polys.filter((p) => p.closed);
  const open = polys.filter((p) => !p.closed && p.pts.length >= 2).map((p) => ({ pts: [...p.pts], ids: p.ids }));
  while (open.length) {
    const first = open.shift()!;
    let cur = first.pts;
    const ids = [...first.ids];
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const o = open[i]!.pts;
        const [cs, ce, os, oe] = [cur[0]!, cur.at(-1)!, o[0]!, o.at(-1)!];
        if (same(ce, os)) cur = [...cur, ...o.slice(1)];
        else if (same(ce, oe)) cur = [...cur, ...[...o].reverse().slice(1)];
        else if (same(cs, oe)) cur = [...o, ...cur.slice(1)];
        else if (same(cs, os)) cur = [...[...o].reverse(), ...cur.slice(1)];
        else continue;
        ids.push(...open[i]!.ids);
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    const closed = cur.length > 2 && same(cur[0]!, cur.at(-1)!);
    done.push({ pts: cur, closed, ids });
  }
  return done;
}

/** All cut paths of a sketch, grouped by layer colour. Closed paths drop their repeated end point. */
export function sketchPaths(s: Sketch): ScenePath[] {
  const byColor = new Map<string, { pts: Vec[]; closed: boolean; ids: string[] }[]>();
  for (const e of s.entities) {
    if (e.construction || e.kind === "point") continue;
    const color = e.color ?? s.color;
    const list = byColor.get(color) ?? [];
    // Text has one closed contour per glyph part: tag each so a single letter's region can be filled.
    entityPolylines(s, e).forEach((p, k) => list.push({ ...p, ids: [e.kind === "text" ? `${e.id}#${k}` : e.id] }));
    byColor.set(color, list);
  }
  const fills = new Map((s.fills ?? []).map((f) => [loopKey(f.loop), f.color]));
  const out: ScenePath[] = [];
  for (const [color, polys] of byColor) {
    for (const p of chainTagged(polys)) {
      const pts = p.closed && p.pts.length > 1 && same(p.pts[0]!, p.pts.at(-1)!) ? p.pts.slice(0, -1) : p.pts;
      if (pts.length < 2) continue;
      if (!p.closed) {
        out.push({ color, closed: false, points: pts });
        continue;
      }
      const src = [...p.ids].sort();
      const fill = fills.get(loopKey(src));
      out.push({ color, closed: true, points: pts, src, ...(fill ? { fill } : {}) });
    }
  }
  return out;
}

export const loopKey = (ids: readonly string[]) => [...ids].sort().join(",");

/** Set (or clear, with null) the fill of the loop `src` in a sketch. */
export function setSketchFill(s: Sketch, src: readonly string[], color: string | null): Sketch {
  const key = loopKey(src);
  const rest = (s.fills ?? []).filter((f) => loopKey(f.loop) !== key);
  return { ...s, fills: color ? [...rest, { loop: [...src].sort(), color }] : rest };
}

/** Ids of non-construction entities that lie on closed loops (circles, or chains whose ends all meet). */
export function closedEntityIds(s: Sketch): Set<string> {
  const ents = s.entities.filter((e) => !e.construction && e.kind !== "point");
  const out = new Set<string>();
  // Union-find over entity ids, joined where their open ends coincide.
  const parent = new Map(ents.map((e) => [e.id, e.id]));
  const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!));
  const ends: { id: string; p: Vec }[] = [];
  for (const e of ents) {
    if (e.kind === "text") out.add(e.id); // outlines are closed whether or not the font is loaded yet
    for (const poly of entityPolylines(s, e)) {
      if (poly.closed) out.add(e.id);
      else if (poly.pts.length >= 2) ends.push({ id: e.id, p: poly.pts[0]! }, { id: e.id, p: poly.pts.at(-1)! });
    }
  }
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i]!.id !== ends[j]!.id && same(ends[i]!.p, ends[j]!.p)) parent.set(find(ends[i]!.id), find(ends[j]!.id));
    }
  }
  // A component is a closed loop when every end meets another end (each endpoint used exactly twice).
  const groups = new Map<string, { id: string; p: Vec }[]>();
  for (const end of ends) {
    const g = find(end.id);
    groups.set(g, [...(groups.get(g) ?? []), end]);
  }
  for (const list of groups.values()) {
    const closed = list.every((a) => list.filter((b) => same(a.p, b.p)).length === 2);
    if (closed) for (const end of list) out.add(end.id);
  }
  return out;
}
