// Test cards for tuning: small jobs that show this machine's behaviour on scrap, and what to read off them.
// Pure: a card is rebuilt from its parameters (stored on the card object), so the results view always matches what
// was engraved. Geometry in card-local mm (y down, top-left at 0,0). Every card uses its own layer colours.
//
// - fill: acceleration and the fill fix. Strips of increasing length engraved at one speed: strips shorter than
//   twice the speed-up distance never reach full speed and burn dark all over; the shortest strip with a lighter
//   middle gives the distance, hence the acceleration. Then three rows of squares 1–8 mm (plain, overscan, the
//   suggested corner power): the row whose small and big squares look most alike is this machine's best fix.
// - scan: scan offset. Bars engraved back and forth at two speeds, each patch with a different offset; the
//   sharpest patch per speed is the offset.
// - grid: a material's settings. Engraved squares over speed × power, and squares cut at falling speed; you pick
//   the engraving you like, the fastest square that fell out (cut) and one that only marked the line (score).
// - kerf: a plate with square holes 6 − 2k mm and a 6 mm peg; the hole the peg fits snugly gives the kerf k.
import { type Vec } from "../geom/geom";
import { type MachineProfile, type Layer, type ScenePath } from "../scene/model";
import { rampDistance, startSpeedOf, suggestCornerPower } from "../machine/motion";

export type CardKind = "fill" | "scan" | "grid" | "kerf";

export interface FillCardParams {
  kind: "fill";
  speed: number;
  power: number;
  /** Model values when the card was made (the strip lengths depend on them). */
  accel: number;
  startSpeed: number;
  minFirePower: number;
  colors: string[];
}
export interface ScanCardParams {
  kind: "scan";
  speeds: number[];
  offsets: number[];
  power: number;
  colors: string[];
}
export interface GridCardParams {
  kind: "grid";
  material: string;
  speeds: number[];
  powers: number[];
  cutSpeeds: number[];
  cutPower: number;
  colors: string[];
}
export interface KerfCardParams {
  kind: "kerf";
  material: string;
  /** Preset the cut settings came from, which gets the kerf. */
  preset?: string;
  speed: number;
  power: number;
  passes: number;
  ks: number[];
  colors: string[];
}
export type CardParams = FillCardParams | ScanCardParams | GridCardParams | KerfCardParams;

/** A clickable area on the card and what choosing it means. */
export interface Patch {
  /** Which question it answers (e.g. "ramp", "row", "speed:200", "engrave", "cut"). */
  group: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The value chosen with it (mm, mm/s, a variant name…). */
  value: number | string;
  /** Short label drawn next to it (numbers and units only, so it needs no translation). */
  label: string;
  /** Grid card: the speed and power of the patch. */
  speed?: number;
  power?: number;
}

export interface Card {
  params: CardParams;
  paths: ScenePath[];
  /** Settings per colour (merged over the layer defaults when the card is placed). */
  layers: (Partial<Omit<Layer, "color">> & { color: string })[];
  patches: Patch[];
  w: number;
  h: number;
}

