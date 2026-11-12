// Click handling and previews for the modify tools (trim, fillet, chamfer, offset, mirror); patterns, shapes and
// text arrive with phases 3–4. Geometry work is in src/sketch/modify.ts.
import { t } from "../../i18n";
import type { Vec } from "../../geom/geom";
import { type Click, pointFor } from "../../sketch/draw";
import { type Sketch, addEntity, entity } from "../../sketch/model";
import { addedEntities, chamferAt, filletAt, mirrorItems, offsetAt, offsetDistance, trimAt, trimPieceAt } from "../../sketch/modify";
import { entityPolylines, splinePoints } from "../../sketch/paths";
import { nearestEntity, nearestPoint } from "../../sketch/pick";
import { circularPattern, drawPolygon, drawSlot, linearPattern } from "../../sketch/shapes";
import { notify } from "../../scene/store";
import type { PreviewShape } from "./render";
import { type Tool, editingDimension, editingText, patchSession, session, setSketch, textDefaults, toolOptions } from "./state";

export interface ModifyPreview {
  shapes: PreviewShape[];
  hover: string | null;
  hint?: string;
}

/** Clicks so far for the slot, polygon and pattern tools. */
let pending: Click[] = [];
/** Offset: the shape picked by the first click. */
let offsetFrom: string | null = null;
/** Mirror: the line picked as the mirror. */
let mirrorAxis: string | null = null;
/** The last fillet/chamfer dimension, so the next one starts at the same size. */
let lastFillet: { id: string; value: number } = { id: "", value: 2 };
let lastChamfer: { id: string; value: number } = { id: "", value: 2 };

/** A modify tool is part-way through (Esc cancels that step before leaving the tool). */
export const modifyActive = () => !!(offsetFrom || mirrorAxis || pending.length);

export const modifyPreviousPoint = (tool: Tool): Vec | undefined =>
  tool === "spline" || tool === "slot" || tool === "polygon" ? pending.at(-1)?.pos : undefined;

export function resetModify(): void {
  pending = [];
  offsetFrom = null;
  mirrorAxis = null;
}

/** Current value of a remembered dimension (it may have been edited since). */
function remembered(s: Sketch, m: { id: string; value: number }): number {
  const c = s.constraints.find((x) => x.id === m.id);
  return c?.value ?? m.value;
}

/** Preview outlines of what an operation would add or change. */
function outline(before: Sketch, after: Sketch): PreviewShape[] {
  return addedEntities(before, after).flatMap((e) => entityPolylines(after, e).map((p) => ({ kind: "polyline" as const, pts: p.pts, closed: p.closed })));
}

/** A corner point under the cursor (where exactly two lines meet). */
function cornerAt(s: Sketch, p: Vec, tol: number): string | null {
  const id = nearestPoint(s, p, tol * 1.5);
  if (!id) return null;
  const n = s.entities.filter((e) => e.kind === "line" && !e.construction && (e.p1 === id || e.p2 === id)).length;
  return n === 2 ? id : null;
}

const curveFilter = (e: { kind: string }) => e.kind === "line" || e.kind === "circle" || e.kind === "arc";

function commit(r: { s: Sketch; dimension?: string } | { error: string }): string | undefined {
  if ("error" in r) {
    notify(r.error, "warn");
    return undefined;
  }
  setSketch(r.s);
  if (r.dimension) editingDimension.value = r.dimension;
  return r.dimension;
}

