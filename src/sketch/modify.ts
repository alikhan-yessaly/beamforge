// Modify tools (pure): trim, fillet, chamfer, mirror and offset. Each returns a new sketch with the constraints
// Onshape would add (points on the cutting curve, tangency, symmetry, a dimension for the size), or an error.
import type { Vec } from "../geom/geom";
import {
  type ArcEntity,
  type Constraint,
  type Entity,
  type LineEntity,
  type NewEntity,
  type Sketch,
  addConstraint,
  addEntity,
  addPoint,
  arcAngles,
  deleteItems,
  entity,
  pt,
} from "./model";
import { distToEntity } from "./pick";
import { solve, solverReady } from "./solver";

type Result = { s: Sketch; dimension?: string } | { error: string };
const TAU = 2 * Math.PI;
const EPS = 1e-6;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec) => Math.hypot(a.x, a.y);
const unit = (a: Vec): Vec => mul(a, 1 / (len(a) || 1));
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;

// ---------------------------------------------------------------- intersections

/** A curve's carrier: a segment (or infinite line) or a circle (optionally an arc range a0..a1). */
type Carrier = { kind: "seg"; a: Vec; b: Vec; infinite?: boolean } | { kind: "circ"; c: Vec; r: number; a0?: number; a1?: number };

function carrierOf(s: Sketch, e: Entity): Carrier | null {
  if (e.kind === "line") return { kind: "seg", a: pt(s, e.p1), b: pt(s, e.p2) };
  if (e.kind === "circle") return { kind: "circ", c: pt(s, e.c), r: e.r };
  if (e.kind === "arc") {
    const { a0, a1 } = arcAngles(s, e);
    return { kind: "circ", c: pt(s, e.c), r: Math.hypot(pt(s, e.start).x - pt(s, e.c).x, pt(s, e.start).y - pt(s, e.c).y), a0, a1 };
  }
  return null;
}

function onCarrier(k: Carrier, p: Vec, eps = 1e-7): boolean {
  if (k.kind === "seg") {
    if (k.infinite) return true;
    const d = sub(k.b, k.a);
    const t = dot(sub(p, k.a), d) / (dot(d, d) || 1);
    return t >= -eps && t <= 1 + eps;
  }
  if (k.a0 === undefined || k.a1 === undefined) return true;
  const a = norm(Math.atan2(p.y - k.c.y, p.x - k.c.x) - k.a0);
  return a <= k.a1 - k.a0 + eps || a >= TAU - eps;
}

function rawIntersect(A: Carrier, B: Carrier): Vec[] {
  if (A.kind === "seg" && B.kind === "seg") {
    const r = sub(A.b, A.a);
    const q = sub(B.b, B.a);
    const den = r.x * q.y - r.y * q.x;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((B.a.x - A.a.x) * q.y - (B.a.y - A.a.y) * q.x) / den;
    return [add(A.a, mul(r, t))];
  }
  if (A.kind === "circ" && B.kind === "seg") return rawIntersect(B, A);
  if (A.kind === "seg" && B.kind === "circ") {
    const d = sub(A.b, A.a);
    const f = sub(A.a, B.c);
    const a = dot(d, d);
    const b = 2 * dot(f, d);
    const c = dot(f, f) - B.r * B.r;
    let disc = b * b - 4 * a * c;
    if (disc < -1e-9 || a < 1e-18) return [];
    disc = Math.max(0, disc);
    const sq = Math.sqrt(disc);
    const ts = sq < 1e-12 ? [-b / (2 * a)] : [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
    return ts.map((t) => add(A.a, mul(d, t)));
  }
  const [C1, C2] = [A as Extract<Carrier, { kind: "circ" }>, B as Extract<Carrier, { kind: "circ" }>];
  const dv = sub(C2.c, C1.c);
  const d = len(dv);
  if (d < 1e-12 || d > C1.r + C2.r + 1e-9 || d < Math.abs(C1.r - C2.r) - 1e-9) return [];
  const a = (C1.r * C1.r - C2.r * C2.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, C1.r * C1.r - a * a));
  const m = add(C1.c, mul(dv, a / d));
  if (h < 1e-12) return [m];
  const off = { x: (-dv.y * h) / d, y: (dv.x * h) / d };
  return [add(m, off), sub(m, off)];
}

