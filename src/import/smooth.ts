// Smoothing for imported outlines (SVG, PDF, HPGL, traced pictures). Pure.
//
// Jagged outlines (pixel stair-steps, auto-traced zigzags, noisy edges) make the laser stutter through hundreds of
// tiny moves. For each path:
//  1. find the real corners, judged at the smoothing scale `s` (directions to the points one `s` of arc length
//     before and after a vertex), so a stair-step of steps smaller than `s` isn't a corner but a square corner is;
//  2. between corners, resample evenly and smooth with a Gaussian (σ = s/2), corrected for shrinkage
//     (2·G(P) − G(G(P))), with the corners pinned;
//  3. merge runs of tiny segments into long ones (Douglas–Peucker).
// Closed shapes smaller than `s` (specks) are dropped.
import type { Vec } from "../geom/geom";
import type { VecPath, VectorImport } from "./types";

export type SmoothLevel = "off" | "light" | "medium" | "strong" | "max";

/** Smoothing scale per level, in mm of the finished size. */
export const SMOOTH_MM: Record<SmoothLevel, number> = { off: 0, light: 0.25, medium: 0.5, strong: 1, max: 2 };

export interface SmoothOptions {
  /** Smoothing scale, mm. 0 = only drop duplicate points. */
  scale: number;
  /** Keep corners sharper than this turn (degrees); 180 = smooth everything. */
  cornerAngle?: number;
}

const DEFAULT_CORNER = 50;

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

function dedupe(pts: Vec[], closed: boolean): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1]!, p) > 1e-4) out.push(p);
  if (closed && out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= 1e-4) out.pop();
  return out;
}

/** Cumulative arc length at each vertex (for closed paths, the closing segment comes last). */
function arcLengths(pts: Vec[], closed: boolean): { at: number[]; total: number } {
  const at = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  const total = at[at.length - 1]! + (closed ? dist(pts[pts.length - 1]!, pts[0]!) : 0);
  return { at, total };
}

/** The point at arc length `t` (wrapping for closed paths, clamped for open ones). */
function pointAt(pts: Vec[], closed: boolean, at: number[], total: number, t: number): Vec {
  if (closed) t = ((t % total) + total) % total;
  else t = Math.max(0, Math.min(total, t));
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo]!, b = lo + 1 < pts.length ? pts[lo + 1]! : closed ? pts[0]! : a;
  const len = (lo + 1 < pts.length ? at[lo + 1]! : total) - at[lo]!;
  const u = len > 0 ? (t - at[lo]!) / len : 0;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

/** Indices of corner vertices, judged at scale `s`: turn above `limit` radians and the sharpest within ±s. */
function corners(pts: Vec[], closed: boolean, s: number, limit: number): number[] {
  const { at, total } = arcLengths(pts, closed);
  const n = pts.length;
  const turnAt = (i: number, r: number) => {
    const p = pts[i]!;
    const b = pointAt(pts, closed, at, total, at[i]! - r), f = pointAt(pts, closed, at, total, at[i]! + r);
    const a1 = Math.atan2(p.y - b.y, p.x - b.x), a2 = Math.atan2(f.y - p.y, f.x - p.x);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  // The arms, from s to 2s before and after the vertex, must point in clearly different directions: a real corner
  // has straight-ish arms meeting at an angle, while a stair-step or notch near the vertex leaves the arms in line.
  const armTurn = (i: number) => {
    const P = (d: number) => pointAt(pts, closed, at, total, at[i]! + d);
    const b2 = P(-2 * s), b1 = P(-s), f1 = P(s), f2 = P(2 * s);
    const a1 = Math.atan2(b1.y - b2.y, b1.x - b2.x), a2 = Math.atan2(f2.y - f1.y, f2.x - f1.x);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  const turn = pts.map((_, i) => {
    if (!closed && (at[i]! < s * 0.5 || total - at[i]! < s * 0.5)) return 0;
    const t1 = turnAt(i, s);
    return t1 > limit && armTurn(i) > limit ? t1 : 0;
  });
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i]! <= limit) continue;
    // The sharpest vertex within ±s along the path wins (ties: the first).
    let best = true;
    for (const dir of [-1, 1]) {
      for (let k = 1; k < n; k++) {
        const j = i + dir * k;
        const jj = closed ? (j + n) % n : j;
        if (jj < 0 || jj >= n || jj === i) break;
        const gap = Math.abs(at[jj]! - at[i]!);
        if ((closed ? Math.min(gap, total - gap) : gap) > s) break;
        if (turn[jj]! > turn[i]! || (turn[jj]! === turn[i]! && jj < i)) best = false;
      }
    }
    if (best) out.push(i);
  }
  return out;
}

