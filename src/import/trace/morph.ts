// @ts-nocheck -- hot pixel loops index typed arrays heavily; noUncheckedIndexedAccess would need a "!" on nearly every access. Covered by tests/autoTrace.test.ts.
// Binary-image operations for automatic tracing: grow a shape (cut outline margin), fill its holes, and thin strokes
// to one-pixel centre lines that become open paths. Bitmaps are row-major Uint8Array, 1 = ink.
import type { Vec } from "../../geom/geom";

/** Chamfer (3-4) distance from every pixel to the nearest ink pixel, in units of 1/3 px. Ink pixels are 0. */
function distance(bits: Uint8Array, w: number, h: number): Uint32Array {
  const INF = 1e9;
  const d = new Uint32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = bits[i] ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Ink grown by `r` px in every direction (rounded corners). */
export function dilate(bits: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return bits.slice();
  const d = distance(bits, w, h);
  const lim = r * 3;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i] <= lim ? 1 : 0;
  return out;
}

/** Background pixels that can't be reached from the image border become ink (closed holes are filled). */
export function fillHoles(bits: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h).fill(1);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!bits[i] && out[i]) {
      out[i] = 0;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < (h - 1) * w) push(i + w);
  }
  return out;
}

/** A copy with `pad` empty pixels added on every side. */
export function pad(bits: Uint8Array, w: number, h: number, p: number): { bits: Uint8Array; w: number; h: number } {
  const W = w + 2 * p, H = h + 2 * p;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) out.set(bits.subarray(y * w, y * w + w), (y + p) * W + p);
  return { bits: out, w: W, h: H };
}

// Neighbour offsets clockwise from north: N, NE, E, SE, S, SW, W, NW.
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

function ring(img: Uint8Array, w: number, h: number, x: number, y: number, out: number[]): void {
  for (let k = 0; k < 8; k++) {
    const nx = x + DX[k], ny = y + DY[k];
    out[k] = nx >= 0 && ny >= 0 && nx < w && ny < h ? img[ny * w + nx] : 0;
  }
}

/** Whether the set neighbours in `n` form one 8-connected group (so removing the centre keeps them connected). */
function oneGroup(n: number[]): boolean {
  let first = -1;
  for (let k = 0; k < 8; k++) if (n[k]) { first = k; break; }
  if (first < 0) return false;
  const seen = [0, 0, 0, 0, 0, 0, 0, 0];
  const stack = [first];
  seen[first] = 1;
  while (stack.length) {
    const a = stack.pop();
    for (let b = 0; b < 8; b++) {
      if (!n[b] || seen[b]) continue;
      const d = (b - a + 8) % 8;
      // Ring neighbours touch; two edge neighbours (even indices) two steps apart touch at the corner between them.
      if (d === 1 || d === 7 || (a % 2 === 0 && b % 2 === 0 && (d === 2 || d === 6))) {
        seen[b] = 1;
        stack.push(b);
      }
    }
  }
  for (let k = 0; k < 8; k++) if (n[k] && !seen[k]) return false;
  return true;
}

/** Zhang–Suen thinning to one-pixel lines, then stair-step corners removed so lines are 8-connected and thin. */
export function thin(bits: Uint8Array, w: number, h: number): Uint8Array {
  const img = bits.slice();
  const n = [0, 0, 0, 0, 0, 0, 0, 0];
  const del: number[] = [];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (img[y * w + x]) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return img;
  for (let changed = true; changed; ) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (!img[i]) continue;
          ring(img, w, h, x, y, n);
          const b = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!n[k] && n[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          // n[0]=N(p2) n[2]=E(p4) n[4]=S(p6) n[6]=W(p8)
          if (step === 0 ? n[0] * n[2] * n[4] === 0 && n[2] * n[4] * n[6] === 0 : n[0] * n[2] * n[6] === 0 && n[0] * n[4] * n[6] === 0) del.push(i);
        }
      }
      for (const i of del) img[i] = 0;
      if (del.length) changed = true;
    }
  }
  // Stair-step clean-up: an L-corner pixel whose neighbours stay connected without it is redundant.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (!img[i]) continue;
      ring(img, w, h, x, y, n);
      const l = (n[0] && n[2]) || (n[2] && n[4]) || (n[4] && n[6]) || (n[6] && n[0]);
      const b = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
      if (l && b >= 2 && oneGroup(n)) img[i] = 0;
    }
  }
  return img;
}

export interface Polyline {
  /** Pixel centres (x + 0.5, y + 0.5). */
  points: Vec[];
  closed: boolean;
}

