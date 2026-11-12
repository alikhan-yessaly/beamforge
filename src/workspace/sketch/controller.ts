// Mouse and keyboard in sketch mode. The canvas forwards events here while a sketch is being edited.
import { signal } from "@preact/signals";
import { type Vec, apply, invert } from "../../geom/geom";
import { type ConstraintTool, applyConstraint, dimensionAnchor, dimensionCanDrive, dimensionFor } from "../../sketch/constrain";
import { type Click, drawArc3, drawArcCenter, drawArcTangent, drawCircle, drawLine, drawPoint, drawRect, drawRectCenter } from "../../sketch/draw";
import { type Sketch, ORIGIN, addConstraint, deleteItems, entity, entityPoints, pt } from "../../sketch/model";
import { type Snap, circleThrough, inferPointAlignments, nearestEntity, nearestPoint, snap } from "../../sketch/pick";
import { solve } from "../../sketch/solver";
import { fromUser, toUser } from "../../scene/model";
import { notify, prefs, profile } from "../../scene/store";
import { view } from "../view";
import { type Preview, type PreviewShape, hitBoxes, sketchScreenMat } from "./render";
import { type Tool, commitDrag, dimensionSuggestions, editingDimension, editingSuggestion, editingText, patchSession, redoSketch, session, setSketch, setTool, undoSketch } from "./state";
import { modifyActive, modifyEnter, modifyPreview, modifyPreviousPoint, resetModify, runModifyClick } from "./modify";
import { dimensionSuggestions as makeSuggestions } from "./suggestions";

export const preview = signal<Preview>({ shapes: [], hover: null });

/** Clicks collected by the active drawing tool. */
let clicks: Click[] = [];
/** Line tool: the chain continues from this point. */
let chainFrom: Click | null = null;
/** Dimension tool: items picked so far. */
let dimPicked: string[] = [];
let pointerScreen: Vec = { x: 0, y: 0 };
let attachment: { sketch: Sketch; snap: NonNullable<Snap> } | null = null;

type Drag =
  | { kind: "point"; id: string; base: Sketch; current: Sketch }
  | { kind: "entity"; ids: string[]; start: Vec; base: Sketch; current: Sketch }
  | { kind: "label"; id: string; start: Vec; offset: Vec; base: Sketch }
  | { kind: "marquee"; a: Vec; b: Vec; additive: boolean };
let drag: Drag | null = null;

export function resetTool(): void {
  clicks = [];
  chainFrom = null;
  dimPicked = [];
  drag = null;
  attachment = null;
  resetModify();
  dimensionSuggestions.value = [];
  editingSuggestion.value = null;
  preview.value = { shapes: [], hover: null };
}

const local = (bed: Vec): Vec => {
  const s = session.value!;
  return apply(invert(s.mat), bed);
};
/** Pick tolerance in sketch mm (8 screen px). */
const tol = () => {
  const s = session.value!;
  return 8 / (view.value.zoom * Math.hypot(s.mat[0], s.mat[1]));
};

function gridSnap(p: Vec): Vec {
  const st = prefs.value.gridStep;
  if (!prefs.value.snapToGrid || !st) return p;
  return { x: Math.round(p.x / st) * st, y: Math.round(p.y / st) * st };
}

const drawingTools: ReadonlySet<Tool> = new Set(["line", "rect", "rectCenter", "circle", "arc3", "arcCenter", "arcTangent", "point", "slot", "polygon", "spline", "text"]);

function previousPoint(tool: Tool): Vec | undefined {
  if (tool === "line") {
    if (chainFrom?.snap?.kind === "point") return session.value?.sketch.points[chainFrom.snap.id] ?? chainFrom.pos;
    return chainFrom?.pos;
  }
  if (tool === "arc3" || tool === "arcCenter" || tool === "arcTangent" || tool === "circle") return clicks.at(-1)?.pos;
  return modifyPreviousPoint(tool);
}

