// @ts-nocheck -- hot pixel loops index typed arrays heavily; noUncheckedIndexedAccess would need a "!" on nearly every access. Covered by tests/trace.test.ts.
// Port of Peter Selinger's Potrace (1.16) bitmap tracer, following the structure of the JS port by kilobtye.
// Stages: path decomposition -> optimal polygon -> vertex adjustment -> smoothing -> optional curve optimisation.
// Pixel-level stages use typed arrays; only the per-path curve stages (a few vertices) use small objects.
import type { Vec } from "../../geom/geom";

export type TurnPolicy = "minority" | "majority" | "black" | "white" | "left" | "right";

export interface TraceOptions {
  /** Drop paths whose area is <= this many pixels (despeckle). */
  turdSize: number;
  turnPolicy: TurnPolicy;
  /** Corner threshold: 0 = all corners, 1.334 = no corners. */
  alphaMax: number;
  optCurve: boolean;
  optTolerance: number;
  /** Max chord deviation when flattening Béziers, in pixels. */
  tolerancePx: number;
}

export interface TracedPath {
  /** Closed outline in pixel coordinates (x right, y down, pixel edges on integers); no repeated closing point. */
  points: Vec[];
  hole: boolean;
}

const DEFAULTS: TraceOptions = { turdSize: 2, turnPolicy: "minority", alphaMax: 1, optCurve: true, optTolerance: 0.2, tolerancePx: 0.25 };
const COS179 = Math.cos((179 * Math.PI) / 180);

const mod = (a: number, n: number): number => (a >= n ? a % n : a >= 0 ? a : n - 1 - ((-1 - a) % n));
const sgn = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
/** True when b lies in the cyclic interval [a, c). */
const cyclic = (a: number, b: number, c: number): boolean => (a <= c ? a <= b && b < c : a <= b || b < c);

// ---------------------------------------------------------------- 1. path decomposition

interface RawPath {
  xs: Int32Array;
  ys: Int32Array;
  hole: boolean;
}

function decompose(bits: Uint8Array, w: number, h: number, policy: TurnPolicy, turdSize: number): RawPath[] {
  const size = w * h;
  const orig = new Uint8Array(size);
  for (let i = 0; i < size; i++) orig[i] = bits[i] ? 1 : 0;
  // bm1 is the working copy: each traced outline is XOR-filled so the next find sees only unprocessed ink.
  const bm1 = orig.slice();
  const at = (x: number, y: number): number => (x >= 0 && y >= 0 && x < w && y < h ? bm1[y * w + x] : 0);

  const majority = (x: number, y: number): boolean => {
    for (let i = 2; i < 5; i++) {
      let ct = 0;
      for (let a = -i + 1; a <= i - 1; a++) {
        ct += at(x + a, y + i - 1) ? 1 : -1;
        ct += at(x + i - 1, y + a - 1) ? 1 : -1;
        ct += at(x + a - 1, y - i) ? 1 : -1;
        ct += at(x - i, y + a) ? 1 : -1;
      }
      if (ct > 0) return true;
      if (ct < 0) return false;
    }
    return false;
  };

  let bx = new Int32Array(4096);
  let by = new Int32Array(4096);
  const out: RawPath[] = [];
  let idx = 0;
  for (;;) {
    while (idx < size && bm1[idx] !== 1) idx++;
    if (idx >= size) break;
    const sx = idx % w;
    const sy = (idx - sx) / w;
    const plus = orig[idx] === 1;
    let x = sx;
    let y = sy;
    let dx = 0;
    let dy = 1;
    let len = 0;
    let area = 0;
    let maxX = sx;
    for (;;) {
      if (len === bx.length) {
        const nx = new Int32Array(len * 2);
        nx.set(bx);
        bx = nx;
        const ny = new Int32Array(len * 2);
        ny.set(by);
        by = ny;
      }
      bx[len] = x;
      by[len] = y;
      len++;
      if (x > maxX) maxX = x;
      x += dx;
      y += dy;
      area -= x * dy;
      if (x === sx && y === sy) break;
      const l = at(x + ((dx + dy - 1) >> 1), y + ((dy - dx - 1) >> 1));
      const r = at(x + ((dx - dy - 1) >> 1), y + ((dy + dx - 1) >> 1));
      if (r && !l) {
        const pickLeft =
          policy === "right" ||
          (policy === "black" && plus) ||
          (policy === "white" && !plus) ||
          (policy === "majority" && majority(x, y)) ||
          (policy === "minority" && !majority(x, y));
        const tmp = dx;
        if (pickLeft) {
          dx = -dy;
          dy = tmp;
        } else {
          dx = dy;
          dy = -tmp;
        }
      } else if (r) {
        const tmp = dx;
        dx = -dy;
        dy = tmp;
      } else if (!l) {
        const tmp = dx;
        dx = dy;
        dy = -tmp;
      }
    }
    // XOR-fill the interior: flip every row span right of each vertical edge.
    let y1 = by[0];
    for (let i = 1; i < len; i++) {
      const px = bx[i];
      const py = by[i];
      if (py !== y1) {
        const row = (y1 < py ? y1 : py) * w;
        for (let j = px; j < maxX; j++) bm1[row + j] ^= 1;
        y1 = py;
      }
    }
    if (area > turdSize) out.push({ xs: bx.slice(0, len), ys: by.slice(0, len), hole: !plus });
  }
  return out;
}

