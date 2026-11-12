// Hit-testing and snapping in sketch coordinates (pure).
import { type Vec, distToSegment } from "../geom/geom";
import { type Entity, ORIGIN, type Sketch, arcAngles, entityPoints, pt } from "./model";
import { entityPolylines } from "./paths";

/** What the cursor is snapped to. */
export type Snap = { kind: "point"; id: string; pos: Vec } | { kind: "curve"; id: string; pos: Vec } | null;

export interface PointAlignment {
  type: "horizontalPts" | "verticalPts";
  ref: string;
  pos: Vec;
}

export function distToEntity(s: Sketch, e: Entity, p: Vec): number {
  switch (e.kind) {
    case "line":
      return distToSegment(p, pt(s, e.p1), pt(s, e.p2));
    case "circle":
      return Math.abs(Math.hypot(p.x - pt(s, e.c).x, p.y - pt(s, e.c).y) - e.r);
    case "arc": {
      const c = pt(s, e.c);
      const { a0, a1 } = arcAngles(s, e);
      let a = Math.atan2(p.y - c.y, p.x - c.x);
      while (a < a0) a += 2 * Math.PI;
      if (a <= a1) return Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - e.r);
      return Math.min(Math.hypot(p.x - pt(s, e.start).x, p.y - pt(s, e.start).y), Math.hypot(p.x - pt(s, e.end).x, p.y - pt(s, e.end).y));
    }
    case "point":
      return Math.hypot(p.x - pt(s, e.p).x, p.y - pt(s, e.p).y);
    default: {
      let d = Infinity;
      for (const poly of entityPolylines(s, e)) {
        for (let i = 1; i < poly.pts.length; i++) d = Math.min(d, distToSegment(p, poly.pts[i - 1]!, poly.pts[i]!));
      }
      if (e.kind === "text" || e.kind === "ref") d = Math.min(d, Math.hypot(p.x - pt(s, e.anchor).x, p.y - pt(s, e.anchor).y));
      return d;
    }
  }
}

/** Points that are visible handles: entity points, the origin; not spline/text internals beyond their own. */
export function handlePoints(s: Sketch): string[] {
  const ids = new Set<string>([ORIGIN]);
  for (const e of s.entities) for (const id of entityPoints(e)) ids.add(id);
  return [...ids];
}

export function nearestPoint(s: Sketch, p: Vec, tol: number, exclude: ReadonlySet<string> = new Set()): string | null {
  let best: string | null = null;
  let bestD = tol;
  for (const id of handlePoints(s)) {
    if (exclude.has(id)) continue;
    const q = s.points[id];
    if (!q) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) [best, bestD] = [id, d];
  }
  return best;
}

export function nearestEntity(s: Sketch, p: Vec, tol: number, filter: (e: Entity) => boolean = () => true): string | null {
  let best: string | null = null;
  let bestD = tol;
  for (const e of s.entities) {
    if (!filter(e)) continue;
    const d = distToEntity(s, e, p);
    if (d <= bestD) [best, bestD] = [e.id, d];
  }
  return best;
}

/** Closest point on an entity (lines, circles, arcs; others: the input). */
export function projectOnto(s: Sketch, e: Entity, p: Vec): Vec {
  if (e.kind === "line") {
    const [a, b] = [pt(s, e.p1), pt(s, e.p2)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return { x: a.x + t * dx, y: a.y + t * dy };
  }
  if (e.kind === "circle" || e.kind === "arc") {
    const c = pt(s, e.c);
    const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
    return { x: c.x + ((p.x - c.x) / d) * e.r, y: c.y + ((p.y - c.y) / d) * e.r };
  }
  return p;
}

/** Snap: existing points first, then lines/circles/arcs (non-point entities). */
export function snap(s: Sketch, p: Vec, tol: number, exclude: ReadonlySet<string> = new Set()): Snap {
  const id = nearestPoint(s, p, tol, exclude);
  if (id) return { kind: "point", id, pos: pt(s, id) };
  const eid = nearestEntity(s, p, tol * 0.8, (e) => (e.kind === "line" || e.kind === "circle" || e.kind === "arc") && !exclude.has(e.id));
  if (eid) {
    const e = s.entities.find((x) => x.id === eid)!;
    return { kind: "curve", id: eid, pos: projectOnto(s, e, p) };
  }
  return null;
}

/** Independently align a cursor to the closest visible point on each axis. */
export function inferPointAlignments(s: Sketch, p: Vec, tol: number, exclude: ReadonlySet<string> = new Set()): PointAlignment[] {
  let vertical: PointAlignment | null = null;
  let horizontal: PointAlignment | null = null;
  let bestX = tol;
  let bestY = tol;
  for (const id of handlePoints(s)) {
    if (exclude.has(id)) continue;
    const q = s.points[id];
    if (!q) continue;
    const dx = Math.abs(q.x - p.x);
    const dy = Math.abs(q.y - p.y);
    if (dx <= bestX) {
      vertical = { type: "verticalPts", ref: id, pos: { x: q.x, y: p.y } };
      bestX = dx;
    }
    if (dy <= bestY) {
      horizontal = { type: "horizontalPts", ref: id, pos: { x: p.x, y: q.y } };
      bestY = dy;
    }
  }
  if (vertical && horizontal) {
    const pos = { x: vertical.pos.x, y: horizontal.pos.y };
    return [
      { ...vertical, pos },
      { ...horizontal, pos },
    ];
  }
  return [vertical ?? horizontal].filter((alignment): alignment is PointAlignment => alignment !== null);
}

/** Near-horizontal / near-vertical inference for a segment from a to b (within `deg`). */
export function inferHV(a: Vec, b: Vec, deg = 4): "h" | "v" | null {
  const ang = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return null;
  if (ang < deg || ang > 180 - deg) return "h";
  if (Math.abs(ang - 90) < deg) return "v";
  return null;
}

/** Circle through three points, or null if they are (nearly) collinear. */
export function circleThrough(a: Vec, b: Vec, c: Vec): { c: Vec; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x: ux, y: uy }, r: Math.hypot(a.x - ux, a.y - uy) };
}
