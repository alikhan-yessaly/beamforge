// Cut order within a group of paths: which path next, where each closed path starts and which way each open path
// runs, to keep the head's travel time down. Pure.
//
// Cost: the time of each jump, from rest to rest at the travel speed and acceleration (`travelTime`), not its
// length; short hops cost more per millimetre than long ones.
//
// Inner first: a closed path is cut after every closed path inside it. A letter and its counters (o, a, e…) form a
// cluster that is cut as one piece (counters, then the outline), so the search below can reorder and reverse runs
// of letters freely; only larger containers (an outline around many shapes) are ordered by precedence.
//
// Steps: nearest-neighbour tour; then rounds of 2-opt and Or-opt (move a run of 1–3 pieces elsewhere, either way
// round) over each piece's nearest neighbours, and a pass that picks every start point and direction for the
// pieces on either side. A closed path starts where it is cheapest to arrive and leave, preferring a sharp corner
// (the head stops there anyway, and the seam hides in it). The last piece heads towards `to` when that is known.
import { type Box, type Vec, pointInPolygon } from "../geom/geom";
import { junctionSpeed, trapezoid } from "./estimate";

export interface OrderItem {
  pts: Vec[];
  closed: boolean;
  box: Box;
  /** Cut speed in mm/s; with `accel`, how much time a start in a corner saves. */
  speed?: number;
  /** Open paths: other ways to cut the same work (e.g. a hatch entered at another corner), each runnable backwards too. */
  variants?: Vec[][];
}

export interface OrderTuning {
  /** Cut a letter and its counters as one piece (default true). */
  clusters?: boolean;
  twoOpt?: boolean;
  orOpt?: boolean;
  /** Pick start points for the neighbours on both sides (default true); off = nearest to arrival only. */
  seams?: boolean;
  /** Prefer sharp corners for start points (default true). */
  corners?: boolean;
  /** Rounds of search + start points (default 3). */
  rounds?: number;
}

export interface OrderOptions {
  /** Travel time in seconds for a jump of `d` mm. */
  cost: (d: number) => number;
  innerFirst: boolean;
  /** Where the head goes after this group, when known: the last piece ends near it. */
  to?: Vec;
  /** Acceleration in mm/s², for the corner preference. */
  accel?: number;
  tuning?: OrderTuning;
}

export interface Ordered {
  /** Item index. */
  i: number;
  /** Points in cut order; a closed path ends where it started. */
  pts: Vec[];
  /** Open paths: which of `variants` (0 without them), and whether it runs backwards. */
  variant: number;
  reversed: boolean;
}

/** Travel time of a jump from rest to rest. */
export const travelTime = (m: { travelSpeed: number; accel: number }) => {
  const v = Math.max(0.1, m.travelSpeed);
  const a = Math.max(1, m.accel);
  return (d: number) => trapezoid(d, 0, 0, v, a);
};

/** Above this many closed paths, skip the O(n²) containment tests (no inner-first). */
export const INNER_FIRST_LIMIT = 3000;
/** Above this many pieces, keep the nearest-neighbour tour (no search). */
const SEARCH_LIMIT = 20000;
/** Delta evaluations allowed for the search (keeps big jobs quick, and the result deterministic). */
const BUDGET = 3e6;
/** A cluster: an outline with at most this many counters, none with anything inside. */
const CLUSTER_MAX = 8;
const K = 8;

const dist = (a: Vec, b: Vec) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};
const boxDist = (b: Box, p: Vec) => {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.sqrt(dx * dx + dy * dy);
};
const area = (b: Box) => (b.maxX - b.minX) * (b.maxY - b.minY);

/** Pieces of work for the tour. */
interface Node {
  /** 0 closed path, 1 open path, 2 cluster (counters then outline). */
  kind: 0 | 1 | 2;
  /** The path (cluster: its outline). */
  item: number;
  holes: number[];
  box: Box;
  /** Nodes that must come before (containers only). */
  preds: number[];
  /** Containers that must come after. */
  succs: number[];
}