function clickAt(p: Vec, shift: boolean, tool: Tool): Click {
  const ses = session.value!;
  const s = ses.sketch;
  if (shift) return { pos: p, snap: null };
  if (!drawingTools.has(tool)) return { pos: p, snap: null };
  const sn = snap(s, p, tol());
  if (sn) return { pos: sn.pos, snap: sn };
  const user = toUser(profile.value, apply(ses.mat, p));
  const q = local(fromUser(profile.value, { x: Math.round(user.x), y: Math.round(user.y) }));
  const previous = previousPoint(tool);
  const previousId = tool === "line" && chainFrom?.snap?.kind === "point" ? chainFrom.snap.id : null;
  const inferences = inferPointAlignments(s, p, tol(), previousId ? new Set([previousId]) : new Set());
  const dx = previous ? Math.abs(p.x - previous.x) : Infinity;
  const dy = previous ? Math.abs(p.y - previous.y) : Infinity;
  const previousAxis = Math.min(dx, dy) <= tol() ? (dx < dy ? "v" : "h") : undefined;
  let pos = { ...q };
  for (const inference of inferences) {
    if (inference.type === "verticalPts") pos.x = inference.pos.x;
    else pos.y = inference.pos.y;
  }
  const retained = inferences.filter((inference) => inference.type !== (previousAxis === "v" ? "verticalPts" : previousAxis === "h" ? "horizontalPts" : null));
  if (previous && previousAxis === "v") pos.x = previous.x;
  if (previous && previousAxis === "h") pos.y = previous.y;
  return {
    pos,
    snap: null,
    ...(retained.length ? { inferences: retained.map(({ type, ref }) => ({ type, ref })) } : {}),
    ...(previousAxis ? { previousAxis } : {}),
  };
}

const opts = (shift: boolean) => ({ construction: session.value!.construction, infer: !shift });

function hitLabel(screen: Vec): string | null {
  for (let i = hitBoxes.length - 1; i >= 0; i--) {
    const h = hitBoxes[i]!;
    if (screen.x >= h.x && screen.x <= h.x + h.w && screen.y >= h.y && screen.y <= h.y + h.h) return h.id;
  }
  return null;
}

/** What is under the cursor in select mode: label/glyph, then point, then entity. */
function hitAny(screen: Vec, p: Vec): string | null {
  const s = session.value!.sketch;
  return hitLabel(screen) ?? nearestPoint(s, p, tol()) ?? nearestEntity(s, p, tol());
}

function selectOnly(ids: string[]): void {
  patchSession({ selected: new Set(ids) });
}

const snapShape = (sn: Snap): PreviewShape[] => (sn ? [{ kind: "snap", at: sn.pos, type: sn.kind === "point" ? "point" : "curve" }] : []);
const inferenceShape = (c: Click): PreviewShape[] =>
  (c.inferences ?? []).map((inference) => ({
    kind: "guide",
    a: pt(session.value!.sketch, inference.ref),
    b: c.pos,
    type: inference.type === "horizontalPts" ? "horizontal" : "vertical",
  }));