/** Intersections of two curves within both of their ranges. */
export function intersect(A: Carrier, B: Carrier): Vec[] {
  return rawIntersect(A, B).filter((p) => onCarrier(A, p) && onCarrier(B, p));
}

// ---------------------------------------------------------------- shared helpers

/** A new point at `pos`, kept on the cutting curve. */
function pointOn(s: Sketch, pos: Vec, cutter: string): { s: Sketch; id: string } {
  const r = addPoint(s, pos);
  const e = entity(r.s, cutter)!;
  return { s: addConstraint(r.s, { type: e.kind === "line" ? "pointOnLine" : "pointOnCircle", refs: [r.id, cutter] }).s, id: r.id };
}

const replaceEntity = (s: Sketch, e: Entity): Sketch => ({ ...s, entities: s.entities.map((x) => (x.id === e.id ? e : x)) });

/** Constraints that pin a line's length or midpoint: dropped once the line is shortened. */
const lengthBound = (c: Constraint, id: string) => (c.type === "distance" && c.refs.length === 1 && c.refs[0] === id) || ((c.type === "equal" || c.type === "midpoint") && c.refs.includes(id));
const dropLengthBound = (s: Sketch, id: string): Sketch => ({ ...s, constraints: s.constraints.filter((c) => !lengthBound(c, id)) });

/** Remove points nothing uses any more, and constraints on them. */
const tidy = (s: Sketch) => deleteItems(s, new Set());

// ---------------------------------------------------------------- trim

type Cut = {
  u: number;
  pos: Vec;
} & ({ kind: "curve"; by: string } | { kind: "point"; point: string });

const preferPoint = (a: Cut, b: Cut) => Number(b.kind === "point") - Number(a.kind === "point");

function cutPoint(s: Sketch, cut: Cut, target: string): { s: Sketch; id: string } {
  if (cut.kind === "curve") return pointOn(s, cut.pos, cut.by);
  return {
    s: {
      ...s,
      constraints: s.constraints.filter((c) =>
        !((c.type === "pointOnLine" || c.type === "pointOnCircle") && c.refs[0] === cut.point && c.refs[1] === target)),
    },
    id: cut.point,
  };
}

export type TrimPiece =
  | { kind: "line"; a: Vec; b: Vec }
  | { kind: "arc"; c: Vec; r: number; a0: number; a1: number };

