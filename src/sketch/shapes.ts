// Shape tools and patterns (pure): slot, regular polygon, linear/grid and circular patterns.
import { t } from "../i18n";
import type { Vec } from "../geom/geom";
import { type Constraint, type Entity, type NewEntity, type Sketch, addConstraint, addEntity, addPoint, entity, entityPoints, pt } from "./model";
import { type Click, pointFor } from "./draw";

interface Opts {
  construction?: boolean;
}
const TAU = 2 * Math.PI;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const ent = (s: Sketch, e: NewEntity, o: Opts) => addEntity(s, (o.construction ? { ...e, construction: true } : e) as NewEntity);

/**
 * Slot: two end centres and a half-width. Two semicircle arcs and two tangent lines, equal radii, with a
 * construction centre line (so it can be dimensioned and constrained like Onshape's).
 */
export function drawSlot(s: Sketch, a: Click, b: Click, halfWidth: number, o: Opts = {}): { s: Sketch } | null {
  const A0 = a.snap?.pos ?? a.pos;
  const B0 = b.snap?.pos ?? b.pos;
  const L = Math.hypot(B0.x - A0.x, B0.y - A0.y);
  if (L < 1e-6 || halfWidth < 1e-6) return null;
  const pa = pointFor(s, a);
  const pb = pointFor(pa.s, b);
  let out = pb.s;
  const A = pt(out, pa.id);
  const B = pt(out, pb.id);
  const u = { x: (B.x - A.x) / L, y: (B.y - A.y) / L };
  const n = { x: -u.y * halfWidth, y: u.x * halfWidth };
  const corners = [
    { x: A.x + n.x, y: A.y + n.y },
    { x: B.x + n.x, y: B.y + n.y },
    { x: B.x - n.x, y: B.y - n.y },
    { x: A.x - n.x, y: A.y - n.y },
  ];
  const ids: string[] = [];
  for (const c of corners) {
    const r = addPoint(out, c);
    out = r.s;
    ids.push(r.id);
  }
  const [p1, p2, p3, p4] = ids as [string, string, string, string];
  // An arc runs counter-clockwise (increasing angle) from start to end; pick the order that bulges away (dir).
  const arcFrom = (c: Vec, x: string, y: string, dir: Vec): [string, string] => {
    const ang = (q: Vec) => Math.atan2(q.y - c.y, q.x - c.x);
    const ax = ang(pt(out, x));
    return norm(Math.atan2(dir.y, dir.x) - ax) < norm(ang(pt(out, y)) - ax) ? [x, y] : [y, x];
  };
  const l1 = ent(out, { kind: "line", p1, p2 }, o);
  const l2 = ent(l1.s, { kind: "line", p1: p3, p2: p4 }, o);
  out = l2.s;
  const [s2, e2] = arcFrom(B, p2, p3, u);
  const a2 = ent(out, { kind: "arc", c: pb.id, r: halfWidth, start: s2, end: e2 }, o);
  out = a2.s;
  const [s1, e1] = arcFrom(A, p4, p1, { x: -u.x, y: -u.y });
  const a1 = ent(out, { kind: "arc", c: pa.id, r: halfWidth, start: s1, end: e1 }, o);
  out = a1.s;
  const axis = addEntity(out, { kind: "line", p1: pa.id, p2: pb.id, construction: true });
  out = axis.s;
  for (const [l, arc] of [[l1.id, a1.id], [l1.id, a2.id], [l2.id, a1.id], [l2.id, a2.id]] as const) out = addConstraint(out, { type: "tangent", refs: [l, arc] }).s;
  out = addConstraint(out, { type: "equal", refs: [a1.id, a2.id] }).s;
  return { s: out };
}

/** Regular polygon: centre and one corner; corners on a construction circle, equal sides. */
export function drawPolygon(s: Sketch, c: Click, corner: Vec, sides: number, o: Opts = {}): { s: Sketch } | null {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  const pc = pointFor(s, c);
  let out = pc.s;
  const C = pt(out, pc.id);
  const r = Math.hypot(corner.x - C.x, corner.y - C.y);
  if (r < 1e-6) return null;
  const a0 = Math.atan2(corner.y - C.y, corner.x - C.x);
  const circ = addEntity(out, { kind: "circle", c: pc.id, r, construction: true });
  out = circ.s;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (TAU * i) / n;
    const p = addPoint(out, { x: C.x + r * Math.cos(a), y: C.y + r * Math.sin(a) });
    out = addConstraint(p.s, { type: "pointOnCircle", refs: [p.id, circ.id] }).s;
    ids.push(p.id);
  }
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = ent(out, { kind: "line", p1: ids[i]!, p2: ids[(i + 1) % n]! }, o);
    out = l.s;
    lines.push(l.id);
  }
  for (let i = 1; i < n; i++) out = addConstraint(out, { type: "equal", refs: [lines[0]!, lines[i]!] }).s;
  return { s: out };
}

