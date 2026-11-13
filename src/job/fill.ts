// Fill (engraving) as vector hatch: turn closed outlines into burn polylines that the job encoder sends as ordinary
// cuts (only commands verified on the machine). All closed paths of a layer are filled together with the even-odd
// rule, so holes stay empty. Units: bed millimetres, internal orientation.
import { t } from "../i18n";
import ClipperLib, { type PolyNodeType } from "clipper-lib";
import { type Vec, pathsBox } from "../geom/geom";
import { DEFAULT_PROFILE, type SweepMode } from "../scene/model";
import { orderItems, travelTime } from "./order";

export type FillPattern = "lines" | "cross" | "dots" | "offset";

export interface FillSettings {
  pattern: FillPattern;
  /** Line / dot / contour spacing, mm. */
  interval: number;
  /** Line direction (and dot grid rotation), degrees. */
  angle: number;
}

export const DEFAULT_FILL: FillSettings = { pattern: "lines", interval: 0.1, angle: 0 };

/** Beyond this many burn polylines a fill is refused (it would make a huge, slow job). */
export const MAX_FILL_PATHS = 200_000;

export interface FillResult {
  paths: Vec[][];
  /** Set when the fill was refused (too dense); `paths` is then empty. */
  error?: string;
}

/**
 * Burn polylines for the closed polygons, in burn order, starting near `from` when given. `sweep` "together" sweeps
 * every part that shares rows in one go (row by row across the gaps); otherwise the quicker choice per pair.
 */
export function fillPaths(polys: Vec[][], s: FillSettings, from?: Vec, sweep: SweepMode = "quick"): FillResult {
  const rings = polys.filter((p) => p.length >= 3);
  const interval = Math.max(0.01, s.interval);
  if (rings.length === 0) return { paths: [] };
  try {
    let paths: Vec[][];
    switch (s.pattern) {
      case "lines":
        paths = hatch(rings, s.angle, interval, "lines", from, sweep);
        break;
      case "cross": {
        // The second direction starts where the first one ended.
        const first = hatch(rings, s.angle, interval, "lines", from, sweep);
        paths = [...first, ...hatch(rings, s.angle + 90, interval, "lines", first.at(-1)?.at(-1) ?? from, sweep)];
        break;
      }
      case "dots":
        paths = hatch(rings, s.angle, interval, "dots", from, sweep);
        break;
      case "offset":
        paths = orderContours(contours(rings, interval), from);
        break;
    }
    return { paths };
  } catch (e) {
    if (e instanceof TooDense) return { paths: [], error: e.message };
    throw e;
  }
}

class TooDense extends Error {}
export const tooDenseMessage = () => t("Fill is too dense (over {n} burn lines). Increase the interval or fill a smaller area.", { n: MAX_FILL_PATHS.toLocaleString() });
const tooDense = () => new TooDense(tooDenseMessage());

const rot = (p: Vec, c: number, s: number): Vec => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c });

/** One scanline's piece inside the outline, in the rotated (scan) frame. */
interface Span {
  row: number;
  y: number;
  l: number;
  r: number;
}

/**
 * Scanline hatch at `angleDeg`: rotate the outline so lines are horizontal, intersect each scanline with every
 * edge (even-odd pairs), rotate back. "dots" puts short burns on a grid along the same scanlines instead.
 *
 * Order: the spans are split into cells, runs of rows with one span each that overlap from row to row (a U shape
 * is three cells: the bottom and each arm). Neighbouring cells that share rows are swept together when crossing
 * the gap on every row is shorter than the jump between them (the same rule as for separate areas); otherwise each
 * cell is swept on its own, back and forth (bidirectional), so a sweep never jumps across a gap on every row.
 * The sweeps are ordered by travel time from `from` (`order.ts`), each entered at whichever corner suits.
 */