/** Evenly spaced samples along `pts` (open), keeping both ends. */
function resample(pts: Vec[], step: number): Vec[] {
  const { at, total } = arcLengths(pts, false);
  const n = Math.max(1, Math.round(total / step));
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) out.push(pointAt(pts, false, at, total, (total * i) / n));
  return out;
}

/** Gaussian smoothing of a sample run; `wrap` for a closed loop, otherwise the ends are pinned. */
function gauss(pts: Vec[], sigma: number, wrap: boolean): Vec[] {
  const n = pts.length;
  if (n < 3 || sigma <= 0) return pts;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  return pts.map((p, i) => {
    if (!wrap && (i === 0 || i === n - 1)) return p;
    let sx = 0, sy = 0, sw = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      if (wrap) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const q = pts[j]!;
      const wk = w[k + r]!;
      sx += q.x * wk;
      sy += q.y * wk;
      sw += wk;
    }
    return { x: sx / sw, y: sy / sw };
  });
}

/** Smoothing with the shrinkage corrected: 2·G(P) − G(G(P)). */
function smoothRun(pts: Vec[], sigma: number, wrap: boolean): Vec[] {
  const g = gauss(pts, sigma, wrap);
  const gg = gauss(g, sigma, wrap);
  return g.map((p, i) => (!wrap && (i === 0 || i === g.length - 1) ? p : { x: 2 * p.x - gg[i]!.x, y: 2 * p.y - gg[i]!.y }));
}

/** Douglas–Peucker on an open polyline (both ends kept). */
export function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a]!, B = pts[b]!;
    const len = dist(A, B);
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i]!;
      const d = len > 1e-12 ? Math.abs((B.x - A.x) * (A.y - P.y) - (A.x - P.x) * (B.y - A.y)) / len : dist(A, P);
      if (d > fd) [far, fd] = [i, d];
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** One path smoothed at scale `s` mm. Returns null when a closed shape is smaller than `s` (a speck). */
export function smoothPath(points: Vec[], closed: boolean, opts: SmoothOptions): Vec[] | null {
  const s = opts.scale;
  let pts = dedupe(points, closed);
  if (s <= 0 || pts.length < 3) return pts;
  if (closed) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) [minX, minY, maxX, maxY] = [Math.min(minX, p.x), Math.min(minY, p.y), Math.max(maxX, p.x), Math.max(maxY, p.y)];
    if (Math.max(maxX - minX, maxY - minY) < s) return null;
  }
  const limit = ((opts.cornerAngle ?? DEFAULT_CORNER) * Math.PI) / 180;
  const cs = limit >= Math.PI ? [] : corners(pts, closed, s, limit);
  const step = Math.max(0.005, s / 6);
  const sigma = s / 2 / step; // in samples
  // Fine enough that curves stay round (no visible facets); the smoothing has already removed the jag.
  const tol = Math.max(0.01, Math.min(0.05, s / 10));
  let out: Vec[];
  if (closed && cs.length === 0) {
    const ring = resample([...pts, pts[0]!], step);
    ring.pop(); // the end repeats the start
    const sm = smoothRun(ring, sigma, true);
    // Simplify as two halves so the ring keeps a sensible anchor.
    const half = sm.length >> 1;
    out = [...simplify(sm.slice(0, half + 1), tol).slice(0, -1), ...simplify([...sm.slice(half), sm[0]!], tol).slice(0, -1)];
  } else {
    // Runs between corners (for open paths the ends count as corners).
    if (closed) {
      const k = cs[0]!;
      pts = [...pts.slice(k), ...pts.slice(0, k)];
      const shifted = cs.map((c) => (c - k + pts.length) % pts.length);
      const marks = [...shifted, pts.length];
      pts = [...pts, pts[0]!];
      out = [];
      for (let m = 0; m + 1 < marks.length; m++) {
        const run = pts.slice(marks[m]!, marks[m + 1]! + 1);
        const sm = simplify(smoothRun(resample(run, step), sigma, false), tol);
        out.push(...sm.slice(0, -1));
      }
    } else {
      const marks = [0, ...cs.filter((c) => c > 0 && c < pts.length - 1), pts.length - 1];
      out = [];
      for (let m = 0; m + 1 < marks.length; m++) {
        const run = pts.slice(marks[m]!, marks[m + 1]! + 1);
        const sm = simplify(smoothRun(resample(run, step), sigma, false), tol);
        out.push(...(m === 0 ? sm : sm.slice(1)));
      }
    }
  }
  return out.length >= (closed ? 3 : 2) ? out : closed ? null : pts;
}

