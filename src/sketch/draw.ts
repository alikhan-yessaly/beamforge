// Creating geometry with the drawing tools (pure). Snapped clicks reuse existing points (coincidence by sharing)
// or add a point-on-curve constraint; inferred horizontal/vertical becomes a constraint.
import type { Vec } from "../geom/geom";
import { type Constraint, type NewEntity, type Sketch, addConstraint, addEntity, addPoint, pt } from "./model";
import { type Snap, circleThrough, inferHV } from "./pick";
import { solve, solverReady } from "./solver";

export interface Click {
  pos: Vec;
  snap: Snap;
  inferences?: { type: "horizontalPts" | "verticalPts"; ref: string }[];
  previousAxis?: "h" | "v";
}

interface Opts {
  construction?: boolean;
  /** Add inferred constraints (Shift turns this off). */
  infer?: boolean;
}

/** Add an inference only when it contributes an independent, solvable constraint. */
function addInference(s: Sketch, constraint: Omit<Constraint, "id">): Sketch {
  const candidate = addConstraint(s, constraint);
  if (!solverReady()) return candidate.s;
  const before = solve(s);
  if (!before.ok) return s;
  const after = solve(candidate.s);
  if (!after.ok || after.dof >= before.dof || after.redundant.length > before.redundant.length) return s;
  return candidate.s;
}

/** The point id for a click: the snapped point, or a new point (constrained onto a snapped curve). */
export function pointFor(s: Sketch, c: Click): { s: Sketch; id: string } {
  if (c.snap?.kind === "point") return { s, id: c.snap.id };
  const r = addPoint(s, c.snap?.pos ?? c.pos);
  let out = r.s;
  if (c.snap?.kind === "curve") {
    const e = out.entities.find((x) => x.id === c.snap!.id);
    const type: Constraint["type"] = e?.kind === "line" ? "pointOnLine" : "pointOnCircle";
    out = addConstraint(out, { type, refs: [r.id, c.snap.id] }).s;
  }
  for (const inference of c.inferences ?? []) {
    out = addInference(out, { type: inference.type, refs: [r.id, inference.ref] });
  }
  return { s: out, id: r.id };
}

const ent = (s: Sketch, e: NewEntity, o: Opts) => addEntity(s, (o.construction ? { ...e, construction: true } : e) as NewEntity);

export function drawLine(s: Sketch, a: Click, b: Click, o: Opts = {}): { s: Sketch; line: string; end: string } {
  const pa = pointFor(s, a);
  const pb = pointFor(pa.s, b);
  const l = ent(pb.s, { kind: "line", p1: pa.id, p2: pb.id }, o);
  let out = l.s;
  const hv = o.infer === false || b.snap?.kind === "point" ? null : b.previousAxis ?? (b.inferences?.length ? null : inferHV(pt(out, pa.id), pt(out, pb.id)));
  if (hv) out = addInference(out, { type: hv === "h" ? "horizontal" : "vertical", refs: [l.id] });
  return { s: out, line: l.id, end: pb.id };
}

/** Axis-aligned rectangle from two opposite corners: 4 lines, 2 horizontal and 2 vertical. */
export function drawRect(s: Sketch, a: Click, b: Click, o: Opts = {}): { s: Sketch; lines: string[] } {
  const p0 = pointFor(s, a);
  let cur = p0.s;
  const corners = [p0.id];
  const A = pt(cur, p0.id);
  const B = b.snap?.pos ?? b.pos;
  for (const q of [{ x: B.x, y: A.y }]) {
    const r = addPoint(cur, q);
    cur = r.s;
    corners.push(r.id);
  }
  const pb = pointFor(cur, b);
  cur = pb.s;
  corners.push(pb.id);
  const r3 = addPoint(cur, { x: A.x, y: B.y });
  cur = r3.s;
  corners.push(r3.id);
  return closeQuad(cur, corners, o);
}

function closeQuad(s: Sketch, corners: string[], o: Opts): { s: Sketch; lines: string[] } {
  let cur = s;
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const l = ent(cur, { kind: "line", p1: corners[i]!, p2: corners[(i + 1) % 4]! }, o);
    cur = l.s;
    lines.push(l.id);
  }
  for (const [i, t] of [[0, "horizontal"], [1, "vertical"], [2, "horizontal"], [3, "vertical"]] as const) cur = addConstraint(cur, { type: t, refs: [lines[i]!] }).s;
  return { s: cur, lines };
}

/** Rectangle from its centre and a corner, with a construction diagonal whose midpoint is the centre. */
export function drawRectCenter(s: Sketch, c: Click, corner: Click, o: Opts = {}): { s: Sketch; lines: string[] } {
  const pc = pointFor(s, c);
  let cur = pc.s;
  const C = pt(cur, pc.id);
  const K = corner.snap?.pos ?? corner.pos;
  const dx = K.x - C.x;
  const dy = K.y - C.y;
  const ids: string[] = [];
  for (const q of [{ x: C.x - dx, y: C.y - dy }, { x: C.x + dx, y: C.y - dy }]) {
    const r = addPoint(cur, q);
    cur = r.s;
    ids.push(r.id);
  }
  const pk = pointFor(cur, corner);
  cur = pk.s;
  ids.push(pk.id);
  const r4 = addPoint(cur, { x: C.x - dx, y: C.y + dy });
  cur = r4.s;
  ids.push(r4.id);
  const q = closeQuad(cur, ids, o);
  const diag = addEntity(q.s, { kind: "line", p1: ids[0]!, p2: ids[2]!, construction: true });
  const mid = addConstraint(diag.s, { type: "midpoint", refs: [pc.id, diag.id] });
  // The centre point must stay a visible handle: give it a point entity.
  const centre = addEntity(mid.s, { kind: "point", p: pc.id, construction: true });
  return { s: centre.s, lines: q.lines };
}

