import { type Box, type Vec, apply, mul } from "../geom/geom";
import type { Estimate } from "../job/estimate";
import type { Toolpath } from "../job/plan";
import { type Doc, type Layer, type MachineProfile, toUser } from "../scene/model";
import { objectBox } from "../scene/ops";
import { activeLayers } from "../job/layers";
import { type View, toScreen } from "./view";

export interface Overlay {
  selection: ReadonlySet<string>;
  selBox: Box | null;
  hover: string | null;
  marquee: Box | null;
  /** Toolpath preview up to time t (seconds); the design is drawn faded underneath. */
  preview?: { tp: Toolpath; est: Estimate; t: number } | null;
  /** Live head position (internal bed mm) while a job or frame runs. */
  head?: Vec | null;
  /** Sketch mode: draw the other objects faded and skip selection handles. */
  dimObjects?: boolean;
  /** Current-position job origin on the drawing, not a physical machine coordinate. */
  jobOrigin?: Vec | null;
  /** Head projected onto the design during a current-position job. */
  projectedHead?: Vec | null;
}

export const HANDLE = 8;
export const ROTATE_OFFSET = 24;

export function layerStrokeStyle(layer: Pick<Layer, "show" | "output"> | undefined) {
  const shadow = layer?.show === false;
  return { alpha: shadow || layer?.output === false ? 0.5 : 1, dash: shadow ? [2, 4] : [] };
}

const css = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Grid steps (mm) for the current zoom: minor lines >= 7 px apart. */
export function gridSteps(zoom: number): { minor: number; major: number } {
  for (const [minor, major] of [[1, 10], [5, 50], [10, 100], [50, 500], [100, 1000]] as const) {
    if (minor * zoom >= 7) return { minor, major };
  }
  let minor = 500;
  while (minor * zoom < 7) minor *= 10;
  return { minor, major: minor * 10 };
}

/** The 8 scale handles as fractions of the box (x, y) in internal orientation, plus the rotate handle. */
export const HANDLES: [number, number][] = [
  [0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5],
];

export function selectionScreenRect(v: View, b: Box) {
  const a = toScreen(v, { x: b.minX, y: b.minY });
  const c = toScreen(v, { x: b.maxX, y: b.maxY });
  // Pad degenerate (zero-width/height) boxes so handles stay usable.
  const pad = 4;
  return { x0: a.x - pad, y0: a.y - pad, x1: c.x + pad, y1: c.y + pad };
}