// ---------------------------------------------------------------- 2. optimal polygon

/** Prefix sums (x, y, xy, x2, y2 relative to the first point) laid out 5 per entry, n + 1 entries. */
function calcSums(xs: Int32Array, ys: Int32Array): Float64Array {
  const n = xs.length;
  const s = new Float64Array(5 * (n + 1));
  const x0 = xs[0];
  const y0 = ys[0];
  for (let i = 0; i < n; i++) {
    const x = xs[i] - x0;
    const y = ys[i] - y0;
    const a = i * 5;
    const b = a + 5;
    s[b] = s[a] + x;
    s[b + 1] = s[a + 1] + y;
    s[b + 2] = s[a + 2] + x * y;
    s[b + 3] = s[a + 3] + x * x;
    s[b + 4] = s[a + 4] + y * y;
  }
  return s;
}

/** For each vertex i, the farthest index reachable by a straight segment (lon[i]). */
function calcLon(xs: Int32Array, ys: Int32Array): Int32Array {
  const n = xs.length;
  const pivot = new Int32Array(n);
  const nc = new Int32Array(n);
  const lon = new Int32Array(n);
  const ct = new Int32Array(4);
  let k = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (xs[i] !== xs[k] && ys[i] !== ys[k]) k = i + 1;
    nc[i] = k;
  }
  for (let i = n - 1; i >= 0; i--) {
    ct[0] = ct[1] = ct[2] = ct[3] = 0;
    const i1 = mod(i + 1, n);
    ct[(3 + 3 * (xs[i1] - xs[i]) + (ys[i1] - ys[i])) / 2]++;
    let c0x = 0;
    let c0y = 0;
    let c1x = 0;
    let c1y = 0;
    k = nc[i];
    let k1 = i;
    let found = false;
    for (;;) {
      ct[(3 + 3 * sgn(xs[k] - xs[k1]) + sgn(ys[k] - ys[k1])) / 2]++;
      if (ct[0] && ct[1] && ct[2] && ct[3]) {
        pivot[i] = k1;
        found = true;
        break;
      }
      const cx = xs[k] - xs[i];
      const cy = ys[k] - ys[i];
      if (c0x * cy - c0y * cx < 0 || c1x * cy - c1y * cx > 0) break;
      if (!(Math.abs(cx) <= 1 && Math.abs(cy) <= 1)) {
        let ox = cx + (cy >= 0 && (cy > 0 || cx < 0) ? 1 : -1);
        let oy = cy + (cx <= 0 && (cx < 0 || cy < 0) ? 1 : -1);
        if (c0x * oy - c0y * ox >= 0) {
          c0x = ox;
          c0y = oy;
        }
        ox = cx + (cy <= 0 && (cy < 0 || cx < 0) ? 1 : -1);
        oy = cy + (cx >= 0 && (cx > 0 || cy < 0) ? 1 : -1);
        if (c1x * oy - c1y * ox <= 0) {
          c1x = ox;
          c1y = oy;
        }
      }
      k1 = k;
      k = nc[k1];
      if (!cyclic(k, i, k1)) break;
    }
    if (!found) {
      const dkx = sgn(xs[k] - xs[k1]);
      const dky = sgn(ys[k] - ys[k1]);
      const cx = xs[k1] - xs[i];
      const cy = ys[k1] - ys[i];
      const a = c0x * cy - c0y * cx;
      const b = c0x * dky - c0y * dkx;
      const c = c1x * cy - c1y * cx;
      const d = c1x * dky - c1y * dkx;
      let j = 10000000;
      if (b < 0) j = Math.floor(a / -b);
      if (d > 0) j = Math.min(j, Math.floor(-c / d));
      pivot[i] = mod(k1 + j, n);
    }
  }
  let j = pivot[n - 1];
  lon[n - 1] = j;
  for (let i = n - 2; i >= 0; i--) {
    if (cyclic(i + 1, pivot[i], j)) j = pivot[i];
    lon[i] = j;
  }
  for (let i = n - 1; i >= 0 && cyclic(mod(i + 1, n), j, lon[i]); i--) lon[i] = j;
  return lon;
}