/** Find the exact piece and crossings used by both the trim preview and the operation. */
function trimTarget(s: Sketch, id: string, p: Vec):
  | { e: LineEntity | ArcEntity | Extract<Entity, { kind: "circle" }>; lo?: Cut; hi?: Cut; piece: TrimPiece }
  | { error: string } {
  const e = entity(s, id);
  if (!e || (e.kind !== "line" && e.kind !== "circle" && e.kind !== "arc")) return { error: "Trim works on lines, circles and arcs." };
  const me = carrierOf(s, e)!;
  const cuts: Cut[] = [];
  for (const o of s.entities) {
    if (o.id === id) continue;
    if (o.kind === "point") {
      const pos = pt(s, o.p);
      if (distToEntity(s, e, pos) <= 1e-5) cuts.push({ kind: "point", u: paramOn(s, e, pos), pos, point: o.p });
      continue;
    }
    const k = carrierOf(s, o);
    if (!k) continue;
    for (const q of intersect(me, k)) cuts.push({ kind: "curve", u: paramOn(s, e, q), pos: q, by: o.id });
  }
  cuts.sort((a, b) => a.u - b.u || preferPoint(a, b));
  const distinct: Cut[] = [];
  for (const cut of cuts) {
    const previous = distinct[distinct.length - 1];
    if (!previous || cut.u - previous.u > EPS) distinct.push(cut);
    else if (cut.kind === "point" && previous.kind !== "point") distinct[distinct.length - 1] = cut;
  }
  const u = paramOn(s, e, p);

  if (e.kind === "line") {
    const inside = distinct.filter((c) => c.u > EPS && c.u < 1 - EPS);
    const lo = maxBelow(inside, u);
    const hi = minAbove(inside, u);
    return { e, lo, hi, piece: { kind: "line", a: lo?.pos ?? pt(s, e.p1), b: hi?.pos ?? pt(s, e.p2) } };
  }

  if (e.kind === "circle") {
    const sorted = distinct;
    if (sorted.length > 1 && sorted[0]!.u + TAU - sorted[sorted.length - 1]!.u <= EPS) {
      if (sorted.at(-1)!.kind === "point" && sorted[0]!.kind !== "point") sorted[0] = { ...sorted.at(-1)!, u: sorted.at(-1)!.u - TAU };
      sorted.pop();
    }
    if (sorted.length === 1) return { error: "A circle needs two distinct crossings or points to trim between." };
    const hi = sorted.find((c) => c.u > u) ?? sorted[0];
    const lo = [...sorted].reverse().find((c) => c.u <= u) ?? sorted[sorted.length - 1];
    const a0 = lo?.u ?? 0;
    let a1 = hi?.u ?? TAU;
    if (hi && a1 <= a0) a1 += TAU;
    return { e, lo, hi, piece: { kind: "arc", c: pt(s, e.c), r: e.r, a0, a1 } };
  }

  const { a0, a1 } = arcAngles(s, e);
  const inside = distinct.filter((c) => c.u > EPS && c.u < a1 - a0 - EPS);
  const lo = maxBelow(inside, u);
  const hi = minAbove(inside, u);
  return { e, lo, hi, piece: { kind: "arc", c: pt(s, e.c), r: e.r, a0: a0 + (lo?.u ?? 0), a1: a0 + (hi?.u ?? a1 - a0) } };
}

export function trimPieceAt(s: Sketch, id: string, p: Vec): TrimPiece | { error: string } {
  const target = trimTarget(s, id, p);
  return "error" in target ? target : target.piece;
}

