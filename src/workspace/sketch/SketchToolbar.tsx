// Sketch-mode toolbar (replaces the main toolbar while a sketch is open) and the inline dimension editor.
import { msg, t, tp } from "../../i18n";
import {
  Check,
  Circle,
  Dot,
  Equal,
  FlipHorizontal2,
  Hexagon,
  LayoutGrid,
  type LucideIcon,
  Pin,
  RectangleHorizontal,
  Redo2,
  RulerDimensionLine,
  Scissors,
  Spline,
  SquareDot,
  Type,
  Undo2,
  X,
} from "lucide-preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { apply as applyMat } from "../../geom/geom";
import { dimensionAnchor, dimensionCanDrive } from "../../sketch/constrain";
import { addConstraint } from "../../sketch/model";
import { measure, solve } from "../../sketch/solver";
import { view } from "../view";
import type { ConstraintTool } from "../../sketch/constrain";
import type { ConstraintType } from "../../sketch/model";
import {
  CnCoincident,
  CnConcentric,
  CnHorizontal,
  CnMidpoint,
  CnParallel,
  CnPerpendicular,
  CnSymmetric,
  CnTangent,
  CnVertical,
  SkArc3,
  SkArcCenter,
  SkArcTangent,
  SkChamfer,
  SkCircularPattern,
  SkConstruction,
  SkFillet,
  SkLine,
  SkOffset,
  SkSlot,
  SketchSheet,
} from "../../ui/customIcons";
import { InlineNameField } from "../../ui/InlineName";
import { IconButton } from "../../ui/icons";
import { NumberInput } from "../../ui/NumberInput";
import { notify } from "../../scene/store";
import { constrainSelected, preview, resetTool, toggleConstruction } from "./controller";
import { hitBoxes, sketchScreenMat } from "./render";
import { type Tool, cancelSketch, closeTextEditor, dimensionSuggestions, editingDimension, editingSuggestion, editingText, finishSketch, redoSketch, renameSketch, session, setSketch, setTool, toolOptions, undoSketch, updateText } from "./state";
import { DEFAULT_FONT, canListLocalFonts, localFontFamilies } from "./fonts";

const TOOLS: { tool: Tool; icon: LucideIcon; label: string }[][] = [
  [
    { tool: "line", icon: SkLine, label: msg("Line (L): click points; Esc or right-click ends") },
    { tool: "rect", icon: RectangleHorizontal, label: msg("Rectangle from corners (R)") },
    { tool: "rectCenter", icon: SquareDot, label: msg("Rectangle from centre") },
    { tool: "circle", icon: Circle, label: msg("Circle: centre, then radius (C)") },
    { tool: "arc3", icon: SkArc3, label: msg("Arc through 3 points: start, end, then a point on it (A)") },
    { tool: "arcCenter", icon: SkArcCenter, label: msg("Arc from centre: centre, start, end") },
    { tool: "arcTangent", icon: SkArcTangent, label: msg("Tangent arc: start at the end of a line or arc") },
    { tool: "slot", icon: SkSlot, label: msg("Slot: two centres, then width") },
    { tool: "polygon", icon: Hexagon, label: msg("Polygon: centre, then a corner (G)") },
    { tool: "spline", icon: Spline, label: msg("Spline through points (N); Enter or double-click ends") },
    { tool: "point", icon: Dot, label: msg("Point (P)") },
    { tool: "text", icon: Type, label: msg("Text (X)") },
  ],
  [
    { tool: "trim", icon: Scissors, label: msg("Trim: click a piece to remove it (T)") },
    { tool: "fillet", icon: SkFillet, label: msg("Fillet: click a corner (F)") },
    { tool: "chamfer", icon: SkChamfer, label: msg("Chamfer: click a corner") },
    { tool: "offset", icon: SkOffset, label: msg("Offset: click a shape, then the side (O)") },
    { tool: "mirror", icon: FlipHorizontal2, label: msg("Mirror: select geometry, then click the mirror line (M)") },
    { tool: "linearPattern", icon: LayoutGrid, label: msg("Linear / grid pattern of the selection") },
    { tool: "circularPattern", icon: SkCircularPattern, label: msg("Circular pattern of the selection: click the centre") },
  ],
  [{ tool: "dimension", icon: RulerDimensionLine, label: msg("Dimension (D): click geometry, then where the value goes; double-click a value to edit it") }],
];

