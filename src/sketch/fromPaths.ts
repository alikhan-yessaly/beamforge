// Turn imported paths (DXF) into sketch geometry (pure). Lines, arcs and circles become editable entities sharing
// their end points; exactly horizontal/vertical lines and tangent joins get constraints. Curves known only as
// points (ellipses, splines) become reference geometry: it moves with its anchor but can't be reshaped.
import type { Seg, Vec } from "../geom/geom";
import type { ScenePath } from "../scene/model";
import { type Sketch, addConstraint, addEntity, addPoint, emptySketch, pt } from "./model";
import { circleThrough } from "./pick";

/** Old imports have no line/arc data: short polylines become lines, long (flattened curves) reference geometry. */
const LEGACY_MAX_POINTS = 16;
const TAU = 2 * Math.PI;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;

export function pathsToSketch(paths: ScenePath[], color: string): { sketch: Sketch; editable: number; reference: number; legacy: boolean } {
  let s = emptySketch(color);
  const byPos = new Map<string, string>();
  const key = (v: Vec) => `${Math.round(v.x * 1e5)},${Math.round(v.y * 1e5)}`;
  // Shared end points (and the origin, if geometry starts there) are one point.
  byPos.set(key({ x: 0, y: 0 }), "o");
  const P = (v: Vec): string => {
    const k = key(v);
    const got = byPos.get(k);
    if (got) return got;
    const r = addPoint(s, v);
    s = r.s;
    byPos.set(k, r.id);
    return r.id;
  };
  let editable = 0;
  let reference = 0;
  const lines: { id: string; a: string; b: string }[] = [];
  const arcs: { id: string; c: string; ends: [string, string] }[] = [];

  const addSeg = (g: Seg, col: string | undefined) => {
    const c = col && col !== color ? { color: col } : {};
    if (g.kind === "line") {
      if (Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) < 1e-9) return;
      const [a, b] = [P(g.a), P(g.b)];
      if (a === b) return;
      const r = addEntity(s, { kind: "line", p1: a, p2: b, ...c });
      s = r.s;
      lines.push({ id: r.id, a, b });
    } else if (g.kind === "circle") {
      const centre = P(g.c); // before reading `s`: P adds the point to it
      const r = addEntity(s, { kind: "circle", c: centre, r: g.r, ...c });
      s = r.s;
    } else {
      const circ = circleThrough(g.a, g.m, g.b);
      if (!circ) return addSeg({ kind: "line", a: g.a, b: g.b }, col);
      // Arcs run with increasing angle from start to end; pick the order that passes through the middle point.
      const ang = (q: Vec) => Math.atan2(q.y - circ.c.y, q.x - circ.c.x);
      const forward = norm(ang(g.m) - ang(g.a)) < norm(ang(g.b) - ang(g.a));
      const [start, end] = forward ? [P(g.a), P(g.b)] : [P(g.b), P(g.a)];
      const centre = P(circ.c);
      const r = addEntity(s, { kind: "arc", c: centre, r: circ.r, start, end, ...c });
      s = r.s;
      arcs.push({ id: r.id, c: centre, ends: [start, end] });
    }
    editable++;
  };

  for (const p of paths) {
    if (p.segs) {
      for (const g of p.segs) addSeg(g, p.color);
      continue;
    }
    if (p.segs === undefined && p.points.length <= LEGACY_MAX_POINTS) {
      const pts = p.closed ? [...p.points, p.points[0]!] : p.points;
      for (let i = 1; i < pts.length; i++) addSeg({ kind: "line", a: pts[i - 1]!, b: pts[i]! }, p.color);
      continue;
    }
    if (p.points.length < 2) continue;
    const anchor = P(p.points[0]!);
    const a = pt(s, anchor);
    s = addEntity(s, { kind: "ref", anchor, points: p.points.map((q) => ({ x: q.x - a.x, y: q.y - a.y })), closed: p.closed, ...(p.color !== color ? { color: p.color } : {}) }).s;
    reference++;
  }

  // Exactly horizontal / vertical lines keep that way.
  for (const l of lines) {
    const [a, b] = [pt(s, l.a), pt(s, l.b)];
    if (Math.abs(a.y - b.y) < 1e-6) s = addConstraint(s, { type: "horizontal", refs: [l.id] }).s;
    else if (Math.abs(a.x - b.x) < 1e-6) s = addConstraint(s, { type: "vertical", refs: [l.id] }).s;
  }
  // Lines meeting arcs tangentially (fillets, slots) stay tangent.
  for (const arc of arcs) {
    const C = pt(s, arc.c);
    for (const end of arc.ends) {
      const E = pt(s, end);
      const rad = { x: E.x - C.x, y: E.y - C.y };
      const rl = Math.hypot(rad.x, rad.y) || 1;
      for (const l of lines) {
        if (l.a !== end && l.b !== end) continue;
        const [a, b] = [pt(s, l.a), pt(s, l.b)];
        const d = { x: b.x - a.x, y: b.y - a.y };
        const dl = Math.hypot(d.x, d.y) || 1;
        if (Math.abs((d.x * rad.x + d.y * rad.y) / (dl * rl)) < 1e-4) s = addConstraint(s, { type: "tangent", refs: [l.id, arc.id] }).s;
      }
    }
  }
  return { sketch: s, editable, reference, legacy: paths.some((p) => p.segs === undefined) };
}
