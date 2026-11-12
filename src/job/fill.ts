// Fill (engraving) as vector hatch: turn closed outlines into burn polylines that the job encoder sends as ordinary
// cuts (only commands verified on the machine). All closed paths of a layer are filled together with the even-odd
// rule, so holes stay empty. Units: bed millimetres, internal orientation.
import { t } from "../i18n";
import ClipperLib, { type PolyNodeType } from "clipper-lib";
import type { Vec } from "../geom/geom";

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

/** Burn polylines for the closed polygons, in burn order. */
export function fillPaths(polys: Vec[][], s: FillSettings): FillResult {
  const rings = polys.filter((p) => p.length >= 3);
  const interval = Math.max(0.01, s.interval);
  if (rings.length === 0) return { paths: [] };
  try {
    let paths: Vec[][];
    switch (s.pattern) {
      case "lines":
        paths = hatch(rings, s.angle, interval, "lines");
        break;
      case "cross":
        paths = [...hatch(rings, s.angle, interval, "lines"), ...hatch(rings, s.angle + 90, interval, "lines")];
        break;
      case "dots":
        paths = hatch(rings, s.angle, interval, "dots");
        break;
      case "offset":
        paths = contours(rings, interval);
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

/**
 * Scanline hatch at `angleDeg`: rotate the outline so lines are horizontal, intersect each scanline with every
 * edge (even-odd pairs), rotate back. Lines alternate direction (bidirectional). "dots" puts short burns on a grid
 * along the same scanlines instead of continuous lines.
 */
function hatch(rings: Vec[][], angleDeg: number, interval: number, kind: "lines" | "dots"): Vec[][] {
  const a = (angleDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(-a), Math.sin(-a)];
  const local = rings.map((r) => r.map((p) => rot(p, c, s)));
  let y0 = Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  for (const r of local) for (const p of r) [y0, y1, x0] = [Math.min(y0, p.y), Math.max(y1, p.y), Math.min(x0, p.x)];
  const back = (p: Vec) => rot(p, Math.cos(a), Math.sin(a));
  const dot = Math.min(0.1, interval / 2); // length of one dot burn
  const out: Vec[][] = [];
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
    const spans: [number, number][] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1]! - xs[k]! > 1e-9) spans.push([xs[k]!, xs[k + 1]!]);
    const rowPaths: Vec[][] = [];
    for (const [l, r] of spans) {
      if (kind === "lines") rowPaths.push([back({ x: l, y }), back({ x: r, y })]);
      else {
        // Dots on a fixed grid (aligned across rows), only where the grid point lies inside the span.
        for (let x = x0 + interval / 2 + Math.ceil((l - x0 - interval / 2) / interval) * interval; x + dot <= r + 1e-9; x += interval) {
          rowPaths.push([back({ x, y }), back({ x: x + dot, y })]);
          if (out.length + rowPaths.length > MAX_FILL_PATHS) throw tooDense();
        }
      }
    }
    if (row % 2 === 1) {
      rowPaths.reverse();
      for (const p of rowPaths) p.reverse();
    }
    out.push(...rowPaths);
    if (out.length > MAX_FILL_PATHS) throw tooDense();
  }
  return out;
}

const UM = 1000; // Clipper works in integers: µm

/** Concentric contours stepping inward by `interval` (the first half an interval inside the outline). */
function contours(rings: Vec[][], interval: number): Vec[][] {
  const c = new ClipperLib.Clipper();
  c.AddPaths(rings.map((r) => r.map((p) => ({ X: Math.round(p.x * UM), Y: Math.round(p.y * UM) }))), ClipperLib.PolyType.ptSubject, true);
  let cur = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, cur, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  const out: Vec[][] = [];
  let step = -interval / 2;
  for (let n = 0; n < 100_000 && cur.length > 0; n++) {
    const co = new ClipperLib.ClipperOffset(2, 0.01 * UM); // round joins, 10 µm arc tolerance
    co.AddPaths(cur, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const next = new ClipperLib.Paths();
    co.Execute(next, step * UM);
    for (const path of next) {
      if (path.length < 3) continue;
      const pts = path.map((p) => ({ x: p.X / UM, y: p.Y / UM }));
      pts.push({ ...pts[0]! }); // closed loop
      out.push(pts);
      if (out.length > MAX_FILL_PATHS) throw tooDense();
    }
    cur = next;
    step = -interval;
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
