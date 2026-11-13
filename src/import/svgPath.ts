// SVG path data ("d" attribute) parser and flattener. Curves are flattened AFTER the transform is applied
// (affine maps keep Béziers Béziers), so the tolerance is honoured in output units (mm).
import { type Mat, type Vec, apply } from "../geom/geom";

export interface Subpath {
  points: Vec[];
  closed: boolean;
}

const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const MAX_STEPS = 1000;

/** Cubic segment as [c1x, c1y, c2x, c2y, x, y]. */
type Cubic = [number, number, number, number, number, number];

/**
 * Flatten path data under matrix `m`. `tol` is the max chord-to-curve distance in output units.
 * Parsing stops at the first error and keeps what was read so far, as browsers do.
 */
export function flattenPathData(d: string, m: Mat, tol: number): Subpath[] {
  const len = d.length;
  let pos = 0;
  const out: Subpath[] = [];
  let sub: Subpath | null = null;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastC: Vec | null = null; // second control point of the previous cubic
  let lastQ: Vec | null = null; // control point of the previous quadratic
  let prev = "";

  const skipSep = () => {
    while (pos < len && /[\s,]/.test(d[pos]!)) pos++;
  };
  const readNum = (): number | null => {
    skipSep();
    NUM.lastIndex = pos;
    const r = NUM.exec(d);
    if (!r) return null;
    pos = NUM.lastIndex;
    return parseFloat(r[0]);
  };
  const readFlag = (): number | null => {
    skipSep();
    const c = d[pos];
    if (c !== "0" && c !== "1") return null;
    pos++;
    return c === "1" ? 1 : 0;
  };

  const finish = (closed: boolean) => {
    if (sub) {
      if (closed && sub.points.length > 1) {
        const a = sub.points[0]!;
        const b = sub.points[sub.points.length - 1]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) sub.points.pop();
        sub.closed = true;
      }
      if (sub.points.length >= 2) out.push(sub);
    }
    sub = null;
  };
  const begin = (x: number, y: number) => {
    finish(false);
    sub = { points: [apply(m, { x, y })], closed: false };
  };
  const lineTo = (x: number, y: number) => {
    if (!sub) begin(cx, cy);
    sub!.points.push(apply(m, { x, y }));
    cx = x;
    cy = y;
  };
  const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) => {
    if (!sub) begin(cx, cy);
    const p0 = apply(m, { x: cx, y: cy });
    const p1 = apply(m, { x: c1x, y: c1y });
    const p2 = apply(m, { x: c2x, y: c2y });
    const p3 = apply(m, { x, y });
    const dd = Math.max(Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y), Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y));
    // Uniform subdivision error <= 3/4 * dd / n^2.
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tol))));
    for (let k = 1; k < steps; k++) {
      const u = k / steps;
      const v = 1 - u;
      const a = v * v * v;
      const b = 3 * v * v * u;
      const c = 3 * v * u * u;
      const e = u * u * u;
      sub!.points.push({ x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y });
    }
    sub!.points.push(p3);
    cx = x;
    cy = y;
  };

  let cmd = "";
  while (true) {
    skipSep();
    if (pos >= len) break;
    const ch = d[pos]!;
    if (/[A-Za-z]/.test(ch)) {
      if (ARITY[ch.toLowerCase()] === undefined) break;
      cmd = ch;
      pos++;
      if (prev === "" && cmd !== "M" && cmd !== "m") break;
    } else if (cmd === "" || cmd === "z" || cmd === "Z") {
      break; // number without a command
    }
    const lower = cmd.toLowerCase();
    const rel = cmd === lower;

    if (lower === "z") {
      finish(true);
      cx = sx;
      cy = sy;
      prev = "z";
      lastC = lastQ = null;
      continue;
    }

    const a: number[] = [];
    let bad = false;
    for (let k = 0; k < ARITY[lower]!; k++) {
      const v = lower === "a" && (k === 3 || k === 4) ? readFlag() : readNum();
      if (v === null) {
        bad = true;
        break;
      }
      a.push(v);
    }
    if (bad) break;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    switch (lower) {
      case "m": {
        const x = ox + a[0]!;
        const y = oy + a[1]!;
        begin(x, y);
        cx = sx = x;
        cy = sy = y;
        cmd = rel ? "l" : "L"; // further pairs are implicit lineto
        lastC = lastQ = null;
        break;
      }
      case "l":
        lineTo(ox + a[0]!, oy + a[1]!);
        lastC = lastQ = null;
        break;
      case "h":
        lineTo(rel ? cx + a[0]! : a[0]!, cy);
        lastC = lastQ = null;
        break;
      case "v":
        lineTo(cx, rel ? cy + a[0]! : a[0]!);
        lastC = lastQ = null;
        break;
      case "c":
        cubicTo(ox + a[0]!, oy + a[1]!, ox + a[2]!, oy + a[3]!, ox + a[4]!, oy + a[5]!);
        lastC = { x: ox + a[2]!, y: oy + a[3]! };
        lastQ = null;
        break;
      case "s": {
        const c1 = lastC && (prev === "c" || prev === "s") ? { x: 2 * cx - lastC.x, y: 2 * cy - lastC.y } : { x: cx, y: cy };
        const c2 = { x: ox + a[0]!, y: oy + a[1]! };
        cubicTo(c1.x, c1.y, c2.x, c2.y, ox + a[2]!, oy + a[3]!);
        lastC = c2;
        lastQ = null;
        break;
      }
      case "q":
      case "t": {
        let q: Vec;
        let x: number;
        let y: number;
        if (lower === "q") {
          q = { x: ox + a[0]!, y: oy + a[1]! };
          x = ox + a[2]!;
          y = oy + a[3]!;
        } else {
          q = lastQ && (prev === "q" || prev === "t") ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y } : { x: cx, y: cy };
          x = ox + a[0]!;
          y = oy + a[1]!;
        }
        // Quadratic -> cubic.
        cubicTo(cx + (2 / 3) * (q.x - cx), cy + (2 / 3) * (q.y - cy), x + (2 / 3) * (q.x - x), y + (2 / 3) * (q.y - y), x, y);
        lastQ = q;
        lastC = null;
        break;
      }
      case "a": {
        const x = ox + a[5]!;
        const y = oy + a[6]!;
        if (cx === x && cy === y) break; // zero-length arc is omitted
        const segs = arcToCubics(cx, cy, a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, x, y);
        if (!segs) lineTo(x, y);
        else for (const s of segs) cubicTo(s[0], s[1], s[2], s[3], s[4], s[5]);
        lastC = lastQ = null;
        break;
      }
    }
    prev = lower;
  }
  finish(false);
  return out;
}

