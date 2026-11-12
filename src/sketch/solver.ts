// planegcs adapter (FreeCAD's 2D constraint solver, WebAssembly, LGPL; loaded as its own file).
// Each solve rebuilds the planegcs system from the sketch: points first, then geometry, then constraints (planegcs
// needs referenced ids pushed before use), solves, writes the result back and reports degrees of freedom,
// conflicts and which points/radii are still free (blue) vs fully defined (black).
import { DebugMode, type GcsWrapper, type SketchPrimitive, make_gcs_wrapper } from "@salusoft89/planegcs";
import type { Vec } from "../geom/geom";
import { type Constraint, type Entity, type Sketch, entity } from "./model";

let wrapper: GcsWrapper | null = null;
let loading: Promise<void> | null = null;

/** Load the solver once. In the browser pass the .wasm URL (Vite `?url` import); in Node a file path. */
export function loadSolver(wasmPath: string): Promise<void> {
  loading ??= make_gcs_wrapper(wasmPath).then((w) => {
    w.debug_mode = DebugMode.NoDebug;
    wrapper = w;
  });
  return loading;
}

export const solverReady = () => wrapper !== null;

export interface SolveResult {
  sketch: Sketch;
  /** The solver converged and every constraint holds. */
  ok: boolean;
  /** Remaining degrees of freedom (0 = fully defined). */
  dof: number;
  /** Our ids of constraints that conflict (red). */
  conflicting: string[];
  redundant: string[];
  /** Point ids and circle entity ids that can still move (blue); only filled when `analyze` is set. */
  free: Set<string>;
}

export interface SolveOptions {
  /** Drag targets: soft (temporary) constraints pulling these points toward these positions. */
  drag?: { id: string; to: Vec }[];
  /** Work out which points are free (one extra solve per point; skipped above 400 points). */
  analyze?: boolean;
}

interface Built {
  prims: SketchPrimitive[];
  /** our id → planegcs id */
  toGcs: Map<string, string>;
  /** planegcs id → our id */
  fromGcs: Map<string, string>;
}

const DEG = Math.PI / 180;

function build(s: Sketch, extra: (b: Built, next: () => string) => void = () => {}): Built {
  const prims: SketchPrimitive[] = [];
  const toGcs = new Map<string, string>();
  const fromGcs = new Map<string, string>();
  let n = 0;
  const next = () => String(++n);
  const map = (ours: string) => {
    const g = next();
    toGcs.set(ours, g);
    fromGcs.set(g, ours);
    return g;
  };
  const P = (id: string) => toGcs.get(id)!;

  for (const [id, p] of Object.entries(s.points)) prims.push({ id: map(id), type: "point", x: p.x, y: p.y, fixed: !!p.fixed } as SketchPrimitive);
  for (const e of s.entities) {
    if (e.kind === "line") prims.push({ id: map(e.id), type: "line", p1_id: P(e.p1), p2_id: P(e.p2) } as SketchPrimitive);
    else if (e.kind === "circle") prims.push({ id: map(e.id), type: "circle", c_id: P(e.c), radius: e.r } as SketchPrimitive);
    else if (e.kind === "arc") {
      const c = s.points[e.c]!;
      const a = s.points[e.start]!;
      const b = s.points[e.end]!;
      let a0 = Math.atan2(a.y - c.y, a.x - c.x);
      let a1 = Math.atan2(b.y - c.y, b.x - c.x);
      if (a1 <= a0) a1 += 2 * Math.PI;
      const id = map(e.id);
      prims.push({ id, type: "arc", c_id: P(e.c), radius: e.r, start_angle: a0, end_angle: a1, start_id: P(e.start), end_id: P(e.end) } as SketchPrimitive);
      prims.push({ id: next(), type: "arc_rules", a_id: id } as SketchPrimitive);
    }
  }
  for (const c of s.constraints) for (const p of toPrims(s, c, toGcs)) {
    const id = next();
    fromGcs.set(id, c.id);
    prims.push({ ...p, id } as SketchPrimitive);
  }
  const b = { prims, toGcs, fromGcs };
  extra(b, next);
  return b;
}

type Prim = Record<string, unknown> & { type: string };