/** Minimum-segment polygon (fewest edges, then least penalty). Returns indices into the point list. */
function bestPolygon(xs: Int32Array, ys: Int32Array, sums: Float64Array, lon: Int32Array): Int32Array {
  const n = xs.length;
  const penalty = (i: number, jj: number): number => {
    let j = jj;
    let r = 0;
    if (j >= n) {
      j -= n;
      r = 1;
    }
    const a = i * 5;
    const b = (j + 1) * 5;
    const e = n * 5;
    const x = sums[b] - sums[a] + r * sums[e];
    const y = sums[b + 1] - sums[a + 1] + r * sums[e + 1];
    const xy = sums[b + 2] - sums[a + 2] + r * sums[e + 2];
    const x2 = sums[b + 3] - sums[a + 3] + r * sums[e + 3];
    const y2 = sums[b + 4] - sums[a + 4] + r * sums[e + 4];
    const k = j + 1 - i + r * n;
    const px = (xs[i] + xs[j]) / 2 - xs[0];
    const py = (ys[i] + ys[j]) / 2 - ys[0];
    const ey = xs[j] - xs[i];
    const ex = -(ys[j] - ys[i]);
    const aa = (x2 - 2 * x * px) / k + px * px;
    const bb = (xy - x * py - y * px) / k + px * py;
    const cc = (y2 - 2 * y * py) / k + py * py;
    return Math.sqrt(ex * ex * aa + 2 * ex * ey * bb + ey * ey * cc);
  };

  const pen = new Float64Array(n + 1);
  const prev = new Int32Array(n + 1);
  const clip0 = new Int32Array(n);
  const clip1 = new Int32Array(n + 1);
  const seg0 = new Int32Array(n + 1);
  const seg1 = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    let c = mod(lon[mod(i - 1, n)] - 1, n);
    if (c === i) c = mod(i + 1, n);
    clip0[i] = c < i ? n : c;
  }
  let j = 1;
  for (let i = 0; i < n; i++) {
    while (j <= clip0[i]) clip1[j++] = i;
  }
  let i = 0;
  for (j = 0; i < n; j++) {
    seg0[j] = i;
    i = clip0[i];
  }
  seg0[j] = n;
  const m = j;
  i = n;
  for (j = m; j > 0; j--) {
    seg1[j] = i;
    i = clip1[i];
  }
  seg1[0] = 0;
  pen[0] = 0;
  for (j = 1; j <= m; j++) {
    for (i = seg1[j]; i <= seg0[j]; i++) {
      let best = -1;
      for (let k = seg0[j - 1]; k >= clip1[i]; k--) {
        const p = penalty(k, i) + pen[k];
        if (best < 0 || p < best) {
          prev[i] = k;
          best = p;
        }
      }
      pen[i] = best;
    }
  }
  const po = new Int32Array(m);
  for (i = n, j = m - 1; i > 0; j--) {
    i = prev[i];
    po[j] = i;
  }
  return po;
}

// ---------------------------------------------------------------- 3. vertex adjustment

