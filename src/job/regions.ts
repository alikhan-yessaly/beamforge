// Fill regions (pure): which closed paths of an object lie inside which, the region a click falls in, and the
// rings that make up a filled region (its outline minus the closed paths directly inside it).
import { type Box, type Vec, pathsBox, pointInPolygon } from "../geom/geom";
import type { ScenePath } from "../scene/model";

/** For each path index: the innermost closed path that contains it (-1 if none, or if the path is open). */
export function containment(paths: readonly ScenePath[]): number[] {
  const cached = cache.get(paths);
  if (cached) return cached;
  const closed = paths.map((p, i) => (p.closed && p.points.length >= 3 ? i : -1)).filter((i) => i >= 0);
  const box: Box[] = paths.map((p) => pathsBox([p]));
  const area = paths.map((p) => Math.abs(signedArea(p.points)));
  const parent = paths.map(() => -1);
  for (const i of closed) {
    const b = box[i]!;
    let best = -1;
    for (const j of closed) {
      if (i === j) continue;
      const B = box[j]!;
      if (b.minX < B.minX || b.minY < B.minY || b.maxX > B.maxX || b.maxY > B.maxY) continue;
      if (area[j]! < area[i]!) continue;
      if (area[j] === area[i]) {
        if (j > i) continue; // identical shapes: the lower index counts as the outer one
      } else if (!pointInPolygon(paths[i]!.points[0]!, paths[j]!.points)) continue;
      if (best < 0 || area[j]! < area[best]!) best = j;
    }
    parent[i] = best;
  }
  cache.set(paths, parent);
  return parent;
}
const cache = new WeakMap<readonly ScenePath[], number[]>();

function signedArea(pts: Vec[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]!.x + pts[i]!.x) * (pts[j]!.y - pts[i]!.y);
  return a / 2;
}

/** The innermost closed path whose area contains `p` (local coords), or -1. */
export function regionAt(paths: readonly ScenePath[], p: Vec): number {
  let best = -1;
  let bestArea = Infinity;
  paths.forEach((path, i) => {
    if (!path.closed || path.points.length < 3) return;
    const b = pathsBox([path]);
    if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) return;
    if (!pointInPolygon(p, path.points)) return;
    const a = Math.abs(signedArea(path.points));
    if (a < bestArea) [best, bestArea] = [i, a];
  });
  return best;
}

/** Rings of the region of closed path `i`: its outline and the closed paths directly inside it (even-odd). */
export function regionRings(paths: readonly ScenePath[], i: number): Vec[][] {
  const parent = containment(paths);
  const rings = [paths[i]!.points];
  parent.forEach((par, j) => {
    if (par === i) rings.push(paths[j]!.points);
  });
  return rings;
}