const CONSTRAINTS: { c: ConstraintTool; icon: LucideIcon; label: string }[] = [
  { c: "coincident", icon: CnCoincident, label: msg("Coincident: two points, or a point on a line/circle") },
  { c: "horizontal", icon: CnHorizontal, label: msg("Horizontal: lines, or two points") },
  { c: "vertical", icon: CnVertical, label: msg("Vertical: lines, or two points") },
  { c: "parallel", icon: CnParallel, label: msg("Parallel: two lines") },
  { c: "perpendicular", icon: CnPerpendicular, label: msg("Perpendicular: two lines") },
  { c: "tangent", icon: CnTangent, label: msg("Tangent: line and circle/arc, or two circles/arcs") },
  { c: "equal", icon: Equal, label: msg("Equal: two lines (length) or two circles/arcs (radius)") },
  { c: "midpoint", icon: CnMidpoint, label: msg("Midpoint: a point and a line") },
  { c: "concentric", icon: CnConcentric, label: msg("Concentric: two circles/arcs") },
  { c: "symmetric", icon: CnSymmetric, label: msg("Symmetric: two points and a line") },
  { c: "fix", icon: Pin, label: msg("Fix: pin the selected points/geometry in place (again to release)") },
];

const CONSTRAINT_NAME: Record<ConstraintType, string> = {
  coincident: msg("coincident"),
  pointOnLine: msg("point on line"),
  pointOnCircle: msg("point on curve"),
  horizontal: msg("horizontal"),
  vertical: msg("vertical"),
  horizontalPts: msg("horizontal"),
  verticalPts: msg("vertical"),
  parallel: msg("parallel"),
  perpendicular: msg("perpendicular"),
  tangent: msg("tangent"),
  equal: msg("equal"),
  midpoint: msg("midpoint"),
  concentric: msg("concentric"),
  symmetric: msg("symmetric"),
  fix: msg("fix"),
  distance: msg("distance"),
  distanceX: msg("horizontal distance"),
  distanceY: msg("vertical distance"),
  pointLineDistance: msg("distance to line"),
  radius: msg("radius"),
  diameter: msg("diameter"),
  angle: msg("angle"),
};

/** The sketch's name; double-click to rename (kept on Finish). */
function SketchName(props: { name: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <span class="ws-sketch-name">
      <SketchSheet size={16} strokeWidth={1.75} aria-hidden="true" />
      {editing ? (
        <InlineNameField value={props.name} label={t("Sketch name")} onCommit={renameSketch} onDone={() => setEditing(false)} />
      ) : (
        <b title={t("Double-click to rename")} onDblClick={() => setEditing(true)}>
          {props.name}
        </b>
      )}
    </span>
  );
}

export function SketchToolbar() {
  const s = session.value;
  if (!s) return null;
  const st = s.status;
  const problems = [...new Set([...st.conflicting, ...(st.redundant ?? [])])];
  const statusText = !s.sketch.entities.length ? t("Empty sketch") : !st.ok ? t("Conflict") : problems.length ? t("Overconstrained") : st.dof === 0 ? t("Fully defined") : tp(["{n} degree of freedom", "{n} degrees of freedom"], st.dof);
  return (
    <div class="ws-toolbar ws-sketchbar">
      <IconButton icon={Check} class="ws-primary" label={t("Finish the sketch (keeps your changes as one undo step)")} onClick={() => finishSketch(true)} />
      <IconButton icon={X} label={t("Cancel: discard the changes to this sketch")} onClick={cancelSketch} />
      <SketchName name={s.name} />
      <span class="ws-sep" />
      <IconButton icon={Undo2} label={t("Sketch undo (⌘Z)")} disabled={!s.undo.length} onClick={() => (undoSketch(), resetTool())} />
      <IconButton icon={Redo2} label={t("Sketch redo (⇧⌘Z)")} disabled={!s.redo.length} onClick={() => (redoSketch(), resetTool())} />
      {TOOLS.map((group, i) => (
        <>
          <span class="ws-sep" key={`sep${i}`} />
          {group.map((tl) => (
            <IconButton
              key={tl.tool}
              icon={tl.icon}
              label={t(tl.label)}
              pressed={s.tool === tl.tool}
              onClick={() => {
                resetTool();
                setTool(tl.tool);
              }}
            />
          ))}
        </>
      ))}
      <IconButton icon={SkConstruction} label={`${t("Construction (Q): toggle the selection, or draw new geometry as construction")}${s.construction ? ` (${t("on")})` : ""}`} pressed={s.construction} onClick={toggleConstruction} />
      <span class="ws-sep" />
      {CONSTRAINTS.map((c) => (
        <IconButton key={c.c} icon={c.icon} label={t(c.label)} disabled={!s.selected.size} onClick={() => constrainSelected(c.c)} />
      ))}
      <ToolOptions tool={s.tool} />
      <span class="ws-grow" />
      <ScaleNote mat={s.mat} />
      <span class={`ws-sketch-status ${!st.ok || problems.length ? "bad" : st.dof === 0 && s.sketch.entities.length ? "ok" : ""}`} title={t("Blue: free to move · black: fully defined · red: conflicting or redundant constraints")}>
        {statusText}
      </span>
      {problems.map((id) => {
        const c = s.sketch.constraints.find((item) => item.id === id);
        return c && <button type="button" class="ws-sketch-conflict" key={id} title={t("Select this conflicting or redundant constraint, then press Delete")} onClick={() => patchConflictSelection(id)}>{t(CONSTRAINT_NAME[c.type])} ({id})</button>;
      })}
      {preview.value.hint && <small class="ws-sketch-hint">{preview.value.hint}</small>}
    </div>
  );
}

