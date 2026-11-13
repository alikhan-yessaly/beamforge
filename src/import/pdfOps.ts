// PDF page drawing operators (as pdf.js lists them) → flattened paths with colours. Pure, so it is unit-tested
// without pdf.js; src/import/pdf.ts feeds it a real page's operator list.
import { msg } from "../i18n";
import { type Mat, type Vec, apply, mul } from "../geom/geom";
import { FLATTEN_TOLERANCE_MM, type VecPath, type VectorImport } from "./types";

/** The pdf.js operator codes this reader understands (pdfjs-dist `OPS`, looked up by name). */
export interface PdfOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  setStrokeRGBColor: number;
  setFillRGBColor: number;
  setStrokeTransparent?: number;
  setFillTransparent?: number;
  setLineWidth: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  showText: number;
  showSpacedText: number;
  nextLineShowText: number;
  nextLineSetSpacingShowText: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
  endPath: number;
}

/** pdf.js DrawOPS, the path verbs inside a constructPath's data array. */
const MOVE = 0, LINE = 1, CURVE = 2, QUAD = 3, CLOSE = 4;

const PT_MM = 25.4 / 72;

interface GState {
  ctm: Mat;
  stroke: string | null;
  fill: string | null;
}

function hexOf(arg: unknown): string | null {
  if (typeof arg === "string" && /^#[0-9a-f]{6}$/i.test(arg)) return arg.toLowerCase();
  if (Array.isArray(arg) || ArrayBuffer.isView(arg)) {
    const a = Array.from(arg as ArrayLike<number>);
    if (a.length >= 3) return `#${a.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
}

/** Points along a cubic Bézier (excluding p0), so no chord strays more than `tol` from the curve. */
function cubic(out: Vec[], p0: Vec, p1: Vec, p2: Vec, p3: Vec, tol: number, depth = 0): void {
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  const d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  const len2 = dx * dx + dy * dy;
  if (depth > 16 || (d1 + d2) * (d1 + d2) <= tol * tol * 16 * Math.max(len2, 1e-12)) {
    out.push(p3);
    return;
  }
  const m = (a: Vec, b: Vec) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = m(p0, p1), p12 = m(p1, p2), p23 = m(p2, p3), p012 = m(p01, p12), p123 = m(p12, p23), mid = m(p012, p123);
  cubic(out, p0, p01, p012, mid, tol, depth + 1);
  cubic(out, mid, p123, p23, p3, tol, depth + 1);
}

/**
 * Walk a page's operator list. `viewport` maps PDF user space (points, y up) to the page's top-left (points,
 * y down), as pdf.js `page.getViewport({ scale: 1 }).transform` gives it. Output is mm, y down.
 */
export function pdfOperatorsToPaths(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, ops: PdfOps, viewport: Mat, pageMm?: { w: number; h: number }): VectorImport {
  const toMm: Mat = mul([PT_MM, 0, 0, PT_MM, 0, 0], viewport);
  let gs: GState = { ctm: toMm, stroke: "#000000", fill: "#000000" };
  const stack: GState[] = [];
  const paths: VecPath[] = [];
  const warnings = new Set<string>();
  // A path being built (between constructPath and the painting operator).
  let pending: { points: Vec[]; closed: boolean }[] = [];

  const paint = (stroke: boolean, fill: boolean, close: boolean) => {
    for (const sp of pending) {
      if (sp.points.length < 2) continue;
      const closed = sp.closed || close || (fill && sp.points.length > 2);
      const s = stroke ? gs.stroke : null;
      const f = fill && closed ? gs.fill : null;
      if (!s && !f) continue;
      paths.push({ points: sp.points, closed, stroke: s, fill: f });
    }
    pending = [];
  };

  const build = (data: ArrayLike<number>) => {
    const tol = FLATTEN_TOLERANCE_MM; // flattening happens after the transform, so this is in mm already
    let cur: { points: Vec[]; closed: boolean } | null = null;
    let last: Vec = { x: 0, y: 0 };
    let start: Vec = { x: 0, y: 0 };
    const at = (x: number, y: number) => apply(gs.ctm, { x, y });
    for (let i = 0; i < data.length; ) {
      const verb = data[i++]!;
      if (verb === MOVE) {
        last = start = at(data[i]!, data[i + 1]!);
        i += 2;
        cur = { points: [last], closed: false };
        pending.push(cur);
      } else if (verb === LINE) {
        last = at(data[i]!, data[i + 1]!);
        i += 2;
        if (!cur) pending.push((cur = { points: [start], closed: false }));
        cur.points.push(last);
      } else if (verb === CURVE) {
        const p1 = at(data[i]!, data[i + 1]!), p2 = at(data[i + 2]!, data[i + 3]!), p3 = at(data[i + 4]!, data[i + 5]!);
        i += 6;
        if (!cur) pending.push((cur = { points: [last], closed: false }));
        cubic(cur.points, last, p1, p2, p3, tol);
        last = p3;
      } else if (verb === QUAD) {
        const q1 = at(data[i]!, data[i + 1]!), p3 = at(data[i + 2]!, data[i + 3]!);
        i += 4;
        if (!cur) pending.push((cur = { points: [last], closed: false }));
        const c1 = { x: last.x + (2 / 3) * (q1.x - last.x), y: last.y + (2 / 3) * (q1.y - last.y) };
        const c2 = { x: p3.x + (2 / 3) * (q1.x - p3.x), y: p3.y + (2 / 3) * (q1.y - p3.y) };
        cubic(cur.points, last, c1, c2, p3, tol);
        last = p3;
      } else if (verb === CLOSE) {
        if (cur) {
          const a = cur.points[0]!, b = cur.points.at(-1)!;
          if (cur.points.length > 1 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) cur.points.pop();
          cur.closed = true;
          last = start;
        }
        cur = null;
      } else break; // unknown verb: stop rather than misread the rest
    }
  };

  for (let k = 0; k < fnArray.length; k++) {
    const fn = fnArray[k]!;
    const args = argsArray[k] as unknown[] | null;
    switch (fn) {
      case ops.save:
        stack.push(gs);
        gs = { ...gs };
        break;
      case ops.restore:
        gs = stack.pop() ?? gs;
        break;
      case ops.transform:
        gs = { ...gs, ctm: mul(gs.ctm, (args as number[]).slice(0, 6) as Mat) };
        break;
      case ops.paintFormXObjectBegin: {
        stack.push(gs);
        const m = args?.[0] as number[] | null;
        gs = m && m.length >= 6 ? { ...gs, ctm: mul(gs.ctm, Array.from(m).slice(0, 6) as Mat) } : { ...gs };
        break;
      }
      case ops.paintFormXObjectEnd:
        gs = stack.pop() ?? gs;
        break;
      case ops.setStrokeRGBColor:
        gs = { ...gs, stroke: hexOf(args?.[0] ?? args) ?? gs.stroke };
        break;
      case ops.setFillRGBColor:
        gs = { ...gs, fill: hexOf(args?.[0] ?? args) ?? gs.fill };
        break;
      case ops.setStrokeTransparent:
        gs = { ...gs, stroke: null };
        break;
      case ops.setFillTransparent:
        gs = { ...gs, fill: null };
        break;
      case ops.constructPath: {
        // pdf.js ≥ 5: [paintOp, [Float32Array of DrawOPS], minMax]; the painting op is folded in.
        const paintOp = args?.[0] as number;
        const data = (args?.[1] as ArrayLike<number>[] | undefined)?.[0];
        if (data) build(data);
        if (typeof paintOp === "number") paintBy(paintOp);
        break;
      }
      case ops.showText:
      case ops.showSpacedText:
      case ops.nextLineShowText:
      case ops.nextLineSetSpacingShowText:
        warnings.add(msg("Text was skipped: convert text to outlines (curves) before exporting the PDF."));
        break;
      case ops.paintImageXObject:
      case ops.paintInlineImageXObject:
      case ops.paintImageMaskXObject:
        warnings.add(msg("Pictures inside the PDF were skipped; import the picture file itself to trace it."));
        break;
      default:
        paintBy(fn);
    }
  }

  function paintBy(op: number): void {
    if (op === ops.stroke) paint(true, false, false);
    else if (op === ops.closeStroke) paint(true, false, true);
    else if (op === ops.fill || op === ops.eoFill) paint(false, true, true);
    else if (op === ops.fillStroke || op === ops.eoFillStroke) paint(true, true, false);
    else if (op === ops.closeFillStroke || op === ops.closeEOFillStroke) paint(true, true, true);
    else if (op === ops.endPath) pending = [];
  }

  return { paths, warnings: [...warnings], ...(pageMm ? { pageMm } : {}) };
}
