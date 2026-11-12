// 2D geometry in millimetres. Workspace convention: x right, y down, origin at the bed's top-left.

export interface Vec {
  x: number;
  y: number;
}

export interface Polyline {
  points: Vec[];
  closed: boolean;
}

/** Exact geometry behind an imported path (lines, 3-point arcs, circles), for turning it into a sketch. */
export type Seg = { kind: "line"; a: Vec; b: Vec } | { kind: "arc"; a: Vec; m: Vec; b: Vec } | { kind: "circle"; c: Vec; r: number };

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Affine matrix [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f (same layout as Canvas setTransform). */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  // m ∘ n (apply n first, then m)
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy: number = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

export function apply(m: Mat, p: Vec): Vec {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error("Singular matrix");
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
export const isEmptyBox = (b: Box) => !(b.minX <= b.maxX && b.minY <= b.maxY);

export function addPoint(b: Box, p: Vec): void {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

export function unionBox(a: Box, b: Box): Box {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function pathsBox(paths: Polyline[], m: Mat = IDENTITY): Box {
  const b = emptyBox();
  for (const p of paths) for (const pt of p.points) addPoint(b, apply(m, pt));
  return b;
}

export function transformPaths(paths: Polyline[], m: Mat): Polyline[] {
  return paths.map((p) => ({ closed: p.closed, points: p.points.map((pt) => apply(m, pt)) }));
}

/** Distance from p to segment ab. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pathLength(p: Polyline): number {
  let len = 0;
  const pts = p.points;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  if (p.closed && pts.length > 1) len += Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y);
  return len;
}

/** Even-odd point-in-polygon test (the polygon is implicitly closed). */
export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