function attachmentFor(s: Sketch, moving: Set<string>): { sketch: Sketch; snap: NonNullable<Snap> } | null {
  const excluded = new Set(moving);
  for (const en of s.entities) if (entityPoints(en).some((id) => moving.has(id))) excluded.add(en.id);
  const candidates = [...moving].flatMap((id) => {
    const position = s.points[id];
    if (!position || position.fixed) return [];
    const target = snap(s, position, tol(), excluded);
    if (!target) return [];
    return [{ id, target, distance: Math.hypot(position.x - target.pos.x, position.y - target.pos.y) }];
  }).sort((a, b) => a.distance - b.distance);
  for (const { id, target } of candidates) {
    const type = target.kind === "point" ? "coincident" : entity(s, target.id)?.kind === "line" ? "pointOnLine" : "pointOnCircle";
    const candidate = addConstraint(s, { type, refs: [id, target.id] });
    const targetEntity = target.kind === "curve" ? entity(s, target.id) : undefined;
    const anchors = target.kind === "point" ? [target.id] : targetEntity?.kind === "arc" ? [targetEntity.c] : targetEntity ? entityPoints(targetEntity) : [];
    const pinnedRadius = targetEntity?.kind === "circle" || targetEntity?.kind === "arc" ? addConstraint(candidate.s, { type: "radius", refs: [targetEntity.id], value: targetEntity.r }) : null;
    const trial = pinnedRadius?.s ?? candidate.s;
    const points = { ...trial.points };
    for (const anchor of anchors) points[anchor] = { ...points[anchor]!, fixed: true };
    const result = solve({ ...trial, points });
    if (!result.ok || result.redundant.includes(candidate.id)) continue;
    const solvedTarget = targetEntity && entity(result.sketch, targetEntity.id);
    if (targetEntity && (targetEntity.kind === "circle" || targetEntity.kind === "arc") &&
        solvedTarget && (solvedTarget.kind === "circle" || solvedTarget.kind === "arc") && Math.abs(targetEntity.r - solvedTarget.r) > 1e-5) continue;
    if (targetEntity?.kind === "arc" && [targetEntity.start, targetEntity.end].some((point) =>
      Math.hypot(result.sketch.points[point]!.x - s.points[point]!.x, result.sketch.points[point]!.y - s.points[point]!.y) > 1e-5)) continue;
    const position = result.sketch.points[id]!;
    if (Math.hypot(position.x - target.pos.x, position.y - target.pos.y) > tol()) continue;
    const restored = { ...result.sketch.points };
    for (const anchor of anchors) restored[anchor] = { ...restored[anchor]!, fixed: s.points[anchor]!.fixed };
    return {
      sketch: { ...result.sketch, points: restored, next: candidate.s.next, constraints: result.sketch.constraints.filter((c) => c.id !== pinnedRadius?.id) },
      snap: { ...target, pos: { x: position.x, y: position.y } },
    };
  }
  return null;
}

export function sketchPointerDown(e: PointerEvent, screen: Vec, bed: Vec): void {
  const before = session.value;
  if (!before) return;
  pointerScreen = screen;
  if (e.button === 0 && drawingTools.has(before.tool)) dimensionSuggestions.value = [];
  sketchPointerDownImpl(e, screen, bed);
  const after = session.value;
  if (!after || after === before || !drawingTools.has(before.tool)) return;
  const old = new Set(before.sketch.entities.map((entity) => entity.id));
  const added = after.sketch.entities.filter((entity) => !old.has(entity.id)).map((entity) => entity.id);
  if (added.length) dimensionSuggestions.value = makeSuggestions(after.sketch, added, before.tool, 25 / (view.value.zoom * Math.hypot(after.mat[0], after.mat[1])));
}

