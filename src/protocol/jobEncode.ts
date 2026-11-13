// Ruida job (.rd) encoder, modelled command for command on what LightBurn 2.2.01 sends to an RDC644XS
// (docs/PROTOCOL.md, "LightBurn job capture"; golden fixtures in tests/fixtures/lightburn-*.rd).
// Commands whose meaning is unknown are copied as LightBurn sends them.
import { encodeInt14, encodeInt35 } from "./numbers";
import { REL_MAX_UM, hasForbiddenParamWrite } from "./encode";
import { checksumCommand, rdChecksum } from "./rd";
import { swizzle } from "./swizzle";

/** A point in machine micrometres (integers; x/y grow away from the home corner). */
export interface PointUm {
  x: number;
  y: number;
}

export interface RdLayer {
  /** mm/s */
  speed: number;
  /** % of full power */
  minPower: number;
  maxPower: number;
  /** CSS "#rrggbb" */
  color: string;
  /**
   * Polylines in cut order, passes already expanded. Each path starts with a travel to its first point (omitted
   * when the head is already there) and cuts through the rest.
   */
  paths: PointUm[][];
}

export interface RdJobInput {
  /** absolute: coordinates are machine positions. current: relative to where the head is when the job starts. */
  mode: "absolute" | "current";
  layers: RdLayer[];
  /**
   * Cut order as runs of paths per layer (index into `layers`), when it isn't simply each layer's paths in turn:
   * a layer can come back later (object-by-object jobs). Its settings are sent again each time it starts.
   */
  blocks?: { layer: number; paths: PointUm[][] }[];
}

const Z5 = [0, 0, 0, 0, 0];
const cmd = (...b: number[]) => Uint8Array.from(b);
const xy = (p: PointUm) => [...encodeInt35(p.x), ...encodeInt35(p.y)];

