import { describe, expect, it } from "vitest";
import { type Vec, pathsBox, pointInPolygon } from "../src/geom/geom";
import { estimate } from "../src/job/estimate";
import { cornerSavings, orderItems, travelTime } from "../src/job/order";
import { type Toolpath, planToolpath } from "../src/job/plan";
import { OUTLINE, TEXT, scenes } from "./fixtures/orderScenes";

const O = { x: 0, y: 0 };
const M = { travelSpeed: 100, accel: 2000 };
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
const item = (pts: Vec[], closed = true, speed?: number) => ({ pts, closed, box: pathsBox([{ points: pts, closed }]), speed });
const square = (x: number, y: number, s: number): Vec[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

/** Burn paths of a toolpath in cut order (runs of joined cut segments), with their layer colour. */
function burns(tp: Toolpath): { pts: Vec[]; color: string }[] {
  const out: { pts: Vec[]; color: string }[] = [];
  tp.segments.forEach((s, i) => {
    const prev = tp.segments[i - 1];
    if (!s.cut) return;
    if (!prev?.cut || prev.x1 !== s.x0 || prev.y1 !== s.y0) out.push({ pts: [{ x: s.x0, y: s.y0 }], color: tp.layers[s.layer]!.color });
    out.at(-1)!.pts.push({ x: s.x1, y: s.y1 });
  });
  return out;
}

describe("cut order", () => {
  it("visits a grid about as well as a serpentine", () => {
    // 10 × 10 points (tiny squares), 10 mm apart; there and back from the corner.
    const items = [];
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) items.push(item(square(10 + i * 10, 10 + j * 10, 0.01)));
    const cost = (d: number) => d;
    const order = orderItems(items, O, { cost, innerFirst: false, to: O });
    let len = 0;
    let at = O;
    for (const o of order) {
      len += dist(at, o.pts[0]!);
      at = o.pts.at(-1)!;
    }
    len += dist(at, O);
    // Serpentine: 99 steps of 10 mm, in from the corner (~14 mm) and back from (10, 100) (~100 mm).
    const serpentine = 990 + Math.hypot(10, 10) + Math.hypot(10, 100);
    expect(len).toBeLessThanOrEqual(serpentine * 1.02);
  });

  it("starts a closed path in a corner when that saves more than the walk to it", () => {
    // A 100 mm square with a vertex every 10 mm; the head comes from straight below the middle of one side.
    const pts: Vec[] = [];
    for (let k = 0; k < 10; k++) pts.push({ x: k * 10, y: 0 });
    for (let k = 0; k < 10; k++) pts.push({ x: 100, y: k * 10 });
    for (let k = 0; k < 10; k++) pts.push({ x: 100 - k * 10, y: 100 });
    for (let k = 0; k < 10; k++) pts.push({ x: 0, y: 100 - k * 10 });
    const from = { x: 50, y: -200 };
    const cost = travelTime(M);
    const slow = orderItems([item(pts, true, 5)], from, { cost, innerFirst: false, accel: M.accel });
    expect(slow[0]!.pts[0]).toEqual({ x: 50, y: 0 }); // slow cut: the corner saves next to nothing
    const fast = orderItems([item(pts, true, 300)], from, { cost, innerFirst: false, accel: M.accel });
    expect([0, 100]).toContain(fast[0]!.pts[0]!.x);
    expect(fast[0]!.pts[0]!.y).toBe(0);
    expect(fast[0]!.pts.at(-1)).toEqual(fast[0]!.pts[0]);
  });

  it("rates corners by the slow-down they cost", () => {
    const sq = cornerSavings([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }], 100, 2000);
    expect(sq[1]).toBe(0); // straight on
    expect(sq[2]).toBeGreaterThan(0.01);
    expect(sq[2]).toBeLessThanOrEqual(100 / 2000);
  });

  it("picks among a path's variants and directions", () => {
    const it0 = { ...item([{ x: 100, y: 0 }, { x: 0, y: 0 }], false), variants: [[{ x: 100, y: 0 }, { x: 0, y: 0 }], [{ x: 0, y: 50 }, { x: 100, y: 50 }]] };
    const [o] = orderItems([it0], { x: 0, y: 60 }, { cost: (d) => d, innerFirst: false });
    expect(o).toMatchObject({ variant: 1, reversed: false });
    const [r] = orderItems([it0], { x: 110, y: 50 }, { cost: (d) => d, innerFirst: false });
    expect(r).toMatchObject({ variant: 1, reversed: true });
  });

  it("an outline waits for every shape inside it, at any depth", () => {
    // A frame around a ring around a dot, plus a dot outside; listed outermost first.
    const items = [item(square(0, 0, 100)), item(square(20, 20, 40)), item(square(30, 30, 20)), item(square(38, 38, 4)), item(square(200, 0, 5))];
    const order = orderItems(items, O, { cost: travelTime(M), innerFirst: true }).map((o) => o.i);
    for (const [inner, outer] of [[3, 2], [2, 1], [1, 0]]) expect(order.indexOf(inner!)).toBeLessThan(order.indexOf(outer!));
  });
});