/** Remove the piece of a line, circle or arc under `p`, between its nearest crossings with other geometry. */
export function trimAt(s: Sketch, id: string, p: Vec): Result {
  const target = trimTarget(s, id, p);
  if ("error" in target) return target;
  const { e, lo, hi } = target;
  if (e.kind === "line") {
    if (!lo && !hi) return { s: tidy(deleteItems(s, new Set([id]))) };
    let out = dropLengthBound(s, id);
    if (!lo) {
      const np = cutPoint(out, hi!, id);
      return { s: tidy(replaceEntity(np.s, { ...e, p1: np.id })) };
    }
    if (!hi) {
      const np = cutPoint(out, lo, id);
      return { s: tidy(replaceEntity(np.s, { ...e, p2: np.id })) };
    }
    // Split: keep [p1, lo] as this line, add [hi, p2] as a collinear new line.
    const a = cutPoint(out, lo, id);
    const b = cutPoint(a.s, hi, id);
    out = replaceEntity(b.s, { ...e, p2: a.id });
    const second = addEntity(out, { kind: "line", p1: b.id, p2: e.p2, ...(e.construction ? { construction: true } : {}), ...(e.color ? { color: e.color } : {}) });
    out = second.s;
    const dir = s.constraints.filter((c) => (c.type === "horizontal" || c.type === "vertical") && c.refs[0] === id);
    for (const c of dir) out = addConstraint(out, { type: c.type, refs: [second.id] }).s;
    if (!dir.length) out = addConstraint(out, { type: "parallel", refs: [id, second.id] }).s;
    out = addConstraint(out, { type: "pointOnLine", refs: [b.id, id] }).s;
    return { s: tidy(out) };
  }

  if (e.kind === "circle") {
    if (!lo || !hi) return { s: tidy(deleteItems(s, new Set([id]))) };
    // The remaining arc runs (increasing angle) from hi round to lo.
    const a = cutPoint(s, hi, id);
    const b = cutPoint(a.s, lo, id);
    const arc: ArcEntity = { id, kind: "arc", c: e.c, r: e.r, start: a.id, end: b.id, ...(e.construction ? { construction: true } : {}), ...(e.color ? { color: e.color } : {}) };
    return { s: tidy(replaceEntity(b.s, arc)) };
  }

  if (!lo && !hi) return { s: tidy(deleteItems(s, new Set([id]))) };
  if (!lo) {
    const np = cutPoint(s, hi!, id);
    return { s: tidy(replaceEntity(np.s, { ...e, start: np.id })) };
  }
  if (!hi) {
    const np = cutPoint(s, lo, id);
    return { s: tidy(replaceEntity(np.s, { ...e, end: np.id })) };
  }
  const a = cutPoint(s, lo, id);
  const b = cutPoint(a.s, hi, id);
  let out = replaceEntity(b.s, { ...e, end: a.id });
  const second = addEntity(out, { kind: "arc", c: e.c, r: e.r, start: b.id, end: e.end, ...(e.construction ? { construction: true } : {}), ...(e.color ? { color: e.color } : {}) });
  out = addConstraint(second.s, { type: "equal", refs: [id, second.id] }).s;
  return { s: tidy(out) };
}

/** Position along an entity: line t (0..1), circle angle (0..2π), arc angle from its start. */
function paramOn(s: Sketch, e: Entity, p: Vec): number {
  if (e.kind === "line") {
    const a = pt(s, e.p1);
    const d = sub(pt(s, e.p2), a);
    return dot(sub(p, a), d) / (dot(d, d) || 1);
  }
  if (e.kind === "circle") return norm(Math.atan2(p.y - pt(s, e.c).y, p.x - pt(s, e.c).x));
  if (e.kind === "arc") return norm(Math.atan2(p.y - pt(s, e.c).y, p.x - pt(s, e.c).x) - arcAngles(s, e).a0);
  return 0;
}

const maxBelow = (cs: Cut[], u: number) => cs.filter((c) => c.u <= u).sort((a, b) => b.u - a.u || preferPoint(a, b))[0];
const minAbove = (cs: Cut[], u: number) => cs.filter((c) => c.u > u).sort((a, b) => a.u - b.u || preferPoint(a, b))[0];

// ---------------------------------------------------------------- fillet and chamfer

/** The two lines meeting at a corner point, with their far ends. */
function corner(s: Sketch, p: string): { l1: LineEntity; l2: LineEntity; a: string; b: string } | { error: string } {
  const lines = s.entities.filter((e): e is LineEntity => e.kind === "line" && !e.construction && (e.p1 === p || e.p2 === p));
  if (lines.length !== 2) return { error: "Click a corner where exactly two lines meet." };
  const [l1, l2] = lines as [LineEntity, LineEntity];
  return { l1, l2, a: l1.p1 === p ? l1.p2 : l1.p1, b: l2.p1 === p ? l2.p2 : l2.p1 };
}

const withEnd = (l: LineEntity, from: string, to: string): LineEntity => (l.p1 === from ? { ...l, p1: to } : { ...l, p2: to });