const rect = (x: number, y: number, w: number, h: number): Vec[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const r1 = (v: number) => Math.round(v * 10) / 10;
const fillLayer = (color: string, speed: number, power: number, extra: Partial<Layer> = {}) => ({
  color,
  mode: "fill" as const,
  speed: r1(speed),
  minPower: r1(power),
  maxPower: r1(power),
  linkPower: true,
  passes: 1,
  output: true,
  fill: { pattern: "lines" as const, interval: 0.1, angle: 0 },
  sweep: "separate" as const,
  overscan: "off" as const,
  show: true,
  material: undefined,
  scanOffset: undefined,
  ...extra,
});
const cutLayer = (color: string, speed: number, power: number, passes = 1) => ({ color, mode: "cut" as const, speed: r1(speed), minPower: r1(power), maxPower: r1(power), linkPower: true, passes, output: true, show: true, kerf: 0, material: undefined });

/** How many layer colours each kind of card needs. */
export function colorsNeeded(kind: CardKind): number {
  return kind === "fill" ? 4 : kind === "scan" ? SCAN_SPEEDS * SCAN_OFFSETS.length : kind === "grid" ? GRID_SPEEDS.length * GRID_POWERS.length + CUT_STEPS.length : 1;
}

/** Strip lengths of the fill card: around twice the expected speed-up distance, 1–120 mm. */
export function rampLengths(p: Pick<FillCardParams, "speed" | "accel" | "startSpeed">): number[] {
  const d = rampDistance(p.speed, { accel: p.accel, startSpeed: p.startSpeed });
  return [0.35, 0.5, 0.7, 1, 1.4, 2, 2.8].map((f) => Math.max(1, Math.min(120, r1(2 * d * f))));
}

export const FILL_ROWS = ["plain", "overscan", "corner"] as const;
const SQUARES = [1, 2, 4, 8];

function fillCard(p: FillCardParams): Card {
  const [cRamp, cPlain, cOver, cCorner] = p.colors as [string, string, string, string];
  const paths: ScenePath[] = [];
  const patches: Patch[] = [];
  let y = 3;
  const lens = rampLengths(p);
  for (const L of lens) {
    paths.push({ color: cRamp, closed: true, points: rect(3, y, L, 1.5) });
    patches.push({ group: "ramp", x: 3, y: y - 0.5, w: L, h: 2.5, value: L, label: `${L} mm` });
    y += 3.5;
  }
  y += 3;
  const rowColor = { plain: cPlain, overscan: cOver, corner: cCorner };
  for (const row of FILL_ROWS) {
    let x = 3;
    for (const s of SQUARES) {
      paths.push({ color: rowColor[row], closed: true, points: rect(x, y, s, s) });
      x += s + 3;
    }
    patches.push({ group: "row", x: 2, y: y - 1, w: x - 2, h: 10, value: row, label: row === "plain" ? "A" : row === "overscan" ? "B" : "C" });
    y += 11;
  }
  // Orientation mark: a small triangle at the top right, engraved with the strips.
  const w = Math.max(3 + lens.at(-1)! + 3, 3 + SQUARES.reduce((a, s) => a + s + 3, 0) + 3, 30);
  paths.push({ color: cRamp, closed: true, points: [{ x: w - 6, y: 2 }, { x: w - 2, y: 2 }, { x: w - 2, y: 6 }] });
  const corner = suggestCornerPower(p.power, p.speed, { startSpeed: p.startSpeed, minFirePower: p.minFirePower });
  return {
    params: p,
    paths,
    patches,
    w,
    h: y,
    layers: [
      fillLayer(cRamp, p.speed, p.power),
      fillLayer(cPlain, p.speed, p.power),
      fillLayer(cOver, p.speed, p.power, { overscan: "auto" }),
      fillLayer(cCorner, p.speed, p.power, { minPower: corner, linkPower: false }),
    ],
  };
}

const SCAN_SPEEDS = 2;
export const SCAN_OFFSETS = [-0.1, 0, 0.1, 0.2, 0.3, 0.4];

function scanCard(p: ScanCardParams): Card {
  const paths: ScenePath[] = [];
  const patches: Patch[] = [];
  const layers: Card["layers"] = [];
  p.speeds.forEach((speed, si) => {
    const y = 3 + si * 13;
    p.offsets.forEach((off, oi) => {
      const color = p.colors[si * p.offsets.length + oi]!;
      const x = 3 + oi * 8;
      for (let b = 0; b < 3; b++) paths.push({ color, closed: true, points: rect(x + b * 1.6, y, 0.8, 7) });
      patches.push({ group: `speed:${speed}`, x: x - 0.8, y: y - 1, w: 6.4, h: 9, value: off, label: `${off >= 0 ? "+" : ""}${off}` });
      layers.push(fillLayer(color, speed, p.power, { scanOffset: off, overscan: "auto" }));
    });
  });
  return { params: p, paths, patches, layers, w: 3 + p.offsets.length * 8 + 2, h: 3 + p.speeds.length * 13 };
}

export const GRID_SPEEDS = [0.6, 0.8, 1, 1.3];
export const GRID_POWERS = [0.7, 1, 1.3];
export const CUT_STEPS = [0.8, 1, 1.3, 2.5];

function gridCard(p: GridCardParams): Card {
  const paths: ScenePath[] = [];
  const patches: Patch[] = [];
  const layers: Card["layers"] = [];
  let k = 0;
  p.powers.forEach((power, pi) => {
    p.speeds.forEach((speed, si) => {
      const color = p.colors[k++]!;
      const [x, y] = [3 + si * 9, 3 + pi * 9];
      paths.push({ color, closed: true, points: rect(x, y, 7, 7) });
      patches.push({ group: "engrave", x: x - 0.5, y: y - 0.5, w: 8, h: 8, value: `${speed}/${power}`, label: "", speed, power });
      layers.push(fillLayer(color, speed, power, { overscan: "auto" }));
    });
  });
  const yc = 3 + p.powers.length * 9 + 4;
  p.cutSpeeds.forEach((speed, i) => {
    const color = p.colors[k++]!;
    const x = 3 + i * 9;
    paths.push({ color, closed: true, points: rect(x, yc, 6, 6) });
    patches.push({ group: "cut", x: x - 0.5, y: yc - 0.5, w: 7, h: 7, value: speed, label: `${speed}`, speed, power: p.cutPower });
    layers.push(cutLayer(color, speed, p.cutPower));
  });
  return { params: p, paths, patches, layers, w: Math.max(3 + p.speeds.length * 9, 3 + p.cutSpeeds.length * 9) + 2, h: yc + 9 };
}

export const KERF_STEPS = [0, 0.05, 0.1, 0.15, 0.2, 0.25];
const PEG = 6;

function kerfCard(p: KerfCardParams): Card {
  const color = p.colors[0]!;
  const paths: ScenePath[] = [];
  const patches: Patch[] = [];
  const w = 3 + p.ks.length * (PEG + 4) + 1;
  paths.push({ color, closed: true, points: rect(0, 0, w, PEG + 8) });
  p.ks.forEach((k, i) => {
    const s = PEG - 2 * k;
    const x = 4 + i * (PEG + 4) + k;
    paths.push({ color, closed: true, points: rect(x, 4 + k, s, s) });
    patches.push({ group: "hole", x: x - 1, y: 3, w: s + 2, h: PEG + 2, value: k, label: `${k}` });
  });
  paths.push({ color, closed: true, points: rect(0, PEG + 12, PEG, PEG) });
  return { params: p, paths, patches, layers: [cutLayer(color, p.speed, p.power, p.passes)], w, h: PEG * 2 + 12 };
}

export function makeCard(p: CardParams): Card {
  switch (p.kind) {
    case "fill":
      return fillCard(p);
    case "scan":
      return scanCard(p);
    case "grid":
      return gridCard(p);
    case "kerf":
      return kerfCard(p);
  }
}

// ---------- Defaults for new cards ----------

/** Fill card for this machine at an engraving speed and power. */
export const fillParams = (m: MachineProfile, speed: number, power: number, colors: string[]): FillCardParams => ({
  kind: "fill",
  speed,
  power,
  accel: m.accel,
  startSpeed: startSpeedOf(m),
  minFirePower: m.minFirePower ?? 10,
  colors,
});

export const scanParams = (speed: number, power: number, colors: string[]): ScanCardParams => ({
  kind: "scan",
  speeds: [r1(speed), r1(Math.min(speed * 2, 500))],
  offsets: SCAN_OFFSETS,
  power,
  colors,
});

export const gridParams = (material: string, engrave: { speed: number; power: number }, cut: { speed: number; power: number }, colors: string[]): GridCardParams => ({
  kind: "grid",
  material,
  speeds: GRID_SPEEDS.map((f) => r1(engrave.speed * f)),
  powers: GRID_POWERS.map((f) => r1(Math.min(100, engrave.power * f))),
  cutSpeeds: CUT_STEPS.map((f) => r1(cut.speed * f)),
  cutPower: cut.power,
  colors,
});

export const kerfParams = (material: string, cut: { speed: number; power: number; passes: number; preset?: string }, colors: string[]): KerfCardParams => ({
  kind: "kerf",
  material,
  preset: cut.preset,
  speed: cut.speed,
  power: cut.power,
  passes: cut.passes,
  ks: KERF_STEPS,
  colors,
});

// ---------- Reading results ----------

/**
 * Acceleration from the fill card: the shortest strip with a lighter middle is twice the speed-up distance.
 * "none" = every strip burned dark (slower than the longest strip shows), "all" = even the shortest had a lighter
 * middle (faster than the shortest shows): the bound, moved a little past it. Rounded to 50 mm/s².
 */
export function accelFromStrip(p: FillCardParams, choice: number | "none" | "all"): number {
  const lens = rampLengths(p);
  const vs = p.startSpeed;
  const dv = Math.max(1, p.speed * p.speed - vs * vs);
  const a = choice === "none" ? (dv / lens.at(-1)!) * 0.8 : choice === "all" ? (dv / lens[0]!) * 1.25 : dv / Math.max(0.5, choice);
  return Math.max(50, Math.round(a / 50) * 50);
}

/** The fill fix for the row chosen as most even. */
export const fixFromRow = (row: (typeof FILL_ROWS)[number]) => (row === "plain" ? "none" : row) as "none" | "overscan" | "corner";
