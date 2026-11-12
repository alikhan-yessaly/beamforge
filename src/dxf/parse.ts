// Minimal ASCII DXF reader: turns 2D entities into polylines in DXF units (Y up).
// Supported: LINE, LWPOLYLINE (bulges), POLYLINE/VERTEX, ARC, CIRCLE, ELLIPSE, SPLINE, INSERT (incl. arrays), SOLID/TRACE outlines.
import { aciToHex } from "./aci";
import { IDENTITY, type Mat, type Polyline, type Seg, type Vec, apply, mul, rotate, scale, translate } from "../geom/geom";

export type DxfSeg = Seg;

export interface DxfPath extends Polyline {
  /** CSS hex colour resolved from the entity, BYLAYER or BYBLOCK. */
  color: string;
  layer: string;
  /** The path as lines and arcs, or null for curves that only exist as points here (ellipses, splines). */
  segs: DxfSeg[] | null;
}

export interface DxfResult {
  paths: DxfPath[];
  /** Millimetres per drawing unit. */
  unitScale: number;
  /** Units as declared by $INSUNITS ("unitless" means we assumed mm). */
  units: string;
  warnings: string[];
}

interface Pair {
  code: number;
  value: string;
}

interface RawEntity {
  type: string;
  pairs: Pair[];
  /** VERTEX children of a POLYLINE. */
  vertices?: RawEntity[];
}

interface Block {
  base: Vec;
  entities: RawEntity[];
}

const UNITS: Record<number, [string, number]> = {
  0: ["unitless", 1],
  1: ["in", 25.4],
  2: ["ft", 304.8],
  4: ["mm", 1],
  5: ["cm", 10],
  6: ["m", 1000],
  8: ["µin", 25.4e-6],
  9: ["mil", 0.0254],
  10: ["yd", 914.4],
  13: ["µm", 0.001],
  14: ["dm", 100],
};

/** Max chord deviation (in drawing units scaled to mm afterwards; good enough for laser work). */
const TOL = 0.01;

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) throw new Error(`Bad DXF group code at line ${i + 1}: "${lines[i]}" (binary DXF is not supported)`);
    out.push({ code, value: lines[i + 1]!.trim() });
  }
  return out;
}

/** Split a pair stream (starting at a 0-code) into entities, grouping POLYLINE vertices. */
function toEntities(pairs: Pair[]): RawEntity[] {
  const flat: RawEntity[] = [];
  for (const p of pairs) {
    if (p.code === 0) flat.push({ type: p.value, pairs: [] });
    else flat.at(-1)?.pairs.push(p);
  }
  const out: RawEntity[] = [];
  let poly: RawEntity | null = null;
  for (const e of flat) {
    if (poly) {
      if (e.type === "VERTEX") {
        poly.vertices!.push(e);
        continue;
      }
      poly = null;
      if (e.type === "SEQEND") continue;
    }
    if (e.type === "POLYLINE") {
      poly = { ...e, vertices: [] };
      out.push(poly);
    } else out.push(e);
  }
  return out;
}

const num = (e: RawEntity, code: number, def = 0): number => {
  const p = e.pairs.find((x) => x.code === code);
  return p ? Number.parseFloat(p.value) : def;
};
const str = (e: RawEntity, code: number, def = ""): string => e.pairs.find((x) => x.code === code)?.value ?? def;
const nums = (e: RawEntity, code: number): number[] => e.pairs.filter((x) => x.code === code).map((x) => Number.parseFloat(x.value));

function segmentsFor(radius: number, sweep: number): number {
  const r = Math.max(Math.abs(radius), 1e-9);
  const step = r > TOL ? 2 * Math.acos(1 - TOL / r) : Math.PI / 2;
  return Math.min(4096, Math.max(4, Math.ceil(Math.abs(sweep) / step)));
}