/** Polygon vertices (absolute pixel coords) moved to the best-fit corner positions. */
function adjustVertices(xs: Int32Array, ys: Int32Array, sums: Float64Array, po: Int32Array): Vec[] {
  const n = xs.length;
  const m = po.length;
  const x0 = xs[0];
  const y0 = ys[0];
  const ctrX = new Float64Array(m);
  const ctrY = new Float64Array(m);
  const dirX = new Float64Array(m);
  const dirY = new Float64Array(m);

  // Centre and principal direction of the points between two polygon vertices.
  const pointSlope = (ii: number, jj: number, c: number): void => {
    let i = ii;
    let j = jj;
    let r = 0;
    while (j >= n) {
      j -= n;
      r++;
    }
    while (i >= n) {
      i -= n;
      r--;
    }
    while (j < 0) {
      j += n;
      r--;
    }
    while (i < 0) {
      i += n;
      r++;
    }
    const a0 = i * 5;
    const b0 = (j + 1) * 5;
    const e = n * 5;
    const x = sums[b0] - sums[a0] + r * sums[e];
    const y = sums[b0 + 1] - sums[a0 + 1] + r * sums[e + 1];
    const xy = sums[b0 + 2] - sums[a0 + 2] + r * sums[e + 2];
    const x2 = sums[b0 + 3] - sums[a0 + 3] + r * sums[e + 3];
    const y2 = sums[b0 + 4] - sums[a0 + 4] + r * sums[e + 4];
    const k = j + 1 - i + r * n;
    ctrX[c] = x / k;
    ctrY[c] = y / k;
    let a = (x2 - (x * x) / k) / k;
    const b = (xy - (x * y) / k) / k;
    let cc = (y2 - (y * y) / k) / k;
    const lambda2 = (a + cc + Math.sqrt((a - cc) * (a - cc) + 4 * b * b)) / 2;
    a -= lambda2;
    cc -= lambda2;
    let l: number;
    if (Math.abs(a) >= Math.abs(cc)) {
      l = Math.sqrt(a * a + b * b);
      if (l !== 0) {
        dirX[c] = -b / l;
        dirY[c] = a / l;
      }
    } else {
      l = Math.sqrt(cc * cc + b * b);
      if (l !== 0) {
        dirX[c] = -cc / l;
        dirY[c] = b / l;
      }
    }
    if (l === 0) dirX[c] = dirY[c] = 0;
  };

  for (let i = 0; i < m; i++) {
    let j = po[mod(i + 1, m)];
    j = mod(j - po[i], n) + po[i];
    pointSlope(po[i], j, i);
  }

  // Per-segment squared-distance-to-line quadratic forms (3x3 each).
  const q = new Float64Array(9 * m);
  const v = [0, 0, 0];
  for (let i = 0; i < m; i++) {
    const d = dirX[i] * dirX[i] + dirY[i] * dirY[i];
    if (d === 0) continue;
    v[0] = dirY[i];
    v[1] = -dirX[i];
    v[2] = -v[1] * ctrY[i] - v[0] * ctrX[i];
    for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) q[i * 9 + l * 3 + k] = (v[l] * v[k]) / d;
  }

  const Q = new Float64Array(9);
  const quad = (x: number, y: number): number => {
    const w = [x, y, 1];
    let sum = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sum += w[i] * Q[i * 3 + j] * w[j];
    return sum;
  };

  const out: Vec[] = [];
  for (let i = 0; i < m; i++) {
    const sx = xs[po[i]] - x0;
    const sy = ys[po[i]] - y0;
    const j = mod(i - 1, m);
    for (let k = 0; k < 9; k++) Q[k] = q[j * 9 + k] + q[i * 9 + k];
    let wx = 0;
    let wy = 0;
    for (;;) {
      const det = Q[0] * Q[4] - Q[1] * Q[3];
      if (det !== 0) {
        wx = (-Q[2] * Q[4] + Q[5] * Q[1]) / det;
        wy = (Q[2] * Q[3] - Q[5] * Q[0]) / det;
        break;
      }
      // Singular: add a line through the original vertex along the dominant direction.
      if (Q[0] > Q[4]) {
        v[0] = -Q[1];
        v[1] = Q[0];
      } else if (Q[4]) {
        v[0] = -Q[4];
        v[1] = Q[3];
      } else {
        v[0] = 1;
        v[1] = 0;
      }
      const d = v[0] * v[0] + v[1] * v[1];
      v[2] = -v[1] * sy - v[0] * sx;
      for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) Q[l * 3 + k] += (v[l] * v[k]) / d;
    }
    if (Math.abs(wx - sx) <= 0.5 && Math.abs(wy - sy) <= 0.5) {
      out.push({ x: wx + x0, y: wy + y0 });
      continue;
    }
    // Optimum is more than half a pixel away: search the edges and corners of the 1x1 box around the original vertex.
    let min = quad(sx, sy);
    let xmin = sx;
    let ymin = sy;
    if (Q[0] !== 0) {
      for (let z = 0; z < 2; z++) {
        wy = sy - 0.5 + z;
        wx = -(Q[1] * wy + Q[2]) / Q[0];
        const cand = quad(wx, wy);
        if (Math.abs(wx - sx) <= 0.5 && cand < min) {
          min = cand;
          xmin = wx;
          ymin = wy;
        }
      }
    }
    if (Q[4] !== 0) {
      for (let z = 0; z < 2; z++) {
        wx = sx - 0.5 + z;
        wy = -(Q[3] * wx + Q[5]) / Q[4];
        const cand = quad(wx, wy);
        if (Math.abs(wy - sy) <= 0.5 && cand < min) {
          min = cand;
          xmin = wx;
          ymin = wy;
        }
      }
    }
    for (let l = 0; l < 2; l++) {
      for (let k = 0; k < 2; k++) {
        wx = sx - 0.5 + l;
        wy = sy - 0.5 + k;
        const cand = quad(wx, wy);
        if (cand < min) {
          min = cand;
          xmin = wx;
          ymin = wy;
        }
      }
    }
    out.push({ x: xmin + x0, y: ymin + y0 });
  }
  return out;
}

