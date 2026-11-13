// Picture → traced vector paths: adjust, threshold (black & white) or reduce colours, trace each colour with
// Potrace, scale to mm. Pure; runs in a worker (worker.ts) so the import dialog stays responsive.
import { msg } from "../../i18n";
import { SMOOTH_MM, segmentCount, smoothImport } from "../smooth";
import type { Rgba, VecPath, VectorImport } from "../types";
import { dilate, fillHoles, joinPolylines, pad, skeletonPaths, thin } from "./morph";
import { adjust, otsu, threshold, toGray } from "./preprocess";
import { trace } from "./potrace";
import { mask, quantize } from "./quantize";

export interface TraceSettings {
  /** "bw": one colour from a brightness threshold; "color": up to `colors` colours, each traced on its own. */
  mode: "bw" | "color";
  /** 0–255, or null for automatic (Otsu). Black & white only. */
  threshold: number | null;
  colors: number;
  invert: boolean;
  brightness: number;
  contrast: number;
  /** Blur radius in px before tracing (smooths noise and JPEG artefacts). */
  blur: number;
  /** Colour mode: leave the white background out. */
  ignoreWhite: boolean;
  /** Drop specks up to this many px². */
  turdSize: number;
  /** Corner smoothing, Potrace alphamax: 0 sharp corners … 1.33 all smooth. */
  smoothness: number;
  /** Outline smoothing after tracing, mm (0 = off): removes leftover stair-steps and wobble smaller than this. */
  smoothMm: number;
  /** Keep sharp corners while smoothing. */
  keepCorners: boolean;
  /** Traced shapes become engraved areas (fill) or outlines to cut. Centre lines are always lines. */
  result: "engrave" | "cut";
  /** outline: trace around each shape; centerline: thin strokes become single open lines (one score pass). */
  lines: "outline" | "centerline";
  /** Add a cut line around the whole design, `stickerMarginMm` outside it, with its holes filled (sticker style). */
  sticker: boolean;
  stickerMarginMm: number;
  /** Black & white: ink is dark pixels (brightness) or the picture's opaque pixels (alpha, for cut-out pictures). */
  source: "brightness" | "alpha";
  /** Colour mode: a plain backdrop colour to leave out besides white (from analyzeImage). */
  background?: [number, number, number] | null;
  /** Millimetres per pixel of `rgba`. */
  mmPerPx: number;
}

export const DEFAULT_TRACE: Omit<TraceSettings, "mmPerPx"> = {
  mode: "bw",
  threshold: null,
  colors: 4,
  invert: false,
  brightness: 0,
  contrast: 0,
  blur: 0,
  ignoreWhite: true,
  turdSize: 4,
  smoothness: 1,
  smoothMm: SMOOTH_MM.light,
  keepCorners: true,
  result: "engrave",
  lines: "outline",
  sticker: false,
  stickerMarginMm: 1.5,
  source: "brightness",
};

/** Colour of the sticker cut line in the traced result (snaps to the red layer unless that one engraves). */
export const STICKER_COLOR = "#ff0000";

export interface TraceResult extends VectorImport {
  /** The threshold actually used (black & white), for the slider. */
  level: number | null;
  /** Segment count before and after smoothing. */
  segments: { before: number; after: number };
}