/** Round a corner where two lines meet with a tangent arc of radius r (plus a radius dimension). */
export function filletAt(s: Sketch, p: string, r: number): Result {
  const k = corner(s, p);
  if ("error" in k) return k;
  const P = pt(s, p);
  const u1 = unit(sub(pt(s, k.a), P));
  const u2 = unit(sub(pt(s, k.b), P));
  const half = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))) / 2;
  if (half < 1e-3 || Math.PI / 2 - half < 1e-3) return { error: "Those lines don't make a corner to round." };
  const d = r / Math.tan(half);
  if (d >= len(sub(pt(s, k.a), P)) || d >= len(sub(pt(s, k.b), P))) return { error: "That radius is too big for these lines." };
  const T1 = add(P, mul(u1, d));
  const T2 = add(P, mul(u2, d));
  const C = add(P, mul(unit(add(u1, u2)), r / Math.sin(half)));
  let out = dropLengthBound(dropLengthBound(s, k.l1.id), k.l2.id);
  const t1 = addPoint(out, T1);
  const t2 = addPoint(t1.s, T2);
  const c = addPoint(t2.s, C);
  out = replaceEntity(replaceEntity(c.s, withEnd(k.l1, p, t1.id)), withEnd(k.l2, p, t2.id));
  const short = norm(Math.atan2(T2.y - C.y, T2.x - C.x) - Math.atan2(T1.y - C.y, T1.x - C.x)) < Math.PI;
  const arc = addEntity(out, { kind: "arc", c: c.id, r, start: short ? t1.id : t2.id, end: short ? t2.id : t1.id, ...(k.l1.color ? { color: k.l1.color } : {}) });
  out = addConstraint(arc.s, { type: "tangent", refs: [k.l1.id, arc.id] }).s;
  out = addConstraint(out, { type: "tangent", refs: [k.l2.id, arc.id] }).s;
  const mid = add(C, mul(unit(sub(P, C)), r));
  const dim = addConstraint(out, { type: "radius", refs: [arc.id], value: r, offset: mul(sub(mid, C), 1.6) });
  return { s: tidy(dim.s), dimension: dim.id };
}

/**
 * Cut a corner where two lines meet with a straight line `d` from the corner along both. The sharp corner stays as
 * a construction point (on both lines), with equal construction legs and a dimension on one of them.
 */
export function chamferAt(s: Sketch, p: string, d: number): Result {
  const k = corner(s, p);
  if ("error" in k) return k;
  const P = pt(s, p);
  const la = len(sub(pt(s, k.a), P));
  const lb = len(sub(pt(s, k.b), P));
  if (d >= la || d >= lb) return { error: "That distance is too big for these lines." };
  const T1 = add(P, mul(unit(sub(pt(s, k.a), P)), d));
  const T2 = add(P, mul(unit(sub(pt(s, k.b), P)), d));
  let out = dropLengthBound(dropLengthBound(s, k.l1.id), k.l2.id);
  const t1 = addPoint(out, T1);
  const t2 = addPoint(t1.s, T2);
  out = replaceEntity(replaceEntity(t2.s, withEnd(k.l1, p, t1.id)), withEnd(k.l2, p, t2.id));
  const cut = addEntity(out, { kind: "line", p1: t1.id, p2: t2.id, ...(k.l1.color ? { color: k.l1.color } : {}) });
  const leg1 = addEntity(cut.s, { kind: "line", p1: p, p2: t1.id, construction: true });
  const leg2 = addEntity(leg1.s, { kind: "line", p1: p, p2: t2.id, construction: true });
  out = addConstraint(leg2.s, { type: "pointOnLine", refs: [p, k.l1.id] }).s;
  out = addConstraint(out, { type: "pointOnLine", refs: [p, k.l2.id] }).s;
  out = addConstraint(out, { type: "equal", refs: [leg1.id, leg2.id] }).s;
  const away = unit(sub(P, mul(add(T1, T2), 0.5)));
  const dim = addConstraint(out, { type: "distance", refs: [leg1.id], value: d, offset: mul(away, Math.max(3, d * 0.6)) });
  return { s: tidy(dim.s), dimension: dim.id };
}

// ---------------------------------------------------------------- mirror