function hatch(rings: Vec[][], angleDeg: number, interval: number, kind: "lines" | "dots", from?: Vec, sweep: SweepMode = "quick"): Vec[][] {
  const a = (angleDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(-a), Math.sin(-a)];
  const local = rings.map((r) => r.map((p) => rot(p, c, s)));
  let y0 = Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  for (const r of local) for (const p of r) [y0, y1, x0] = [Math.min(y0, p.y), Math.max(y1, p.y), Math.min(x0, p.x)];
  const back = (p: Vec) => rot(p, Math.cos(a), Math.sin(a));
  const dot = Math.min(0.1, interval / 2); // length of one dot burn
  let count = 0;

  // Cells: runs of spans, one per row, each overlapping the previous one and nothing else.
  const cells: Span[][] = [];
  let prev: { span: Span; cell: number }[] = [];
  let row = 0;
  for (let y = y0 + interval / 2; y < y1; y += interval, row++) {
    const xs: number[] = [];
    for (const r of local) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const p = r[i]!;
        const q = r[j]!;
        if (p.y > y !== q.y > y) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
      }
    }
    xs.sort((m, n) => m - n);
    const spans: Span[] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > 1e-9) spans.push({ row, y, l: xs[k]!, r: xs[k + 1]! });
    count += spans.length;
    if (count > MAX_FILL_PATHS) throw tooDense();
    // Overlaps between the previous row's spans and this row's (both sorted and disjoint: one merge pass).
    const up = new Int32Array(spans.length);
    const upOf = new Int32Array(spans.length).fill(-1);
    const down = new Int32Array(prev.length);
    for (let i = 0, j = 0; i < prev.length && j < spans.length; ) {
      const p = prev[i]!.span;
      const q = spans[j]!;
      if (p.l < q.r && q.l < p.r) {
        up[j]!++;
        upOf[j] = i;
        down[i]!++;
      }
      if (p.r < q.r) i++;
      else j++;
    }
    prev = spans.map((span, j) => {
      const i = upOf[j]!;
      if (up[j] === 1 && down[i] === 1) {
        const cell = prev[i]!.cell;
        cells[cell]!.push(span);
        return { span, cell };
      }
      cells.push([span]);
      return { span, cell: cells.length - 1 };
    });
  }
  // Sweeps: groups of cells swept together, row by row.
  const groups = groupCells(cells, interval, sweep === "together");
  const pieces = (sp: Span, rev: boolean): Vec[][] => {
    if (kind === "lines") return [rev ? [back({ x: sp.r, y: sp.y }), back({ x: sp.l, y: sp.y })] : [back({ x: sp.l, y: sp.y }), back({ x: sp.r, y: sp.y })]];
    // Dots on a fixed grid (aligned across rows), only where the grid point lies inside the span.
    const out: Vec[][] = [];
    for (let x = x0 + interval / 2 + Math.ceil((sp.l - x0 - interval / 2) / interval) * interval; x + dot <= sp.r + 1e-9; x += interval) out.push([back({ x, y: sp.y }), back({ x: x + dot, y: sp.y })]);
    if (rev) {
      out.reverse();
      for (const p of out) p.reverse();
    }
    return out;
  };
  // A group's rows (spans sorted by x within each row), first to last.
  const rowsOf = (g: Span[][]): Span[][] => {
    const byRow = new Map<number, Span[]>();
    for (const cell of g) for (const sp of cell) byRow.set(sp.row, [...(byRow.get(sp.row) ?? []), sp]);
    return [...byRow.keys()].sort((m, n) => m - n).map((r) => byRow.get(r)!.sort((m, n) => m.l - n.l));
  };
  const sweeps = groups.map(rowsOf);
  // Entry options: from the first or the last row, starting at the left or the right; rows alternate after that.
  const corner = (rows: Span[][], fromEnd: boolean, right: boolean) => {
    const first = fromEnd ? rows.at(-1)! : rows[0]!;
    const last = fromEnd ? rows[0]! : rows.at(-1)!;
    const revLast = ((rows.length - 1) % 2 === 1) !== right;
    return {
      start: { x: right ? first.at(-1)!.r : first[0]!.l, y: first[0]!.y },
      end: { x: revLast ? last[0]!.l : last.at(-1)!.r, y: last[0]!.y },
    };
  };
  // Sweep order by travel time (`order.ts`): each sweep as its two corner entries, each runnable backwards.
  const items = sweeps.map((rows) => {
    const variants = [false, true].map((right) => {
      const k = corner(rows, false, right);
      return [back(k.start), back(k.end)];
    });
    return { pts: variants[0]!, closed: false, box: pathsBox(variants.map((points) => ({ points, closed: false }))), variants };
  });
  const out: Vec[][] = [];
  for (const o of orderItems(items, from ?? back({ x: x0, y: y0 }), { cost: travelTime(DEFAULT_PROFILE), innerFirst: false })) {
    const right = o.variant === 1;
    const part: Vec[][] = [];
    sweeps[o.i]!.forEach((spans, k) => {
      // Odd rows (counted from the first) run back the other way.
      const rev = (k % 2 === 1) !== right;
      for (const sp of rev ? [...spans].reverse() : spans) part.push(...pieces(sp, rev));
      if (out.length + part.length > MAX_FILL_PATHS) throw tooDense();
    });
    if (o.reversed) {
      part.reverse();
      for (const p of part) p.reverse();
    }
    out.push(...part);
    if (out.length > MAX_FILL_PATHS) throw tooDense();
  }
  return out;
}

/** Above this many cells, each cell is swept on its own (the pairwise test is O(n²)). */
const CELL_GROUP_LIMIT = 2000;

/**
 * Which cells to sweep together: two cells that share rows, when crossing the gap between them on every shared
 * row is shorter than jumping from one to the other once (centre to centre), or always with `together`. Rows are
 * `interval` apart.
 */
function groupCells(cells: Span[][], interval: number, together = false): Span[][][] {
  if (cells.length > CELL_GROUP_LIMIT) return cells.map((c) => [c]);
  const box = cells.map((cell) => {
    let [x0, x1] = [Infinity, -Infinity];
    for (const sp of cell) [x0, x1] = [Math.min(x0, sp.l), Math.max(x1, sp.r)];
    return { x0, x1, r0: cell[0]!.row, r1: cell.at(-1)!.row, y0: cell[0]!.y, y1: cell.at(-1)!.y };
  });
  const parent = cells.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const [A, B] = [box[i]!, box[j]!];
      const shared = Math.min(A.r1, B.r1) - Math.max(A.r0, B.r0) + 1;
      if (shared <= 0) continue;
      const gap = Math.max(0, B.x0 - A.x1, A.x0 - B.x1);
      const jump = Math.hypot((A.x0 + A.x1 - B.x0 - B.x1) / 2, (A.y0 + A.y1 - B.y0 - B.y1) / 2);
      if (together || shared * gap < jump) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Span[][]>();
  cells.forEach((cell, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), cell]));
  return [...groups.values()];
}

