// @ts-nocheck -- hot pixel loops index typed arrays heavily; noUncheckedIndexedAccess would need a "!" on nearly every access. Covered by tests/trace.test.ts.
// Colour reduction for colour tracing: k-means (k-means++ seeding, fixed seed) on a subsample, then every pixel is assigned.
import type { Rgba } from "../types";

export interface Quantized {
  /** "#rrggbb" lower case, most common colour first. */
  palette: string[];
  /** Palette index per pixel; 255 = transparent or ignored background. */
  index: Uint8Array;
}

const hex = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

/** Small deterministic PRNG (mulberry32) so the same image always gives the same palette. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantize(img: Rgba, colors: number, opts: { ignoreWhite?: boolean } = {}): Quantized {
  const n = img.width * img.height;
  const d = img.data;
  const index = new Uint8Array(n).fill(255);
  const k = Math.max(1, Math.min(16, Math.round(colors)));

  // Subsample opaque pixels (at most ~20k) so seeding and iterations stay fast on big images.
  let opaque = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] >= 128) opaque++;
  if (opaque === 0) return { palette: [], index };
  const stride = Math.max(1, Math.floor(opaque / 20000));
  const sr: number[] = [];
  const sg: number[] = [];
  const sb: number[] = [];
  let seen = 0;
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] < 128) continue;
    if (seen++ % stride === 0) {
      sr.push(d[i * 4]);
      sg.push(d[i * 4 + 1]);
      sb.push(d[i * 4 + 2]);
    }
  }
  const m = sr.length;
  const rand = rng(0x5eed1234);

  // k-means++ seeding; stops early when every sample already coincides with a centre (fewer distinct colours than k).
  const cr: number[] = [];
  const cg: number[] = [];
  const cb: number[] = [];
  const dist = new Float64Array(m).fill(Infinity);
  let pick = Math.floor(rand() * m);
  while (cr.length < k) {
    cr.push(sr[pick]);
    cg.push(sg[pick]);
    cb.push(sb[pick]);
    let total = 0;
    for (let i = 0; i < m; i++) {
      const dr = sr[i] - sr[pick];
      const dg = sg[i] - sg[pick];
      const db = sb[i] - sb[pick];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < dist[i]) dist[i] = dd;
      total += dist[i];
    }
    if (total <= 0) break;
    let target = rand() * total;
    pick = m - 1;
    for (let i = 0; i < m; i++) {
      target -= dist[i];
      if (target <= 0 && dist[i] > 0) {
        pick = i;
        break;
      }
    }
    if (dist[pick] === 0) {
      // Rounding fell on an already-covered sample: take the farthest one instead.
      let far = 0;
      for (let i = 1; i < m; i++) if (dist[i] > dist[far]) far = i;
      pick = far;
    }
  }
  const kk = cr.length;

  // Lloyd iterations on the sample.
  const assign = new Uint8Array(m);
  for (let it = 0; it < 14; it++) {
    const acc = new Float64Array(kk * 4);
    let moved = 0;
    for (let i = 0; i < m; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const dr = sr[i] - cr[c];
        const dg = sg[i] - cg[c];
        const db = sb[i] - cb[c];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      if (assign[i] !== best) moved++;
      assign[i] = best;
      acc[best * 4] += sr[i];
      acc[best * 4 + 1] += sg[i];
      acc[best * 4 + 2] += sb[i];
      acc[best * 4 + 3]++;
    }
    for (let c = 0; c < kk; c++) {
      const cnt = acc[c * 4 + 3];
      if (cnt > 0) {
        cr[c] = acc[c * 4] / cnt;
        cg[c] = acc[c * 4 + 1] / cnt;
        cb[c] = acc[c * 4 + 2] / cnt;
      }
    }
    if (it > 0 && moved === 0) break;
  }
  // Round centres to bytes first so assignment and palette agree exactly.
  for (let c = 0; c < kk; c++) {
    cr[c] = Math.round(cr[c]);
    cg[c] = Math.round(cg[c]);
    cb[c] = Math.round(cb[c]);
  }

  // Assign every pixel; a tiny cache skips the search for runs of equal colour.
  const raw = new Uint8Array(n).fill(255);
  const counts = new Float64Array(kk);
  let lastKey = -1;
  let lastC = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (d[p + 3] < 128) continue;
    const key = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
    if (key !== lastKey) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < kk; c++) {
        const dr = d[p] - cr[c];
        const dg = d[p + 1] - cg[c];
        const db = d[p + 2] - cb[c];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      lastKey = key;
      lastC = best;
    }
    raw[i] = lastC;
    counts[lastC]++;
  }

  // Background: the cluster nearest white, if it really is near white (otherwise there is no paper colour to drop).
  let bg = -1;
  if (opts.ignoreWhite) {
    let bd = Infinity;
    for (let c = 0; c < kk; c++) {
      const dd = (255 - cr[c]) ** 2 + (255 - cg[c]) ** 2 + (255 - cb[c]) ** 2;
      if (dd < bd) {
        bd = dd;
        bg = c;
      }
    }
    if (bd > 110 * 110) bg = -1;
  }

  // Keep non-empty clusters, most common first.
  const order: number[] = [];
  for (let c = 0; c < kk; c++) if (c !== bg && counts[c] > 0) order.push(c);
  order.sort((a, b) => counts[b] - counts[a] || a - b);
  const remap = new Uint8Array(kk).fill(255);
  order.forEach((c, i) => (remap[c] = i));
  for (let i = 0; i < n; i++) if (raw[i] !== 255) index[i] = remap[raw[i]];
  const palette = order.map((c) => `#${hex(cr[c])}${hex(cg[c])}${hex(cb[c])}`);
  return { palette, index };
}

/** 1 where the palette index equals value, else 0. */
export function mask(index: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(index.length);
  for (let i = 0; i < index.length; i++) out[i] = index[i] === value ? 1 : 0;
  return out;
}