function arcPoints(c: Vec, r: number, a0: number, sweep: number, includeStart = true): Vec[] {
  const n = segmentsFor(r, sweep);
  const pts: Vec[] = [];
  for (let i = includeStart ? 0 : 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pts;
}

/** Points of a bulged segment from a to b, excluding a. */
function bulgePoints(a: Vec, b: Vec, bulge: number): Vec[] {
  if (Math.abs(bulge) < 1e-12) return [b];
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < 1e-12) return [b];
  const r = chord / (2 * Math.sin(theta / 2));
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const h = r * Math.cos(theta / 2); // signed distance from chord midpoint to centre
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  const c = { x: mid.x + nx * h, y: mid.y + ny * h };
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const pts = arcPoints(c, Math.abs(r), a0, theta, false);
  pts[pts.length - 1] = b; // exact endpoint
  return pts;
}

/** A bulged polyline as lines and 3-point arcs. */
function bulgedSegs(verts: { p: Vec; bulge: number }[], closed: boolean): DxfSeg[] {
  const out: DxfSeg[] = [];
  const n = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    if (Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) < 1e-12) continue;
    if (Math.abs(a.bulge) < 1e-12) out.push({ kind: "line", a: a.p, b: b.p });
    else {
      // The arc's middle: from the chord midpoint, out by the sagitta (bulge = tan(θ/4), sagitta = bulge · chord/2).
      const mid = { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 };
      const nx = -(b.p.y - a.p.y) / 2;
      const ny = (b.p.x - a.p.x) / 2;
      out.push({ kind: "arc", a: a.p, m: { x: mid.x - nx * a.bulge, y: mid.y - ny * a.bulge }, b: b.p });
    }
  }
  return out;
}

function bulgedPolyline(verts: { p: Vec; bulge: number }[], closed: boolean): Vec[] {
  if (verts.length === 0) return [];
  const pts: Vec[] = [verts[0]!.p];
  const n = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = verts[i]!;
    const b = verts[(i + 1) % verts.length]!;
    pts.push(...bulgePoints(a.p, b.p, a.bulge));
  }
  if (closed && pts.length > 1) pts.pop(); // last point duplicates the first
  return pts;
}

function deBoor(k: number, degree: number, t: number, knots: number[], ctrl: { x: number; y: number; w: number }[]) {
  const d: { x: number; y: number; w: number }[] = [];
  for (let j = 0; j <= degree; j++) {
    const c = ctrl[j + k - degree]!;
    d.push({ x: c.x * c.w, y: c.y * c.w, w: c.w });
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = j + k - degree;
      const denom = knots[i + 1 + degree - r]! - knots[i]!;
      const alpha = denom === 0 ? 0 : (t - knots[i]!) / denom;
      const a = d[j - 1]!;
      const b = d[j]!;
      d[j] = { x: (1 - alpha) * a.x + alpha * b.x, y: (1 - alpha) * a.y + alpha * b.y, w: (1 - alpha) * a.w + alpha * b.w };
    }
  }
  const p = d[degree]!;
  return { x: p.x / p.w, y: p.y / p.w };
}

