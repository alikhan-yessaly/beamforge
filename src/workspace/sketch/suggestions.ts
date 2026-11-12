import { type Constraint, type Sketch, entity, pt } from "../../sketch/model";
import { dimensionFor } from "../../sketch/constrain";

export type DimensionSuggestion = Omit<Constraint, "id">;

/** Dimension the independent sizes of the geometry just created. */
export function dimensionSuggestions(s: Sketch, ids: string[], tool: string, offset: number): DimensionSuggestion[] {
  const entities = ids.map((id) => entity(s, id)).filter((e) => e !== undefined);
  const line = (id: string, side: number): DimensionSuggestion | null => {
    const e = entity(s, id);
    if (!e || e.kind !== "line") return null;
    const a = pt(s, e.p1);
    const b = pt(s, e.p2);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) return null;
    return dimensionFor(s, [id], {
      x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * offset * side,
      y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * offset * side,
    });
  };
  if (tool === "rect" || tool === "rectCenter") {
    const lines = entities.filter((e) => e.kind === "line" && !e.construction);
    return [lines[0] && line(lines[0].id, -1), lines[1] && line(lines[1].id, -1)].filter((d): d is DimensionSuggestion => !!d);
  }
  if (tool === "line") {
    const e = entities.find((e) => e.kind === "line");
    const d = e && line(e.id, -1);
    return d ? [d] : [];
  }
  if (tool === "slot") {
    const axis = entities.find((e) => e.kind === "line" && e.construction);
    const arc = entities.find((e) => e.kind === "arc");
    const d = axis && line(axis.id, -1);
    const r = arc && dimensionFor(s, [arc.id], { x: pt(s, arc.c).x + arc.r + offset, y: pt(s, arc.c).y });
    return [d, r].filter((x): x is DimensionSuggestion => !!x);
  }
  const curve = entities.find((e) => e.kind === "circle" || e.kind === "arc");
  if (curve && (curve.kind === "circle" || curve.kind === "arc")) {
    const c = pt(s, curve.c);
    const d = dimensionFor(s, [curve.id], { x: c.x + curve.r + offset, y: c.y });
    return d ? [d] : [];
  }
  return [];
}