/** Mirror entities about a line, tied to the originals with symmetric constraints. */
export function mirrorItems(s: Sketch, ids: string[], lineId: string): Result {
  const axis = entity(s, lineId);
  if (axis?.kind !== "line") return { error: "Mirror: click a line to mirror about." };
  const A = pt(s, axis.p1);
  const B = pt(s, axis.p2);
  const dir = unit(sub(B, A));
  const reflect = (p: Vec): Vec => {
    const v = sub(p, A);
    const along = mul(dir, dot(v, dir));
    return sub(add(A, mul(along, 2)), v);
  };
  const onAxis = (p: Vec) => Math.abs((p.x - A.x) * dir.y - (p.y - A.y) * dir.x) < 1e-6;
  let out = s;
  const map = new Map<string, string>();
  const m = (id: string): string => {
    const got = map.get(id);
    if (got) return got;
    const P = pt(s, id);
    if (onAxis(P)) {
      map.set(id, id);
      return id;
    }
    const r = addPoint(out, reflect(P));
    out = addConstraint(r.s, { type: "symmetric", refs: [id, r.id, lineId] }).s;
    map.set(id, r.id);
    return r.id;
  };
  let count = 0;
  for (const id of ids) {
    const e = entity(s, id);
    if (!e || e.id === lineId) continue;
    const base = { ...(e.construction ? { construction: true } : {}), ...(e.color ? { color: e.color } : {}) };
    let ne: NewEntity | null = null;
    if (e.kind === "line") ne = { kind: "line", p1: m(e.p1), p2: m(e.p2), ...base };
    else if (e.kind === "circle") ne = { kind: "circle", c: m(e.c), r: e.r, ...base };
    else if (e.kind === "arc") ne = { kind: "arc", c: m(e.c), r: e.r, start: m(e.end), end: m(e.start), ...base };
    else if (e.kind === "point") ne = { kind: "point", p: m(e.p), ...base };
    else if (e.kind === "spline") ne = { kind: "spline", pts: e.pts.map(m), closed: e.closed, ...base };
    if (!ne) continue;
    const r = addEntity(out, ne);
    out = r.s;
    if (e.kind === "circle") out = addConstraint(out, { type: "equal", refs: [e.id, r.id] }).s;
    count++;
  }
  if (!count) return { error: "Mirror: select lines, circles, arcs, points or splines first (not the mirror line)." };
  return { s: out };
}

// ---------------------------------------------------------------- offset

interface Step {
  e: LineEntity | ArcEntity;
  /** Walked from its second point to its first (end → start). */
  rev: boolean;
}

/** The chain of lines and arcs joined end to end through `id` (stopping at branches), in walking order. */
export function chainOf(s: Sketch, id: string): { steps: Step[]; closed: boolean } | null {
  const first = entity(s, id);
  if (!first || (first.kind !== "line" && first.kind !== "arc")) return null;
  const ends = (e: LineEntity | ArcEntity): [string, string] => (e.kind === "line" ? [e.p1, e.p2] : [e.start, e.end]);
  const pool = s.entities.filter((e): e is LineEntity | ArcEntity => (e.kind === "line" || e.kind === "arc") && e.construction === first.construction);
  const at = (p: string) => pool.filter((e) => ends(e).includes(p));
  const steps: Step[] = [{ e: first, rev: false }];
  const used = new Set([first.id]);
  // Forward from the first entity's second point.
  let tip = ends(first)[1];
  let closed = false;
  for (;;) {
    const here = at(tip);
    if (here.length !== 2) break;
    const next = here.find((e) => !used.has(e.id));
    if (!next) {
      closed = here.some((e) => e.id === first.id) && steps.length > 1;
      break;
    }
    const [a, b] = ends(next);
    const rev = b === tip;
    steps.push({ e: next, rev });
    used.add(next.id);
    tip = rev ? a : b;
  }
  if (!closed) {
    // Backward from the first entity's first point.
    let tail = ends(first)[0];
    for (;;) {
      const here = at(tail);
      if (here.length !== 2) break;
      const prev = here.find((e) => !used.has(e.id));
      if (!prev) break;
      const [a, b] = ends(prev);
      const rev = a === tail; // walking towards `tail` means arriving at its a when reversed
      steps.unshift({ e: prev, rev });
      used.add(prev.id);
      tail = rev ? b : a;
    }
  }
  return { steps, closed };
}