function splinePoints(e: RawEntity): { pts: Vec[]; closed: boolean } {
  const flags = num(e, 70);
  const degree = num(e, 71, 3);
  const knots = nums(e, 40);
  const weights = nums(e, 41);
  const xs = nums(e, 10);
  const ys = nums(e, 20);
  const ctrl = xs.map((x, i) => ({ x, y: ys[i] ?? 0, w: weights[i] ?? 1 }));
  const closed = (flags & 1) !== 0;
  if (ctrl.length < degree + 1 || knots.length !== ctrl.length + degree + 1) {
    // Fall back to fit points (or control polygon).
    const fx = nums(e, 11);
    const fy = nums(e, 21);
    const pts = fx.length ? fx.map((x, i) => ({ x, y: fy[i] ?? 0 })) : ctrl.map((c) => ({ x: c.x, y: c.y }));
    return { pts, closed };
  }
  const pts: Vec[] = [];
  const t0 = knots[degree]!;
  const t1 = knots[knots.length - degree - 1]!;
  for (let k = degree; k < knots.length - degree - 1; k++) {
    const a = knots[k]!;
    const b = knots[k + 1]!;
    if (b <= a) continue;
    // Estimate span size from its control polygon for the sample count.
    let span = 0;
    for (let j = k - degree; j < k; j++) span += Math.hypot(ctrl[j + 1]!.x - ctrl[j]!.x, ctrl[j + 1]!.y - ctrl[j]!.y);
    const n = Math.min(256, Math.max(8, Math.ceil(Math.sqrt(span / TOL))));
    for (let i = pts.length === 0 ? 0 : 1; i <= n; i++) pts.push(deBoor(k, degree, a + ((b - a) * i) / n, knots, ctrl));
  }
  if (pts.length === 0 && t1 > t0) pts.push(deBoor(degree, degree, t0, knots, ctrl));
  if (closed && pts.length > 1 && Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y) < 1e-9) pts.pop();
  return { pts, closed };
}

/** Object Coordinate System → WCS for 2D entities: only the mirrored case (extrusion 0,0,-1) is handled. */
/** The uniform scale of a matrix that keeps circles round (rotation/mirror and one scale), else null. */
function similarityScale(m: Mat): number | null {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(sx - sy) <= 1e-9 * Math.max(1, sx) && Math.abs(dot) <= 1e-9 * Math.max(1, sx * sy) ? sx : null;
}

function ocs(e: RawEntity): Mat {
  return num(e, 230, 1) < 0 ? scale(-1, 1) : IDENTITY;
}

interface Ctx {
  blocks: Map<string, Block>;
  layerColors: Map<string, string>;
  out: DxfPath[];
  unsupported: Map<string, number>;
  depth: number;
}

function resolveColor(e: RawEntity, layer: string, ctx: Ctx, blockColor: string): string {
  const tc = e.pairs.find((p) => p.code === 420);
  if (tc) return `#${(Number.parseInt(tc.value, 10) & 0xffffff).toString(16).padStart(6, "0")}`;
  const aci = num(e, 62, 256);
  if (aci === 0) return blockColor; // BYBLOCK
  if (aci === 256) return ctx.layerColors.get(layer) ?? "#000000"; // BYLAYER
  return aciToHex(Math.abs(aci));
}