export function runModifyClick(tool: Tool, _c: Click, p: Vec, _shift: boolean, tol: number): void {
  const ses = session.value;
  if (!ses) return;
  const s = ses.sketch;
  switch (tool) {
    case "trim": {
      const id = nearestEntity(s, p, tol, curveFilter);
      if (id) commit(trimAt(s, id, p));
      return;
    }
    case "fillet":
    case "chamfer": {
      const id = cornerAt(s, p, tol);
      if (!id) {
        notify(t("Click a corner where two lines meet."));
        return;
      }
      const m = tool === "fillet" ? lastFillet : lastChamfer;
      const value = remembered(s, m);
      const dim = commit(tool === "fillet" ? filletAt(s, id, value) : chamferAt(s, id, value));
      if (dim) {
        const next = { id: dim, value };
        if (tool === "fillet") lastFillet = next;
        else lastChamfer = next;
      }
      return;
    }
    case "offset": {
      if (!offsetFrom) {
        offsetFrom = nearestEntity(s, p, tol, (e) => e.kind === "line" || e.kind === "circle" || e.kind === "arc");
        return;
      }
      const id = offsetFrom;
      offsetFrom = null;
      commit(offsetAt(s, id, offsetDistance(s, id, p)));
      return;
    }
    case "mirror": {
      const id = nearestEntity(s, p, tol);
      if (!id) return;
      if (!mirrorAxis) {
        if (entity(s, id)?.kind !== "line") {
          notify(t("Mirror: first click the line to mirror about."));
          return;
        }
        mirrorAxis = id;
        const sel = [...ses.selected].filter((x) => x !== id && entity(s, x));
        if (sel.length) {
          commit(mirrorItems(s, sel, id));
          patchSession({ selected: new Set() });
        }
        return;
      }
      if (id !== mirrorAxis) commit(mirrorItems(s, [id], mirrorAxis));
      return;
    }
    case "text": {
      const a = pointFor(s, _c);
      const made = addEntity(a.s, { kind: "text", anchor: a.id, text: "Text", size: textDefaults.size, angle: 0, font: textDefaults.font, ...(ses.construction ? { construction: true } : {}) });
      setSketch(made.s, { record: false, solve: false });
      editingText.value = { id: made.id, before: s, isNew: true };
      return;
    }
    case "spline": {
      // A click on the last point (or a double-click) ends it; a click on the first point closes it.
      const last = pending[pending.length - 1];
      if (last && dist(at(last), at(_c)) <= tol) {
        finishSpline(false);
        return;
      }
      if (pending.length >= 3 && dist(at(pending[0]!), at(_c)) <= tol) {
        finishSpline(true);
        return;
      }
      pending.push(_c);
      return;
    }
    case "slot":
    case "polygon":
    case "linearPattern":
    case "circularPattern": {
      const r = shapeStep(tool, s, [...pending, _c], ses.construction, [...ses.selected]);
      if (r === "more") {
        pending.push(_c);
        return;
      }
      pending = [];
      if (r) commit(r);
      return;
    }
    default:
      notify(t("This tool isn't available yet."));
  }
}

/** Make the spline from the clicks so far (needs two points). */
function finishSpline(closed: boolean): void {
  const ses = session.value;
  const cl = pending;
  pending = [];
  if (!ses || cl.length < 2) return;
  let s = ses.sketch;
  const ids: string[] = [];
  for (const c of cl) {
    const r = pointFor(s, c);
    s = r.s;
    ids.push(r.id);
  }
  setSketch(addEntity(s, { kind: "spline", pts: ids, closed: closed && ids.length >= 3, ...(ses.construction ? { construction: true } : {}) }).s);
}

/** Enter: end a spline being drawn. */
export function modifyEnter(tool: Tool): boolean {
  if (tool !== "spline" || pending.length < 2) return false;
  finishSpline(false);
  return true;
}

const dist = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y);
const at = (c: Click) => c.snap?.pos ?? c.pos;

/** The sketch a shape/pattern tool makes from these clicks, "more" if it needs another click, or an error. */
function shapeStep(tool: Tool, s: Sketch, cl: Click[], construction: boolean, selected: string[]): { s: Sketch } | { error: string } | "more" | null {
  const o = { construction };
  const opt = toolOptions.value;
  const items = selected.filter((id) => entity(s, id));
  switch (tool) {
    case "slot": {
      if (cl.length < 3) return "more";
      const [A, B, W] = [at(cl[0]!), at(cl[1]!), cl[2]!.pos];
      const L = dist(A, B) || 1;
      const half = Math.abs(((B.x - A.x) * (A.y - W.y) - (A.x - W.x) * (B.y - A.y)) / L);
      return drawSlot(s, cl[0]!, cl[1]!, half, o) ?? { error: t("Slot: the two centres must be apart and the width more than 0.") };
    }
    case "polygon":
      if (cl.length < 2) return "more";
      return drawPolygon(s, cl[0]!, at(cl[1]!), opt.sides, o) ?? { error: t("Polygon: click away from the centre.") };
    case "linearPattern": {
      if (!items.length) return { error: t("Select the geometry to pattern first (select tool, S), then pick this tool.") };
      const need = opt.count2 > 1 ? 3 : 2;
      if (cl.length < need) return "more";
      const base = at(cl[0]!);
      const step = (c: Click) => ({ x: at(c).x - base.x, y: at(c).y - base.y });
      return linearPattern(s, items, step(cl[1]!), opt.count1, need === 3 ? step(cl[2]!) : { x: 0, y: 0 }, opt.count2);
    }
    case "circularPattern": {
      if (!items.length) return { error: t("Select the geometry to pattern first (select tool, S), then pick this tool.") };
      const pc = pointFor(s, cl[0]!);
      let base = pc.s;
      // A centre made by this click needs an entity so it stays (and shows) as a handle.
      if (cl[0]!.snap?.kind !== "point") base = addEntity(base, { kind: "point", p: pc.id, construction: true }).s;
      return circularPattern(base, items, pc.id, opt.countC);
    }
    default:
      return null;
  }
}