/** SVG arc (endpoint form, spec F.6.5) to cubic Béziers of at most 90 degrees; null means "draw a straight line". */
function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): Cubic[] | null {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return null;
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const th1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  const th2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  let dth = th2 - th1;
  if (fs === 0 && dth > 0) dth -= 2 * Math.PI;
  else if (fs === 1 && dth < 0) dth += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9));
  const delta = dth / n;
  const k = (4 / 3) * Math.tan(delta / 4);
  const pt = (a: number): Vec => ({ x: cx + rx * Math.cos(a) * cosP - ry * Math.sin(a) * sinP, y: cy + rx * Math.cos(a) * sinP + ry * Math.sin(a) * cosP });
  const dv = (a: number): Vec => ({ x: -rx * Math.sin(a) * cosP - ry * Math.cos(a) * sinP, y: -rx * Math.sin(a) * sinP + ry * Math.cos(a) * cosP });
  const res: Cubic[] = [];
  for (let i = 0; i < n; i++) {
    const a1 = th1 + i * delta;
    const a2 = a1 + delta;
    const p1 = pt(a1);
    const p2 = i === n - 1 ? { x: x2, y: y2 } : pt(a2);
    const d1 = dv(a1);
    const d2 = dv(a2);
    res.push([p1.x + k * d1.x, p1.y + k * d1.y, p2.x - k * d2.x, p2.y - k * d2.y, p2.x, p2.y]);
  }
  return res;
}