export function draw(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, v: View, doc: Doc, p: MachineProfile, ov: Overlay): void {
  const colors = {
    bg: css("--ws-bg", "#e7e9ec"),
    bed: css("--ws-bed", "#ffffff"),
    minor: css("--ws-grid-minor", "#eef0f3"),
    major: css("--ws-grid-major", "#d5d9df"),
    text: css("--ws-text", "#6b7280"),
    sel: css("--ws-select", "#2563eb"),
    out: css("--ws-out", "#dc2626"),
  };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);

  const flipX = p.origin.endsWith("right");
  const flipY = p.origin.startsWith("bottom");
  const { minor, major } = gridSteps(v.zoom);
  ctx.lineWidth = 1;
  ctx.font = "11px system-ui, sans-serif";

  // Bed.
  const b0 = toScreen(v, { x: 0, y: 0 });
  const b1 = toScreen(v, { x: p.bedW, y: p.bedH });
  ctx.fillStyle = colors.bed;
  ctx.fillRect(b0.x, b0.y, b1.x - b0.x, b1.y - b0.y);

  // Grid, counted from the origin corner so labels read as machine coordinates.
  const lines = (count: number, step: number, axis: "x" | "y", color: string, skipMajor: boolean) => {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const u = i * step;
      if (skipMajor && u % major === 0) continue;
      if (axis === "x") {
        const x = Math.round(toScreen(v, { x: flipX ? p.bedW - u : u, y: 0 }).x) + 0.5;
        ctx.moveTo(x, b0.y);
        ctx.lineTo(x, b1.y);
      } else {
        const y = Math.round(toScreen(v, { x: 0, y: flipY ? p.bedH - u : u }).y) + 0.5;
        ctx.moveTo(b0.x, y);
        ctx.lineTo(b1.x, y);
      }
    }
    ctx.stroke();
  };
  lines(Math.floor(p.bedW / minor), minor, "x", colors.minor, true);
  lines(Math.floor(p.bedH / minor), minor, "y", colors.minor, true);
  lines(Math.floor(p.bedW / major), major, "x", colors.major, false);
  lines(Math.floor(p.bedH / major), major, "y", colors.major, false);
  ctx.strokeStyle = colors.major;
  ctx.strokeRect(Math.round(b0.x) + 0.5, Math.round(b0.y) + 0.5, Math.round(b1.x - b0.x), Math.round(b1.y - b0.y));

  // Rulers: labels along the outside of the bed.
  ctx.fillStyle = colors.text;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (let u = 0; u <= p.bedW + 1e-9; u += major) {
    const x = toScreen(v, { x: flipX ? p.bedW - u : u, y: 0 }).x;
    ctx.fillText(String(u), x, b0.y - 4);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let u = 0; u <= p.bedH + 1e-9; u += major) {
    const y = toScreen(v, { x: 0, y: flipY ? p.bedH - u : u }).y;
    ctx.fillText(String(u), b0.x - 5, y);
  }

  // Origin marker.
  const o = toScreen(v, { x: flipX ? p.bedW : 0, y: flipY ? p.bedH : 0 });
  ctx.fillStyle = colors.out;
  ctx.beginPath();
  ctx.arc(o.x, o.y, 5, 0, 2 * Math.PI);
  ctx.fill();
  // Objects.
  ctx.lineJoin = "round";
  const layerSettings = new Map(activeLayers(doc).map((layer) => [layer.color, layer]));
  for (const obj of doc.objects) {
    const m = mul([v.zoom, 0, 0, v.zoom, v.ox, v.oy], obj.mat);
    const selected = ov.selection.has(obj.id);
    const ob = objectBox(obj);
    const outside = ob.minX < -1e-6 || ob.minY < -1e-6 || ob.maxX > p.bedW + 1e-6 || ob.maxY > p.bedH + 1e-6;
    // Batch paths by colour.
    const byColor = new Map<string, typeof obj.paths>();
    for (const path of obj.paths) {
      const list = byColor.get(path.color);
      if (list) list.push(path);
      else byColor.set(path.color, [path]);
    }
    for (const [color, paths] of byColor) {
      ctx.beginPath();
      for (const path of paths) {
        const pts = path.points;
        if (pts.length === 0) continue;
        const s0 = apply(m, pts[0]!);
        ctx.moveTo(s0.x, s0.y);
        for (let i = 1; i < pts.length; i++) {
          const s = apply(m, pts[i]!);
          ctx.lineTo(s.x, s.y);
        }
        if (path.closed) ctx.closePath();
      }
      const style = layerStrokeStyle(layerSettings.get(color));
      const layerMode = layerSettings.get(color)?.mode ?? "cut";
      if (layerMode !== "cut") {
        // Fill layers: tint the area that will be engraved (even-odd, so holes stay clear).
        ctx.fillStyle = color === "#ffffff" ? "#000000" : color;
        ctx.globalAlpha = 0.18 * style.alpha * (ov.preview ? 0.25 : 1);
        ctx.fill("evenodd");
      }
      ctx.strokeStyle = color === "#ffffff" ? "#000000" : color;
      ctx.globalAlpha = style.alpha * (ov.preview ? 0.25 : 1) * (ov.dimObjects ? 0.3 : 1);
      ctx.lineWidth = selected || ov.hover === obj.id ? 2 : 1.25;
      ctx.setLineDash(style.dash);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
    if (outside) {
      const a = toScreen(v, { x: ob.minX, y: ob.minY });
      const c = toScreen(v, { x: ob.maxX, y: ob.maxY });
      ctx.strokeStyle = colors.out;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
      ctx.setLineDash([]);
    }
  }

  ctx.globalAlpha = 1;
  if (ov.preview) drawToolpath(ctx, v, ov.preview.tp, ov.preview.est, ov.preview.t, colors.out);
  if (ov.jobOrigin) {
    const origin = toScreen(v, ov.jobOrigin);
    ctx.strokeStyle = "#7c3aed";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 6, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(origin.x - 10, origin.y);
    ctx.lineTo(origin.x + 10, origin.y);
    ctx.moveTo(origin.x, origin.y - 10);
    ctx.lineTo(origin.x, origin.y + 10);
    ctx.stroke();
    ctx.fillStyle = "#6d28d9";
    // The reference is the drawing's corner nearest home, so put the label on the home side: outside the drawing.
    let toLeft = !p.origin.endsWith("right");
    const toTop = !p.origin.startsWith("bottom");
    if (!toLeft && origin.x > w - 130) toLeft = true; // keep it on screen
    if (toLeft && origin.x < 130) toLeft = false;
    ctx.textAlign = toLeft ? "right" : "left";
    ctx.textBaseline = toTop ? "bottom" : "top";
    ctx.fillText("Job reference", origin.x + (toLeft ? -12 : 12), origin.y + (toTop ? -6 : 6));
  }
  if (ov.head) {
    const h = toScreen(v, ov.head);
    ctx.strokeStyle = colors.out;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 7, 0, 2 * Math.PI);
    ctx.moveTo(h.x - 11, h.y);
    ctx.lineTo(h.x + 11, h.y);
    ctx.moveTo(h.x, h.y - 11);
    ctx.lineTo(h.x, h.y + 11);
    ctx.stroke();
  }
  if (ov.projectedHead) {
    const h = toScreen(v, ov.projectedHead);
    ctx.strokeStyle = "#7c3aed";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 7, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = "#6d28d9";
    ctx.textAlign = h.x > w - 130 ? "right" : "left";
    ctx.textBaseline = "top";
    ctx.fillText("On drawing", h.x + (h.x > w - 130 ? -12 : 12), h.y + 6);
  }
  if (ov.preview) return;

  // Selection frame and handles.
  if (ov.selBox) {
    const r = selectionScreenRect(v, ov.selBox);
    ctx.strokeStyle = colors.sel;
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    const cx = (r.x0 + r.x1) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, r.y0);
    ctx.lineTo(cx, r.y0 - ROTATE_OFFSET);
    ctx.stroke();
    ctx.fillStyle = colors.bed;
    for (const [fx, fy] of HANDLES) {
      const x = r.x0 + (r.x1 - r.x0) * fx;
      const y = r.y0 + (r.y1 - r.y0) * fy;
      ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
    }
    ctx.beginPath();
    ctx.arc(cx, r.y0 - ROTATE_OFFSET, HANDLE / 2 + 1, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }

  if (ov.marquee) {
    const a = toScreen(v, { x: ov.marquee.minX, y: ov.marquee.minY });
    const c = toScreen(v, { x: ov.marquee.maxX, y: ov.marquee.maxY });
    ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
    ctx.strokeStyle = colors.sel;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.setLineDash([]);
  }
}