export function traceImage(img: Rgba, s: TraceSettings): TraceResult {
  const { width: w, height: h } = img;
  const k = s.mmPerPx;
  const opts = { turdSize: s.turdSize, alphaMax: s.smoothness, optCurve: true, optTolerance: 0.2, tolerancePx: Math.max(0.1, 0.02 / k) };
  const paths: VecPath[] = [];
  const all = new Uint8Array(w * h); // every traced pixel, for the sticker outline
  const emit = (bits: Uint8Array, color: string) => {
    for (let i = 0; i < bits.length; i++) if (bits[i]) all[i] = 1;
    if (s.lines === "centerline") {
      // Whiskers shorter than about a stroke width come from thinning corners, not from the drawing.
      const lines = joinPolylines(skeletonPaths(thin(bits, w, h), w, h, Math.max(3, strokeWidth(bits, w, h) * 1.5)));
      for (const l of lines) {
        if (l.points.length < 2) continue;
        paths.push({ points: l.points.map((p) => ({ x: p.x * k, y: p.y * k })), closed: l.closed, stroke: color, fill: null });
      }
      return;
    }
    for (const tp of trace(bits, w, h, opts)) {
      if (tp.points.length < 3) continue;
      const points = tp.points.map((p) => ({ x: p.x * k, y: p.y * k }));
      paths.push({ points, closed: true, stroke: s.result === "cut" ? color : null, fill: s.result === "engrave" ? color : null });
    }
  };
  let level: number | null = null;
  if (s.mode === "bw") {
    if (s.source === "alpha") {
      const bits = new Uint8Array(w * h);
      for (let i = 0; i < bits.length; i++) bits[i] = (img.data[i * 4 + 3]! >= 128) !== s.invert ? 1 : 0;
      emit(bits, "#000000");
    } else {
      const gray = adjust(toGray(img), w, h, { brightness: s.brightness, contrast: s.contrast, blur: s.blur, invert: s.invert });
      level = s.threshold ?? otsu(gray);
      emit(threshold(gray, level), "#000000");
    }
  } else {
    // Colour mode traces the picture's own colours; the brightness, contrast, blur and threshold controls are
    // black & white only (the dialog hides them here).
    const q = quantize(img, s.colors, { ignoreWhite: s.ignoreWhite, background: s.background });
    q.palette.forEach((color, i) => emit(mask(q.index, i), color));
  }
  if (s.sticker) paths.push(...stickerOutline(all, w, h, k, s.stickerMarginMm, s.turdSize));
  const before = segmentCount(paths);
  const smoothed = smoothImport({ paths, warnings: [] }, { scale: s.smoothMm, cornerAngle: s.keepCorners ? undefined : 180 }).paths;
  return {
    paths: smoothed,
    warnings: smoothed.length ? [] : [msg("The trace found no shapes: try another threshold, or invert.")],
    level,
    segments: { before, after: segmentCount(smoothed) },
    pageMm: { w: w * k, h: h * k },
  };
}

/** Typical stroke width of the ink in px: 2 × area / perimeter (exact for long straight strokes). */
export function strokeWidth(bits: Uint8Array, w: number, h: number): number {
  let area = 0, perim = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bits[i]) continue;
      area++;
      if (x === 0 || !bits[i - 1]) perim++;
      if (x === w - 1 || !bits[i + 1]) perim++;
      if (y === 0 || !bits[i - w]) perim++;
      if (y === h - 1 || !bits[i + w]) perim++;
    }
  }
  return perim ? (2 * area) / perim : 0;
}

/** One cut line around everything traced, `marginMm` outside it, holes filled; mm, may reach past the picture. */
export function stickerOutline(all: Uint8Array, w: number, h: number, mmPerPx: number, marginMm: number, turdSize: number): VecPath[] {
  const r = Math.max(0, marginMm / mmPerPx);
  const p = Math.ceil(r) + 2;
  const big = pad(all, w, h, p);
  const grown = fillHoles(dilate(big.bits, big.w, big.h, r), big.w, big.h);
  // Specks the trace dropped shouldn't get an outline of their own.
  const minArea = Math.max(turdSize, Math.PI * (r + 1) ** 2 * 1.5);
  return trace(grown, big.w, big.h, { turdSize: minArea, alphaMax: 1, optCurve: true, optTolerance: 0.2, tolerancePx: Math.max(0.1, 0.02 / mmPerPx) })
    .filter((tp) => !tp.hole && tp.points.length >= 3)
    .map((tp) => ({ points: tp.points.map((q) => ({ x: (q.x - p) * mmPerPx, y: (q.y - p) * mmPerPx })), closed: true, stroke: STICKER_COLOR, fill: null }));
}
