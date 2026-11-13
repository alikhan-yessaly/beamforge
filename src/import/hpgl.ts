// HPGL / PLT importer. Plotter units are 40 per mm (1016 per inch); HPGL y is up, so the result is flipped
// about the drawing's top (max y) to give y-down, non-negative y. Pens map to fixed colours.
import { msg } from "../i18n";
import type { Vec } from "../geom/geom";
import { FLATTEN_TOLERANCE_MM, type VecPath, type VectorImport } from "./types";

const UNITS_PER_MM = 40;
const CLOSE_EPS_MM = 0.01;

const PEN_COLORS = ["#000000", "#ff0000", "#00e000", "#0000ff", "#00e0e0", "#ff00ff", "#d0d000"];
const PEN_CYCLE = ["#ff8000", "#8000ff", "#008080", "#804000", "#808080", "#ff0080", "#80c000", "#0080ff"];

/** Colour for a pen number (1-based; 0 acts as pen 1). */
export function penColor(pen: number): string {
  const n = Math.max(1, Math.floor(pen));
  return n <= PEN_COLORS.length ? PEN_COLORS[n - 1]! : PEN_CYCLE[(n - 8) % PEN_CYCLE.length]!;
}

/** Commands that only affect plotting style or hardware and can be ignored safely. */
const IGNORED = new Set(["LT", "PW", "PS", "BP", "NP", "PG", "CO", "VS", "FS", "DF", "TR", "LA", "WU", "SP0", "SG", "RP", "AF", "AH", "NR", "OI", "OS", "IW"]);
const KNOWN = new Set(["IN", "SP", "PU", "PD", "PA", "PR", "CI", "AA", "AR", "EA", "ER", "RA", "RR", "LB"]);