describe("cut order on text", () => {
  const all = scenes();
  const plan = (name: string) => planToolpath(all.find((s) => s.name === name)!.doc, { start: O, innerFirst: true, motion: M });

  it("cuts every shape after the shapes inside it, and a letter's counters right before it", () => {
    for (const name of ["one word", "scattered words, cut", "dense page + scatter"]) {
      const b = burns(plan(name)).filter((p) => p.pts.length > 3);
      const box = b.map((p) => pathsBox([{ points: p.pts, closed: true }]));
      const inside = (j: number, i: number) => {
        const [x, X] = [box[j]!, box[i]!];
        return x.minX >= X.minX && x.maxX <= X.maxX && x.minY >= X.minY && x.maxY <= X.maxY && pointInPolygon(b[j]!.pts[0]!, b[i]!.pts);
      };
      const wrong: string[] = [];
      for (let i = 0; i < b.length; i++) {
        for (let j = i + 1; j < b.length; j++) if (inside(j, i)) wrong.push(`${j} inside ${i} but cut later`);
        // A letter's counters: the paths just before it that lie inside it, with nothing else in between.
        if (b[i]!.color !== TEXT) continue;
        const holes: number[] = [];
        for (let j = 0; j < i; j++) if (b[j]!.color === TEXT && inside(j, i)) holes.push(j);
        holes.forEach((j, k) => j !== i - holes.length + k && wrong.push(`counter ${j} of ${i} not just before it`));
      }
      expect(wrong, name).toEqual([]);
    }
  });

  it("the text heads for the outline's start, and the outline ends near home", () => {
    const tp = plan("scattered words, cut");
    const travel = tp.segments.filter((s) => !s.cut);
    const last = travel.at(-1)!;
    const intoOutline = travel.at(-2)!;
    expect(Math.hypot(last.x0 - O.x, last.y0 - O.y)).toBeLessThan(40);
    expect(Math.hypot(intoOutline.x1 - intoOutline.x0, intoOutline.y1 - intoOutline.y0)).toBeLessThan(60);
    expect(burns(tp).at(-1)!.color).toBe(OUTLINE);
  });

  it("travels less than the old nearest-neighbour order on every test drawing", () => {
    // Travel seconds of the previous planner (nearest neighbour + 2-opt on distance) at 100 mm/s, 2000 mm/s².
    const before: Record<string, number> = {
      "tag grid": 14.9,
      "one word": 5.8,
      "scattered words, cut": 36.5,
      "scattered words, engraved": 311.7,
      "four plates, mixed": 280.7,
      "dense page + scatter": 180.3,
    };
    for (const s of all) {
      const e = estimate(planToolpath(s.doc, { start: O, innerFirst: true, motion: M }), M);
      expect(e.travelTime, s.name).toBeLessThan(before[s.name]! * (s.name.includes("engraved") ? 0.99 : 0.95));
    }
  });
});
