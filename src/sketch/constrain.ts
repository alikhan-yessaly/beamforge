// Turning a selection into constraints and dimensions, the way Onshape's toolbar and dimension tool do (pure).
import { t } from "../i18n";
import type { Vec } from "../geom/geom";
import { type Constraint, type ConstraintType, type Entity, type Sketch, addConstraint, entity, pt } from "./model";
import { measure, solve } from "./solver";

export type ConstraintTool =
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "equal"
  | "midpoint"
  | "concentric"
  | "symmetric"
  | "fix";

const kindOf = (s: Sketch, id: string): Entity["kind"] | "pt" | null => (s.points[id] ? "pt" : (entity(s, id)?.kind ?? null));
const isCurve = (k: string | null) => k === "circle" || k === "arc";

/** Apply a constraint tool to the selected ids. Returns the new sketch, or a message saying what to select. */
export function applyConstraint(s: Sketch, tool: ConstraintTool, sel: string[]): { s: Sketch } | { error: string } {
  const pts = sel.filter((id) => s.points[id]);
  const lines = sel.filter((id) => kindOf(s, id) === "line");
  const curves = sel.filter((id) => isCurve(kindOf(s, id)));
  const add = (type: ConstraintType, refs: string[], base = s) => addConstraint(base, { type, refs }).s;
  switch (tool) {
    case "coincident":
      if (pts.length === 2 && sel.length === 2) return { s: add("coincident", pts) };
      if (pts.length === 1 && lines.length === 1) return { s: add("pointOnLine", [pts[0]!, lines[0]!]) };
      if (pts.length === 1 && curves.length === 1) return { s: add("pointOnCircle", [pts[0]!, curves[0]!]) };
      return { error: t("Coincident: select two points, or a point and a line, circle or arc.") };
    case "horizontal":
    case "vertical": {
      if (lines.length && lines.length === sel.length) {
        let out = s;
        for (const l of lines) out = add(tool, [l], out);
        return { s: out };
      }
      if (pts.length === 2 && sel.length === 2) return { s: add(tool === "horizontal" ? "horizontalPts" : "verticalPts", pts) };
      return { error: tool === "horizontal" ? t("Horizontal: select lines, or two points.") : t("Vertical: select lines, or two points.") };
    }
    case "parallel":
    case "perpendicular":
      if (lines.length === 2 && sel.length === 2) return { s: add(tool, lines) };
      return { error: tool === "parallel" ? t("Parallel: select two lines.") : t("Perpendicular: select two lines.") };
    case "tangent":
      if (sel.length === 2 && (lines.length + curves.length === 2) && curves.length >= 1) return { s: add("tangent", sel) };
      return { error: t("Tangent: select a line and a circle/arc, or two circles/arcs.") };
    case "equal":
      if (sel.length === 2 && (lines.length === 2 || curves.length === 2)) return { s: add("equal", sel) };
      return { error: t("Equal: select two lines, or two circles/arcs.") };
    case "midpoint":
      if (pts.length === 1 && lines.length === 1 && sel.length === 2) return { s: add("midpoint", [pts[0]!, lines[0]!]) };
      return { error: t("Midpoint: select a point and a line.") };
    case "concentric":
      if (curves.length === 2 && sel.length === 2) return { s: add("concentric", curves) };
      return { error: t("Concentric: select two circles or arcs.") };
    case "symmetric":
      if (pts.length === 2 && lines.length === 1 && sel.length === 3) return { s: add("symmetric", [pts[0]!, pts[1]!, lines[0]!]) };
      return { error: t("Symmetric: select two points and the line to mirror about.") };
    case "fix": {
      // Pin points (and the points of selected entities); toggles off if all are pinned already.
      const ids = new Set(pts);
      for (const id of sel) {
        const e = entity(s, id);
        if (e) for (const p of e.kind === "line" ? [e.p1, e.p2] : e.kind === "circle" || e.kind === "arc" ? [e.c] : []) ids.add(p);
      }
      if (!ids.size) return { error: t("Fix: select points or geometry.") };
      const unfix = [...ids].every((id) => s.points[id]!.fixed);
      const points = { ...s.points };
      for (const id of ids) if (id !== "o") points[id] = { ...points[id]!, fixed: !unfix };
      return { s: { ...s, points } };
    }
  }
}

/**
 * The dimension for what was picked (1 or 2 items) and where its label goes, Onshape-style:
 * line → length; circle → diameter; arc → radius; point+point → horizontal, vertical or aligned distance by
 * where the label is dropped; point+line → distance to the line; line+line → angle (or distance if parallel).
 */