/** One of our constraints → planegcs constraint primitives (without ids). */
function toPrims(s: Sketch, c: Constraint, g: Map<string, string>): Prim[] {
  const G = (id: string) => g.get(id)!;
  const ent = (id: string): Entity | undefined => entity(s, id);
  const [a, b, d] = c.refs as [string, string, string];
  const curve = (id: string) => ent(id)?.kind; // "circle" | "arc" | "line"
  switch (c.type) {
    case "coincident":
      return [{ type: "p2p_coincident", p1_id: G(a), p2_id: G(b) }];
    case "pointOnLine":
      return [{ type: "point_on_line_pl", p_id: G(a), l_id: G(b) }];
    case "pointOnCircle":
      return [curve(b) === "arc" ? { type: "point_on_arc", p_id: G(a), a_id: G(b) } : { type: "point_on_circle", p_id: G(a), c_id: G(b) }];
    case "horizontal":
      return [{ type: "horizontal_l", l_id: G(a) }];
    case "vertical":
      return [{ type: "vertical_l", l_id: G(a) }];
    case "horizontalPts":
      return [{ type: "horizontal_pp", p1_id: G(a), p2_id: G(b) }];
    case "verticalPts":
      return [{ type: "vertical_pp", p1_id: G(a), p2_id: G(b) }];
    case "parallel":
      return [{ type: "parallel", l1_id: G(a), l2_id: G(b) }];
    case "perpendicular":
      return [{ type: "perpendicular_ll", l1_id: G(a), l2_id: G(b) }];
    case "tangent": {
      const [ka, kb] = [curve(a), curve(b)];
      // Joined end to end (fillets, tangent arcs): "tangent + coincident" is degenerate for the solver, so say it
      // without signs: the line is perpendicular to the radius there, or the joint lies on the line of centres.
      const [ea, eb] = [ent(a), ent(b)];
      const ends = (e?: Entity) => (e?.kind === "line" ? [e.p1, e.p2] : e?.kind === "arc" ? [e.start, e.end] : []);
      const shared = ends(ea).find((p) => ends(eb).includes(p));
      if (shared && ea && eb) {
        if (ea.kind === "line" && eb.kind === "arc") return [{ type: "perpendicular_pppp", l1p1_id: G(ea.p1), l1p2_id: G(ea.p2), l2p1_id: G(eb.c), l2p2_id: G(shared) }];
        if (ea.kind === "arc" && eb.kind === "line") return [{ type: "perpendicular_pppp", l1p1_id: G(eb.p1), l1p2_id: G(eb.p2), l2p1_id: G(ea.c), l2p2_id: G(shared) }];
        if (ea.kind === "arc" && eb.kind === "arc") return [{ type: "point_on_line_ppp", p_id: G(shared), lp1_id: G(ea.c), lp2_id: G(eb.c) }];
      }
      if (ka === "line" && kb === "circle") return [{ type: "tangent_lc", l_id: G(a), c_id: G(b) }];
      if (ka === "circle" && kb === "line") return [{ type: "tangent_lc", l_id: G(b), c_id: G(a) }];
      if (ka === "line" && kb === "arc") return [{ type: "tangent_la", l_id: G(a), a_id: G(b) }];
      if (ka === "arc" && kb === "line") return [{ type: "tangent_la", l_id: G(b), a_id: G(a) }];
      if (ka === "circle" && kb === "circle") return [{ type: "tangent_cc", c1_id: G(a), c2_id: G(b) }];
      if (ka === "circle" && kb === "arc") return [{ type: "tangent_ca", c_id: G(a), a_id: G(b) }];
      if (ka === "arc" && kb === "circle") return [{ type: "tangent_ca", c_id: G(b), a_id: G(a) }];
      if (ka === "arc" && kb === "arc") return [{ type: "tangent_aa", a1_id: G(a), a2_id: G(b) }];
      return [];
    }
    case "equal": {
      const [ka, kb] = [curve(a), curve(b)];
      if (ka === "line" && kb === "line") return [{ type: "equal_length", l1_id: G(a), l2_id: G(b) }];
      if (ka === "circle" && kb === "circle") return [{ type: "equal_radius_cc", c1_id: G(a), c2_id: G(b) }];
      if (ka === "circle" && kb === "arc") return [{ type: "equal_radius_ca", c1_id: G(a), a2_id: G(b) }];
      if (ka === "arc" && kb === "circle") return [{ type: "equal_radius_ca", c1_id: G(b), a2_id: G(a) }];
      if (ka === "arc" && kb === "arc") return [{ type: "equal_radius_aa", a1_id: G(a), a2_id: G(b) }];
      return [];
    }
    case "midpoint": {
      const l = ent(b);
      return l?.kind === "line" ? [{ type: "p2p_symmetric_ppp", p1_id: G(l.p1), p2_id: G(l.p2), p_id: G(a) }] : [];
    }
    case "concentric": {
      const [ea, eb] = [ent(a), ent(b)];
      const ca = ea && (ea.kind === "circle" || ea.kind === "arc") ? ea.c : null;
      const cb = eb && (eb.kind === "circle" || eb.kind === "arc") ? eb.c : null;
      return ca && cb ? [{ type: "p2p_coincident", p1_id: G(ca), p2_id: G(cb) }] : [];
    }
    case "symmetric":
      return [{ type: "p2p_symmetric_ppl", p1_id: G(a), p2_id: G(b), l_id: G(d) }];
    case "fix":
      return []; // pinned via SPoint.fixed
    case "distance": {
      // Either two points, or one line (its length).
      const l = ent(a);
      if (l?.kind === "line") return [{ type: "p2p_distance", p1_id: G(l.p1), p2_id: G(l.p2), distance: c.value! }];
      return [{ type: "p2p_distance", p1_id: G(a), p2_id: G(b), distance: c.value! }];
    }
    case "distanceX":
      return [{ type: "difference", param1: { o_id: G(a), prop: "x" }, param2: { o_id: G(b), prop: "x" }, difference: c.value! }];
    case "distanceY":
      return [{ type: "difference", param1: { o_id: G(a), prop: "y" }, param2: { o_id: G(b), prop: "y" }, difference: c.value! }];
    case "pointLineDistance":
      return [{ type: "p2l_distance", p_id: G(a), l_id: G(b), distance: c.value! }];
    case "radius":
      return [curve(a) === "arc" ? { type: "arc_radius", a_id: G(a), radius: c.value! } : { type: "circle_radius", c_id: G(a), radius: c.value! }];
    case "diameter":
      return [curve(a) === "arc" ? { type: "arc_diameter", a_id: G(a), diameter: c.value! } : { type: "circle_diameter", c_id: G(a), diameter: c.value! }];
    case "angle":
      return [{ type: "l2l_angle_ll", l1_id: G(a), l2_id: G(b), angle: c.value! * DEG }];
  }
}

