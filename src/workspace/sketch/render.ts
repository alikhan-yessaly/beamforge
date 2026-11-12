// Drawing a sketch in sketch mode: geometry coloured by status (blue free, black defined, red conflict, grey
// dashed construction), the origin, constraint glyphs, dimensions and the active tool's preview. Records where
// dimension labels and glyphs were drawn so the controller can hit-test them.
import { type Mat, type Vec, apply, mul } from "../../geom/geom";
import { dimensionAnchor } from "../../sketch/constrain";
import { type Constraint, type Entity, ORIGIN, type Sketch, entity, entityPoints, isDimension, pt } from "../../sketch/model";
import { entityPolylines } from "../../sketch/paths";
import type { TrimPiece } from "../../sketch/modify";
import type { View } from "../view";
import type { SketchSession } from "./state";
import { measure } from "../../sketch/solver";
import type { DimensionSuggestion } from "./suggestions";

export const COLORS = { free: "#2563eb", defined: "#111827", conflict: "#dc2626", construction: "#64748b", selected: "#f59e0b", hover: "#fbbf24", preview: "#2563eb" };

/** Screen rectangles of dimension labels and constraint glyphs from the last draw, for hit-testing. */
export const hitBoxes: { id: string; x: number; y: number; w: number; h: number }[] = [];

export type PreviewShape =
  | { kind: "line"; a: Vec; b: Vec; hv?: "h" | "v" | null; construction?: boolean }
  | { kind: "circle"; c: Vec; r: number }
  | { kind: "arc"; c: Vec; r: number; a0: number; a1: number }
  | { kind: "polyline"; pts: Vec[]; closed?: boolean }
  | { kind: "trim"; piece: TrimPiece }
  | { kind: "snap"; at: Vec; type: "point" | "curve" }
  | { kind: "guide"; a: Vec; b: Vec; type: "horizontal" | "vertical" }
  | { kind: "dimension"; constraint: Constraint; locked?: boolean }
  | { kind: "marquee"; a: Vec; b: Vec };

export interface Preview {
  shapes: PreviewShape[];
  hover: string | null;
  /** A short hint for the active tool. */
  hint?: string;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function sketchScreenMat(v: View, mat: Mat): Mat {
  return mul([v.zoom, 0, 0, v.zoom, v.ox, v.oy], mat);
}

export function drawSketch(ctx: CanvasRenderingContext2D, v: View, ses: SketchSession, preview: Preview, suggestions: DimensionSuggestion[] = []): void {
  const s = ses.sketch;
  const M = sketchScreenMat(v, ses.mat);
  const S = (p: Vec) => apply(M, p);
  const scale = Math.hypot(M[0], M[1]); // px per sketch mm
  hitBoxes.length = 0;

  const conflictRefs = new Set<string>();
  const problematic = new Set([...ses.status.conflicting, ...(ses.status.redundant ?? [])]);
  for (const c of s.constraints) if (problematic.has(c.id)) for (const r of c.refs) conflictRefs.add(r);
  const defined = (e: Entity) => !entityPoints(e).some((p) => ses.status.free.has(p)) && !ses.status.free.has(e.id) && ses.status.ok;
  const colorOf = (e: Entity) =>
    conflictRefs.has(e.id) || entityPoints(e).some((id) => conflictRefs.has(id)) ? COLORS.conflict : (ses.tool !== "trim" && ses.selected.has(e.id)) ? COLORS.selected : preview.hover === e.id ? COLORS.hover : e.construction ? COLORS.construction : defined(e) ? COLORS.defined : COLORS.free;

  // Origin: axes through it, dashed, plus a small cross.
  const o = S({ x: 0, y: 0 });
  ctx.save();
  ctx.strokeStyle = "rgba(100,116,139,.45)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  const ax = { x: M[0] / scale, y: M[1] / scale };
  const ay = { x: M[2] / scale, y: M[3] / scale };
  const far = 5000;
  ctx.beginPath();
  ctx.moveTo(o.x - ax.x * far, o.y - ax.y * far);
  ctx.lineTo(o.x + ax.x * far, o.y + ax.y * far);
  ctx.moveTo(o.x - ay.x * far, o.y - ay.y * far);
  ctx.lineTo(o.x + ay.x * far, o.y + ay.y * far);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = ses.selected.has(ORIGIN) ? COLORS.selected : "#334155";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x + ax.x * 18, o.y + ax.y * 18);
  ctx.moveTo(o.x, o.y);
  ctx.lineTo(o.x + ay.x * 18, o.y + ay.y * 18);
  ctx.stroke();
  ctx.restore();