// ---------------------------------------------------------------- 4. smoothing and curve optimisation

const CORNER = 0;
const CURVE = 1;

/** Closed Bézier path: segment i runs from c[3(i-1)+2] with controls c[3i], c[3i+1] to c[3i+2]; corners use c[3i+1] as the corner point. */
interface Curve {
  n: number;
  tag: Uint8Array;
  c: Vec[];
  vertex: Vec[];
  alpha: Float64Array;
  alpha0: Float64Array;
  beta: Float64Array;
}

const ZERO: Vec = { x: 0, y: 0 };
const interval = (lam: number, a: Vec, b: Vec): Vec => ({ x: a.x + lam * (b.x - a.x), y: a.y + lam * (b.y - a.y) });
const ddist = (p: Vec, q: Vec): number => Math.hypot(p.x - q.x, p.y - q.y);
const dpara = (p0: Vec, p1: Vec, p2: Vec): number => (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
const cprod = (p0: Vec, p1: Vec, p2: Vec, p3: Vec): number => (p1.x - p0.x) * (p3.y - p2.y) - (p3.x - p2.x) * (p1.y - p0.y);
const iprod = (p0: Vec, p1: Vec, p2: Vec): number => (p1.x - p0.x) * (p2.x - p0.x) + (p1.y - p0.y) * (p2.y - p0.y);
const iprod1 = (p0: Vec, p1: Vec, p2: Vec, p3: Vec): number => (p1.x - p0.x) * (p3.x - p2.x) + (p1.y - p0.y) * (p3.y - p2.y);

function bezier(t: number, p0: Vec, p1: Vec, p2: Vec, p3: Vec): Vec {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const c = 3 * s * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Parameter t where the Bézier's tangent is parallel to q0->q1, or -1. */
function tangent(p0: Vec, p1: Vec, p2: Vec, p3: Vec, q0: Vec, q1: Vec): number {
  const A = cprod(p0, p1, q0, q1);
  const B = cprod(p1, p2, q0, q1);
  const C = cprod(p2, p3, q0, q1);
  const a = A - 2 * B + C;
  const b = -2 * A + 2 * B;
  const c = A;
  const d = b * b - 4 * a * c;
  if (a === 0 || d < 0) return -1;
  const s = Math.sqrt(d);
  const r1 = (-b + s) / (2 * a);
  const r2 = (-b - s) / (2 * a);
  if (r1 >= 0 && r1 <= 1) return r1;
  if (r2 >= 0 && r2 <= 1) return r2;
  return -1;
}

function smooth(vertex: Vec[], alphaMax: number): Curve {
  const m = vertex.length;
  const curve: Curve = {
    n: m,
    tag: new Uint8Array(m),
    c: new Array<Vec>(3 * m).fill(ZERO),
    vertex,
    alpha: new Float64Array(m),
    alpha0: new Float64Array(m),
    beta: new Float64Array(m),
  };
  for (let i = 0; i < m; i++) {
    const j = mod(i + 1, m);
    const k = mod(i + 2, m);
    const p4 = interval(0.5, vertex[k], vertex[j]);
    const denom = Math.abs(vertex[k].x - vertex[i].x) + Math.abs(vertex[k].y - vertex[i].y);
    let alpha: number;
    if (denom !== 0) {
      const dd = Math.abs(dpara(vertex[i], vertex[j], vertex[k]) / denom);
      alpha = (dd > 1 ? 1 - 1 / dd : 0) / 0.75;
    } else {
      alpha = 4 / 3;
    }
    curve.alpha0[j] = alpha;
    if (alpha >= alphaMax) {
      curve.tag[j] = CORNER;
      curve.c[3 * j + 1] = vertex[j];
      curve.c[3 * j + 2] = p4;
    } else {
      alpha = alpha < 0.55 ? 0.55 : alpha > 1 ? 1 : alpha;
      curve.tag[j] = CURVE;
      curve.c[3 * j] = interval(0.5 + 0.5 * alpha, vertex[i], vertex[j]);
      curve.c[3 * j + 1] = interval(0.5 + 0.5 * alpha, vertex[k], vertex[j]);
      curve.c[3 * j + 2] = p4;
    }
    curve.alpha[j] = alpha;
    curve.beta[j] = 0.5;
  }
  return curve;
}

interface Opti {
  pen: number;
  c0: Vec;
  c1: Vec;
  t: number;
  s: number;
  alpha: number;
}

/** Try to replace vertices i..j by one Bézier; returns false (and fills res) when that is possible within tolerance. */
function optiPenalty(curve: Curve, i: number, j: number, res: Opti, optTol: number, convc: Int8Array, areac: Float64Array): boolean {
  const m = curve.n;
  const vertex = curve.vertex;
  const c = curve.c;
  if (i === j) return true;
  let k = i;
  const i1 = mod(i + 1, m);
  let k1 = mod(k + 1, m);
  const conv = convc[k1];
  if (conv === 0) return true;
  const d0 = ddist(vertex[i], vertex[i1]);
  for (k = k1; k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const k2 = mod(k + 2, m);
    if (convc[k1] !== conv) return true;
    if (sgn(cprod(vertex[i], vertex[i1], vertex[k1], vertex[k2])) !== conv) return true;
    if (iprod1(vertex[i], vertex[i1], vertex[k1], vertex[k2]) < d0 * ddist(vertex[k1], vertex[k2]) * COS179) return true;
  }
  const p0 = c[mod(i, m) * 3 + 2];
  const p1 = vertex[mod(i + 1, m)];
  const p2 = vertex[mod(j, m)];
  const p3 = c[mod(j, m) * 3 + 2];
  let area = areac[j] - areac[i];
  area -= dpara(vertex[0], c[i * 3 + 2], c[j * 3 + 2]) / 2;
  if (i >= j) area += areac[m];
  const A1 = dpara(p0, p1, p2);
  const A2 = dpara(p0, p1, p3);
  const A3 = dpara(p0, p2, p3);
  const A4 = A1 + A3 - A2;
  if (A2 === A1) return true;
  const t = A3 / (A3 - A4);
  const s = A2 / (A2 - A1);
  const A = (A2 * t) / 2;
  if (A === 0) return true;
  const R = area / A;
  const alpha = 2 - Math.sqrt(4 - R / 0.3);
  const c0 = interval(t * alpha, p0, p1);
  const c1 = interval(s * alpha, p3, p2);
  res.c0 = c0;
  res.c1 = c1;
  res.alpha = alpha;
  res.t = t;
  res.s = s;
  res.pen = 0;
  for (k = mod(i + 1, m); k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const tt = tangent(p0, c0, c1, p3, vertex[k], vertex[k1]);
    if (tt < -0.5) return true;
    const pt = bezier(tt, p0, c0, c1, p3);
    const d = ddist(vertex[k], vertex[k1]);
    if (d === 0) return true;
    const d1 = dpara(vertex[k], vertex[k1], pt) / d;
    if (Math.abs(d1) > optTol) return true;
    if (iprod(vertex[k], vertex[k1], pt) < 0 || iprod(vertex[k1], vertex[k], pt) < 0) return true;
    res.pen += d1 * d1;
  }
  for (k = i; k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const tt = tangent(p0, c0, c1, p3, c[k * 3 + 2], c[k1 * 3 + 2]);
    if (tt < -0.5) return true;
    const pt = bezier(tt, p0, c0, c1, p3);
    const d = ddist(c[k * 3 + 2], c[k1 * 3 + 2]);
    if (d === 0) return true;
    let d1 = dpara(c[k * 3 + 2], c[k1 * 3 + 2], pt) / d;
    let d2 = dpara(c[k * 3 + 2], c[k1 * 3 + 2], vertex[k1]) / d;
    d2 *= 0.75 * curve.alpha[k1];
    if (d2 < 0) {
      d1 = -d1;
      d2 = -d2;
    }
    if (d1 < d2 - optTol) return true;
    if (d1 < d2) res.pen += (d1 - d2) * (d1 - d2);
  }
  return false;
}

/** Merge runs of smooth segments into fewer Béziers (dynamic programming, fewest segments then least penalty). */
function optiCurve(curve: Curve, optTol: number): Curve {
  const m = curve.n;
  const vert = curve.vertex;
  const convc = new Int8Array(m);
  for (let i = 0; i < m; i++) convc[i] = curve.tag[i] === CURVE ? sgn(dpara(vert[mod(i - 1, m)], vert[i], vert[mod(i + 1, m)])) : 0;
  const areac = new Float64Array(m + 1);
  let area = 0;
  const p0 = vert[0];
  for (let i = 0; i < m; i++) {
    const i1 = mod(i + 1, m);
    if (curve.tag[i1] === CURVE) {
      const alpha = curve.alpha[i1];
      area += (0.3 * alpha * (4 - alpha) * dpara(curve.c[i * 3 + 2], vert[i1], curve.c[i1 * 3 + 2])) / 2;
      area += dpara(p0, curve.c[i * 3 + 2], curve.c[i1 * 3 + 2]) / 2;
    }
    areac[i + 1] = area;
  }
  const pt = new Int32Array(m + 1);
  const pen = new Float64Array(m + 1);
  const len = new Int32Array(m + 1);
  const opt: Opti[] = new Array<Opti>(m + 1);
  const o: Opti = { pen: 0, c0: ZERO, c1: ZERO, t: 0, s: 0, alpha: 0 };
  pt[0] = -1;
  for (let j = 1; j <= m; j++) {
    pt[j] = j - 1;
    pen[j] = pen[j - 1];
    len[j] = len[j - 1] + 1;
    for (let i = j - 2; i >= 0; i--) {
      if (optiPenalty(curve, i, mod(j, m), o, optTol, convc, areac)) break;
      if (len[j] > len[i] + 1 || (len[j] === len[i] + 1 && pen[j] > pen[i] + o.pen)) {
        pt[j] = i;
        pen[j] = pen[i] + o.pen;
        len[j] = len[i] + 1;
        opt[j] = { ...o };
      }
    }
  }
  const om = len[m];
  const out: Curve = {
    n: om,
    tag: new Uint8Array(om),
    c: new Array<Vec>(3 * om).fill(ZERO),
    vertex: new Array<Vec>(om).fill(ZERO),
    alpha: new Float64Array(om),
    alpha0: new Float64Array(om),
    beta: new Float64Array(om),
  };
  const s = new Float64Array(om);
  const tt = new Float64Array(om);
  let j = m;
  for (let i = om - 1; i >= 0; i--) {
    const jm = mod(j, m);
    if (pt[j] === j - 1) {
      out.tag[i] = curve.tag[jm];
      out.c[i * 3] = curve.c[jm * 3];
      out.c[i * 3 + 1] = curve.c[jm * 3 + 1];
      out.c[i * 3 + 2] = curve.c[jm * 3 + 2];
      out.vertex[i] = vert[jm];
      out.alpha[i] = curve.alpha[jm];
      out.alpha0[i] = curve.alpha0[jm];
      out.beta[i] = curve.beta[jm];
      s[i] = tt[i] = 1;
    } else {
      out.tag[i] = CURVE;
      out.c[i * 3] = opt[j].c0;
      out.c[i * 3 + 1] = opt[j].c1;
      out.c[i * 3 + 2] = curve.c[jm * 3 + 2];
      out.vertex[i] = interval(opt[j].s, curve.c[jm * 3 + 2], vert[jm]);
      out.alpha[i] = opt[j].alpha;
      out.alpha0[i] = opt[j].alpha;
      s[i] = opt[j].s;
      tt[i] = opt[j].t;
    }
    j = pt[j];
  }
  for (let i = 0; i < om; i++) out.beta[i] = s[i] / (s[i] + tt[mod(i + 1, om)]);
  return out;
}

// ---------------------------------------------------------------- 5. flattening

/** Appends the points after p0 up to and including p3, subdividing until the chord error is within tol. */
function flattenBezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, tol: number, out: Vec[], depth: number): void {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy);
  let d1: number;
  let d2: number;
  if (len < 1e-12) {
    d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    d2 = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  } else {
    d1 = Math.abs((p1.x - p0.x) * dy - (p1.y - p0.y) * dx) / len;
    d2 = Math.abs((p2.x - p0.x) * dy - (p2.y - p0.y) * dx) / len;
  }
  // A cubic strays from its chord by at most 3/4 of the larger control-point offset.
  if (0.75 * Math.max(d1, d2) <= tol || depth >= 16) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  const p01 = interval(0.5, p0, p1);
  const p12 = interval(0.5, p1, p2);
  const p23 = interval(0.5, p2, p3);
  const a = interval(0.5, p01, p12);
  const b = interval(0.5, p12, p23);
  const mid = interval(0.5, a, b);
  flattenBezier(p0, p01, a, mid, tol, out, depth + 1);
  flattenBezier(mid, b, p23, p3, tol, out, depth + 1);
}