function run(w: GcsWrapper, b: Built): { ok: boolean; out: Map<string, SketchPrimitive> } {
  w.clear_data();
  w.push_primitives_and_params(b.prims);
  const status = w.solve();
  w.apply_solution();
  const out = new Map(w.sketch_index.get_primitives().map((p) => [String(p.id), p]));
  return { ok: (status === 0 || status === 1) && !w.has_gcs_conflicting_constraints(), out };
}

function applyBack(s: Sketch, b: Built, out: Map<string, SketchPrimitive>): Sketch {
  const points = { ...s.points };
  for (const id of Object.keys(points)) {
    const p = out.get(b.toGcs.get(id)!) as { x: number; y: number } | undefined;
    if (p) points[id] = { ...points[id]!, x: p.x, y: p.y };
  }
  const entities = s.entities.map((e) => {
    if (e.kind !== "circle" && e.kind !== "arc") return e;
    const g = out.get(b.toGcs.get(e.id)!) as { radius: number } | undefined;
    return g ? { ...e, r: g.radius } : e;
  });
  return { ...s, points, entities };
}

export function solve(s: Sketch, opts: SolveOptions = {}): SolveResult {
  const w = wrapper;
  if (!w) throw new Error("Sketch solver not loaded");
  const b = build(s, (bb, next) => {
    for (const d of opts.drag ?? []) {
      const p = bb.toGcs.get(d.id);
      if (!p) continue;
      bb.prims.push({ id: next(), type: "coordinate_x", p_id: p, x: d.to.x, temporary: true } as SketchPrimitive);
      bb.prims.push({ id: next(), type: "coordinate_y", p_id: p, y: d.to.y, temporary: true } as SketchPrimitive);
    }
  });
  const { ok, out } = run(w, b);
  const conflicting = [...new Set(w.get_gcs_conflicting_constraints().map((id) => b.fromGcs.get(String(id)) ?? String(id)))];
  const redundant = [...new Set(w.get_gcs_redundant_constraints().map((id) => b.fromGcs.get(String(id)) ?? String(id)))];
  const solved = ok || opts.drag ? applyBack(s, b, out) : s;
  const dof = opts.drag ? -1 : w.gcs.dof();
  const free = opts.analyze && ok ? freeItems(w, solved, dof) : new Set<string>();
  return { sketch: solved, ok, dof, conflicting, redundant, free };
}