  // Entities.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const e of s.entities) {
    if (e.kind === "point") continue;
    ctx.strokeStyle = colorOf(e);
    ctx.lineWidth = (ses.tool !== "trim" && ses.selected.has(e.id)) || preview.hover === e.id ? 2.5 : 1.6;
    ctx.setLineDash(e.construction ? [6, 4] : []);
    ctx.beginPath();
    for (const poly of entityPolylines(s, e)) {
      poly.pts.forEach((p, i) => {
        const q = S(p);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
    }
    ctx.stroke();
    // A layer-colour swatch tick on non-construction geometry, so the target layer is visible.
    ctx.setLineDash([]);
  }

  // Points (handles).
  const drawn = new Set<string>();
  for (const e of s.entities) {
    for (const id of entityPoints(e)) {
      if (drawn.has(id)) continue;
      drawn.add(id);
      const p = s.points[id];
      if (!p) continue;
      const q = S(p);
      const sel = ses.selected.has(id) || preview.hover === id;
      ctx.fillStyle = conflictRefs.has(id) ? COLORS.conflict : sel ? COLORS.selected : p.fixed ? COLORS.defined : ses.status.free.has(id) ? COLORS.free : COLORS.defined;
      ctx.beginPath();
      ctx.arc(q.x, q.y, sel ? 4.5 : 3, 0, 2 * Math.PI);
      ctx.fill();
      if (p.fixed && id !== ORIGIN) {
        ctx.strokeStyle = ctx.fillStyle;
        ctx.strokeRect(q.x - 5, q.y - 5, 10, 10);
      }
    }
  }

  // Constraint glyphs and dimensions.
  ctx.font = "11px system-ui, sans-serif";
  for (const c of s.constraints) {
    const bad = problematic.has(c.id);
    if (c.hidden && !bad) continue;
    const sel = ses.selected.has(c.id) || preview.hover === c.id;
    if (isDimension(c)) drawDimension(ctx, s, c, S, scale, bad, sel);
    else if (bad || sel || c.refs.some((id) => {
      if (ses.selected.has(id) || preview.hover === id) return true;
      const e = entity(s, id);
      if (e && entityPoints(e).some((p) => ses.selected.has(p) || preview.hover === p)) return true;
      return [...ses.selected, ...(preview.hover ? [preview.hover] : [])].some((selected) => {
        const en = entity(s, selected);
        return en && entityPoints(en).includes(id);
      });
    })) drawGlyph(ctx, s, c, S, bad, sel);
  }

  drawPreview(ctx, s, preview, S);
  for (const [i, suggestion] of suggestions.entries()) {
    const c: Constraint = { ...suggestion, id: `suggestion-${i}`, value: measure(s, suggestion.type, suggestion.refs) };
    drawDimension(ctx, s, c, S, scale, false, false, true);
  }
}

const GLYPH: Partial<Record<Constraint["type"], string>> = {
  horizontal: "H",
  vertical: "V",
  horizontalPts: "H",
  verticalPts: "V",
  parallel: "∥",
  perpendicular: "⊥",
  tangent: "T",
  equal: "=",
  midpoint: "M",
  concentric: "◎",
  symmetric: "⋈",
  pointOnLine: "•",
  pointOnCircle: "•",
  coincident: "•",
};

function glyphAnchors(s: Sketch, c: Constraint): Vec[] {
  const at = (id: string): Vec | null => {
    if (s.points[id]) return pt(s, id);
    const e = entity(s, id);
    if (!e) return null;
    if (e.kind === "line") {
      const [a, b] = [pt(s, e.p1), pt(s, e.p2)];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    if (e.kind === "circle" || e.kind === "arc") return { x: pt(s, e.c).x + e.r * 0.7, y: pt(s, e.c).y - e.r * 0.7 };
    return null;
  };
  if (c.type === "symmetric") return [at(c.refs[2]!)].filter(Boolean) as Vec[];
  if (c.type === "midpoint" || c.type === "pointOnLine" || c.type === "pointOnCircle" || c.type === "coincident") return [at(c.refs[0]!)].filter(Boolean) as Vec[];
  return c.refs.map(at).filter(Boolean) as Vec[];
}

function drawGlyph(ctx: CanvasRenderingContext2D, s: Sketch, c: Constraint, S: (p: Vec) => Vec, bad: boolean, sel: boolean): void {
  const g = GLYPH[c.type];
  if (!g) return;
  for (const a of glyphAnchors(s, c)) {
    const q = S(a);
    const x = q.x + 8;
    const y = q.y - 16;
    const w = 14;
    const h = 14;
    if (g === "•") {
      ctx.fillStyle = bad ? COLORS.conflict : sel ? COLORS.selected : "#0f766e";
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2, 0, 2 * Math.PI);
      ctx.fill();
      hitBoxes.push({ id: c.id, x: q.x - 5, y: q.y - 5, w: 10, h: 10 });
      continue;
    }
    ctx.fillStyle = bad ? COLORS.conflict : sel ? COLORS.selected : "#e2e8f0";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = bad || sel ? "#fff" : "#334155";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(g, x + w / 2, y + h / 2 + 0.5);
    hitBoxes.push({ id: c.id, x, y, w, h });
  }
}

function arrow(ctx: CanvasRenderingContext2D, from: Vec, to: Vec): void {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - 7 * Math.cos(ang - 0.35), to.y - 7 * Math.sin(ang - 0.35));
  ctx.lineTo(to.x - 7 * Math.cos(ang + 0.35), to.y - 7 * Math.sin(ang + 0.35));
  ctx.closePath();
  ctx.fill();
}