/** Percent → 14-bit power, as LightBurn rounds it (10 % → 0x0C66). */
export const powerValue = (pct: number) => Math.round((Math.min(100, Math.max(0, pct)) * 0x3fff) / 100);
/** "#rrggbb" → 0xBBGGRR, the order `CA 06` uses. */
export function colorValue(css: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(css);
  const rgb = m ? parseInt(m[1]!, 16) : 0;
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

// Constant bytes of `F2 02` (Element Name) in every capture; meaning unknown.
const ELEMENT_NAME = [0x05, 0x2a, 0x39, 0x1c, 0x41, 0x04, 0x6a, 0x15, 0x08, 0x20];

interface Bounds {
  min: PointUm;
  max: PointUm;
}

function bounds(paths: PointUm[][]): Bounds | null {
  let b: Bounds | null = null;
  for (const p of paths) {
    for (const v of p) {
      if (!b) b = { min: { ...v }, max: { ...v } };
      else {
        b.min.x = Math.min(b.min.x, v.x);
        b.min.y = Math.min(b.min.y, v.y);
        b.max.x = Math.max(b.max.x, v.x);
        b.max.y = Math.max(b.max.y, v.y);
      }
    }
  }
  return b;
}

/** Encode a job as unswizzled commands, ending with the checksum and `D7`. */
export function encodeJobCommands(input: RdJobInput): Uint8Array[] {
  const round = (paths: PointUm[][]) => paths.map((p) => p.map((v) => ({ x: Math.round(v.x), y: Math.round(v.y) }))).filter((p) => p.length > 0);
  const kept = input.layers.map((l, i) => ({ ...l, i, paths: round(l.paths) })).filter((l) => l.paths.length > 0);
  const layers = kept.map(({ i: _, ...l }) => l);
  // Runs to cut, as indices into `layers` (empty layers dropped).
  const index = new Map(kept.map((l, n) => [l.i, n]));
  const runs = (input.blocks ?? input.layers.map((l, layer) => ({ layer, paths: l.paths })))
    .map((b) => ({ n: index.get(b.layer), paths: round(b.paths) }))
    .filter((b): b is { n: number; paths: PointUm[][] } => b.n !== undefined && b.paths.length > 0);
  if (layers.length === 0) throw new Error("Nothing to cut: no layer has paths");
  if (layers.length > 128) throw new Error("Too many layers (max 128)");
  const doc = bounds(layers.flatMap((l) => l.paths))!;
  const w = doc.max.x - doc.min.x;
  const h = doc.max.y - doc.min.y;

  const out: Uint8Array[] = [];
  const push = (...b: number[]) => out.push(cmd(...b));

  // Header.
  if (input.mode === "absolute") push(0xd8, 0x10), push(0xe6, 0x01);
  else push(0xd8, 0x12);
  push(0xf0);
  push(0xf1, 0x02, 0x00);
  push(0xd8, 0x00);
  push(0xe7, 0x06, ...Z5, ...Z5);
  push(0xe7, 0x38, 0x00);
  push(0xe7, 0x03, ...xy(doc.min));
  push(0xe7, 0x07, ...xy(doc.max));
  push(0xe7, 0x50, ...xy(doc.min));
  push(0xe7, 0x51, ...xy(doc.max));
  push(0xe7, 0x04, ...encodeInt14(1), ...encodeInt14(1), ...Z5, ...Z5);
  push(0xe7, 0x05, 0x00);

  // Layer table.
  layers.forEach((l, n) => {
    const b = bounds(l.paths)!;
    const lo = encodeInt14(powerValue(l.minPower));
    const hi = encodeInt14(powerValue(Math.max(l.minPower, l.maxPower)));
    push(0xc9, 0x04, n, ...encodeInt35(Math.round(l.speed * 1000)));
    push(0xc6, 0x31, n, ...lo);
    push(0xc6, 0x32, n, ...hi);
    push(0xc6, 0x41, n, ...lo);
    push(0xc6, 0x42, n, ...hi);
    push(0xca, 0x06, n, ...encodeInt35(colorValue(l.color)));
    push(0xca, 0x41, n, 0x00);
    push(0xe7, 0x52, n, ...xy(b.min));
    push(0xe7, 0x53, n, ...xy(b.max));
    push(0xe7, 0x61, n, ...xy(b.min));
    push(0xe7, 0x62, n, ...xy(b.max));
  });
  push(0xca, 0x22, layers.length - 1);
  // Offsets for laser heads 1 and 2 (always both, whatever the layer count).
  for (const sub of [0x54, 0x55]) for (const head of [0, 1]) push(0xe7, sub, head, ...Z5);
  push(0xf1, 0x03, ...Z5, ...Z5);

  // One element, one array cell.
  push(0xf1, 0x00, 0x00);
  push(0xf1, 0x01, 0x00);
  push(0xf2, 0x00, 0x00);
  push(0xf2, 0x01, 0x00);
  push(0xf2, 0x02, ...ELEMENT_NAME);
  push(0xf2, 0x03, ...xy(doc.min));
  push(0xf2, 0x04, ...xy(doc.max));
  push(0xf2, 0x05, ...encodeInt14(1), ...encodeInt14(1), ...encodeInt35(w), ...encodeInt35(h));
  push(0xf2, 0x06, ...Z5, ...Z5);
  push(0xf2, 0x07, 0x00);
  push(0xea, 0x00);
  push(0xe7, 0x60, 0x00);
  push(0xe7, 0x13, ...xy(doc.min));
  push(0xe7, 0x17, ...xy(doc.max));
  push(0xe7, 0x23, ...xy(doc.min));
  push(0xe7, 0x24, 0x00);
  push(0xe7, 0x37, ...xy(doc.max));
  push(0xe7, 0x08, ...encodeInt14(1), ...encodeInt14(1), ...encodeInt35(w), ...encodeInt35(h));

  // Cutting.
  let pos: PointUm | null = null;
  let length = 0; // µm of cuts and travels after the first move, for DA 01 06 20
  for (const { n, paths } of runs) {
    const l = layers[n]!;
    const lo = encodeInt14(powerValue(l.minPower));
    const hi = encodeInt14(powerValue(Math.max(l.minPower, l.maxPower)));
    push(0xca, 0x01, 0x00);
    push(0xca, 0x02, n);
    push(0xca, 0x01, 0x30);
    push(0xca, 0x01, 0x10);
    push(0xca, 0x01, 0x13);
    push(0xc9, 0x02, ...encodeInt35(Math.round(l.speed * 1000)));
    push(0xc6, 0x12, ...Z5);
    push(0xc6, 0x13, ...Z5);
    push(0xc6, 0x50, 0x00, 0x01);
    push(0xc6, 0x51, 0x00, 0x01);
    push(0xc6, 0x01, ...lo);
    push(0xc6, 0x02, ...hi);
    push(0xc6, 0x21, ...lo);
    push(0xc6, 0x22, ...hi);
    push(0xca, 0x03, 0x01);
    for (const path of paths) {
      const first = path[0]!;
      if (!pos || pos.x !== first.x || pos.y !== first.y) {
        if (pos) length += Math.hypot(first.x - pos.x, first.y - pos.y);
        push(0x88, ...xy(first));
        pos = first;
      }
      for (let k = 1; k < path.length; k++) {
        const p = path[k]!;
        const dx = p.x - pos.x;
        const dy = p.y - pos.y;
        if (dx === 0 && dy === 0) continue;
        length += Math.hypot(dx, dy);
        if (Math.abs(dx) <= REL_MAX_UM && Math.abs(dy) <= REL_MAX_UM) push(0xa9, ...encodeInt14(dx), ...encodeInt14(dy));
        else push(0xa8, ...xy(p));
        pos = p;
      }
    }
  }

  // Trailer.
  push(0xeb);
  push(0xe7, 0x00);
  const mm = encodeInt35(Math.floor(length / 1000));
  push(0xda, 0x01, 0x06, 0x20, ...mm, ...mm);
  out.push(cmd(0xd7)); // placeholder position for the checksum is just before D7
  const ck = checksumCommand(rdChecksum(out));
  out.splice(out.length - 1, 0, ck);
  if (hasForbiddenParamWrite(out)) throw new Error("Internal error: job contains a forbidden memory write");
  return out;
}

/** Encode a job as a swizzled .rd file (the bytes to save or stream). */
export function encodeJob(input: RdJobInput, magic = 0x88): Uint8Array {
  const cmds = encodeJobCommands(input);
  const flat = new Uint8Array(cmds.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of cmds) {
    flat.set(c, o);
    o += c.length;
  }
  return swizzle(flat, magic);
}