/**
 * The one-pixel lines of a thinned bitmap as polylines, split at junctions. Branches from a line end to a junction
 * shorter than `spurPx` (thinning whiskers at corners) are dropped; isolated bits shorter than it too.
 */
export function skeletonPaths(skel: Uint8Array, w: number, h: number, spurPx: number): Polyline[] {
  const deg = new Uint8Array(w * h);
  const n = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!skel[i]) continue;
    ring(skel, w, h, x, y, n);
    deg[i] = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
  }
  const isNode = (i: number) => skel[i] && deg[i] !== 2;
  const used = new Uint8Array(w * h); // interior (degree-2) pixels already in a polyline
  const edges = new Set<string>(); // node–node steps already taken
  const out: (Polyline & { ends: number })[] = [];
  const pt = (i: number): Vec => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });
  const neighbours = (i: number): number[] => {
    const x = i % w, y = Math.floor(i / w);
    const r: number[] = [];
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k], ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && skel[ny * w + nx]) r.push(ny * w + nx);
    }
    return r;
  };
  const walk = (start: number, first: number): number[] => {
    const chain = [start, first];
    let prev = start, cur = first;
    while (!isNode(cur)) {
      used[cur] = 1;
      const next = neighbours(cur).find((j) => j !== prev && (isNode(j) ? j !== start || chain.length > 2 : !used[j]));
      if (next === undefined) break;
      chain.push(next);
      prev = cur;
      cur = next;
      if (cur === start) break;
    }
    return chain;
  };
  for (let i = 0; i < w * h; i++) {
    if (!isNode(i)) continue;
    if (deg[i] === 0) continue; // a lone dot
    for (const j of neighbours(i)) {
      if (isNode(j)) {
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (edges.has(key)) continue;
        edges.add(key);
        out.push({ points: [pt(i), pt(j)], closed: false, ends: (deg[i] === 1 ? 1 : 0) + (deg[j] === 1 ? 1 : 0) });
        continue;
      }
      if (used[j]) continue;
      const chain = walk(i, j);
      const end = chain[chain.length - 1];
      out.push({ points: chain.map(pt), closed: false, ends: (deg[i] === 1 ? 1 : 0) + (isNode(end) && deg[end] === 1 ? 1 : 0) });
    }
  }
  // Closed loops without any junction or end (an "O").
  for (let i = 0; i < w * h; i++) {
    if (!skel[i] || used[i] || deg[i] !== 2) continue;
    const loop = [i];
    used[i] = 1;
    let prev = -1, cur = i;
    for (;;) {
      const next = neighbours(cur).find((j) => j !== prev && !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      loop.push(next);
      prev = cur;
      cur = next;
    }
    out.push({ points: loop.map(pt), closed: loop.length > 2, ends: 0 });
  }
  const len = (p: Vec[]) => {
    let s = 0;
    for (let k = 1; k < p.length; k++) s += Math.hypot(p[k].x - p[k - 1].x, p[k].y - p[k - 1].y);
    return s;
  };
  return out
    .filter((p) => (p.ends === 1 ? len(p.points) >= spurPx : p.ends === 2 ? len(p.points) >= 2 : true))
    .map(({ points, closed }) => ({ points, closed }));
}

/** Chains that meet end to end (at a junction pixel, or ends within `gap` px) joined into longer polylines. */
export function joinPolylines(lines: Polyline[], gap = 1.5): Polyline[] {
  const open = lines.filter((l) => !l.closed).map((l) => l.points.slice());
  const done: Polyline[] = lines.filter((l) => l.closed);
  const near = (a: Vec, b: Vec) => Math.abs(a.x - b.x) <= gap && Math.abs(a.y - b.y) <= gap;
  while (open.length) {
    let cur = open.pop();
    for (let grew = true; grew; ) {
      grew = false;
      for (let k = open.length - 1; k >= 0; k--) {
        const o = open[k];
        const head = cur[0], tail = cur[cur.length - 1];
        if (near(tail, o[0])) cur = cur.concat(o.slice(1));
        else if (near(tail, o[o.length - 1])) cur = cur.concat(o.slice(0, -1).reverse());
        else if (near(head, o[o.length - 1])) cur = o.concat(cur.slice(1));
        else if (near(head, o[0])) cur = o.slice().reverse().concat(cur.slice(1));
        else continue;
        open.splice(k, 1);
        grew = true;
      }
    }
    const closed = cur.length > 3 && near(cur[0], cur[cur.length - 1]);
    done.push({ points: closed ? cur.slice(0, -1) : cur, closed });
  }
  return done;
}