export function dimensionText(c: Constraint): string {
  const v = Math.abs(c.value ?? 0);
  if (c.type === "radius") return `R${fmt(v)}`;
  if (c.type === "diameter") return `Ø${fmt(v)}`;
  if (c.type === "angle") return `${fmt(v)}°`;
  return fmt(v);
}

function drawDimension(
  ctx: CanvasRenderingContext2D,
  s: Sketch,
  c: Constraint,
  S: (p: Vec) => Vec,
  scale: number,
  bad: boolean,
  sel: boolean,
  ghost = false,
  locked = false,
): void {
  const color = locked ? "#94a3b8" : bad ? COLORS.conflict : ghost ? COLORS.preview : sel ? COLORS.selected : "#0f172a";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  const anchor = dimensionAnchor(s, c);
  const off = c.offset ?? { x: 0, y: -8 };
  const label = { x: anchor.x + off.x, y: anchor.y + off.y };
  const L = S(label);
  const line = (a: Vec, b: Vec) => {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };
  const ends = (): [Vec, Vec] | null => {
    const [a, b] = c.refs as [string, string];
    const e = entity(s, a);
    if (e?.kind === "line") return [pt(s, e.p1), pt(s, e.p2)];
    if (s.points[a] && b && s.points[b]) return [pt(s, a), pt(s, b)];
    return null;
  };
  if (c.type === "distance" || c.type === "distanceX" || c.type === "distanceY") {
    const pq = ends();
    if (pq) {
      let [A, B] = pq;
      let A2: Vec;
      let B2: Vec;
      if (c.type === "distanceX") {
        A2 = { x: A.x, y: label.y };
        B2 = { x: B.x, y: label.y };
      } else if (c.type === "distanceY") {
        A2 = { x: label.x, y: A.y };
        B2 = { x: label.x, y: B.y };
      } else {
        const len = Math.hypot(B.x - A.x, B.y - A.y) || 1;
        const n = { x: -(B.y - A.y) / len, y: (B.x - A.x) / len };
        const d = (label.x - A.x) * n.x + (label.y - A.y) * n.y;
        A2 = { x: A.x + n.x * d, y: A.y + n.y * d };
        B2 = { x: B.x + n.x * d, y: B.y + n.y * d };
      }
      ctx.globalAlpha = 0.5;
      line(S(A), S(A2));
      line(S(B), S(B2));
      ctx.globalAlpha = 1;
      line(S(A2), S(B2));
      arrow(ctx, S(B2), S(A2));
      arrow(ctx, S(A2), S(B2));
      [A, B] = [A2, B2];
    }
  } else if (c.type === "pointLineDistance") {
    const l = entity(s, c.refs[1]!);
    if (l?.kind === "line") {
      const [a, b, p] = [pt(s, l.p1), pt(s, l.p2), pt(s, c.refs[0]!)];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1);
      const f = { x: a.x + t * dx, y: a.y + t * dy };
      line(S(p), S(f));
      arrow(ctx, S(p), S(f));
      arrow(ctx, S(f), S(p));
    }
  } else if (c.type === "radius" || c.type === "diameter") {
    const e = entity(s, c.refs[0]!);
    if (e && (e.kind === "circle" || e.kind === "arc")) {
      const C = pt(s, e.c);
      const d = Math.hypot(label.x - C.x, label.y - C.y) || 1;
      const u = { x: (label.x - C.x) / d, y: (label.y - C.y) / d };
      const edge = { x: C.x + u.x * e.r, y: C.y + u.y * e.r };
      const from = c.type === "diameter" ? { x: C.x - u.x * e.r, y: C.y - u.y * e.r } : C;
      line(S(from), S(label));
      arrow(ctx, S(from), S(edge));
      if (c.type === "diameter") arrow(ctx, S(edge), S(from));
    }
  } else if (c.type === "angle") {
    line(S(anchor), L);
  }
  // Label.
  const text = dimensionText(c);
  ctx.font = "12px system-ui, sans-serif";
  const w = ctx.measureText(text).width + 8;
  const h = 16;
  const x = L.x - w / 2;
  const y = L.y - h / 2;
  ctx.fillStyle = sel ? "#fef3c7" : "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, L.x, L.y + 0.5);
  if (!ghost) hitBoxes.push({ id: c.id, x, y, w, h });
  void scale;
}

