// Sketch mode: the sketch being edited, its own undo/redo, the active tool and selection, and the solver status.
// Finishing writes the sketch (and the paths generated from it) back to its object as one project undo step.
import { signal } from "@preact/signals";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { type Mat, apply, translate } from "../../geom/geom";
import { fitBox, view, viewTouched } from "../view";
import { type SceneObject, newId as newObjectId } from "../../scene/model";
import { commit, doc, notify, profile, selection } from "../../scene/store";
import { type Sketch, type TextEntity, deleteItems, emptySketch, sketchBox } from "../../sketch/model";
import { pathsToSketch } from "../../sketch/fromPaths";
import { sketchPaths, textReady } from "../../sketch/paths";
import "./fonts"; // registers text outlines
import { loadSolver, solve, solverReady } from "../../sketch/solver";
import type { DimensionSuggestion } from "./suggestions";

export type Tool =
  | "select"
  | "line"
  | "rect"
  | "rectCenter"
  | "circle"
  | "arc3"
  | "arcCenter"
  | "arcTangent"
  | "point"
  | "dimension"
  | "slot"
  | "polygon"
  | "spline"
  | "text"
  | "trim"
  | "fillet"
  | "chamfer"
  | "offset"
  | "mirror"
  | "linearPattern"
  | "circularPattern";

export interface SolveStatus {
  ok: boolean;
  dof: number;
  conflicting: string[];
  redundant?: string[];
  free: Set<string>;
}

export interface SketchSession {
  /** Object being edited; null for a new sketch not yet in the document. */
  objectId: string | null;
  name: string;
  mat: Mat;
  original: Sketch;
  sketch: Sketch;
  undo: Sketch[];
  redo: Sketch[];
  tool: Tool;
  /** Draw new geometry as construction. */
  construction: boolean;
  /** Selected point, entity and constraint ids. */
  selected: ReadonlySet<string>;
  status: SolveStatus;
}

export const session = signal<SketchSession | null>(null);
/** Settings for the shape and pattern tools, shown in the toolbar while the tool is active. */
export const toolOptions = signal({ sides: 6, count1: 3, count2: 1, countC: 6 });
/** Text entity whose words, size and font are being edited, with the sketch from before (one undo step). */
export const editingText = signal<{ id: string; before: Sketch; isNew: boolean } | null>(null);
/** Dimension whose value is being typed (constraint id). */
export const editingDimension = signal<string | null>(null);
export const dimensionSuggestions = signal<DimensionSuggestion[]>([]);
export const editingSuggestion = signal<{ index: number; initial: string } | null>(null);

const EMPTY_STATUS: SolveStatus = { ok: true, dof: 0, conflicting: [], free: new Set() };

function analyse(s: Sketch): { sketch: Sketch; status: SolveStatus } {
  if (!solverReady()) return { sketch: s, status: EMPTY_STATUS };
  const r = solve(s, { analyze: true });
  const ids = new Set(s.constraints.map((c) => c.id));
  return { sketch: r.ok ? r.sketch : s, status: { ok: r.ok, dof: r.dof, conflicting: r.conflicting.filter((id) => ids.has(id)), redundant: r.redundant.filter((id) => ids.has(id)), free: r.free } };
}