/** Number of segments for an arc of `sweep` radians at radius `r` mm within the flatten tolerance. */
function arcSteps(r: number, sweep: number, chordDeg?: number): number {
  if (chordDeg && chordDeg > 0) return Math.max(1, Math.ceil(Math.abs((sweep * 180) / Math.PI) / chordDeg));
  const step = r > FLATTEN_TOLERANCE_MM ? 2 * Math.acos(1 - FLATTEN_TOLERANCE_MM / r) : Math.PI / 2;
  return Math.min(1440, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
}

interface RawPath {
  points: Vec[];
  closed: boolean;
  pen: number;
}

/** Parse HPGL text into paths in mm. Never throws. */
export function parseHpgl(text: string): VectorImport {
  // Strip PCL/PJL wrappers: keep what follows "ESC%0B" (enter HPGL/2), turn other escapes into separators.
  let src = text;
  const enter = src.indexOf("\x1b%0B");
  if (enter >= 0) src = src.slice(enter + 4);
  src = src.replace(/\x1b%[-0-9]*[A-Z@]/g, ";");

  const raw: RawPath[] = [];
  const unknown: string[] = [];
  let x = 0;
  let y = 0; // plotter units, y up
  let down = false;
  let rel = false;
  let pen = 1;
  let cur: Vec[] | null = null;

  const mm = (px: number, py: number): Vec => ({ x: px / UNITS_PER_MM, y: py / UNITS_PER_MM });
  const flush = () => {
    if (cur && cur.length >= 2) {
      let pts = cur;
      let closed = false;
      const a = pts[0]!;
      const b = pts[pts.length - 1]!;
      if (pts.length >= 4 && Math.hypot(a.x - b.x, a.y - b.y) <= CLOSE_EPS_MM) {
        pts = pts.slice(0, -1);
        closed = true;
      }
      raw.push({ points: pts, closed, pen });
    }
    cur = null;
  };
  /** End the running polyline but keep drawing from the same spot if the pen is down. */
  const restart = () => {
    flush();
    if (down) cur = [mm(x, y)];
  };
  const closedShape = (pts: Vec[]) => {
    restart();
    raw.push({ points: pts, closed: true, pen });
  };
  const moveTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    if (down) {
      if (!cur) cur = [mm(x, y)];
      else cur.push(mm(x, y));
    }
  };
  const coordList = (a: number[], useRel: boolean) => {
    for (let i = 0; i + 1 < a.length; i += 2) moveTo(useRel ? x + a[i]! : a[i]!, useRel ? y + a[i + 1]! : a[i + 1]!);
  };
  const penDown = () => {
    if (!down) {
      down = true;
      cur = [mm(x, y)];
    }
  };
  const penUp = () => {
    flush();
    down = false;
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (!/[A-Za-z]/.test(c)) {
      i++;
      continue;
    }
    const op = (c + (src[i + 1] ?? "")).toUpperCase();
    i += 2;
    if (op === "LB") {
      // Label text runs to ETX (0x03) or the end of the line.
      let e = i;
      while (e < n && src[e] !== "\x03" && src[e] !== "\n") e++;
      i = e + 1;
      if (!unknown.includes("LB")) unknown.push("LB");
      continue;
    }
    let e = i;
    while (e < n && src[e] !== ";" && !/[A-Za-z]/.test(src[e]!)) e++;
    const args = src
      .slice(i, e)
      .split(/[\s,]+/)
      .filter((s) => s !== "")
      .map(parseFloat)
      .filter((v) => Number.isFinite(v));
    i = e;

    switch (op) {
      case "IN":
        penUp();
        x = y = 0;
        rel = false;
        pen = 1;
        break;
      case "SP":
        restart();
        pen = Math.max(1, args[0] ?? 1);
        break;
      case "PU":
        penUp();
        coordList(args, rel);
        break;
      case "PD":
        penDown();
        coordList(args, rel);
        break;
      case "PA":
        rel = false;
        coordList(args, false);
        break;
      case "PR":
        rel = true;
        coordList(args, true);
        break;
      case "CI": {
        const r = (args[0] ?? 0) / UNITS_PER_MM;
        if (!(r > 0)) break;
        const steps = arcSteps(r, 2 * Math.PI, args[1]);
        const c0 = mm(x, y);
        const pts: Vec[] = [];
        for (let k = 0; k < steps; k++) {
          const a = (2 * Math.PI * k) / steps;
          pts.push({ x: c0.x + r * Math.cos(a), y: c0.y + r * Math.sin(a) });
        }
        closedShape(pts);
        break;
      }
      case "AA":
      case "AR": {
        if (args.length < 3) break;
        const ccx = op === "AR" ? x + args[0]! : args[0]!;
        const ccy = op === "AR" ? y + args[1]! : args[1]!;
        const sweep = (args[2]! * Math.PI) / 180;
        const a0 = Math.atan2(y - ccy, x - ccx);
        const rad = Math.hypot(x - ccx, y - ccy);
        if (rad === 0 || sweep === 0) break;
        const steps = arcSteps(rad / UNITS_PER_MM, sweep, args[3]);
        for (let k = 1; k <= steps; k++) {
          const a = a0 + (sweep * k) / steps;
          moveTo(ccx + rad * Math.cos(a), ccy + rad * Math.sin(a));
        }
        break;
      }
      case "EA":
      case "ER":
      case "RA":
      case "RR": {
        if (args.length < 2) break;
        const relative = op === "ER" || op === "RR";
        const x2 = relative ? x + args[0]! : args[0]!;
        const y2 = relative ? y + args[1]! : args[1]!;
        closedShape([mm(x, y), mm(x2, y), mm(x2, y2), mm(x, y2)]);
        break;
      }
      default:
        if (!KNOWN.has(op) && !IGNORED.has(op) && !unknown.includes(op)) unknown.push(op);
    }
  }
  flush();

  const warnings: string[] = [];
  if (unknown.length) warnings.push(`Unsupported HPGL commands were ignored: ${unknown.join(", ")}.`);
  if (!raw.length) {
    warnings.push(msg("No drawing commands were found in the HPGL file."));
    return { paths: [], warnings };
  }

  let maxY = -Infinity;
  for (const p of raw) for (const pt of p.points) if (pt.y > maxY) maxY = pt.y;
  const paths: VecPath[] = raw.map((p) => ({
    points: p.points.map((pt) => ({ x: pt.x, y: maxY - pt.y })),
    closed: p.closed,
    stroke: penColor(p.pen),
    fill: null,
  }));
  return { paths, warnings };
}
