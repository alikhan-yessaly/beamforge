import { describe, expect, it } from "vitest";
import { adjust, otsu, threshold, toGray } from "../src/import/trace/preprocess";
import { trace } from "../src/import/trace/potrace";
import { mask, quantize } from "../src/import/trace/quantize";
import type { Rgba } from "../src/import/types";

function bitmap(w: number, h: number, fn: (x: number, y: number) => boolean): Uint8Array {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = fn(x, y) ? 1 : 0;
  return b;
}

function rgba(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = fn(x, y);
      data.set(px, (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const bounds = (pts: { x: number; y: number }[]) => ({
  minX: Math.min(...pts.map((p) => p.x)),
  maxX: Math.max(...pts.map((p) => p.x)),
  minY: Math.min(...pts.map((p) => p.y)),
  maxY: Math.max(...pts.map((p) => p.y)),
});

const area = (pts: { x: number; y: number }[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

describe("potrace", () => {
  it("traces a filled square to one four-corner path", () => {
    const bits = bitmap(40, 40, (x, y) => x >= 10 && x < 30 && y >= 5 && y < 25);
    const paths = trace(bits, 40, 40);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.hole).toBe(false);
    expect(paths[0]!.points).toHaveLength(4);
    const b = bounds(paths[0]!.points);
    expect(b.minX).toBeCloseTo(10, 6);
    expect(b.maxX).toBeCloseTo(30, 6);
    expect(b.minY).toBeCloseTo(5, 6);
    expect(b.maxY).toBeCloseTo(25, 6);
  });

  it("gives outer path plus hole for a ring", () => {
    const bits = bitmap(50, 50, (x, y) => x >= 5 && x < 45 && y >= 5 && y < 45 && !(x >= 15 && x < 35 && y >= 15 && y < 35));
    const paths = trace(bits, 50, 50);
    expect(paths).toHaveLength(2);
    const outer = paths.find((p) => !p.hole)!;
    const hole = paths.find((p) => p.hole)!;
    expect(area(outer.points)).toBeCloseTo(1600, 3);
    expect(area(hole.points)).toBeCloseTo(400, 3);
  });

  it("removes specks below turdSize", () => {
    const bits = bitmap(40, 40, (x, y) => (x >= 10 && x < 20 && y >= 10 && y < 20) || (x === 30 && y === 30) || (x >= 5 && x < 7 && y >= 35 && y < 37));
    expect(trace(bits, 40, 40, { turdSize: 5 })).toHaveLength(1);
    expect(trace(bits, 40, 40, { turdSize: 0 }).length).toBe(3);
  });

  it("handles a single pixel with turdSize 0 without crashing", () => {
    const bits = bitmap(5, 5, (x, y) => x === 2 && y === 2);
    const paths = trace(bits, 5, 5, { turdSize: 0 });
    expect(paths).toHaveLength(1);
  });

  it("traces a circle to a smooth path near the radius", () => {
    const r = 40;
    const bits = bitmap(100, 100, (x, y) => (x + 0.5 - 50) ** 2 + (y + 0.5 - 50) ** 2 <= r * r);
    const paths = trace(bits, 100, 100);
    expect(paths).toHaveLength(1);
    const pts = paths[0]!.points;
    for (const p of pts) expect(Math.abs(Math.hypot(p.x - 50, p.y - 50) - r)).toBeLessThan(1);
    // Smooth fitting needs far fewer points than the ~250 pixel-edge staircase corners.
    expect(pts.length).toBeLessThan(200);
    expect(area(pts)).toBeGreaterThan(Math.PI * r * r * 0.98);
    expect(area(pts)).toBeLessThan(Math.PI * r * r * 1.02);
  });

  it("alphaMax 0 keeps every polygon vertex as a corner", () => {
    const bits = bitmap(100, 100, (x, y) => (x + 0.5 - 50) ** 2 + (y + 0.5 - 50) ** 2 <= 40 * 40);
    const sharp = trace(bits, 100, 100, { alphaMax: 0, optCurve: false })[0]!.points;
    const smoothPts = trace(bits, 100, 100)[0]!.points;
    expect(sharp.length).toBeLessThan(smoothPts.length * 2 + 200);
    expect(sharp.length).toBeGreaterThan(8);
  });

  it("is fast on a 1000x1000 random-blob image", () => {
    let s = 12345;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const w = 1000;
    const noise = new Float32Array(w * w);
    for (let i = 0; i < noise.length; i++) noise[i] = rnd() * 255;
    const blurred = adjust(noise, w, w, { brightness: 0, contrast: 100, blur: 4, invert: false });
    const bits = threshold(blurred, 128);
    const t0 = performance.now();
    const paths = trace(bits, w, w);
    const ms = performance.now() - t0;
    expect(paths.length).toBeGreaterThan(10);
    expect(ms).toBeLessThan(8000);
  });
});

describe("preprocess", () => {
  it("toGray composites alpha over white", () => {
    const g = toGray(rgba(3, 1, (x) => (x === 0 ? [0, 0, 0, 255] : x === 1 ? [0, 0, 0, 0] : [255, 255, 255, 255])));
    expect(g[0]).toBeCloseTo(0, 3);
    expect(g[1]).toBeCloseTo(255, 3);
    expect(g[2]).toBeCloseTo(255, 3);
  });

  it("otsu splits a bimodal image between the modes", () => {
    const g = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) g[i] = i % 2 ? 200 : 50;
    const level = otsu(g);
    expect(level).toBeGreaterThanOrEqual(50);
    expect(level).toBeLessThan(200);
    const bits = threshold(g, level);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(0);
  });

  it("adjust inverts and shifts brightness", () => {
    const g = new Float32Array([0, 100, 255]);
    const inv = adjust(g, 3, 1, { brightness: 0, contrast: 0, blur: 0, invert: true });
    expect(Array.from(inv)).toEqual([255, 155, 0]);
    const bright = adjust(g, 3, 1, { brightness: 20, contrast: 0, blur: 0, invert: false });
    expect(bright[0]).toBeCloseTo(51, 3);
    expect(bright[1]).toBeCloseTo(151, 3);
    expect(bright[2]).toBe(255);
    const same = adjust(g, 3, 1, { brightness: 0, contrast: 0, blur: 0, invert: false });
    expect(Array.from(same)).toEqual([0, 100, 255]);
  });

  it("adjust blur averages neighbours and keeps size", () => {
    const g = new Float32Array([0, 0, 90, 0, 0]);
    const out = adjust(g, 5, 1, { brightness: 0, contrast: 0, blur: 1, invert: false });
    expect(out[2]).toBeCloseTo(30, 3);
    expect(out[1]).toBeCloseTo(30, 3);
    expect(out[0]).toBeCloseTo(0, 3);
  });
});

describe("quantize", () => {
  const colors: [number, number, number][] = [
    [255, 0, 0],
    [0, 128, 0],
    [0, 0, 255],
  ];
  const img = rgba(30, 30, (x) => [...colors[Math.floor(x / 10)]!, 255] as [number, number, number, number]);

  it("returns the three colours with correct indices", () => {
    const q = quantize(img, 3);
    expect(q.palette.slice().sort()).toEqual(["#0000ff", "#008000", "#ff0000"]);
    const red = q.palette.indexOf("#ff0000");
    const blue = q.palette.indexOf("#0000ff");
    expect(q.index[0]).toBe(red);
    expect(q.index[29]).toBe(blue);
    expect(mask(q.index, red).reduce((a, b) => a + b, 0)).toBe(300);
  });

  it("marks transparent pixels 255", () => {
    const q = quantize(rgba(4, 1, (x) => [10, 10, 10, x < 2 ? 0 : 255]), 2);
    expect(q.index[0]).toBe(255);
    expect(q.index[3]).not.toBe(255);
  });

  it("ignoreWhite drops the white cluster", () => {
    const withWhite = rgba(30, 10, (x) => (x < 10 ? [255, 255, 255, 255] : x < 20 ? [0, 0, 0, 255] : [255, 0, 0, 255]));
    const q = quantize(withWhite, 3, { ignoreWhite: true });
    expect(q.palette.slice().sort()).toEqual(["#000000", "#ff0000"]);
    expect(q.index[0]).toBe(255);
    expect(q.index[15]).not.toBe(255);
  });

  it("is deterministic", () => {
    const noisy = rgba(64, 64, (x, y) => [(x * 37) % 256, (y * 91) % 256, (x * y) % 256, 255]);
    expect(quantize(noisy, 6).palette).toEqual(quantize(noisy, 6).palette);
  });
});