export function drawCircle(s: Sketch, c: Click, edge: Vec, o: Opts = {}): { s: Sketch; circle: string } {
  const pc = pointFor(s, c);
  const C = pt(pc.s, pc.id);
  const r = Math.max(0.01, Math.hypot(edge.x - C.x, edge.y - C.y));
  const e = ent(pc.s, { kind: "circle", c: pc.id, r }, o);
  return { s: e.s, circle: e.id };
}

/** Arc through start, end and a third point on it. */
export function drawArc3(s: Sketch, a: Click, b: Click, through: Vec, o: Opts = {}): { s: Sketch; arc: string } | null {
  const A = a.snap?.pos ?? a.pos;
  const B = b.snap?.pos ?? b.pos;
  const circ = circleThrough(A, B, through);
  if (!circ) return null;
  // Arcs run counter-clockwise (increasing angle) from start to end; swap if the third point says otherwise.
  const ang = (p: Vec) => Math.atan2(p.y - circ.c.y, p.x - circ.c.x);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccwThrough = norm(ang(through) - ang(A)) < norm(ang(B) - ang(A));
  const [first, second] = ccwThrough ? [a, b] : [b, a];
  const p1 = pointFor(s, first);
  const p2 = pointFor(p1.s, second);
  const pc = addPoint(p2.s, circ.c);
  const e = ent(pc.s, { kind: "arc", c: pc.id, r: circ.r, start: p1.id, end: p2.id }, o);
  return { s: e.s, arc: e.id };
}

/** Arc around a centre from start to end (counter-clockwise on screen when `ccw`, else clockwise). */
export function drawArcCenter(s: Sketch, c: Click, a: Click, end: Vec, ccw: boolean, o: Opts = {}): { s: Sketch; arc: string } {
  const pc = pointFor(s, c);
  const C = pt(pc.s, pc.id);
  const A = a.snap?.pos ?? a.pos;
  const r = Math.max(0.01, Math.hypot(A.x - C.x, A.y - C.y));
  const ea = Math.atan2(end.y - C.y, end.x - C.x);
  const B = { x: C.x + r * Math.cos(ea), y: C.y + r * Math.sin(ea) };
  const pa = pointFor(pc.s, a);
  const pb = addPoint(pa.s, B);
  // Solver arcs increase in angle; with y down, that is clockwise on screen.
  const [start, endId] = ccw ? [pb.id, pa.id] : [pa.id, pb.id];
  // The arc's own rules keep both endpoints on its circle, so no extra constraint is needed.
  const e = ent(pb.s, { kind: "arc", c: pc.id, r, start, end: endId }, o);
  return { s: e.s, arc: e.id };
}

/** Tangent arc continuing from the end of a line (or arc) at point `from`. */
export function drawArcTangent(s: Sketch, from: string, along: string, end: Click, o: Opts = {}): { s: Sketch; arc: string } | null {
  const e = s.entities.find((x) => x.id === along);
  if (!e || (e.kind !== "line" && e.kind !== "arc")) return null;
  const P = pt(s, from);
  // Tangent direction at P, pointing away from the entity.
  let t: Vec;
  if (e.kind === "line") {
    const other = pt(s, e.p1 === from ? e.p2 : e.p1);
    t = { x: P.x - other.x, y: P.y - other.y };
  } else {
    const c = pt(s, e.c);
    const rad = { x: P.x - c.x, y: P.y - c.y };
    t = from === e.end ? { x: -rad.y, y: rad.x } : { x: rad.y, y: -rad.x };
  }
  const tl = Math.hypot(t.x, t.y) || 1;
  t = { x: t.x / tl, y: t.y / tl };
  const E = end.snap?.pos ?? end.pos;
  const n = { x: -t.y, y: t.x };
  const d = { x: E.x - P.x, y: E.y - P.y };
  const denom = 2 * (d.x * n.x + d.y * n.y);
  if (Math.abs(denom) < 1e-9) return null;
  const k = (d.x * d.x + d.y * d.y) / denom; // centre = P + k n
  const C = { x: P.x + k * n.x, y: P.y + k * n.y };
  const r = Math.abs(k);
  const pe = pointFor(s, end);
  const pc = addPoint(pe.s, C);
  // Going along t: arc increases angle (solver CCW) when the centre is on the +n side... with y down, check cross.
  const cross = t.x * (C.y - P.y) - t.y * (C.x - P.x);
  const [start, endId] = cross > 0 ? [from, pe.id] : [pe.id, from];
  const a = ent(pc.s, { kind: "arc", c: pc.id, r, start, end: endId }, o);
  return { s: addConstraint(a.s, { type: "tangent", refs: [along, a.id] }).s, arc: a.id };
}

export function drawPoint(s: Sketch, c: Click, o: Opts = {}): { s: Sketch; point: string } {
  const p = pointFor(s, c);
  const e = ent(p.s, { kind: "point", p: p.id }, o);
  return { s: e.s, point: e.id };
}