export function orderItems(items: OrderItem[], from: Vec, opts: OrderOptions): Ordered[] {
  if (!items.length) return [];
  const tune = { clusters: true, twoOpt: true, orOpt: true, seams: true, corners: true, rounds: 3, ...opts.tuning };
  const c = opts.cost;
  const rings = items.map((it) => (it.closed ? ring(it.pts) : it.pts));
  const nodes = buildNodes(items, rings, opts.innerFirst, tune.clusters);
  const n = nodes.length;

  // Corner savings per vertex of closed paths, computed when first needed.
  const bonusCache = new Map<number, Float64Array>();
  const bonus = (i: number): Float64Array | null => {
    const it = items[i]!;
    if (!tune.corners || !it.speed || !opts.accel || !it.closed) return null;
    let b = bonusCache.get(i);
    if (!b) bonusCache.set(i, (b = cornerSavings(rings[i]!, it.speed, opts.accel)));
    return b;
  };

  // Per-node state: start vertex of a closed path / outline (or an open path's variant), direction of an open path,
  // counter order of a cluster.
  const seam = new Int32Array(n);
  const ways = (i: number): Vec[][] => items[i]!.variants ?? [rings[i]!];
  const flip = new Uint8Array(n);
  const holeSeq: { i: number; k: number }[][] = nodes.map(() => []);
  const inPt: Vec[] = new Array(n);
  const outPt: Vec[] = new Array(n);
  /** The symmetric stand-in used by the search: a cluster counts as one point between its entry and exit. */
  const portA: Vec[] = new Array(n);
  const portB: Vec[] = new Array(n);
  const setPorts = (x: number) => {
    const nd = nodes[x]!;
    const r = nd.kind === 1 ? ways(nd.item)[seam[x]!]! : rings[nd.item]!;
    if (nd.kind === 1) {
      [inPt[x], outPt[x]] = flip[x] ? [r.at(-1)!, r[0]!] : [r[0]!, r.at(-1)!];
      [portA[x], portB[x]] = [inPt[x]!, outPt[x]!];
    } else if (nd.kind === 0) {
      inPt[x] = outPt[x] = portA[x] = portB[x] = r[seam[x]!]!;
    } else {
      const h = holeSeq[x]![0]!;
      inPt[x] = rings[h.i]![h.k]!;
      outPt[x] = r[seam[x]!]!;
      portA[x] = portB[x] = { x: (inPt[x]!.x + outPt[x]!.x) / 2, y: (inPt[x]!.y + outPt[x]!.y) / 2 };
    }
  };

  /** Place a node's start points: arriving from `p`, leaving towards `q` (if known). */
  const place = (x: number, p: Vec, q: Vec | undefined, both: boolean) => {
    const nd = nodes[x]!;
    if (nd.kind === 1) {
      // Each variant either way; on a tie (e.g. a lone path, there and back), the nearer start.
      let best = { cost: Infinity, near: Infinity, v: 0, f: 0 };
      ways(nd.item).forEach((r, v) => {
        for (const f of [0, 1]) {
          const [a, b] = f ? [r.at(-1)!, r[0]!] : [r[0]!, r.at(-1)!];
          const cost = c(dist(p, a)) + (q && both ? c(dist(b, q)) : 0);
          const near = dist(p, a);
          if (cost < best.cost - 1e-9 || (cost <= best.cost + 1e-9 && near < best.near - 1e-12)) best = { cost, near, v, f };
        }
      });
      seam[x] = best.v;
      flip[x] = best.f;
    } else if (nd.kind === 0) {
      seam[x] = bestVertex(rings[nd.item]!, p, both ? q : undefined, c, bonus(nd.item));
    } else {
      // Counters nearest first from the arrival, then the outline.
      const left = [...nd.holes];
      const seq: { i: number; k: number }[] = [];
      let at = p;
      while (left.length) {
        let [bi, bd] = [0, Infinity];
        left.forEach((h, j) => {
          const k = bestVertex(rings[h]!, at, undefined, c, null);
          const d = dist(at, rings[h]![k]!);
          if (d < bd) [bi, bd] = [j, d];
        });
        const h = left.splice(bi, 1)[0]!;
        const k = bestVertex(rings[h]!, at, undefined, c, bonus(h));
        seq.push({ i: h, k });
        at = rings[h]![k]!;
      }
      holeSeq[x] = seq;
      seam[x] = bestVertex(rings[nd.item]!, at, both ? q : undefined, c, bonus(nd.item));
    }
    setPorts(x);
  };

  // 1. Nearest-neighbour tour, honouring precedence.
  const tour = nearestTour(nodes, rings, ways, from, place, outPt);

  // 2. Search rounds.
  if (n >= 3 && n <= SEARCH_LIMIT && (tune.twoOpt || tune.orOpt)) {
    const budget = { left: BUDGET };
    for (let round = 0; round < tune.rounds; round++) {
      const changed = search(tour, nodes, from, opts.to, c, portA, portB, flip, tune, budget);
      placeAll(tour, from, opts.to, place, inPt, outPt, tune.seams, 1);
      if (!changed || budget.left <= 0) break;
    }
    // Once more: each start point now sees its neighbours' final ones.
    if (tune.seams) placeAll(tour, from, opts.to, place, inPt, outPt, true, 1);
  } else {
    placeAll(tour, from, opts.to, place, inPt, outPt, tune.seams);
  }

  // 3. Points in cut order.
  const out: Ordered[] = [];
  for (const x of tour) {
    const nd = nodes[x]!;
    if (nd.kind === 1) {
      const it = items[nd.item]!;
      const r = it.variants ? it.variants[seam[x]!]! : it.pts;
      out.push({ i: nd.item, pts: flip[x] ? [...r].reverse() : r, variant: it.variants ? seam[x]! : 0, reversed: !!flip[x] });
    } else {
      for (const h of holeSeq[x]!) out.push({ i: h.i, pts: rotate(rings[h.i]!, h.k), variant: 0, reversed: false });
      out.push({ i: nd.item, pts: rotate(rings[nd.item]!, seam[x]!), variant: 0, reversed: false });
    }
  }
  return out;
}

