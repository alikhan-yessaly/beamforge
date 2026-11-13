import { describe, expect, it } from "vitest";
import type { Vec } from "../src/geom/geom";
import { SMOOTH_MM, jaggedness, simplify, smoothImport, smoothPath, suggestedLevel } from "../src/import/smooth";
import type { VecPath } from "../src/import/types";

/** Axis-aligned stair-steps through the given points rounded to a `g` mm grid, like a traced pixel edge. */
function pixelate(pts: Vec[], g: number): Vec[] {
  const r = pts.map((p) => ({ x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }));
  const out: Vec[] = [];
  r.forEach((p, i) => {
    if (i > 0) out.push({ x: p.x, y: r[i - 1]!.y });
    out.push(p);
  });
  return out;
}

const circle = (cx: number, cy: number, rad: number, n = 400): Vec[] =>
  Array.from({ length: n }, (_, i) => ({ x: cx + rad * Math.cos((2 * Math.PI * i) / n), y: cy + rad * Math.sin((2 * Math.PI * i) / n) }));

/** A square with a point every 0.1 mm and ±`noise` mm wobble. */
function noisySquare(size: number, noise: number): Vec[] {
  const out: Vec[] = [];
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  const corners = [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4]!;
    const n = Math.round(size / 0.1);
    for (let k = 0; k < n; k++) {
      const u = k / n;
      const wob = k === 0 ? 0 : rnd();
      // Wobble across the edge only.
      const nx = -(b.y - a.y) / size, ny = (b.x - a.x) / size;
      out.push({ x: a.x + (b.x - a.x) * u + nx * wob, y: a.y + (b.y - a.y) * u + ny * wob });
    }
  });
  return out;
}

const near = (p: Vec, q: Vec, tol: number) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;