export function modifyPreview(tool: Tool, p: Vec, tol: number, click: Click): ModifyPreview {
  const s = session.value?.sketch;
  if (!s) return { shapes: [], hover: null };
  const tryOutline = (r: { s: Sketch } | { error: string }) => ("error" in r ? [] : outline(s, r.s));
  switch (tool) {
    case "trim": {
      const id = nearestEntity(s, p, tol, curveFilter);
      const piece = id ? trimPieceAt(s, id, p) : null;
      return {
        shapes: piece && !("error" in piece) ? [{ kind: "trim", piece }] : [],
        hover: null,
        hint: piece && "error" in piece ? piece.error : t("Click the piece of a line, circle or arc to remove"),
      };
    }
    case "fillet":
    case "chamfer": {
      const id = cornerAt(s, p, tol);
      const v = remembered(s, tool === "fillet" ? lastFillet : lastChamfer);
      const shapes = id ? tryOutline(tool === "fillet" ? filletAt(s, id, v) : chamferAt(s, id, v)) : [];
      return { shapes, hover: id, hint: tool === "fillet" ? t("Click a corner where two lines meet (radius {v} mm, then type a new value)", { v: Math.round(v * 100) / 100 }) : t("Click a corner where two lines meet (distance {v} mm, then type a new value)", { v: Math.round(v * 100) / 100 }) };
    }
    case "offset": {
      if (!offsetFrom) return { shapes: [], hover: nearestEntity(s, p, tol, curveFilter), hint: t("Click a line, arc or circle; joined lines and arcs offset together") };
      const d = offsetDistance(s, offsetFrom, p);
      return { shapes: tryOutline(offsetAt(s, offsetFrom, d, false)), hover: offsetFrom, hint: t("Offset {d} mm: click to place, then type the distance", { d: Math.round(Math.abs(d) * 100) / 100 }) };
    }
    case "mirror": {
      const id = nearestEntity(s, p, tol);
      if (!mirrorAxis) {
        const n = session.value!.selected.size;
        return { shapes: [], hover: id, hint: n ? `Click the line to mirror the ${n} selected item${n === 1 ? "" : "s"} about` : t("Click the line to mirror about, then the geometry to mirror") };
      }
      const shapes = id && id !== mirrorAxis ? tryOutline(mirrorItems(s, [id], mirrorAxis)) : [];
      return { shapes, hover: id, hint: t("Click geometry to mirror it; Esc when done") };
    }
    case "text":
      return { shapes: [], hover: null, hint: t("Click where the text starts (its baseline)") };
    case "spline": {
      const pts = [...pending.map(at), p];
      const shapes: PreviewShape[] = pts.length >= 2 ? [{ kind: "polyline", pts: splinePoints(pts, false) }] : [];
      return { shapes, hover: null, hint: pending.length < 2 ? t("Click points the curve passes through") : t("Click more points; click the last point again or press Enter to end, the first to close") };
    }
    case "slot":
    case "polygon":
    case "linearPattern":
    case "circularPattern": {
      const ses = session.value!;
      const r = shapeStep(tool, s, [...pending, click], ses.construction, [...ses.selected]);
      const shapes: PreviewShape[] = r && r !== "more" && !("error" in r) ? outline(s, r.s) : [];
      if (r === "more" && pending.length) shapes.push({ kind: "line", a: at(pending[pending.length - 1]!), b: p });
      const opt = toolOptions.value;
      const hint = {
        slot: [t("Click the first end's centre"), t("Click the second end's centre"), t("Click to set the width")][pending.length],
        polygon: [t("Click the centre ({n} sides)", { n: opt.sides }), t("Click a corner")][pending.length],
        linearPattern: [t("Click a base point"), t("Click where the first copy goes"), t("Click where the first copy of the second direction goes")][pending.length],
        circularPattern: [t("Click the centre ({n} in all)", { n: opt.countC })][pending.length],
      }[tool];
      return { shapes, hover: null, ...(hint ? { hint } : {}) };
    }
    default:
      return { shapes: [], hover: null };
  }
}