function emitEntities(entities: RawEntity[], m: Mat, ctx: Ctx, parentLayer: string, parentColor: string): void {
  for (const e of entities) {
    let layer = str(e, 8, "0");
    if (layer === "0" && parentLayer) layer = parentLayer; // layer 0 inside blocks inherits
    const color = resolveColor(e, layer, ctx, parentColor);
    const mm = mul(m, ocs(e));
    // Lines and arcs survive a transform only when it keeps circles round (rotation, uniform scale, mirror).
    const k = similarityScale(mm);
    const mapSeg = (s: DxfSeg): DxfSeg =>
      s.kind === "line" ? { kind: "line", a: apply(mm, s.a), b: apply(mm, s.b) } : s.kind === "arc" ? { kind: "arc", a: apply(mm, s.a), m: apply(mm, s.m), b: apply(mm, s.b) } : { kind: "circle", c: apply(mm, s.c), r: s.r * k! };
    const push = (pts: Vec[], closed: boolean, segs: DxfSeg[] | null = null) => {
      if (pts.length >= 2) ctx.out.push({ points: pts.map((p) => apply(mm, p)), closed, color, layer, segs: segs && k !== null ? segs.map(mapSeg) : null });
    };
    switch (e.type) {
      case "LINE": {
        const [a, b] = [{ x: num(e, 10), y: num(e, 20) }, { x: num(e, 11), y: num(e, 21) }];
        push([a, b], false, [{ kind: "line", a, b }]);
        break;
      }
      case "LWPOLYLINE": {
        const verts: { p: Vec; bulge: number }[] = [];
        for (const p of e.pairs) {
          if (p.code === 10) verts.push({ p: { x: Number.parseFloat(p.value), y: 0 }, bulge: 0 });
          else if (p.code === 20 && verts.length) verts.at(-1)!.p.y = Number.parseFloat(p.value);
          else if (p.code === 42 && verts.length) verts.at(-1)!.bulge = Number.parseFloat(p.value);
        }
        const closed = (num(e, 70) & 1) !== 0;
        push(bulgedPolyline(verts, closed), closed, bulgedSegs(verts, closed));
        break;
      }
      case "POLYLINE": {
        const flags = num(e, 70);
        if (flags & (16 | 64)) {
          ctx.unsupported.set("POLYLINE (mesh)", (ctx.unsupported.get("POLYLINE (mesh)") ?? 0) + 1);
          break;
        }
        const verts = (e.vertices ?? [])
          .filter((v) => (num(v, 70) & 16) === 0) // skip spline frame control points
          .map((v) => ({ p: { x: num(v, 10), y: num(v, 20) }, bulge: num(v, 42) }));
        const closed = (flags & 1) !== 0;
        // Smoothed (spline/curve-fit) polylines are only approximated by their vertices.
        push(bulgedPolyline(verts, closed), closed, flags & (2 | 4) ? null : bulgedSegs(verts, closed));
        break;
      }
      case "CIRCLE": {
        const c = { x: num(e, 10), y: num(e, 20) };
        const pts = arcPoints(c, num(e, 40), 0, 2 * Math.PI);
        pts.pop();
        push(pts, true, [{ kind: "circle", c, r: num(e, 40) }]);
        break;
      }
      case "ARC": {
        const a0 = (num(e, 50) * Math.PI) / 180;
        let a1 = (num(e, 51) * Math.PI) / 180;
        while (a1 <= a0) a1 += 2 * Math.PI;
        const c = { x: num(e, 10), y: num(e, 20) };
        const r = num(e, 40);
        const on = (a: number) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
        push(arcPoints(c, r, a0, a1 - a0), false, [{ kind: "arc", a: on(a0), m: on((a0 + a1) / 2), b: on(a1) }]);
        break;
      }
      case "ELLIPSE": {
        const c = { x: num(e, 10), y: num(e, 20) };
        const mx = num(e, 11);
        const my = num(e, 21);
        const ratio = num(e, 40, 1);
        const t0 = num(e, 41, 0);
        let t1 = num(e, 42, 2 * Math.PI);
        while (t1 <= t0) t1 += 2 * Math.PI;
        const major = Math.hypot(mx, my);
        const rot = Math.atan2(my, mx);
        const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
        const n = segmentsFor(major, t1 - t0);
        const pts: Vec[] = [];
        for (let i = 0; i <= n; i++) {
          const t = t0 + ((t1 - t0) * i) / n;
          const lx = major * Math.cos(t);
          const ly = major * ratio * Math.sin(t);
          pts.push({ x: c.x + lx * Math.cos(rot) - ly * Math.sin(rot), y: c.y + lx * Math.sin(rot) + ly * Math.cos(rot) });
        }
        if (full) pts.pop();
        push(pts, full);
        break;
      }
      case "SPLINE": {
        const { pts, closed } = splinePoints(e);
        push(pts, closed);
        break;
      }
      case "SOLID":
      case "TRACE": {
        // Corner order is 1-2-4-3.
        const p = (k: number) => ({ x: num(e, 10 + k), y: num(e, 20 + k) });
        push([p(0), p(1), p(3), p(2)], true);
        break;
      }
      case "INSERT": {
        const block = ctx.blocks.get(str(e, 2));
        if (!block || ctx.depth > 16) break;
        const ins = { x: num(e, 10), y: num(e, 20) };
        const sx = num(e, 41, 1);
        const sy = num(e, 42, 1);
        const rot = (num(e, 50) * Math.PI) / 180;
        const cols = Math.max(1, num(e, 70, 1));
        const rows = Math.max(1, num(e, 71, 1));
        const dc = num(e, 44);
        const dr = num(e, 45);
        ctx.depth++;
        for (let r = 0; r < rows; r++) {
          for (let ci = 0; ci < cols; ci++) {
            // Array offsets are along the rotated insert axes.
            const off = apply(rotate(rot), { x: ci * dc, y: r * dr });
            let bm = translate(ins.x + off.x, ins.y + off.y);
            bm = mul(bm, rotate(rot));
            bm = mul(bm, scale(sx, sy));
            bm = mul(bm, translate(-block.base.x, -block.base.y));
            emitEntities(block.entities, mul(mm, bm), ctx, layer, color);
          }
        }
        ctx.depth--;
        break;
      }
      case "POINT":
      case "TEXT":
      case "MTEXT":
      case "DIMENSION":
      case "HATCH":
      case "VIEWPORT":
      case "ATTDEF":
      case "ATTRIB":
      default:
        ctx.unsupported.set(e.type, (ctx.unsupported.get(e.type) ?? 0) + 1);
    }
  }
}