function sketchPointerDownImpl(e: PointerEvent, screen: Vec, bed: Vec): void {
  const ses = session.value;
  if (!ses) return;
  const p = local(bed);
  if (e.button === 2) {
    // Right-click ends the current chain / tool step.
    resetTool();
    return;
  }
  const s = ses.sketch;
  const o = opts(e.shiftKey);
  const tool = ses.tool;
  const c = clickAt(p, e.shiftKey, tool);

  if (tool === "select") {
    const hit = hitAny(screen, p);
    if (!hit) {
      if (!e.shiftKey) selectOnly([]);
      drag = { kind: "marquee", a: p, b: p, additive: e.shiftKey };
      return;
    }
    const selected = new Set(ses.selected);
    if (e.shiftKey && selected.has(hit)) {
      selected.delete(hit);
      patchSession({ selected });
      return;
    }
    selected.add(hit);
    patchSession({ selected });
    const con = s.constraints.find((x) => x.id === hit);
    if (con?.offset) drag = { kind: "label", id: hit, start: p, offset: con.offset, base: s };
    else if (s.points[hit] && hit !== ORIGIN && !s.points[hit]!.fixed) drag = { kind: "point", id: hit, base: s, current: s };
    else if (entity(s, hit)) drag = { kind: "entity", ids: [...selected].filter((id) => entity(s, id)), start: p, base: s, current: s };
    return;
  }

  if (tool === "line") {
    if (!chainFrom) {
      chainFrom = c;
      return;
    }
    if (chainFrom.snap?.kind === "point") {
      const end = pt(s, chainFrom.snap.id);
      chainFrom = { pos: end, snap: { kind: "point", id: chainFrom.snap.id, pos: end } };
    }
    if (Math.hypot(c.pos.x - chainFrom.pos.x, c.pos.y - chainFrom.pos.y) < 1e-6) {
      notify("Choose a different endpoint for the line.", "warn");
      return;
    }
    const r = drawLine(s, chainFrom, c, o);
    setSketch(r.s);
    const end = pt(session.value!.sketch, r.end);
    chainFrom = { pos: end, snap: { kind: "point", id: r.end, pos: end } };
    // Clicking an existing point closes the chain there.
    if (c.snap?.kind === "point") chainFrom = null;
    return;
  }

  clicks.push(c);
  const done = () => {
    clicks = [];
    preview.value = { shapes: [], hover: null };
  };
  switch (tool) {
    case "point":
      setSketch(drawPoint(s, c, o).s);
      done();
      return;
    case "rect":
    case "rectCenter":
    case "circle":
      if (clicks.length < 2) return;
      if (tool === "rect") setSketch(drawRect(s, clicks[0]!, clicks[1]!, o).s);
      else if (tool === "rectCenter") setSketch(drawRectCenter(s, clicks[0]!, clicks[1]!, o).s);
      else setSketch(drawCircle(s, clicks[0]!, clicks[1]!.pos, o).s);
      done();
      return;
    case "arc3": {
      if (clicks.length < 3) return;
      const r = drawArc3(s, clicks[0]!, clicks[1]!, clicks[2]!.pos, o);
      if (r) setSketch(r.s);
      else notify("Those three points are in a line; no arc goes through them.", "warn");
      done();
      return;
    }
    case "arcCenter": {
      if (clicks.length < 3) return;
      const C = clicks[0]!.pos;
      const A = clicks[1]!.pos;
      const B = clicks[2]!.pos;
      const cross = (A.x - C.x) * (B.y - C.y) - (A.y - C.y) * (B.x - C.x);
      setSketch(drawArcCenter(s, clicks[0]!, clicks[1]!, B, cross < 0, o).s);
      done();
      return;
    }
    case "arcTangent": {
      if (clicks.length === 1) {
        const from = c.snap?.kind === "point" ? c.snap.id : null;
        const along = from ? s.entities.find((x) => (x.kind === "line" && (x.p1 === from || x.p2 === from)) || (x.kind === "arc" && (x.start === from || x.end === from))) : undefined;
        if (!along) {
          notify("Tangent arc: start on the end of a line or arc.");
          clicks = [];
        }
        return;
      }
      const from = clicks[0]!.snap!.kind === "point" ? (clicks[0]!.snap as { id: string }).id : "";
      const along = s.entities.find((x) => (x.kind === "line" && (x.p1 === from || x.p2 === from)) || (x.kind === "arc" && (x.start === from || x.end === from)))!;
      const r = drawArcTangent(s, from, along.id, c, o);
      if (r) setSketch(r.s);
      done();
      return;
    }
    case "dimension": {
      clicks = [];
      const hit = nearestPoint(s, p, tol()) ?? nearestEntity(s, p, tol(), (x) => x.kind !== "point");
      if (dimPicked.length === 0) {
        if (hit) dimPicked = [hit];
        return;
      }
      if (dimPicked.length === 1 && hit && hit !== dimPicked[0]) {
        dimPicked = [dimPicked[0]!, hit];
        return;
      }
      const d = dimensionFor(s, dimPicked, c.pos);
      dimPicked = [];
      preview.value = { shapes: [], hover: null };
      if (!d) {
        notify("Nothing to dimension there: pick a line, circle, arc, or two points/lines.");
        return;
      }
      if (!dimensionCanDrive(s, d)) {
        notify("This dimension is already constrained and cannot be changed.", "warn");
        return;
      }
      const r = addConstraint(s, d);
      setSketch(r.s);
      editingDimension.value = r.id;
      return;
    }
    default:
      clicks = [];
      runModifyClick(tool, c, p, e.shiftKey, tol());
      if (tool === "trim") preview.value = { shapes: [], hover: null };
  }
}