function flatten(curve: Curve, tol: number): Vec[] {
  const m = curve.n;
  const out: Vec[] = [];
  for (let i = 0; i < m; i++) {
    const start = curve.c[mod(i - 1, m) * 3 + 2];
    if (curve.tag[i] === CORNER) {
      out.push({ x: curve.c[3 * i + 1].x, y: curve.c[3 * i + 1].y });
      out.push({ x: curve.c[3 * i + 2].x, y: curve.c[3 * i + 2].y });
    } else {
      flattenBezier(start, curve.c[3 * i], curve.c[3 * i + 1], curve.c[3 * i + 2], tol, out, 0);
    }
  }
  return out;
}

/** Drops repeated points and points that lie on the straight line between their neighbours (corner mid-edge points). */
function simplify(pts: Vec[]): Vec[] {
  let cur = pts;
  for (let pass = 0; pass < 2; pass++) {
    const out: Vec[] = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const a = out.length > 0 ? out[out.length - 1] : cur[mod(i - 1, n)];
      const b = cur[i];
      const c = cur[mod(i + 1, n)];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const bcx = c.x - b.x;
      const bcy = c.y - b.y;
      if (abx * abx + aby * aby < 1e-18) continue;
      const cross = abx * bcy - aby * bcx;
      const dot = abx * bcx + aby * bcy;
      if (Math.abs(cross) <= 1e-9 * (Math.hypot(abx, aby) * Math.hypot(bcx, bcy) + 1e-30) && dot >= 0) continue;
      out.push(b);
    }
    cur = out;
  }
  return cur;
}

// ---------------------------------------------------------------- public API

/** Traces a bitmap (1 = ink) into closed outlines. Holes come out as separate paths with hole = true. */
export function trace(bits: Uint8Array, width: number, height: number, opts: Partial<TraceOptions> = {}): TracedPath[] {
  const o: TraceOptions = { ...DEFAULTS, ...opts };
  const result: TracedPath[] = [];
  if (width <= 0 || height <= 0) return result;
  for (const raw of decompose(bits, width, height, o.turnPolicy, o.turdSize)) {
    const sums = calcSums(raw.xs, raw.ys);
    const lon = calcLon(raw.xs, raw.ys);
    const po = bestPolygon(raw.xs, raw.ys, sums, lon);
    const vertices = adjustVertices(raw.xs, raw.ys, sums, po);
    let curve = smooth(vertices, o.alphaMax);
    if (o.optCurve) curve = optiCurve(curve, o.optTolerance);
    const points = simplify(flatten(curve, o.tolerancePx));
    if (points.length >= 3) result.push({ points, hole: raw.hole });
  }
  return result;
}