/**
 * Copy entities with each point moved by `move`. Constraints among the copied items come along (dimensions as
 * hidden followers of the originals); horizontal/vertical only when `keepDirections` (translations).
 */
export function copyItems(s: Sketch, ids: string[], move: (p: Vec) => Vec, keepDirections: boolean): { s: Sketch; map: Map<string, string> } {
  let out = s;
  const map = new Map<string, string>();
  const ents = ids.map((id) => entity(s, id)).filter((e): e is Entity => !!e);
  const P = (id: string): string => {
    const got = map.get(id);
    if (got) return got;
    const r = addPoint(out, move(pt(s, id)));
    out = r.s;
    map.set(id, r.id);
    return r.id;
  };
  for (const e of ents) {
    let ne: NewEntity;
    const base = { ...(e.construction ? { construction: true } : {}), ...(e.color ? { color: e.color } : {}) };
    switch (e.kind) {
      case "line":
        ne = { kind: "line", p1: P(e.p1), p2: P(e.p2), ...base };
        break;
      case "circle":
        ne = { kind: "circle", c: P(e.c), r: e.r, ...base };
        break;
      case "arc":
        ne = { kind: "arc", c: P(e.c), r: e.r, start: P(e.start), end: P(e.end), ...base };
        break;
      case "point":
        ne = { kind: "point", p: P(e.p), ...base };
        break;
      case "spline":
        ne = { kind: "spline", pts: e.pts.map(P), closed: e.closed, ...base };
        break;
      case "text":
      case "ref": {
        // Rigid items: the anchor moves; text/ref copies keep their own angle (rotation is not applied to them).
        const a = P(e.anchor);
        ne = { ...(e as Omit<typeof e, "id">), anchor: a } as NewEntity;
        break;
      }
    }
    const r = addEntity(out, ne);
    out = r.s;
    map.set(e.id, r.id);
  }
  // Constraints entirely within the copied set.
  const inside = (c: Constraint) => c.refs.every((r) => map.has(r));
  for (const c of s.constraints) {
    if (!inside(c)) continue;
    if (!keepDirections && (c.type === "horizontal" || c.type === "vertical" || c.type === "horizontalPts" || c.type === "verticalPts" || c.type === "distanceX" || c.type === "distanceY")) continue;
    const refs = c.refs.map((r) => map.get(r)!);
    const dim = c.value !== undefined;
    out = addConstraint(out, { type: c.type, refs, ...(dim ? { value: c.value, hidden: true, link: c.link ?? c.id } : {}) }).s;
  }
  return { s: out, map };
}

/** The first point of the first entity: what pins each pattern copy to the original. */
function anchorOf(s: Sketch, ids: string[]): string | null {
  for (const id of ids) {
    const e = entity(s, id);
    if (e) return entityPoints(e)[0] ?? null;
  }
  return null;
}

/** Linear (one direction) or grid (two) pattern: copies at i·step1 + j·step2, held there relative to the original. */
export function linearPattern(s: Sketch, ids: string[], step1: Vec, count1: number, step2: Vec, count2: number): { s: Sketch } | { error: string } {
  const anchor = anchorOf(s, ids);
  if (!anchor) return { error: t("Select the geometry to pattern first.") };
  let out = s;
  const n1 = Math.max(1, Math.round(count1));
  const n2 = Math.max(1, Math.round(count2));
  if (n1 * n2 < 2) return { error: t("Set more than one copy.") };
  for (let i = 0; i < n1; i++) {
    for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const d = { x: i * step1.x + j * step2.x, y: i * step1.y + j * step2.y };
      const c = copyItems(out, ids, (p) => ({ x: p.x + d.x, y: p.y + d.y }), true);
      out = c.s;
      const a = c.map.get(anchor)!;
      out = addConstraint(out, { type: "distanceX", refs: [anchor, a], value: d.x, hidden: true }).s;
      out = addConstraint(out, { type: "distanceY", refs: [anchor, a], value: d.y, hidden: true }).s;
    }
  }
  return { s: out };
}

/** Circular pattern: `count` items in all (the original included) spread evenly around the centre point. */
export function circularPattern(s: Sketch, ids: string[], centre: string, count: number, sweepDeg = 360): { s: Sketch } | { error: string } {
  const n = Math.max(2, Math.round(count));
  if (!anchorOf(s, ids)) return { error: t("Select the geometry to pattern first.") };
  const C = pt(s, centre);
  const full = Math.abs(sweepDeg - 360) < 1e-9;
  const step = ((sweepDeg * Math.PI) / 180) / (full ? n : n - 1);
  let out = s;
  for (let k = 1; k < n; k++) {
    const a = step * k;
    const [co, si] = [Math.cos(a), Math.sin(a)];
    const rot = (p: Vec) => ({ x: C.x + (p.x - C.x) * co - (p.y - C.y) * si, y: C.y + (p.x - C.x) * si + (p.y - C.y) * co });
    out = copyItems(out, ids, rot, false).s;
  }
  return { s: out };
}