/** A closed path's vertices without an explicit closing vertex. */
function ring(pts: Vec[]): Vec[] {
  const l = pts.at(-1)!;
  return pts.length > 1 && l.x === pts[0]!.x && l.y === pts[0]!.y ? pts.slice(0, -1) : pts;
}

/** The ring from vertex k round to k again. */
function rotate(r: Vec[], k: number): Vec[] {
  const i = k % r.length;
  return [...r.slice(i), ...r.slice(0, i), r[i]!];
}

/** Start vertex: cheapest to arrive at from `p` (and leave towards `q`), less what starting in a corner saves. */
function bestVertex(r: Vec[], p: Vec, q: Vec | undefined, c: (d: number) => number, bonus: Float64Array | null): number {
  let [best, bestCost] = [0, Infinity];
  if (!q && !bonus) {
    // Just the nearest vertex (the cost grows with distance).
    for (let k = 0; k < r.length; k++) {
      const dx = r[k]!.x - p.x;
      const dy = r[k]!.y - p.y;
      const e = dx * dx + dy * dy;
      if (e < bestCost) [best, bestCost] = [k, e];
    }
    return best;
  }
  for (let k = 0; k < r.length; k++) {
    const v = r[k]!;
    const e = c(dist(p, v)) + (q ? c(dist(v, q)) : 0) - (bonus ? bonus[k]! : 0);
    if (e < bestCost - 1e-12) [best, bestCost] = [k, e];
  }
  return best;
}

/**
 * Time a cut saves by starting at each vertex: the slow-down for that corner it no longer makes. Crossing a corner
 * at vj instead of v costs (v − vj)² / (a v).
 */
export function cornerSavings(r: Vec[], v: number, a: number): Float64Array {
  const m = r.length;
  const out = new Float64Array(m);
  if (m < 3) return out;
  for (let k = 0; k < m; k++) {
    const p = r[(k + m - 1) % m]!;
    const q = r[k]!;
    const s = r[(k + 1) % m]!;
    const l1 = dist(p, q);
    const l2 = dist(q, s);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const vj = junctionSpeed((q.x - p.x) / l1, (q.y - p.y) / l1, (s.x - q.x) / l2, (s.y - q.y) / l2, v, a);
    out[k] = ((v - vj) * (v - vj)) / (a * v);
  }
  return out;
}