const UM = 1000; // Clipper works in integers: µm

/** Concentric contours stepping inward by `interval` (the first half an interval inside the outline), level by level. */
function contours(rings: Vec[][], interval: number): Vec[][][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(rings.map((r) => r.map((p) => ({ X: Math.round(p.x * UM), Y: Math.round(p.y * UM) }))), ClipperLib.PolyType.ptSubject, true);
  let cur = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, cur, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  const levels: Vec[][][] = [];
  let count = 0;
  let step = -interval / 2;
  for (let n = 0; n < 100_000 && cur.length > 0; n++) {
    const co = new ClipperLib.ClipperOffset(2, 0.01 * UM); // round joins, 10 µm arc tolerance
    co.AddPaths(cur, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const next = new ClipperLib.Paths();
    co.Execute(next, step * UM);
    const level: Vec[][] = [];
    for (const path of next) {
      if (path.length < 3) continue;
      level.push(path.map((p) => ({ x: p.X / UM, y: p.Y / UM })));
      if (++count > MAX_FILL_PATHS) throw tooDense();
    }
    if (level.length) levels.push(level);
    cur = next;
    step = -interval;
  }
  return levels;
}

const segDist = (p: Vec, a: Vec, b: Vec) => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const len = dx * dx + dy * dy;
  const k = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
};
const ringDist = (p: Vec, ring: Vec[]) => {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) d = Math.min(d, segDist(p, ring[j]!, ring[i]!));
  return d;
};

/**
 * Contour burn order: outside in. Each ring waits for its parent (the nearest ring one level further out), so a
 * branch is followed inward to its end before the head moves on; the next ring is the nearest one that's ready,
 * entered at its vertex nearest the head. Rings come back closed (last point = first).
 */
function orderContours(levels: Vec[][][], from?: Vec): Vec[][] {
  const rings: { pts: Vec[]; parent: number }[] = [];
  const base: number[] = [];
  levels.forEach((level, n) => {
    base.push(rings.length);
    for (const pts of level) {
      let parent = -1;
      if (n > 0) {
        let best = Infinity;
        levels[n - 1]!.forEach((outer, k) => {
          const d = ringDist(pts[0]!, outer);
          if (d < best) [best, parent] = [d, base[n - 1]! + k];
        });
      }
      rings.push({ pts, parent });
    }
  });
  const done = new Uint8Array(rings.length);
  const out: Vec[][] = [];
  let pos = from ?? rings[0]?.pts[0];
  for (let n = 0; n < rings.length && pos; n++) {
    let [best, bestD, bestK] = [-1, Infinity, 0];
    rings.forEach((r, i) => {
      if (done[i] || (r.parent >= 0 && !done[r.parent])) return;
      r.pts.forEach((v, k) => {
        const d = Math.hypot(v.x - pos!.x, v.y - pos!.y);
        if (d < bestD) [best, bestD, bestK] = [i, d, k];
      });
    });
    done[best] = 1;
    const pts = rings[best]!.pts;
    const ring = [...pts.slice(bestK), ...pts.slice(0, bestK)];
    ring.push({ ...ring[0]! });
    out.push(ring);
    pos = ring[0];
  }
  return out;
}

/**
 * Separate filled areas ("islands": an outline plus its holes) from groups of rings. Each group is read even-odd
 * (a shape and the shapes inside it); groups are then united, so overlapping regions don't cancel each other.
 */
export function fillIslands(groups: Vec[][][]): Vec[][][] {
  const toC = (r: Vec[]) => r.map((p) => ({ X: Math.round(p.x * UM), Y: Math.round(p.y * UM) }));
  const all = new ClipperLib.Clipper();
  for (const g of groups) {
    const rings = g.filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const c = new ClipperLib.Clipper();
    c.AddPaths(rings.map(toC), ClipperLib.PolyType.ptSubject, true);
    const solved = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, solved, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    if (solved.length) all.AddPaths(solved, ClipperLib.PolyType.ptSubject, true);
  }
  const tree = new ClipperLib.PolyTree();
  all.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  const fromC = (path: { X: number; Y: number }[]) => path.map((p) => ({ x: p.X / UM, y: p.Y / UM }));
  const out: Vec[][][] = [];
  // Children of the root and of holes are outlines; children of outlines are their holes.
  const visit = (node: PolyNodeType) => {
    for (const outer of node.Childs()) {
      out.push([fromC(outer.Contour()), ...outer.Childs().map((h) => fromC(h.Contour()))]);
      for (const hole of outer.Childs()) visit(hole);
    }
  };
  visit(tree);
  return out;
}