/** Format an internal point in user (machine-origin) coordinates. */
export function formatUser(p: MachineProfile, pt: Vec): string {
  const u = toUser(p, pt);
  return `X ${u.x.toFixed(2)}  Y ${u.y.toFixed(2)} mm`;
}

/** Index of the first segment that ends after time t (binary search over the estimate's end times). */
export function segmentAt(end: Float64Array, t: number): number {
  let lo = 0;
  let hi = end.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (end[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Cuts in their layer colour, travels as thin dashed lines, everything after time t faded, and the head at t. */
function drawToolpath(ctx: CanvasRenderingContext2D, v: View, tp: Toolpath, est: Estimate, t: number, travelColor: string): void {
  const segs = tp.segments;
  if (segs.length === 0) return;
  const cur = Math.min(segmentAt(est.endTimes, t), segs.length);
  // Where the head is inside the current segment (by time, close enough for a preview).
  let head: Vec = toScreen(v, tp.start);
  let frac = 1;
  if (cur < segs.length) {
    const s = segs[cur]!;
    const t0 = cur > 0 ? est.endTimes[cur - 1]! : 0;
    const t1 = est.endTimes[cur]!;
    frac = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    head = toScreen(v, { x: s.x0 + (s.x1 - s.x0) * frac, y: s.y0 + (s.y1 - s.y0) * frac });
  } else {
    const s = segs.at(-1)!;
    head = toScreen(v, { x: s.x1, y: s.y1 });
  }

  const stroke = (from: number, to: number, cut: boolean, layer: number, alpha: number, partial = 1) => {
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const s = segs[i]!;
      if (s.cut !== cut || (cut && s.layer !== layer)) continue;
      const a = toScreen(v, { x: s.x0, y: s.y0 });
      const k = i === to - 1 ? partial : 1;
      const b = toScreen(v, { x: s.x0 + (s.x1 - s.x0) * k, y: s.y0 + (s.y1 - s.y0) * k });
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.globalAlpha = alpha;
    ctx.stroke();
  };

  ctx.lineCap = "round";
  for (let li = 0; li < tp.layers.length; li++) {
    const c = tp.layers[li]!.color;
    ctx.strokeStyle = c === "#ffffff" ? "#000000" : c;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    stroke(cur, segs.length, true, li, 0.15);
    stroke(0, Math.min(cur + 1, segs.length), true, li, 1, frac);
  }
  ctx.strokeStyle = travelColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  stroke(cur, segs.length, false, -1, 0.15);
  stroke(0, Math.min(cur + 1, segs.length), false, -1, 0.8, frac);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  ctx.fillStyle = travelColor;
  ctx.beginPath();
  ctx.arc(head.x, head.y, 4, 0, 2 * Math.PI);
  ctx.fill();
}
