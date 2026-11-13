// Test drawings for job ordering: simple, middle and hard, with real text outlines (Roboto, the app's default font).
// Deterministic (seeded), so tests and the benchmark (scripts/bench-order.ts) see the same work.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Font, parse } from "opentype.js";
import { IDENTITY, type Vec } from "../../src/geom/geom";
import { updateLayer } from "../../src/job/layers";
import type { Doc, ScenePath } from "../../src/scene/model";
import { textContours } from "../../src/sketch/text";

let font: Font | null = null;
export function roboto(): Font {
  if (font) return font;
  const file = createRequire(import.meta.url).resolve("@fontsource/roboto/files/roboto-latin-400-normal.woff");
  const buf = readFileSync(file);
  font = parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return font;
}

export const TEXT = "#ff0000";
export const OUTLINE = "#0000ff";
export const ENGRAVE = "#00e000";
export const HOLES = "#ff00ff";

const WORDS = "laser cut wood acrylic plywood beam forge maple birch oak walnut edge kerf focus lens mirror tube power speed pass layer fill hatch name tag gift box lid hinge joint slot tab panel sign label".split(" ");

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const rect = (x: number, y: number, w: number, h: number): Vec[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const circle = (cx: number, cy: number, r: number, n = 48): Vec[] => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
/** A rounded rectangle (corner radius r). */
function plate(x: number, y: number, w: number, h: number, r = 6): Vec[] {
  const out: Vec[] = [];
  const corners = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ] as const;
  for (const [cx, cy, a0] of corners) for (let k = 0; k <= 8; k++) {
    const a = ((a0 + (90 * k) / 8) * Math.PI) / 180;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return out;
}

/** Text outlines as closed paths (the closing vertex dropped, as the app stores closed paths). */
function text(s: string, at: Vec, size: number, angle: number, color: string): ScenePath[] {
  return textContours(roboto(), s, at, size, angle).map((c) => ({ color, closed: true, points: c.slice(0, -1) }));
}

/** Words scattered over a box without overlapping much (rejection sampling on their boxes). */
function scatter(r: () => number, box: { x: number; y: number; w: number; h: number }, count: number, sizes: [number, number], color: string, angles = true): ScenePath[] {
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out: ScenePath[] = [];
  for (let n = 0, tries = 0; n < count && tries < count * 50; tries++) {
    const word = WORDS[Math.floor(r() * WORDS.length)]!;
    const size = sizes[0] + r() * (sizes[1] - sizes[0]);
    const angle = angles && r() < 0.35 ? Math.round((r() - 0.5) * 180) : 0;
    const at = { x: box.x + r() * box.w, y: box.y + r() * box.h };
    const paths = text(word, at, size, angle, color);
    const pts = paths.flatMap((p) => p.points);
    const b = { x0: Math.min(...pts.map((p) => p.x)) - 1, y0: Math.min(...pts.map((p) => p.y)) - 1, x1: Math.max(...pts.map((p) => p.x)) + 1, y1: Math.max(...pts.map((p) => p.y)) + 1 };
    if (b.x0 < box.x || b.y0 < box.y || b.x1 > box.x + box.w || b.y1 > box.y + box.h) continue;
    if (placed.some((q) => b.x0 < q.x1 && q.x0 < b.x1 && b.y0 < q.y1 && q.y0 < b.y1)) continue;
    placed.push(b);
    out.push(...paths);
    n++;
  }
  return out;
}

function docOf(paths: ScenePath[], fills: string[] = []): Doc {
  let d: Doc = { objects: [{ id: "o", name: "o", mat: IDENTITY, paths }], layers: [] };
  for (const c of fills) d = updateLayer(d, c, { mode: "fill", fill: { pattern: "lines", interval: 0.1, angle: 0 } });
  return d;
}

export interface Scene {
  name: string;
  level: "simple" | "middle" | "hard";
  doc: Doc;
}

export function scenes(): Scene[] {
  const out: Scene[] = [];

  // Simple: a grid of tags, each with a hole.
  {
    const paths: ScenePath[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
      paths.push({ color: OUTLINE, closed: true, points: rect(20 + i * 30, 20 + j * 30, 24, 24) });
      paths.push({ color: HOLES, closed: true, points: circle(32 + i * 30, 26 + j * 30, 2.5) });
    }
    out.push({ name: "tag grid", level: "simple", doc: docOf(paths) });
  }
  // Simple: one word on a plate.
  {
    const paths = [{ color: OUTLINE, closed: true, points: plate(40, 40, 165, 50) }, ...text("BeamForge", { x: 52, y: 75 }, 20, 0, TEXT)];
    out.push({ name: "one word", level: "simple", doc: docOf(paths) });
  }
  // Middle: words scattered on a plate, cut.
  {
    const r = rng(7);
    const paths = [{ color: OUTLINE, closed: true, points: plate(20, 20, 320, 220) }, ...scatter(r, { x: 30, y: 30, w: 300, h: 200 }, 40, [4, 12], TEXT)];
    out.push({ name: "scattered words, cut", level: "middle", doc: docOf(paths) });
  }
  // Middle: scattered words engraved (fill) on a plate, a few cut words and holes.
  {
    const r = rng(11);
    const paths: ScenePath[] = [{ color: OUTLINE, closed: true, points: plate(20, 20, 320, 220) }];
    paths.push(...scatter(r, { x: 30, y: 30, w: 300, h: 200 }, 30, [5, 10], ENGRAVE, false));
    for (let k = 0; k < 8; k++) paths.push({ color: HOLES, closed: true, points: circle(40 + k * 40, 225, 3) });
    out.push({ name: "scattered words, engraved", level: "middle", doc: docOf(paths, [ENGRAVE]) });
  }
  // Hard: four plates, each with cut words, engraved words and holes; open score lines.
  {
    const r = rng(23);
    const paths: ScenePath[] = [];
    for (let px = 0; px < 2; px++) for (let py = 0; py < 2; py++) {
      const x = 10 + px * 295;
      const y = 10 + py * 195;
      paths.push({ color: OUTLINE, closed: true, points: plate(x, y, 285, 185) });
      paths.push(...scatter(r, { x: x + 8, y: y + 8, w: 269, h: 130 }, 35, [3, 9], TEXT));
      paths.push(...scatter(r, { x: x + 8, y: y + 140, w: 269, h: 36 }, 6, [4, 6], ENGRAVE, false));
      for (let k = 0; k < 6; k++) paths.push({ color: HOLES, closed: true, points: circle(x + 20 + k * 48, y + 180 - 6, 2) });
      paths.push({ color: TEXT, closed: false, points: [{ x: x + 10, y: y + 138 }, { x: x + 275, y: y + 138 }] });
    }
    out.push({ name: "four plates, mixed", level: "hard", doc: docOf(paths, [ENGRAVE]) });
  }
  // Hard: dense small text (a page of 2.5 mm text) plus scattered larger words, cut.
  {
    const r = rng(31);
    const paths: ScenePath[] = [{ color: OUTLINE, closed: true, points: plate(10, 10, 560, 370) }];
    for (let line = 0; line < 30; line++) {
      const words: string[] = [];
      for (let k = 0; k < 9; k++) words.push(WORDS[Math.floor(r() * WORDS.length)]!);
      paths.push(...text(words.join(" "), { x: 20, y: 25 + line * 6 }, 2.5, 0, TEXT));
    }
    paths.push(...scatter(r, { x: 300, y: 20, w: 260, h: 350 }, 60, [3, 14], TEXT));
    paths.push(...scatter(r, { x: 20, y: 210, w: 270, h: 160 }, 40, [3, 10], TEXT));
    out.push({ name: "dense page + scatter", level: "hard", doc: docOf(paths) });
  }
  return out;
}
