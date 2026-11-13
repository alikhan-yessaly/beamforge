// @ts-nocheck -- hot pixel loops index typed arrays heavily; noUncheckedIndexedAccess would need a "!" on nearly every access. Covered by tests/trace.test.ts.
// Pure image adjustments applied before thresholding / tracing. No DOM, no allocation per pixel object.
import type { Rgba } from "../types";

export interface AdjustOptions {
  /** -100..100, added to the grey level (100 = +255). */
  brightness: number;
  /** -100..100, scales contrast around mid grey. */
  contrast: number;
  /** Box blur radius in pixels; 0 = none. */
  blur: number;
  invert: boolean;
}

/** Luminance 0..255 per pixel, with alpha composited over white (transparent = paper). */
export function toGray(img: Rgba): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = d[p + 3] / 255;
    const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    out[i] = lum * a + 255 * (1 - a);
  }
  return out;
}

/** Edge-clamped box blur of one row/column pass using a running sum. */
function boxPass(src: Float32Array, dst: Float32Array, len: number, stride: number, lines: number, lineStride: number, r: number): void {
  const win = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = sum / win;
      const add = Math.min(len - 1, i + r + 1);
      const sub = Math.max(0, i - r);
      sum += src[base + add * stride] - src[base + sub * stride];
    }
  }
}

/** Blur, then contrast and brightness, then optional inversion. Returns a new array clamped to 0..255. */
export function adjust(gray: Float32Array, w: number, h: number, opts: AdjustOptions): Float32Array {
  let cur = gray;
  const r = Math.round(opts.blur);
  if (r > 0 && w > 0 && h > 0) {
    const tmp = new Float32Array(gray.length);
    const out = new Float32Array(gray.length);
    boxPass(cur, tmp, w, 1, h, w, r); // horizontal
    boxPass(tmp, out, h, w, w, 1, r); // vertical
    cur = out;
  }
  const c = Math.max(-100, Math.min(100, opts.contrast)) * 2.55;
  // Classic contrast factor; maps c = 0 to 1 and approaches a hard step near +255.
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = Math.max(-100, Math.min(100, opts.brightness)) * 2.55;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < out.length; i++) {
    let v = f * (cur[i] - 128) + 128 + b;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    out[i] = opts.invert ? 255 - v : v;
  }
  return out;
}

/** Otsu's threshold: the level L such that "dark" = gray <= L maximises between-class variance. Ties resolve to the middle. */
export function otsu(gray: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.round(gray[i]);
    hist[v < 0 ? 0 : v > 255 ? 255 : v]++;
  }
  const total = gray.length;
  if (total === 0) return 128;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let first = 0;
  let last = 0;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best + 1e-9) {
      best = between;
      first = last = v;
    } else if (Math.abs(between - best) <= 1e-9) {
      last = v;
    }
  }
  return Math.round((first + last) / 2);
}

/** 1 = ink (gray <= level), 0 = background. */
export function threshold(gray: Float32Array, level: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] <= level ? 1 : 0;
  return out;
}