/** Pieces for the tour, with containment: clusters for letters, precedence for larger containers. */
function buildNodes(items: OrderItem[], rings: Vec[][], innerFirst: boolean, clusters: boolean): Node[] {
  const N = items.length;
  const closed = items.map((_, i) => i).filter((i) => items[i]!.closed && rings[i]!.length >= 3);
  const parent = new Int32Array(N).fill(-1);
  if (innerFirst && closed.length <= INNER_FIRST_LIMIT) {
    // inside(j, i): closed j lies inside closed i. Equal boxes (duplicates): the higher index is the inner one.
    const sorted = [...closed].sort((a, b) => area(items[a]!.box) - area(items[b]!.box) || b - a);
    const rank = new Int32Array(N);
    sorted.forEach((i, r) => (rank[i] = r));
    for (const j of closed) {
      const b = items[j]!.box;
      let best = -1;
      for (const i of closed) {
        if (i === j) continue;
        const B = items[i]!.box;
        if (b.minX < B.minX || b.minY < B.minY || b.maxX > B.maxX || b.maxY > B.maxY) continue;
        const same = b.minX === B.minX && b.minY === B.minY && b.maxX === B.maxX && b.maxY === B.maxY;
        if (same ? j < i : !pointInPolygon(rings[j]![0]!, rings[i]!)) continue;
        // The tightest container is the direct parent.
        if (best < 0 || rank[i]! < rank[best]!) best = i;
      }
      parent[j] = best;
    }
  }
  const children: number[][] = items.map(() => []);
  for (let j = 0; j < N; j++) if (parent[j]! >= 0) children[parent[j]!]!.push(j);
  const height = new Int32Array(N).fill(-1);
  const h = (i: number): number => {
    if (height[i]! >= 0) return height[i]!;
    let m = 0;
    for (const ch of children[i]!) m = Math.max(m, 1 + h(ch));
    return (height[i] = m);
  };
  // A cluster: an outline whose counters have nothing inside them (a letter, a washer).
  const isCluster = (i: number) => clusters && h(i) === 1 && children[i]!.length <= CLUSTER_MAX;
  const nodeOf = new Int32Array(N).fill(-1);
  const nodes: Node[] = [];
  for (let i = 0; i < N; i++) {
    if (parent[i]! >= 0 && isCluster(parent[i]!)) continue; // a counter: part of its letter
    nodeOf[i] = nodes.length;
    const cl = items[i]!.closed && isCluster(i);
    nodes.push({ kind: !items[i]!.closed || rings[i]!.length < 3 ? 1 : cl ? 2 : 0, item: i, holes: cl ? children[i]! : [], box: items[i]!.box, preds: [], succs: [] });
  }
  for (let i = 0; i < N; i++) if (nodeOf[i]! < 0) nodeOf[i] = nodeOf[parent[i]!]!;
  // Containers wait for every piece inside them.
  for (let i = 0; i < N; i++) {
    const x = nodeOf[i]!;
    for (let p = parent[i]!; p >= 0; p = parent[p]!) {
      const y = nodeOf[p]!;
      if (y === x) continue;
      nodes[y]!.preds.push(x);
      nodes[x]!.succs.push(y);
    }
  }
  for (const nd of nodes) {
    nd.preds = [...new Set(nd.preds)];
    nd.succs = [...new Set(nd.succs)];
  }
  return nodes;
}

/** Nearest ready piece next (by its nearest point), from `from`. */
function nearestTour(nodes: Node[], rings: Vec[][], variantsOf: (i: number) => Vec[][], from: Vec, place: (x: number, p: Vec, q: Vec | undefined, both: boolean) => void, outPt: Vec[]): number[] {
  const n = nodes.length;
  const waiting = new Int32Array(n);
  nodes.forEach((nd, x) => (waiting[x] = nd.preds.length));
  const done = new Uint8Array(n);
  const near = (x: number, p: Vec, bound: number): number => {
    const nd = nodes[x]!;
    if (nd.kind === 1) {
      let d = Infinity;
      for (const r of variantsOf(nd.item)) d = Math.min(d, dist(p, r[0]!), dist(p, r.at(-1)!));
      return d;
    }
    let d = Infinity;
    for (const i of nd.kind === 2 ? nd.holes : [nd.item]) {
      for (const v of rings[i]!) d = Math.min(d, dist(p, v));
      if (d < bound) bound = d;
    }
    return d;
  };
  const tour: number[] = [];
  const bd = new Float64Array(n);
  let pos = from;
  for (let step = 0; step < n; step++) {
    let [best, bestD] = [-1, Infinity];
    // Seed with the nearest box, so the bound below prunes most of the rest.
    let [seed, seedB] = [-1, Infinity];
    for (let x = 0; x < n; x++) {
      if (done[x] || waiting[x]! > 0) continue;
      const b = boxDist(nodes[x]!.box, pos);
      bd[x] = b;
      if (b < seedB) [seed, seedB] = [x, b];
    }
    if (seed >= 0) [best, bestD] = [seed, near(seed, pos, Infinity)];
    for (let x = 0; x < n; x++) {
      if (x === seed || done[x] || waiting[x]! > 0) continue;
      if (bd[x]! >= bestD) continue;
      const d = near(x, pos, bestD);
      if (d < bestD) [best, bestD] = [x, d];
    }
    if (best < 0) best = done.indexOf(0); // only through a containment cycle
    done[best] = 1;
    for (const s of nodes[best]!.succs) waiting[s]!--;
    tour.push(best);
    place(best, pos, undefined, false);
    pos = outPt[best]!;
  }
  return tour;
}