export function sketchPointerMove(e: PointerEvent, screen: Vec, bed: Vec): void {
  const ses = session.value;
  if (!ses) return;
  pointerScreen = screen;
  const p = local(bed);
  const s = ses.sketch;
  if (drag) {
    if (drag.kind === "point") {
      const r = solve(drag.base, { drag: [{ id: drag.id, to: gridSnap(p) }] });
      attachment = !e.shiftKey && r.ok ? attachmentFor(r.sketch, new Set([drag.id])) : null;
      drag.current = r.sketch;
      setSketch(drag.current, { record: false, solve: false });
      preview.value = { shapes: snapShape(attachment?.snap ?? null), hover: null, ...(attachment ? { hint: "Release to attach · hold Shift to move without attaching" } : {}) };
    } else if (drag.kind === "entity") {
      const g = drag;
      const d = { x: p.x - g.start.x, y: p.y - g.start.y };
      const ids = new Set<string>();
      for (const id of g.ids) {
        const en = entity(g.base, id);
        if (en) for (const q of entityPoints(en)) if (!g.base.points[q]!.fixed) ids.add(q);
      }
      const r = solve(g.base, { drag: [...ids].map((id) => ({ id, to: { x: g.base.points[id]!.x + d.x, y: g.base.points[id]!.y + d.y } })) });
      attachment = !e.shiftKey && r.ok ? attachmentFor(r.sketch, ids) : null;
      g.current = r.sketch;
      setSketch(g.current, { record: false, solve: false });
      preview.value = { shapes: snapShape(attachment?.snap ?? null), hover: null, ...(attachment ? { hint: "Release to attach · hold Shift to move without attaching" } : {}) };
    } else if (drag.kind === "label") {
      const d = { x: p.x - drag.start.x, y: p.y - drag.start.y };
      const id = drag.id;
      const off = { x: drag.offset.x + d.x, y: drag.offset.y + d.y };
      setSketch({ ...s, constraints: s.constraints.map((c) => (c.id === id ? { ...c, offset: off } : c)) }, { record: false, solve: false });
    } else {
      drag.b = p;
      preview.value = { shapes: [{ kind: "marquee", a: drag.a, b: p }], hover: null };
    }
    return;
  }

  const tool = ses.tool;
  if (tool === "select") {
    preview.value = { shapes: [], hover: hitAny(screen, p) };
    return;
  }
  const c = clickAt(p, e.shiftKey, tool);
  let shapes: PreviewShape[] = [...snapShape(c.snap), ...inferenceShape(c)];
  const P = c.pos;
  const A = clicks[0]?.pos;
  const previous = previousPoint(tool);
  if (previous && c.previousAxis && tool !== "line") shapes.push({ kind: "guide", a: previous, b: P, type: c.previousAxis === "h" ? "horizontal" : "vertical" });
  switch (tool) {
    case "line":
      if (chainFrom && Math.hypot(P.x - chainFrom.pos.x, P.y - chainFrom.pos.y) >= 1e-6) {
        const draft = drawLine(s, chainFrom, c, opts(e.shiftKey));
        const added = draft.s.constraints.filter((con) => !s.constraints.some((existing) => existing.id === con.id));
        const axis = added.find((con) => con.refs[0] === draft.line && (con.type === "horizontal" || con.type === "vertical"));
        const hv = axis?.type === "horizontal" ? "h" : axis?.type === "vertical" ? "v" : null;
        shapes = [...snapShape(c.snap), ...inferenceShape({ ...c, inferences: c.inferences?.filter((inference) =>
          added.some((con) => con.type === inference.type && con.refs[0] === draft.end && con.refs[1] === inference.ref)) })];
        if (previous && c.previousAxis && hv === c.previousAxis) shapes.push({ kind: "guide", a: previous, b: P, type: hv === "h" ? "horizontal" : "vertical" });
        shapes.push({ kind: "line", a: chainFrom.pos, b: P, hv, construction: ses.construction });
      }
      break;
    case "rect":
      if (A) shapes.push({ kind: "polyline", pts: [A, { x: P.x, y: A.y }, P, { x: A.x, y: P.y }], closed: true });
      break;
    case "rectCenter":
      if (A) {
        const dx = P.x - A.x;
        const dy = P.y - A.y;
        shapes.push({ kind: "polyline", pts: [{ x: A.x - dx, y: A.y - dy }, { x: A.x + dx, y: A.y - dy }, P, { x: A.x - dx, y: A.y + dy }], closed: true });
      }
      break;
    case "circle":
      if (A) shapes.push({ kind: "circle", c: A, r: Math.hypot(P.x - A.x, P.y - A.y) });
      break;
    case "arc3":
      if (clicks.length === 1) shapes.push({ kind: "line", a: A!, b: P });
      if (clicks.length === 2) {
        const circ = circleThrough(A!, clicks[1]!.pos, P);
        if (circ) shapes.push({ kind: "polyline", pts: arcPreview(circ.c, circ.r, A!, clicks[1]!.pos, P) });
      }
      break;
    case "arcCenter":
      if (clicks.length === 1) shapes.push({ kind: "line", a: A!, b: P });
      if (clicks.length === 2) {
        const C = A!;
        const B = clicks[1]!.pos;
        const r = Math.hypot(B.x - C.x, B.y - C.y);
        let a0 = Math.atan2(B.y - C.y, B.x - C.x);
        let a1 = Math.atan2(P.y - C.y, P.x - C.x);
        const cross = (B.x - C.x) * (P.y - C.y) - (B.y - C.y) * (P.x - C.x);
        if (cross < 0) [a0, a1] = [a1, a0];
        if (a1 < a0) a1 += 2 * Math.PI;
        shapes.push({ kind: "arc", c: C, r, a0, a1 });
      }
      break;
    case "arcTangent":
      if (clicks.length === 1) shapes.push({ kind: "line", a: A!, b: P });
      break;
    case "dimension":
      let locked = false;
      if (dimPicked.length) {
        const d = dimensionFor(s, dimPicked, c.pos);
        if (d) {
          locked = !dimensionCanDrive(s, d);
          shapes.push({ kind: "dimension", constraint: { ...d, id: "__preview__" }, locked });
        }
      }
      preview.value = {
        shapes,
        hover: nearestPoint(s, p, tol()) ?? nearestEntity(s, p, tol()),
        hint: locked ? "Already constrained: this dimension cannot be changed" : dimPicked.length >= 2 ? "Click to place the dimension" : "Click another item, or click where the dimension goes",
      };
      return;
    default:
      const mp = modifyPreview(tool, drawingTools.has(tool) ? P : p, tol(), c);
      preview.value = { shapes: [...shapes, ...mp.shapes], hover: mp.hover, ...(mp.hint ? { hint: mp.hint } : {}) };
      return;
  }
  preview.value = { shapes, hover: null };
}

