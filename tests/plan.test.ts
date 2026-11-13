import { describe, expect, it } from "vitest";
import { IDENTITY, type Vec } from "../src/geom/geom";
import { buildJob } from "../src/job/build";
import { fillPaths } from "../src/job/fill";
import { updateLayer } from "../src/job/layers";
import { planToolpath } from "../src/job/plan";
import { encodeJobCommands } from "../src/protocol/jobEncode";
import type { Doc, MachineProfile, ScenePath } from "../src/scene/model";

const sq = (x: number, y: number, s: number): Vec[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const path = (pts: Vec[], color: string, fill?: string): ScenePath => ({ color, closed: true, points: pts, ...(fill ? { fill } : {}) });
const docOf = (paths: ScenePath[]): Doc => ({ objects: [{ id: "o", name: "o", mat: IDENTITY, paths }], layers: [] });
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
/** Jumps between consecutive burn paths longer than `min`. */
const jumps = (paths: Vec[][], min: number) => paths.slice(1).filter((p, i) => dist(paths[i]!.at(-1)!, p[0]!) > min).length;
const R = "#ff0000";
const B = "#0000ff";
const F = "#00e000";
const O = { x: 0, y: 0 };

describe("fill trajectories", () => {
  // A U: 30 × 30 with a 10 mm wide, 20 mm deep notch from the top.
  const U: Vec[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }];

  it("lines sweep each arm of a U on its own instead of crossing the notch on every row", () => {
    const { paths } = fillPaths([U], { pattern: "lines", interval: 1, angle: 0 });
    expect(paths).toHaveLength(20 * 2 + 10);
    // Three cells (two arms, the base): two jumps between them, every other move is to the next row.
    expect(jumps(paths, 3)).toBeLessThanOrEqual(2);
    // Each sweep runs back and forth: consecutive rows of a cell go opposite ways.
    expect(paths[0]![0]!.x < paths[0]![1]!.x).not.toBe(paths[1]![0]!.x < paths[1]![1]!.x);
  });

  it("sweeps near parts of one area together across a hairline gap", () => {
    // Two 10 mm squares 0.2 mm apart, as one area (e.g. letters): crossing 0.2 mm per row beats jumping back.
    const { paths } = fillPaths([sq(0, 0, 10), sq(10.2, 0, 10)], { pattern: "lines", interval: 1, angle: 0 });
    expect(paths).toHaveLength(20);
    expect(jumps(paths, 2)).toBe(0);
  });

  it("starts the second cross-hatch direction where the first ended", () => {
    const { paths } = fillPaths([sq(0, 0, 10)], { pattern: "cross", interval: 1, angle: 0 });
    expect(paths).toHaveLength(20);
    expect(dist(paths[9]!.at(-1)!, paths[10]![0]!)).toBeLessThan(1);
    expect(jumps(paths, 1.5)).toBe(0);
  });

  it("offset contours run outside in, each from the point nearest the last", () => {
    const { paths } = fillPaths([sq(0, 0, 20)], { pattern: "offset", interval: 1, angle: 0 });
    expect(paths.length).toBe(10);
    const size = (p: Vec[]) => Math.max(...p.map((v) => v.x)) - Math.min(...p.map((v) => v.x));
    for (let i = 1; i < paths.length; i++) expect(size(paths[i]!)).toBeLessThan(size(paths[i - 1]!));
    expect(jumps(paths, 1.5)).toBe(0);
    for (const p of paths) expect(p.at(-1)).toEqual(p[0]);
  });

  it("offset contours follow one branch inward before the other", () => {
    // A dumbbell: the contours split into two branches.
    const bell: Vec[] = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 }, { x: 40, y: 8 }, { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 12 }, { x: 20, y: 12 }, { x: 20, y: 20 }, { x: 0, y: 20 }];
    const { paths } = fillPaths([bell], { pattern: "offset", interval: 1, angle: 0 });
    const side = (p: Vec[]) => (p.every((v) => v.x < 30) ? "L" : p.every((v) => v.x > 30) ? "R" : "both");
    const seq = paths.map(side).filter((s, i, a) => s !== a[i - 1]);
    expect(seq).toEqual(["both", seq[1], seq[1] === "L" ? "R" : "L"]);
  });
});

describe("job order", () => {
  // Two parts far apart: a red outline with a green fill inside each. Red is listed first.
  const parts = () => {
    let d = docOf([path(sq(10, 10, 20), R, F), path(sq(300, 10, 20), R, F)]);
    d = updateLayer(d, R, { mode: "cut" });
    d = updateLayer(d, F, { mode: "fill", fill: { pattern: "lines", interval: 1, angle: 0 } });
    return d;
  };
  const sequence = (tp: ReturnType<typeof planToolpath>) =>
    tp.segments.filter((s) => s.cut).map((s) => `${s.x0 < 150 ? "A" : "B"}${tp.layers[s.layer]!.color === F ? "fill" : "cut"}`).filter((s, i, a) => s !== a[i - 1]);

  it("fills before the cut around them, even when the cut layer is listed first", () => {
    for (const order of ["layer", "object"] as const) {
      const seq = sequence(planToolpath(parts(), { start: O, innerFirst: true, order }));
      for (const p of ["A", "B"]) expect(seq.indexOf(`${p}fill`)).toBeLessThan(seq.indexOf(`${p}cut`));
    }
  });

  it("auto finishes one part before the next when that travels less", () => {
    const tp = planToolpath(parts(), { start: O, innerFirst: true });
    expect(tp.order).toBe("object");
    expect(sequence(tp)).toEqual(["Afill", "Acut", "Bfill", "Bcut"]);
    expect(sequence(planToolpath(parts(), { start: O, innerFirst: true, order: "layer" }))).toEqual(["Afill", "Bfill", "Bcut", "Acut"]);
  });

  it("keeps layer by layer when it's no slower", () => {
    // Plain cuts on one layer: nothing to group.
    const d = docOf([path(sq(10, 10, 5), R), path(sq(40, 10, 5), R), path(sq(70, 10, 5), R)]);
    expect(planToolpath(d, { start: O, innerFirst: true }).order).toBe("layer");
  });

  it("cuts holes on a later layer before the outline around them", () => {
    // Red outline (listed first) around a blue hole.
    const d = docOf([path(sq(10, 10, 40), R), path(sq(20, 20, 10), B)]);
    const tp = planToolpath(d, { start: O, innerFirst: true });
    expect(tp.order).toBe("object");
    const first = tp.segments.find((s) => s.cut)!;
    expect(tp.layers[first.layer]!.color).toBe(B);
    const forced = planToolpath(d, { start: O, innerFirst: true, order: "layer" });
    expect(forced.warnings.some((w) => /later layer/.test(w))).toBe(true);
  });

  it("encodes a layer that comes back with its settings sent again", () => {
    const P: MachineProfile = { name: "t", bedW: 600, bedH: 400, origin: "top-left", travelSpeed: 100, accel: 2000 };
    const hex = (c: Uint8Array) => [...c.slice(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const starts = (order: "layer" | "object") => encodeJobCommands(buildJob(parts(), P, { mode: "absolute", innerFirst: true, order }).input).filter((c) => hex(c) === "ca 02").map((c) => c[2]);
    // Red is layer 0, green 1; fills go first either way.
    expect(starts("layer")).toEqual([1, 0]);
    expect(starts("object")).toEqual([1, 0, 1, 0]);
  });
});