/** Segment count of a set of paths. */
export const segmentCount = (paths: readonly VecPath[]) => paths.reduce((n, p) => n + Math.max(0, p.points.length - (p.closed ? 0 : 1)), 0);

/** A whole import smoothed at `scale` mm (in the import's own units). */
export function smoothImport(vi: VectorImport, opts: SmoothOptions): VectorImport {
  if (opts.scale <= 0) return vi;
  const paths: VecPath[] = [];
  for (const p of vi.paths) {
    const pts = smoothPath(p.points, p.closed, opts);
    if (pts && pts.length >= 2) paths.push({ ...p, points: pts });
  }
  return { ...vi, paths };
}

/**
 * How jagged the outlines are: `score` (0–1) is the share of vertices that turn sharply (over 35°) between two
 * short segments (under `short` mm), and `step` the typical length of those segments (the stair-step size), mm.
 * Pixel stair-steps and zigzags score high; clean CAD and smooth curves near 0.
 */
export function jaggedStats(paths: readonly VecPath[], short = 1.2): { score: number; step: number } {
  let n = 0;
  const steps: number[] = [];
  for (const p of paths) {
    const pts = p.points, m = pts.length;
    if (m < 3) continue;
    for (let i = p.closed ? 0 : 1; i < (p.closed ? m : m - 1); i++) {
      const a = pts[(i - 1 + m) % m]!, b = pts[i]!, c = pts[(i + 1) % m]!;
      const l1 = dist(a, b), l2 = dist(b, c);
      if (l1 < 1e-9 || l2 < 1e-9) continue;
      n++;
      if (l1 > short || l2 > short) continue;
      const cos = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l1 * l2);
      if (cos < Math.cos((35 * Math.PI) / 180)) steps.push(Math.min(l1, l2));
    }
  }
  steps.sort((x, y) => x - y);
  return { score: n ? steps.length / n : 0, step: steps.length ? steps[steps.length >> 1]! : 0 };
}

export const jaggedness = (paths: readonly VecPath[], short?: number) => jaggedStats(paths, short).score;

/**
 * The level an import starts with: off for clean outlines; for jagged ones, the lightest level at least 2.5 times
 * the stair-step size (smoothing can only remove steps clearly smaller than its scale).
 */
export function suggestedLevel(paths: readonly VecPath[]): SmoothLevel {
  const { score, step } = jaggedStats(paths);
  if (score <= 0.1) return "off";
  const need = 2.5 * step;
  return (["light", "medium", "strong", "max"] as const).find((l) => SMOOTH_MM[l] >= need) ?? "max";
}