function arcPreview(c: Vec, r: number, a: Vec, b: Vec, through: Vec): Vec[] {
  const ang = (p: Vec) => Math.atan2(p.y - c.y, p.x - c.x);
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(a);
  let sweep = norm(ang(b) - a0);
  if (norm(ang(through) - a0) > sweep) sweep -= 2 * Math.PI;
  const pts: Vec[] = [];
  for (let i = 0; i <= 48; i++) pts.push({ x: c.x + r * Math.cos(a0 + (sweep * i) / 48), y: c.y + r * Math.sin(a0 + (sweep * i) / 48) });
  return pts;
}

export function sketchPointerUp(e: PointerEvent, _screen: Vec, _bed: Vec): void {
  const d = drag;
  drag = null;
  const attached = !e.shiftKey ? attachment : null;
  attachment = null;
  if (!d || !session.value) return;
  if (d.kind === "point" || d.kind === "entity") {
    if (d.current !== d.base) commitDrag(d.base, attached?.sketch ?? d.current);
    preview.value = { shapes: [], hover: null };
  } else if (d.kind === "label") {
    if (session.value.sketch !== d.base) commitDrag(d.base, session.value.sketch);
  } else {
    // Marquee: select entities whose points all lie inside.
    const s = session.value.sketch;
    const [x0, x1] = [Math.min(d.a.x, d.b.x), Math.max(d.a.x, d.b.x)];
    const [y0, y1] = [Math.min(d.a.y, d.b.y), Math.max(d.a.y, d.b.y)];
    const inside = (id: string) => {
      const q = s.points[id];
      return !!q && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
    };
    const ids = s.entities.filter((en) => entityPoints(en).every(inside)).map((en) => en.id);
    const sel = new Set(d.additive ? session.value.selected : []);
    for (const id of ids) sel.add(id);
    patchSession({ selected: sel });
    preview.value = { shapes: [], hover: null };
  }
}