export function parseDxf(text: string): DxfResult {
  const pairs = tokenize(text);
  // Split into sections.
  const sections = new Map<string, Pair[]>();
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value === "SECTION" && pairs[i + 1]?.code === 2) {
      const name = pairs[i + 1]!.value;
      const body: Pair[] = [];
      i += 2;
      while (i < pairs.length && !(pairs[i]!.code === 0 && pairs[i]!.value === "ENDSEC")) body.push(pairs[i++]!);
      sections.set(name, body);
    }
  }

  // Header: units.
  let insunits = 0;
  const header = sections.get("HEADER") ?? [];
  for (let i = 0; i < header.length; i++) {
    if (header[i]!.code === 9 && header[i]!.value === "$INSUNITS") insunits = Number.parseInt(header[i + 1]?.value ?? "0", 10);
  }
  const [units, unitScale] = UNITS[insunits] ?? UNITS[0]!;

  // Layer colours.
  const layerColors = new Map<string, string>();
  for (const e of toEntities(sections.get("TABLES") ?? [])) {
    if (e.type !== "LAYER") continue;
    const tc = e.pairs.find((p) => p.code === 420);
    const color = tc
      ? `#${(Number.parseInt(tc.value, 10) & 0xffffff).toString(16).padStart(6, "0")}`
      : aciToHex(Math.abs(num(e, 62, 7)));
    layerColors.set(str(e, 2), color);
  }

  // Blocks.
  const blocks = new Map<string, Block>();
  let current: { name: string; block: Block } | null = null;
  for (const e of toEntities(sections.get("BLOCKS") ?? [])) {
    if (e.type === "BLOCK") {
      current = { name: str(e, 2), block: { base: { x: num(e, 10), y: num(e, 20) }, entities: [] } };
    } else if (e.type === "ENDBLK") {
      if (current) blocks.set(current.name, current.block);
      current = null;
    } else current?.block.entities.push(e);
  }

  const ctx: Ctx = { blocks, layerColors, out: [], unsupported: new Map(), depth: 0 };
  const entities = sections.get("ENTITIES");
  if (!entities) throw new Error("No ENTITIES section: not a DXF file?");
  emitEntities(toEntities(entities), IDENTITY, ctx, "", "#000000");

  const warnings: string[] = [];
  for (const [type, n] of ctx.unsupported) warnings.push(`Skipped ${n} ${type} entit${n === 1 ? "y" : "ies"}`);
  if (insunits === 0) warnings.push("Drawing has no units ($INSUNITS); assumed millimetres");
  return { paths: ctx.out, unitScale, units, warnings };
}