async function open(objectId: string | null, name: string, mat: Mat, sketch: Sketch): Promise<void> {
  try {
    await loadSolver(wasmUrl);
  } catch (e) {
    notify(`Could not load the sketch solver: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  const a = analyse(sketch);
  dimensionSuggestions.value = [];
  editingSuggestion.value = null;
  selection.value = new Set();
  // Zoom to the sketch (an empty one: a 200 × 140 mm area around its origin).
  const b = sketchBox(sketch);
  const empty = !Number.isFinite(b.minX);
  const local = empty ? { minX: -100, minY: -70, maxX: 100, maxY: 70 } : { minX: b.minX - 10, minY: b.minY - 10, maxX: b.maxX + 10, maxY: b.maxY + 10 };
  const corners = [apply(mat, { x: local.minX, y: local.minY }), apply(mat, { x: local.maxX, y: local.maxY }), apply(mat, { x: local.minX, y: local.maxY }), apply(mat, { x: local.maxX, y: local.minY })];
  view.value = fitBox({ minX: Math.min(...corners.map((c) => c.x)), minY: Math.min(...corners.map((c) => c.y)), maxX: Math.max(...corners.map((c) => c.x)), maxY: Math.max(...corners.map((c) => c.y)) });
  viewTouched.value = true;
  session.value = { objectId, name, mat, original: sketch, sketch: a.sketch, undo: [], redo: [], tool: "select", construction: false, selected: new Set(), status: a.status };
}

/** Start a new sketch with its origin at the centre of the bed. */
export function newSketch(): Promise<void> {
  const p = profile.value;
  return open(null, "Sketch", translate(p.bedW / 2, p.bedH / 2), emptySketch());
}

export function editSketch(o: SceneObject): Promise<void> {
  if (!o.sketch) return editAsSketch(o);
  return open(o.id, o.name, o.mat, o.sketch);
}

/**
 * Open any drawing in sketch mode: a sketch as it is; an imported one converted to sketch geometry (lines, arcs,
 * circles editable; ellipses and splines as reference geometry). It only becomes a sketch if changed and finished.
 */
export function editAsSketch(o: SceneObject): Promise<void> {
  if (o.sketch) return editSketch(o);
  if (o.children?.length) {
    notify("Ungroup this first: a group can't be edited as one sketch.", "warn");
    return Promise.resolve();
  }
  const counts = new Map<string, number>();
  for (const p of o.paths) counts.set(p.color, (counts.get(p.color) ?? 0) + 1);
  const color = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#000000";
  const r = pathsToSketch(o.paths, color);
  if (!r.editable && !r.reference) {
    notify("Nothing in this drawing can be edited as a sketch.", "warn");
    return Promise.resolve();
  }
  if (r.reference)
    notify(
      r.legacy
        ? `${r.reference} curve${r.reference === 1 ? "" : "s"} can be moved but not reshaped: this drawing was imported before sketches existed. Import the DXF again to edit its arcs and circles.`
        : `${r.reference} curve${r.reference === 1 ? "" : "s"} (ellipses/splines) can be moved but not reshaped.`,
    );
  if (r.sketch.entities.length > 1500) notify("This is a big drawing; sketch editing may be slow.", "warn");
  return open(o.id, o.name, o.mat, r.sketch);
}

/** Replace the working sketch (one sketch-undo step unless `record` is false) and re-solve. */
export function setSketch(next: Sketch, opts: { record?: boolean; solve?: boolean } = {}): void {
  const s = session.value;
  if (!s) return;
  const a = opts.solve === false ? { sketch: next, status: s.status } : analyse(next);
  if (opts.solve !== false && !a.status.ok) notify("That change conflicts with existing constraints (shown in red). Undo or delete a constraint.", "warn");
  else if (opts.solve !== false && a.status.redundant?.some((id) => !s.status.redundant?.includes(id))) notify("Redundant constraints are shown in red. Select and delete one to resolve the overconstraint.", "warn");
  session.value = {
    ...s,
    sketch: a.sketch,
    status: a.status,
    undo: opts.record === false ? s.undo : [...s.undo, s.sketch].slice(-200),
    redo: opts.record === false ? s.redo : [],
  };
}

export const patchSession = (patch: Partial<SketchSession>) => {
  if (session.value) session.value = { ...session.value, ...patch };
};

export function setTool(tool: Tool): void {
  const active = session.value?.tool;
  patchSession({ tool: active === tool && tool !== "select" ? "select" : tool });
}

export function undoSketch(): void {
  const s = session.value;
  const prev = s?.undo.at(-1);
  if (!s || !prev) return;
  const a = analyse(prev);
  session.value = { ...s, sketch: a.sketch, status: a.status, undo: s.undo.slice(0, -1), redo: [...s.redo, s.sketch], selected: new Set() };
}

export function redoSketch(): void {
  const s = session.value;
  const next = s?.redo.at(-1);
  if (!s || !next) return;
  const a = analyse(next);
  session.value = { ...s, sketch: a.sketch, status: a.status, redo: s.redo.slice(0, -1), undo: [...s.undo, s.sketch], selected: new Set() };
}

/** Leave sketch mode. `keep` writes the edit back (one project undo step); otherwise it is discarded. */
export function finishSketch(keep: boolean): void {
  const s = session.value;
  if (!s) return;
  if (keep && s.sketch !== s.original && !textReady(s.sketch)) {
    notify("A font is still loading; try Finish again in a moment.", "warn");
    return;
  }
  editingDimension.value = null;
  dimensionSuggestions.value = [];
  editingSuggestion.value = null;
  editingText.value = null;
  session.value = null;
  if (!keep || s.sketch === s.original) return;
  const paths = sketchPaths(s.sketch);
  if (s.objectId === null) {
    if (s.sketch.entities.length === 0) return;
    const obj: SceneObject = { id: newObjectId(), name: s.name, paths, mat: s.mat, sketch: s.sketch };
    commit({ ...doc.value, objects: [...doc.value.objects, obj] });
    selection.value = new Set([obj.id]);
  } else {
    commit({ ...doc.value, objects: doc.value.objects.map((o) => (o.id === s.objectId ? { ...o, sketch: s.sketch, paths } : o)) });
    selection.value = new Set([s.objectId]);
  }
}

/** Ask before throwing away sketch edits. */
export function cancelSketch(): void {
  const s = session.value;
  if (!s) return;
  if (s.sketch !== s.original && !window.confirm("Discard the changes to this sketch?")) return;
  finishSketch(false);
}

export const hasChanges = () => !!session.value && session.value.sketch !== session.value.original;

/** End a drag: keep `final`, with one undo step back to `base` (the sketch before the drag). */
export function commitDrag(base: Sketch, final: Sketch): void {
  const s = session.value;
  if (!s) return;
  const a = analyse(final);
  session.value = { ...s, sketch: a.sketch, status: a.status, undo: [...s.undo, base].slice(-200), redo: [] };
}

// Dev-only handle for inspecting the sketch session from the browser console.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__sketch = { session, editingDimension };

/** Size and font for the next text (the last ones used). */
export const textDefaults = { size: 10, font: "Roboto" };

/** Change the text being edited live (no undo step yet; closing the editor makes one). */
export function updateText(patch: Partial<Pick<TextEntity, "text" | "size" | "angle" | "font">>): void {
  const ed = editingText.value;
  const s = session.value;
  if (!ed || !s) return;
  if (patch.size) textDefaults.size = patch.size;
  if (patch.font) textDefaults.font = patch.font;
  setSketch({ ...s.sketch, entities: s.sketch.entities.map((e) => (e.id === ed.id && e.kind === "text" ? { ...e, ...patch } : e)) }, { record: false, solve: false });
}

/** Close the text editor: keep the edit as one undo step (empty text removes it), or put things back. */
export function closeTextEditor(keep: boolean): void {
  const ed = editingText.value;
  const s = session.value;
  editingText.value = null;
  if (!ed || !s) return;
  const e = s.sketch.entities.find((x) => x.id === ed.id);
  const empty = !e || e.kind !== "text" || !e.text.trim();
  if (!keep || (empty && ed.isNew)) {
    setSketch(ed.before, { record: false });
    return;
  }
  const next = empty ? deleteItems(s.sketch, new Set([ed.id])) : s.sketch;
  if (next !== ed.before) commitDrag(ed.before, next);
}