describe("outline smoothing", () => {
  it("a pixel stair-step diagonal becomes a straight line", () => {
    const stairs = pixelate(Array.from({ length: 41 }, (_, i) => ({ x: i * 0.25, y: i * 0.25 })), 0.25);
    expect(stairs.length).toBeGreaterThan(60);
    const out = smoothPath(stairs, false, { scale: 0.5 })!;
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out[0]).toEqual(stairs[0]);
    expect(out[out.length - 1]).toEqual(stairs[stairs.length - 1]);
    for (const p of out) expect(Math.abs(p.x - p.y) / Math.SQRT2).toBeLessThan(0.15);
  });

  it("a pixelated circle comes out round, the right size, with far fewer segments", () => {
    const pix = pixelate(circle(20, 20, 10), 0.2);
    expect(jaggedness([{ points: pix, closed: true, stroke: "#000000", fill: null }])).toBeGreaterThan(0.3);
    const out = smoothPath(pix, true, { scale: 0.5 })!;
    expect(out.length).toBeLessThan(pix.length / 3);
    for (const p of out) expect(Math.abs(Math.hypot(p.x - 20, p.y - 20) - 10)).toBeLessThan(0.1);
    expect(jaggedness([{ points: out, closed: true, stroke: "#000000", fill: null }])).toBeLessThan(0.05);
  });

  it("keeps sharp corners and straightens wobbly edges", () => {
    const sq = noisySquare(20, 0.05);
    const out = smoothPath(sq, true, { scale: 0.5 })!;
    expect(out.length).toBeLessThan(40);
    for (const c of [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }]) expect(out.some((p) => near(p, c, 0.1))).toBe(true);
  });

  it("a pixelated rotated square: straight edges and its four corners", () => {
    const a = (20 * Math.PI) / 180;
    const rot = (x: number, y: number) => ({ x: 30 + x * Math.cos(a) - y * Math.sin(a), y: 30 + x * Math.sin(a) + y * Math.cos(a) });
    const truth = [rot(-10, -10), rot(10, -10), rot(10, 10), rot(-10, 10)];
    const dense: Vec[] = [];
    truth.forEach((p, i) => {
      const q = truth[(i + 1) % 4]!;
      for (let k = 0; k < 200; k++) dense.push({ x: p.x + ((q.x - p.x) * k) / 200, y: p.y + ((q.y - p.y) * k) / 200 });
    });
    const pix = pixelate(dense, 0.2);
    const out = smoothPath(pix, true, { scale: 0.5 })!;
    expect(out.length).toBeLessThan(pix.length / 5);
    for (const c of truth) expect(out.some((p) => near(p, c, 0.3))).toBe(true);
    // Only the four real corners may still count as sharp turns.
    expect(jaggedness([{ points: out, closed: true, stroke: "#000000", fill: null }])).toBeLessThanOrEqual(4 / out.length);
  });

  it("rounds corners when they aren't kept", () => {
    const sq = noisySquare(20, 0);
    const out = smoothPath(sq, true, { scale: 1, cornerAngle: 180 })!;
    expect(out.some((p) => near(p, { x: 0, y: 0 }, 0.1))).toBe(false);
  });

  it("drops specks smaller than the smoothing scale and leaves clean paths alone", () => {
    expect(smoothPath(circle(0, 0, 0.1, 12), true, { scale: 0.5 })).toBeNull();
    const clean = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }];
    expect(smoothPath(clean, false, { scale: 0.5 })).toEqual(clean);
    expect(smoothPath(clean, false, { scale: 0 })).toEqual(clean);
  });

  it("smoothImport keeps colours and drops what collapses", () => {
    const paths: VecPath[] = [
      { points: pixelate(circle(20, 20, 10), 0.2), closed: true, stroke: null, fill: "#ff0000" },
      { points: circle(50, 50, 0.1, 12), closed: true, stroke: null, fill: "#ff0000" },
    ];
    const out = smoothImport({ paths, warnings: [] }, { scale: 0.5 });
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0]!.fill).toBe("#ff0000");
  });

  it("suggests smoothing only for jagged drawings", () => {
    const pix: VecPath = { points: pixelate(circle(20, 20, 10), 0.2), closed: true, stroke: "#000000", fill: null };
    const smooth: VecPath = { points: circle(20, 20, 10, 200), closed: true, stroke: "#000000", fill: null };
    const cad: VecPath = { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 0, y: 30 }], closed: true, stroke: "#000000", fill: null };
    expect(suggestedLevel([pix])).not.toBe("off");
    expect(suggestedLevel([smooth])).toBe("off");
    expect(suggestedLevel([cad])).toBe("off");
  });

  it("picks a level at least 2.5 times the stair-step size", () => {
    const at = (g: number): VecPath => ({ points: pixelate(circle(30, 30, 20, 3000), g), closed: true, stroke: "#000000", fill: null });
    expect(suggestedLevel([at(0.1)])).toBe("light");
    expect(suggestedLevel([at(0.2)])).toBe("medium");
    expect(suggestedLevel([at(0.4)])).toBe("strong");
    expect(suggestedLevel([at(0.6)])).toBe("max");
  });

  it("at the suggested level, pixel circles of any step size come out smooth", () => {
    for (const g of [0.1, 0.2, 0.4, 0.6]) {
      const p: VecPath = { points: pixelate(circle(30, 30, 20, 3000), g), closed: true, stroke: "#000000", fill: null };
      const out = smoothPath(p.points, true, { scale: SMOOTH_MM[suggestedLevel([p])] })!;
      expect(jaggedness([{ ...p, points: out }]), `step ${g}`).toBeLessThan(0.05);
      for (const q of out) expect(Math.abs(Math.hypot(q.x - 30, q.y - 30) - 20), `step ${g}`).toBeLessThan(0.75 * g + 0.15);
    }
  });

  it("Douglas–Peucker keeps the ends and the far point", () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 1, y: 0.001 }, { x: 2, y: 0 }, { x: 3, y: 5 }], 0.01)).toEqual([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 5 }]);
  });
});