/** Which points (and circle radii) can still move: nudge each with a soft constraint and see if it gives. */
function freeItems(w: GcsWrapper, s: Sketch, dof: number): Set<string> {
  const free = new Set<string>();
  if (dof <= 0) return free;
  const ids = Object.keys(s.points).filter((id) => !s.points[id]!.fixed);
  if (ids.length > 400) return new Set(ids); // too big to probe: show all as free
  const base = build(s);
  const moved = (out: Map<string, SketchPrimitive>, gid: string, x: number, y: number) => {
    const p = out.get(gid) as { x: number; y: number } | undefined;
    return !!p && Math.hypot(p.x - x, p.y - y) > 1e-4;
  };
  for (const id of ids) {
    const gid = base.toGcs.get(id)!;
    const p = s.points[id]!;
    let n = base.prims.length + 1000;
    const prims = [
      ...base.prims,
      { id: String(++n), type: "coordinate_x", p_id: gid, x: p.x + 1, temporary: true },
      { id: String(++n), type: "coordinate_y", p_id: gid, y: p.y + 1, temporary: true },
    ] as SketchPrimitive[];
    const { out } = run(w, { ...base, prims });
    if (moved(out, gid, p.x, p.y)) free.add(id);
  }
  for (const e of s.entities) {
    if (e.kind !== "circle") continue;
    const gid = base.toGcs.get(e.id)!;
    const prims = [...base.prims, { id: String(base.prims.length + 5000), type: "circle_radius", c_id: gid, radius: e.r + 1, temporary: true }] as SketchPrimitive[];
    const { out } = run(w, { ...base, prims });
    const r = (out.get(gid) as { radius: number } | undefined)?.radius ?? e.r;
    if (Math.abs(r - e.r) > 1e-4) free.add(e.id);
  }
  return free;
}

/** Current value a dimension would have, measured from the geometry (for new dimensions). */
export function measure(s: Sketch, type: Constraint["type"], refs: string[]): number {
  const P = (id: string) => s.points[id]!;
  const e0 = entity(s, refs[0]!);
  switch (type) {
    case "distance": {
      if (e0?.kind === "line") return Math.hypot(P(e0.p2).x - P(e0.p1).x, P(e0.p2).y - P(e0.p1).y);
      return Math.hypot(P(refs[1]!).x - P(refs[0]!).x, P(refs[1]!).y - P(refs[0]!).y);
    }
    case "distanceX":
      return P(refs[1]!).x - P(refs[0]!).x;
    case "distanceY":
      return P(refs[1]!).y - P(refs[0]!).y;
    case "pointLineDistance": {
      const l = entity(s, refs[1]!);
      if (l?.kind !== "line") return 0;
      const [a, b, p] = [P(l.p1), P(l.p2), P(refs[0]!)];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
    }
    case "radius":
      return e0 && (e0.kind === "circle" || e0.kind === "arc") ? e0.r : 0;
    case "diameter":
      return e0 && (e0.kind === "circle" || e0.kind === "arc") ? 2 * e0.r : 0;
    case "angle": {
      const l1 = e0;
      const l2 = entity(s, refs[1]!);
      if (l1?.kind !== "line" || l2?.kind !== "line") return 0;
      const a1 = Math.atan2(P(l1.p2).y - P(l1.p1).y, P(l1.p2).x - P(l1.p1).x);
      const a2 = Math.atan2(P(l2.p2).y - P(l2.p1).y, P(l2.p2).x - P(l2.p1).x);
      let d = ((a2 - a1) * 180) / Math.PI;
      while (d <= -180) d += 360;
      while (d > 180) d -= 360;
      return d;
    }
    default:
      return 0;
  }
}