/** Start points and directions for every piece, given its neighbours in the tour. */
function placeAll(tour: number[], from: Vec, to: Vec | undefined, place: (x: number, p: Vec, q: Vec | undefined, both: boolean) => void, inPt: Vec[], outPt: Vec[], both: boolean, passes = 2): void {
  for (let pass = 0; pass < (both ? passes : 1); pass++) {
    for (let k = 0; k < tour.length; k++) {
      const p = k === 0 ? from : outPt[tour[k - 1]!]!;
      const q = k === tour.length - 1 ? to : inPt[tour[k + 1]!];
      place(tour[k]!, p, q, both);
    }
  }
}

/** 2-opt and Or-opt with neighbour lists, first improvement. Returns whether the tour changed. */
function search(
  tour: number[],
  nodes: Node[],
  from: Vec,
  to: Vec | undefined,
  c: (d: number) => number,
  A: Vec[],
  B: Vec[],
  flip: Uint8Array,
  tune: { twoOpt: boolean; orOpt: boolean },
  budget: { left: number },
): boolean {
  const n = tour.length;
  const pos = new Int32Array(nodes.length);
  const reindex = (lo: number, hi: number) => {
    for (let k = lo; k <= hi; k++) pos[tour[k]!] = k;
  };
  reindex(0, n - 1);
  // Entry and exit of the piece at tour index k, in the search's symmetric model; a reversed piece swaps them.
  const ent = (x: number) => A[x]!;
  const ext = (x: number) => B[x]!;
  const prevOut = (k: number) => (k === 0 ? from : ext(tour[k - 1]!));
  const nextIn = (k: number) => (k === n - 1 ? to : ent(tour[k + 1]!));
  const cc = (p: Vec, q: Vec | undefined) => (q ? c(dist(p, q)) : 0);
  const reverseNode = (x: number) => {
    if (nodes[x]!.kind === 1) {
      flip[x] = flip[x] ? 0 : 1;
      [A[x], B[x]] = [B[x]!, A[x]!];
    }
  };
  const neighbours = knn(nodes, tour, A, B);
  // The pieces nearest the start and the target: candidates to begin or end the tour.
  const nearest = (p: Vec | undefined) => {
    if (!p) return new Set<number>();
    const d = tour.map((x) => Math.min(dist(p, A[x]!), dist(p, B[x]!)));
    return new Set([...tour.keys()].sort((a, b) => d[a]! - d[b]!).slice(0, K).map((k) => tour[k]!));
  };
  const nearFrom = nearest(from);
  const nearTo = nearest(to);
  const hasPreds = nodes.some((nd) => nd.preds.length);

  /** Reversing tour[l..r] keeps every container after what's inside it. */
  const canReverse = (l: number, r: number) => {
    if (!hasPreds) return true;
    for (let k = l; k <= r; k++) for (const p of nodes[tour[k]!]!.preds) if (pos[p]! >= l && pos[p]! < k) return false;
    return true;
  };
  /** Moving tour[s..e] to between j-1 and j keeps precedence (and so does reversing it, if `rev`). */
  const canMove = (s: number, e: number, j: number, rev: boolean) => {
    if (!hasPreds) return true;
    for (let k = s; k <= e; k++) {
      const nd = nodes[tour[k]!]!;
      if (j > e) for (const y of nd.succs) if (pos[y]! > e && pos[y]! < j) return false;
      if (j < s) for (const y of nd.preds) if (pos[y]! >= j && pos[y]! < s) return false;
    }
    return !rev || canReverse(s, e);
  };

  const reverse = (l: number, r: number) => {
    for (let a = l, b = r; a < b; a++, b--) [tour[a], tour[b]] = [tour[b]!, tour[a]!];
    for (let k = l; k <= r; k++) reverseNode(tour[k]!);
    reindex(l, r);
  };
  const move = (s: number, e: number, j: number, rev: boolean) => {
    const seg = tour.splice(s, e - s + 1);
    if (rev) {
      seg.reverse();
      seg.forEach(reverseNode);
    }
    const at = j > e ? j - seg.length : j;
    tour.splice(at, 0, ...seg);
    reindex(Math.min(s, at), Math.max(e, at + seg.length - 1));
  };

  // Work queue of pieces whose links may improve ("don't look" bits): all at first, then the ends of changed links.
  const queue: number[] = [...tour];
  const queued = new Uint8Array(nodes.length).fill(1);
  const touch = (...ks: number[]) => {
    for (const k of ks) {
      if (k < 0 || k >= n) continue;
      const x = tour[k]!;
      if (!queued[x]) {
        queued[x] = 1;
        queue.push(x);
      }
    }
  };
  const doReverse = (l: number, r: number) => {
    reverse(l, r);
    touch(l - 1, l, r, r + 1);
  };

  /** One improving move around x, if there is one. */
  const tryNode = (x: number): boolean => {
    const k = pos[x]!;
    if (tune.twoOpt) {
      const p = prevOut(k);
      const oldIn = cc(p, ent(x));
      const z = k < n - 1 ? tour[k + 1]! : -1;
      const oldOut = z >= 0 ? cc(ext(x), ent(z)) : 0;
      // End the tour with x (reverse k..n-1), next to the target.
      if (to && nearTo.has(x) && k < n - 1) {
        const l = tour[n - 1]!;
        budget.left--;
        if (cc(p, ext(l)) + cc(ent(x), to) - oldIn - cc(ext(l), to) < -1e-9 && canReverse(k, n - 1)) return doReverse(k, n - 1), true;
      }
      // Begin the tour with x (reverse 0..k), next to the start.
      if (nearFrom.has(x) && k > 0) {
        const f = tour[0]!;
        const q = nextIn(k);
        budget.left--;
        if (cc(from, ext(x)) + cc(ent(f), q) - cc(from, ent(f)) - cc(ext(x), q) < -1e-9 && canReverse(0, k)) return doReverse(0, k), true;
      }
      for (const w of neighbours[x]!) {
        budget.left--;
        const j = pos[w]!;
        // Link x's predecessor to w.
        if (j > k) {
          // Reverse k..j.
          const q = nextIn(j);
          if (cc(p, ext(w)) + cc(ent(x), q) - oldIn - cc(ext(w), q) < -1e-9 && canReverse(k, j)) return doReverse(k, j), true;
        } else if (j < k - 1) {
          // Reverse j+1..k-1.
          const y = tour[k - 1]!;
          const u = tour[j + 1]!;
          if (cc(ext(w), ext(y)) + cc(ent(u), ent(x)) - cc(ext(w), ent(u)) - oldIn < -1e-9 && canReverse(j + 1, k - 1)) return doReverse(j + 1, k - 1), true;
        }
        // Link x to w as its successor.
        if (z >= 0 && j > k + 1) {
          // Reverse k+1..j.
          const q = nextIn(j);
          if (cc(ext(x), ext(w)) + cc(ent(z), q) - oldOut - cc(ext(w), q) < -1e-9 && canReverse(k + 1, j)) return doReverse(k + 1, j), true;
        } else if (j < k) {
          // Reverse j..k.
          const pw = prevOut(j);
          const q = nextIn(k);
          if (cc(pw, ext(x)) + cc(ent(w), q) - cc(pw, ent(w)) - cc(ext(x), q) < -1e-9 && canReverse(j, k)) return doReverse(j, k), true;
        }
      }
    }
    // Or-opt: move the run starting at x (1–3 pieces) next to a neighbour of its first or last piece, either way round.
    if (tune.orOpt) {
      for (let len = 1; len <= 3 && k + len - 1 < n; len++) {
        const e = k + len - 1;
        const first = tour[k]!;
        const last = tour[e]!;
        const p = prevOut(k);
        const q = nextIn(e);
        const gain = cc(p, ent(first)) + cc(ext(last), q) - cc(p, q);
        if (gain <= 1e-9) continue;
        const near = len > 1 ? [...neighbours[first]!, ...neighbours[last]!] : neighbours[first]!;
        for (const w of near) {
          const j0 = pos[w]!;
          if (j0 >= k && j0 <= e) continue;
          // Insert before w (between j0-1 and j0) or after it (between j0 and j0+1).
          for (const j of [j0, j0 + 1]) {
            if (j >= k && j <= e + 1) continue;
            budget.left--;
            const u = j === 0 ? from : ext(tour[j - 1]!);
            const v = j === n ? to : ent(tour[j]!);
            const base = cc(u, v);
            const fwd = cc(u, ent(first)) + cc(ext(last), v) - base;
            const rev = cc(u, ext(last)) + cc(ent(first), v) - base;
            const r = rev < fwd - 1e-9;
            if (Math.min(fwd, rev) < gain - 1e-9 && canMove(k, e, j, r)) {
              move(k, e, j, r);
              const at = pos[first]!;
              touch(k - 1, k, at - 1, at, at + len - 1, at + len, pos[last]! - 1, pos[last]! + 1);
              return true;
            }
          }
        }
      }
    }
    return false;
  };

  let changed = false;
  while (queue.length && budget.left > 0) {
    const x = queue.shift()!;
    queued[x] = 0;
    if (tryNode(x)) {
      changed = true;
      touch(pos[x]!);
    }
  }
  return changed;
}

