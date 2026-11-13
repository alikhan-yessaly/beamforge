// Picture → traced vector paths: adjust, threshold (black & white) or reduce colours, trace each colour with
// Potrace, scale to mm. Pure; runs in a worker (worker.ts) so the import dialog stays responsive.
import { msg } from "../../i18n";
import { SMOOTH_MM, segmentCount, smoothImport } from "../smooth";
import type { Rgba, VecPath, VectorImport } from "../types";
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
  /** Traced shapes become engraved areas (fill) or outlines to cut. */
  result: "engrave" | "cut";
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
};

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
  const emit = (bits: Uint8Array, color: string) => {
    for (const tp of trace(bits, w, h, opts)) {
      if (tp.points.length < 3) continue;
      const points = tp.points.map((p) => ({ x: p.x * k, y: p.y * k }));
      paths.push({ points, closed: true, stroke: s.result === "cut" ? color : null, fill: s.result === "engrave" ? color : null });
    }
  };
  let level: number | null = null;
  if (s.mode === "bw") {
    const gray = adjust(toGray(img), w, h, { brightness: s.brightness, contrast: s.contrast, blur: s.blur, invert: s.invert });
    level = s.threshold ?? otsu(gray);
    emit(threshold(gray, level), "#000000");
  } else {
    // Colour mode traces the picture's own colours; the brightness, contrast, blur and threshold controls are
    // black & white only (the dialog hides them here).
    const q = quantize(img, s.colors, { ignoreWhite: s.ignoreWhite });
    q.palette.forEach((color, i) => emit(mask(q.index, i), color));
  }
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