const stepEnds = (st: Step): [string, string] => {
  const [a, b] = st.e.kind === "line" ? [st.e.p1, st.e.p2] : [st.e.start, st.e.end];
  return st.rev ? [b, a] : [a, b];
};

/** Signed offset distance for the cursor at p (positive: to the left of the walking direction). */
export function offsetDistance(s: Sketch, id: string, p: Vec): number {
  const e = entity(s, id);
  if (e?.kind === "circle") return e.r - len(sub(p, pt(s, e.c)));
  const ch = chainOf(s, id);
  if (!ch) return 0;
  let best = ch.steps[0]!;
  let bd = Infinity;
  for (const st of ch.steps) {
    const d = distToEntity(s, st.e, p);
    if (d < bd) [best, bd] = [st, d];
  }
  if (best.e.kind === "arc") {
    const r = len(sub(p, pt(s, best.e.c)));
    return best.rev ? r - best.e.r : best.e.r - r;
  }
  const [a, b] = stepEnds(best).map((q) => pt(s, q)) as [Vec, Vec];
  const t = unit(sub(b, a));
  return dot(sub(p, a), { x: -t.y, y: t.x });
}

/** Offset a chain of lines and arcs (or a circle) by signed distance d. Lines stay parallel at a dimensioned distance. */
export function offsetAt(s: Sketch, id: string, d: number, prune = true): Result {
  if (Math.abs(d) < 1e-6) return { error: "Move away from the shape to set the offset." };
  const e0 = entity(s, id);
  const base = (e: Entity) => ({ ...(e.construction ? { construction: true } : {}), ...(e.color ? { color: e.color } : {}) });
  if (e0?.kind === "circle") {
    const r = e0.r - d;
    if (r <= 1e-6) return { error: "The offset is bigger than the circle." };
    return { s: addEntity(s, { kind: "circle", c: e0.c, r, ...base(e0) }).s };
  }
  const ch = chainOf(s, id);
  if (!ch) return { error: "Offset works on lines, arcs and circles." };
  const { steps, closed } = ch;
  // Each step's offset carrier and naive offset end points.
  const shifted = steps.map((st) => {
    const [a, b] = stepEnds(st).map((q) => pt(s, q)) as [Vec, Vec];
    if (st.e.kind === "line") {
      const t = unit(sub(b, a));
      const n = mul({ x: -t.y, y: t.x }, d);
      const k: Carrier = { kind: "seg", a: add(a, n), b: add(b, n), infinite: true };
      return { k, from: add(a, n), to: add(b, n), r: 0 };
    }
    const c = pt(s, st.e.c);
    const r = st.e.r + (st.rev ? d : -d);
    const at = (q: Vec) => add(c, mul(unit(sub(q, c)), r));
    return { k: { kind: "circ", c, r } as Carrier, from: at(a), to: at(b), r };
  });
  if (shifted.some((x, i) => steps[i]!.e.kind === "arc" && x.r <= 1e-6)) return { error: "The offset is bigger than an arc's radius." };
  // Joints: where consecutive offsets meet.
  const joint = (i: number, j: number): Vec => {
    const A = shifted[i]!;
    const B = shifted[j]!;
    if (len(sub(A.to, B.from)) < 1e-6) return A.to;
    const guess = mul(add(A.to, B.from), 0.5);
    const xs = rawIntersect(A.k, B.k);
    if (!xs.length) return guess;
    return xs.reduce((best, q) => (len(sub(q, guess)) < len(sub(best, guess)) ? q : best));
  };
  const n = steps.length;
  let out = s;
  const ptIds: string[] = [];
  // ptIds[i] = start of step i; ptIds[n] = end of the last step (open chains).
  for (let i = 0; i < n; i++) {
    const pos = i === 0 ? (closed ? joint(n - 1, 0) : shifted[0]!.from) : joint(i - 1, i);
    const r = addPoint(out, pos);
    out = r.s;
    ptIds.push(r.id);
  }
  if (!closed) {
    const r = addPoint(out, shifted[n - 1]!.to);
    out = r.s;
    ptIds.push(r.id);
  } else ptIds.push(ptIds[0]!);
  let master: string | undefined;
  const made: string[] = [];
  for (let i = 0; i < n; i++) {
    const st = steps[i]!;
    const [from, to] = [ptIds[i]!, ptIds[i + 1]!];
    if (st.e.kind === "line") {
      const l = addEntity(out, { kind: "line", p1: from, p2: to, ...base(st.e) });
      out = addConstraint(l.s, { type: "parallel", refs: [st.e.id, l.id] }).s;
      const c = addConstraint(out, {
        type: "pointLineDistance",
        refs: [from, st.e.id],
        value: Math.abs(d),
        ...(master ? { hidden: true, link: master } : { offset: { x: 0, y: 0 } }),
      });
      out = c.s;
      master ??= c.id;
      made.push(l.id);
    } else {
      const [start, end] = st.rev ? [to, from] : [from, to];
      const a = addEntity(out, { kind: "arc", c: st.e.c, r: shifted[i]!.r, start, end, ...base(st.e) });
      out = a.s;
      made.push(a.id);
    }
  }
  // Where the original pieces meet tangentially, say so for the copies too. Otherwise the joint is a double root
  // (a point on a line and on a circle that just touch) and the solver can't move it.
  for (let i = closed ? 0 : 1; i < n; i++) {
    const j = (i - 1 + n) % n;
    const [A, B] = [steps[j]!, steps[i]!];
    if (A.e.kind === "line" && B.e.kind === "line") continue;
    const shared = stepEnds(B)[0];
    if (tangentAt(s, A.e, B.e, shared)) out = addConstraint(out, { type: "tangent", refs: [made[j]!, made[i]!] }).s;
  }
  // Tangent joints can make some of the hidden distances say the same thing twice: drop those.
  if (prune && solverReady()) {
    const extra = new Set(solve(out, { analyze: true }).redundant);
    out = { ...out, constraints: out.constraints.filter((c) => !(c.hidden && extra.has(c.id))) };
  }
  return { s: out, ...(master ? { dimension: master } : {}) };
}

/** Do a line/arc and an arc meet tangentially at point p (direction ⟂ radius, or centres in line with p)? */
function tangentAt(s: Sketch, a: LineEntity | ArcEntity, b: LineEntity | ArcEntity, p: string): boolean {
  const P = pt(s, p);
  const radial = (e: ArcEntity) => unit(sub(P, pt(s, e.c)));
  if (a.kind === "line" || b.kind === "line") {
    const [l, arc] = (a.kind === "line" ? [a, b] : [b, a]) as [LineEntity, ArcEntity];
    if (arc.kind !== "arc") return false;
    return Math.abs(dot(unit(sub(pt(s, l.p2), pt(s, l.p1))), radial(arc))) < 1e-3;
  }
  const [u, v] = [radial(a), radial(b)];
  return Math.abs(u.x * v.y - u.y * v.x) < 1e-3;
}

/** Entities added by an operation (for previews): those in `after` that `before` doesn't have. */
export function addedEntities(before: Sketch, after: Sketch): Entity[] {
  const had = new Set(before.entities.map((e) => e.id));
  return after.entities.filter((e) => !had.has(e.id) || before.entities.find((x) => x.id === e.id) !== e);
}