/** K nearest pieces of each piece, by their tour points (both ends of an open path); a k-d tree over the points. */
function knn(nodes: Node[], tour: number[], A: Vec[], B: Vec[]): number[][] {
  const px: number[] = [];
  const py: number[] = [];
  const owner: number[] = [];
  for (const x of tour) {
    for (const p of nodes[x]!.kind === 1 ? [A[x]!, B[x]!] : [A[x]!]) {
      px.push(p.x);
      py.push(p.y);
      owner.push(x);
    }
  }
  const m = px.length;
  // Implicit k-d tree: idx[lo..hi) is split at its median along x or y by depth.
  const idx = new Int32Array(m);
  for (let i = 0; i < m; i++) idx[i] = i;
  const build = (lo: number, hi: number, depth: number) => {
    if (hi - lo <= 1) return;
    const key = depth % 2 ? py : px;
    const sub = Array.from(idx.subarray(lo, hi)).sort((a, b) => key[a]! - key[b]!);
    idx.set(sub, lo);
    const mid = (lo + hi) >> 1;
    build(lo, mid, depth + 1);
    build(mid + 1, hi, depth + 1);
  };
  build(0, m, 0);
  // Best K distinct owners so far (small arrays, kept sorted by distance).
  let bestD: number[] = [];
  let bestX: number[] = [];
  const offer = (d: number, x: number) => {
    const at = bestX.indexOf(x);
    if (at >= 0) {
      if (d >= bestD[at]!) return;
      bestD.splice(at, 1);
      bestX.splice(at, 1);
    }
    if (bestD.length >= K && d >= bestD[K - 1]!) return;
    let i = bestD.length;
    while (i > 0 && bestD[i - 1]! > d) i--;
    bestD.splice(i, 0, d);
    bestX.splice(i, 0, x);
    if (bestD.length > K) {
      bestD.length = K;
      bestX.length = K;
    }
  };
  const query = (qx: number, qy: number, self: number, lo: number, hi: number, depth: number) => {
    if (hi <= lo) return;
    const mid = (lo + hi) >> 1;
    const i = idx[mid]!;
    if (owner[i] !== self) offer(Math.hypot(px[i]! - qx, py[i]! - qy), owner[i]!);
    const diff = depth % 2 ? qy - py[i]! : qx - px[i]!;
    const [near, far] = diff < 0 ? [[lo, mid], [mid + 1, hi]] : [[mid + 1, hi], [lo, mid]];
    query(qx, qy, self, near[0]!, near[1]!, depth + 1);
    if (bestD.length < K || Math.abs(diff) < bestD[bestD.length - 1]!) query(qx, qy, self, far[0]!, far[1]!, depth + 1);
  };
  const out: number[][] = nodes.map(() => []);
  for (const x of tour) {
    bestD = [];
    bestX = [];
    for (const p of nodes[x]!.kind === 1 ? [A[x]!, B[x]!] : [A[x]!]) query(p.x, p.y, x, 0, m, 0);
    out[x] = bestX;
  }
  return out;
}