export function dimensionFor(s: Sketch, picked: string[], label: Vec): Omit<Constraint, "id"> | null {
  const [a, b] = picked;
  const ka = a ? kindOf(s, a) : null;
  const kb = b ? kindOf(s, b) : null;
  const mk = (type: ConstraintType, refs: string[], anchor: Vec): Omit<Constraint, "id"> => {
    let value = measure(s, type, refs);
    if (type === "angle" && Math.abs(value) > 90) value = value > 0 ? value - 180 : value + 180; // acute between the lines
    return { type, refs, value, offset: { x: label.x - anchor.x, y: label.y - anchor.y } };
  };
  if (picked.length === 1 && a) {
    const e = entity(s, a);
    if (e?.kind === "line") return mk("distance", [a], mid(pt(s, e.p1), pt(s, e.p2)));
    if (e?.kind === "circle") return mk("diameter", [a], pt(s, e.c));
    if (e?.kind === "arc") return mk("radius", [a], pt(s, e.c));
    return null;
  }
  if (!a || !b) return null;
  if (ka === "pt" && kb === "pt") {
    const [p, q] = [pt(s, a), pt(s, b)];
    const m = mid(p, q);
    const outsideX = label.x < Math.min(p.x, q.x) || label.x > Math.max(p.x, q.x);
    const outsideY = label.y < Math.min(p.y, q.y) || label.y > Math.max(p.y, q.y);
    if (outsideX && !outsideY) return mk("distanceY", [a, b], m);
    if (outsideY && !outsideX) return mk("distanceX", [a, b], m);
    return mk("distance", [a, b], m);
  }
  if (ka === "pt" && kb === "line") return mk("pointLineDistance", [a, b], pt(s, a));
  if (ka === "line" && kb === "pt") return mk("pointLineDistance", [b, a], pt(s, b));
  if (ka === "line" && kb === "line") {
    const [l1, l2] = [entity(s, a) as Extract<Entity, { kind: "line" }>, entity(s, b) as Extract<Entity, { kind: "line" }>];
    const ang = measure(s, "angle", [a, b]);
    if (Math.abs(Math.sin((ang * Math.PI) / 180)) < 1e-3) return mk("pointLineDistance", [l2.p1, a], pt(s, l2.p1));
    return mk("angle", [a, b], mid(pt(s, l1.p2), pt(s, l2.p1)));
  }
  if ((ka === "pt" && isCurve(kb)) || (isCurve(ka) && kb === "pt")) {
    // point to centre distance
    const [p, c] = ka === "pt" ? [a, b] : [b, a];
    const e = entity(s, c) as Extract<Entity, { kind: "circle" | "arc" }>;
    return mk("distance", [p, e.c], mid(pt(s, p), pt(s, e.c)));
  }
  return null;
}

/** A driving dimension is available only if a small change can actually be solved. */
export function dimensionCanDrive(s: Sketch, dimension: Omit<Constraint, "id">): boolean {
  const value = measure(s, dimension.type, dimension.refs);
  const delta = Math.max(Math.abs(value) * 0.01, 0.01);
  const candidate = addConstraint(s, { ...dimension, value: value + delta });
  const result = solve(candidate.s);
  if (!result.ok || result.redundant.includes(candidate.id)) return false;
  const actual = measure(result.sketch, dimension.type, dimension.refs);
  return Math.abs(actual - (value + delta)) <= Math.max(delta * 0.05, 1e-5);
}

const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Anchor (sketch coords) a dimension's label offset is relative to; matches dimensionFor. */
export function dimensionAnchor(s: Sketch, c: Constraint): Vec {
  const [a, b] = c.refs as [string, string];
  switch (c.type) {
    case "distance": {
      const e = entity(s, a);
      if (e?.kind === "line") return mid(pt(s, e.p1), pt(s, e.p2));
      return mid(pt(s, a), pt(s, b));
    }
    case "distanceX":
    case "distanceY":
      return mid(pt(s, a), pt(s, b));
    case "pointLineDistance":
      return pt(s, a);
    case "radius":
    case "diameter": {
      const e = entity(s, a) as Extract<Entity, { kind: "circle" | "arc" }>;
      return pt(s, e.c);
    }
    case "angle": {
      const [l1, l2] = [entity(s, a) as Extract<Entity, { kind: "line" }>, entity(s, b) as Extract<Entity, { kind: "line" }>];
      return mid(pt(s, l1.p2), pt(s, l2.p1));
    }
    default:
      return { x: 0, y: 0 };
  }
}