export function sketchDoubleClick(screen: Vec, bed: Vec): void {
  const ses = session.value;
  if (!ses) return;
  const s = ses.sketch;
  const id = hitLabel(screen);
  if (id && s.constraints.find((c) => c.id === id && c.value !== undefined)) {
    editingDimension.value = id;
    return;
  }
  if (ses.tool !== "select") return;
  const t = nearestEntity(s, local(bed), tol(), (e) => e.kind === "text");
  if (t) editingText.value = { id: t, before: s, isNew: false };
}

export function deleteSelected(): void {
  const ses = session.value;
  if (!ses || !ses.selected.size) return;
  // Selecting a point deletes the geometry that uses it.
  const ids = new Set(ses.selected);
  for (const id of ses.selected) {
    if (ses.sketch.points[id]) for (const en of ses.sketch.entities) if (entityPoints(en).includes(id)) ids.add(en.id);
  }
  ids.delete(ORIGIN);
  setSketch(deleteItems(ses.sketch, ids));
  patchSession({ selected: new Set() });
}

export function constrainSelected(t: ConstraintTool): void {
  const ses = session.value;
  if (!ses) return;
  const r = applyConstraint(ses.sketch, t, [...ses.selected]);
  if ("error" in r) notify(r.error);
  else setSketch(r.s);
}

/** Toggle construction for selected geometry; with nothing selected, toggle construction mode for new geometry. */
export function toggleConstruction(): void {
  const ses = session.value;
  if (!ses) return;
  const ents = [...ses.selected].filter((id) => entity(ses.sketch, id));
  if (!ents.length) {
    patchSession({ construction: !ses.construction });
    return;
  }
  const allOn = ents.every((id) => entity(ses.sketch, id)!.construction);
  setSketch({ ...ses.sketch, entities: ses.sketch.entities.map((en) => (ents.includes(en.id) ? { ...en, construction: !allOn } : en)) });
}

const KEYS: Record<string, Tool> = { l: "line", r: "rect", c: "circle", a: "arc3", p: "point", d: "dimension", s: "select", t: "trim", f: "fillet", o: "offset", m: "mirror", g: "polygon", n: "spline", x: "text" };

/** Keyboard in sketch mode. Returns true when handled. */
export function sketchKey(e: KeyboardEvent): boolean {
  const ses = session.value;
  if (!ses) return false;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    if (e.shiftKey) redoSketch();
    else undoSketch();
    resetTool();
    return true;
  }
  if (mod && k === "y") {
    redoSketch();
    resetTool();
    return true;
  }
  if (mod) return false;
  if (!e.altKey && /^[0-9.]$/.test(e.key) && dimensionSuggestions.value.length && !editingSuggestion.value && !editingDimension.value) {
    const matrix = sketchScreenMat(view.value, ses.mat);
    let best = 0;
    let distance = Infinity;
    dimensionSuggestions.value.forEach((suggestion, index) => {
      const anchor = dimensionAnchor(ses.sketch, { ...suggestion, id: "" });
      const label = apply(matrix, { x: anchor.x + (suggestion.offset?.x ?? 0), y: anchor.y + (suggestion.offset?.y ?? 0) });
      const d = Math.hypot(label.x - pointerScreen.x, label.y - pointerScreen.y);
      if (d < distance) [best, distance] = [index, d];
    });
    editingSuggestion.value = { index: best, initial: e.key };
    return true;
  }
  if (k === "escape") {
    if (clicks.length || chainFrom || dimPicked.length || drag || modifyActive()) resetTool();
    else if (ses.tool !== "select") setTool("select");
    else patchSession({ selected: new Set() });
    return true;
  }
  if (k === "enter" && modifyEnter(ses.tool)) return true;
  if (k === "delete" || k === "backspace") {
    deleteSelected();
    return true;
  }
  if (k === "q") {
    toggleConstruction();
    return true;
  }
  const tool = KEYS[k];
  if (tool) {
    resetTool();
    setTool(tool);
    return true;
  }
  return false;
}