function patchConflictSelection(id: string): void {
  const s = session.value;
  if (s) session.value = { ...s, selected: new Set([id]), tool: "select" };
}

/** A scaled sketch keeps its own dimensions; say what size it will cut at. */
function ScaleNote({ mat }: { mat: readonly number[] }) {
  const pct = (v: number) => Math.round(v * 10000) / 100;
  const sx = pct(Math.hypot(mat[0]!, mat[1]!));
  const sy = pct(Math.hypot(mat[2]!, mat[3]!));
  if (Math.abs(sx - 100) < 0.01 && Math.abs(sy - 100) < 0.01) return null;
  return (
    <span class="ws-sketch-scaled" title={t("The dimensions here are the sketch's own. It is placed at this scale and cuts at it; change the scale in Position & size.")}>
      {t("Scaled {scale}", { scale: sx === sy ? `${sx} %` : `${sx} × ${sy} %` })}
    </span>
  );
}

/** Count fields for the polygon and pattern tools. */
function ToolOptions({ tool }: { tool: Tool }) {
  const o = toolOptions.value;
  const set = (patch: Partial<typeof o>) => (toolOptions.value = { ...o, ...patch });
  const field = (label: string, value: number, min: number, onCommit: (v: number) => void) => (
    <NumberInput class="ws-sketch-count" value={value} label={label} step={1} min={min} max={100} decimals={0} onCommit={(v) => onCommit(Math.round(v))} onInvalid={(m) => notify(m, "error")} />
  );
  if (tool === "polygon") return <span class="ws-sketch-opts">{t("Sides")} {field(t("Number of sides"), o.sides, 3, (v) => set({ sides: v }))}</span>;
  if (tool === "linearPattern")
    return (
      <span class="ws-sketch-opts">
        {t("Copies")} {field(t("Copies in the first direction (the original included)"), o.count1, 1, (v) => set({ count1: v }))} ×{" "}
        {field(t("Copies in the second direction (1 for a single row)"), o.count2, 1, (v) => set({ count2: v }))}
      </span>
    );
  if (tool === "circularPattern") return <span class="ws-sketch-opts">{t("Copies")} {field(t("Copies around the circle (the original included)"), o.countC, 2, (v) => set({ countC: v }))}</span>;
  return null;
}

const MORE_FONTS = "\u0001more-fonts";

/** Words, size, angle and font for the text being edited, under its start point. */
export function TextEditor() {
  const ed = editingText.value;
  const s = session.value;
  const ref = useRef<HTMLInputElement>(null);
  const [families, setFamilies] = useState<string[] | null>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [ed?.id]);
  if (!ed || !s) return null;
  const e = s.sketch.entities.find((x) => x.id === ed.id);
  if (!e || e.kind !== "text") return null;
  const a = s.sketch.points[e.anchor];
  if (!a) return null;
  const at = applyMat(sketchScreenMat(view.value, s.mat), a);
  const fonts = [...new Set([DEFAULT_FONT, e.font, ...(families ?? [])])];
  return (
    <div
      class="ws-text-editor"
      style={{ left: `${at.x}px`, top: `${at.y + 8}px` }}
      onPointerDown={(ev) => ev.stopPropagation()}
      onKeyDown={(ev) => {
        if (ev.key === "Escape") closeTextEditor(false);
        if (ev.key === "Enter" && (ev.target as HTMLElement).tagName !== "SELECT") closeTextEditor(true);
        ev.stopPropagation();
      }}
    >
      <input ref={ref} class="ws-text-words" value={e.text} aria-label={t("Text")} onInput={(ev) => updateText({ text: (ev.target as HTMLInputElement).value })} />
      <label title={t("Cap height (mm)")}>
        H <NumberInput value={e.size} label={t("Text height in mm (capital letters)")} min={0.1} max={1000} onCommit={(v) => updateText({ size: v })} onInvalid={(m) => notify(m, "error")} />
      </label>
      <label title={t("Angle (degrees, counter-clockwise)")}>
        ∠ <NumberInput value={e.angle} label={t("Text angle in degrees")} min={-360} max={360} onCommit={(v) => updateText({ angle: v })} onInvalid={(m) => notify(m, "error")} />
      </label>
      <select
        value={e.font}
        aria-label={t("Font")}
        onChange={(ev) => {
          const v = (ev.target as HTMLSelectElement).value;
          if (v === MORE_FONTS) void localFontFamilies().then((f) => (f.length ? setFamilies(f) : notify(t("This browser can't list the computer's fonts (Chrome can, with permission)."), "warn")));
          else updateText({ font: v });
        }}
      >
        {fonts.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        {!families && canListLocalFonts() && <option value={MORE_FONTS}>{t("More fonts on this computer…")}</option>}
      </select>
      <IconButton icon={Check} label={t("Done (Enter)")} onClick={() => closeTextEditor(true)} />
    </div>
  );
}