function drawPreview(ctx: CanvasRenderingContext2D, s: Sketch, p: Preview, S: (v: Vec) => Vec): void {
  ctx.save();
  ctx.strokeStyle = COLORS.preview;
  ctx.lineWidth = 1.5;
  for (const sh of p.shapes) {
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(sh.kind === "line" && sh.construction ? [6, 4] : []);
    ctx.beginPath();
    if (sh.kind === "trim") {
      ctx.strokeStyle = COLORS.hover;
      ctx.lineWidth = 3;
      const piece = sh.piece;
      if (piece.kind === "line") {
        const [a, b] = [S(piece.a), S(piece.b)];
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      } else {
        const n = 64;
        for (let i = 0; i <= n; i++) {
          const a = piece.a0 + ((piece.a1 - piece.a0) * i) / n;
          const q = S({ x: piece.c.x + piece.r * Math.cos(a), y: piece.c.y + piece.r * Math.sin(a) });
          if (i === 0) ctx.moveTo(q.x, q.y);
          else ctx.lineTo(q.x, q.y);
        }
      }
      ctx.stroke();
    } else if (sh.kind === "line") {
      const [a, b] = [S(sh.a), S(sh.b)];
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (sh.hv) {
        ctx.fillStyle = COLORS.preview;
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(sh.hv === "h" ? "H" : "V", (a.x + b.x) / 2 + 8, (a.y + b.y) / 2 - 8);
      }
    } else if (sh.kind === "circle" || sh.kind === "arc") {
      const a0 = sh.kind === "arc" ? sh.a0 : 0;
      const a1 = sh.kind === "arc" ? sh.a1 : 2 * Math.PI;
      const n = 64;
      for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        const q = S({ x: sh.c.x + sh.r * Math.cos(a), y: sh.c.y + sh.r * Math.sin(a) });
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    } else if (sh.kind === "polyline") {
      sh.pts.forEach((v, i) => {
        const q = S(v);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      if (sh.closed) ctx.closePath();
      ctx.stroke();
    } else if (sh.kind === "snap") {
      const q = S(sh.at);
      ctx.strokeStyle = "#16a34a";
      ctx.lineWidth = 2;
      if (sh.type === "point") ctx.arc(q.x, q.y, 6, 0, 2 * Math.PI);
      else ctx.rect(q.x - 4, q.y - 4, 8, 8);
      ctx.stroke();
      ctx.strokeStyle = COLORS.preview;
      ctx.lineWidth = 1.5;
    } else if (sh.kind === "guide") {
      const [a, b] = [S(sh.a), S(sh.b)];
      ctx.strokeStyle = "#16a34a";
      ctx.fillStyle = "#16a34a";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(sh.type === "horizontal" ? "H" : "V", (a.x + b.x) / 2 + 5, (a.y + b.y) / 2 - 5);
    } else if (sh.kind === "dimension") {
      drawDimension(ctx, s, sh.constraint, S, 1, false, false, true, sh.locked);
    } else if (sh.kind === "marquee") {
      const [a, b] = [S(sh.a), S(sh.b)];
      ctx.setLineDash([4, 3]);
      ctx.fillStyle = "rgba(37,99,235,.08)";
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
  }
  ctx.restore();
}