/** Text box over a dimension label while its value is being edited (Enter applies, Esc keeps it as it was). */
export function DimensionEditor() {
  const id = editingDimension.value;
  const suggestion = editingSuggestion.value;
  const s = session.value;
  const ref = useRef<HTMLDivElement>(null);
  const proposed = suggestion ? dimensionSuggestions.value[suggestion.index] : undefined;
  const c = s && proposed
    ? { ...proposed, id: "__suggestion__", value: measure(s.sketch, proposed.type, proposed.refs) }
    : s?.sketch.constraints.find((x) => x.id === id);
  // Over the label: its drawn box when there is one, else where the label goes (anchor + offset), so the box
  // shows at once for a dimension the canvas hasn't drawn yet.
  const pos = (() => {
    if (!c || !s) return null;
    const h = !suggestion && hitBoxes.find((b) => b.id === id);
    if (h) return { x: h.x + h.w / 2, y: h.y + h.h / 2 };
    const a = dimensionAnchor(s.sketch, c);
    return applyMat(sketchScreenMat(view.value, s.mat), { x: a.x + (c.offset?.x ?? 0), y: a.y + (c.offset?.y ?? 0) });
  })();
  useLayoutEffect(() => {
    const input = id || suggestion ? ref.current?.querySelector("input") : null;
    input?.focus();
    if (suggestion && input) input.setSelectionRange(input.value.length, input.value.length);
    else input?.select();
  }, [id, suggestion]);
  if ((!id && !suggestion) || !s || !pos) return null;
  if (!c || c.value === undefined) return null;
  const sign = c.type === "distanceX" || c.type === "distanceY" ? Math.sign(c.value) || 1 : 1;
  const apply = (v: number) => {
    if ((c.type === "radius" || c.type === "diameter" || c.type.startsWith("distance") || c.type === "pointLineDistance") && v <= 0) {
      notify(t("A size must be greater than 0."), "error");
      return;
    }
    if (suggestion && proposed) {
      if (!dimensionCanDrive(s.sketch, proposed)) {
        notify(t("This dimension is already constrained and cannot be changed."), "warn");
        return;
      }
      const next = addConstraint(s.sketch, { ...proposed, value: v * sign }).s;
      const result = solve(next);
      if (!result.ok) {
        notify(t("That dimension conflicts with existing constraints."), "warn");
        return;
      }
      setSketch(next);
      dimensionSuggestions.value = dimensionSuggestions.value.filter((_, index) => index !== suggestion.index);
      editingSuggestion.value = null;
    } else {
      // Hidden dimensions linked to this one (an offset's other sides) follow its value.
      setSketch({ ...s.sketch, constraints: s.sketch.constraints.map((x) => (x.id === id || x.link === id ? { ...x, value: v * sign } : x)) });
    }
    editingDimension.value = null;
    document.querySelector<HTMLCanvasElement>(".ws-canvas-wrap canvas")?.focus();
  };
  return (
    <div
      ref={ref}
      class="ws-dim-editor"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          editingDimension.value = null;
          editingSuggestion.value = null;
          document.querySelector<HTMLCanvasElement>(".ws-canvas-wrap canvas")?.focus();
        }
      }}
      onFocusOut={() => setTimeout(() => {
        if (editingDimension.value === id) editingDimension.value = null;
        if (editingSuggestion.value === suggestion) editingSuggestion.value = null;
      }, 0)}
    >
      <NumberInput key={id ?? `suggestion-${suggestion?.index}`} value={Math.abs(c.value)} initialText={suggestion?.initial} commitOnEnter commitOnBlur={!suggestion} label={t("Dimension value")} onCommit={apply} onInvalid={(m) => notify(m, "error")} />
    </div>
  );
}
