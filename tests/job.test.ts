import { describe, expect, it } from "vitest";
import { IDENTITY, type Vec } from "../src/geom/geom";
import { estimate, formatDuration, trapezoid } from "../src/job/estimate";
import { activeLayers, moveLayer, updateLayer, visibleDocument } from "../src/job/layers";
import { planToolpath } from "../src/job/plan";
import type { Doc, ScenePath } from "../src/scene/model";

const rect = (x: number, y: number, w: number, h: number, color = "#000000"): ScenePath => ({
  color,
  closed: true,
  points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
});
const line = (a: Vec, b: Vec, color = "#000000"): ScenePath => ({ color, closed: false, points: [a, b] });
const docOf = (paths: ScenePath[], layers: Doc["layers"] = []): Doc => ({
  objects: [{ id: "o", name: "o", paths, mat: IDENTITY }],
  layers,
});
const O = { x: 0, y: 0 };

describe("layers", () => {
  const d = docOf([rect(0, 0, 10, 10, "#ff0000"), rect(20, 0, 10, 10, "#0000ff")]);

  it("gives every colour in use a default layer, in first-seen order", () => {
    expect(activeLayers(d).map((l) => [l.color, l.speed, l.passes, l.output])).toEqual([
      ["#ff0000", 20, 1, true],
      ["#0000ff", 20, 1, true],
    ]);
  });

  it("stores edits and order, and keeps settings of colours no longer used", () => {
    let e = updateLayer(d, "#0000ff", { speed: 5, passes: 3 });
    e = moveLayer(e, "#0000ff", -1);
    expect(activeLayers(e).map((l) => l.color)).toEqual(["#0000ff", "#ff0000"]);
    expect(activeLayers(e)[0]).toMatchObject({ speed: 5, passes: 3 });
    const gone: Doc = { ...e, objects: [{ ...e.objects[0]!, paths: [rect(0, 0, 10, 10, "#ff0000")] }] };
    expect(activeLayers(gone).map((l) => l.color)).toEqual(["#ff0000"]);
    expect(gone.layers.find((l) => l.color === "#0000ff")).toMatchObject({ speed: 5 });
  });

  it("links corner power to power by default, and unlinks when a different corner power is set", () => {
    let e = updateLayer(d, "#ff0000", { maxPower: 40 });
    expect(activeLayers(e)[0]).toMatchObject({ minPower: 40, maxPower: 40, linkPower: true });
    e = updateLayer(e, "#ff0000", { minPower: 15 });
    expect(activeLayers(e)[0]).toMatchObject({ minPower: 15, maxPower: 40, linkPower: false });
    e = updateLayer(e, "#ff0000", { maxPower: 50 });
    expect(activeLayers(e)[0]).toMatchObject({ minPower: 15, maxPower: 50 });
    e = updateLayer(e, "#ff0000", { linkPower: true });
    expect(activeLayers(e)[0]).toMatchObject({ minPower: 50, maxPower: 50 });
    // Older layers without the flag: linked only if the two powers are equal.
    const old = { ...d, layers: [{ color: "#ff0000", speed: 20, minPower: 10, maxPower: 20, passes: 1, output: true }] };
    expect(activeLayers(updateLayer(old, "#ff0000", { maxPower: 30 }))[0]).toMatchObject({ minPower: 10, maxPower: 30 });
  });

  it("clamps values", () => {
    const e = updateLayer(d, "#ff0000", { minPower: 50, maxPower: 30, passes: 0, speed: -1 });
    // Power is the main number: corner power is capped at it.
    expect(activeLayers(e)[0]).toMatchObject({ minPower: 30, maxPower: 30, passes: 1, speed: 0.1 });
  });

  it("defaults old layers to visible and filters hidden colours without altering output", () => {
    const old = updateLayer(d, "#ff0000", { output: false });
    old.layers = old.layers.map(({ show: _show, ...layer }) => layer);
    expect(activeLayers(old)[0]!.show).not.toBe(false);
    expect(visibleDocument(old)).toBe(old);
    const hidden = updateLayer(old, "#0000ff", { show: false });
    expect(visibleDocument(hidden).objects[0]!.paths.map((p) => p.color)).toEqual(["#ff0000"]);
    expect(planToolpath(hidden, { start: O, innerFirst: false }).layers.map((l) => l.color)).toEqual(["#0000ff"]);
    expect(activeLayers(hidden).find((l) => l.color === "#0000ff")).toMatchObject({ show: false, output: true });
  });
});

describe("planToolpath", () => {
  it("cuts layers in order, skips output-off layers, and returns to the start", () => {
    let d = docOf([rect(100, 0, 10, 10, "#ff0000"), rect(0, 0, 10, 10, "#0000ff"), rect(50, 50, 5, 5, "#00ff00")]);
    d = moveLayer(d, "#0000ff", -1);
    d = updateLayer(d, "#00ff00", { output: false });
    const tp = planToolpath(d, { start: O, innerFirst: true });
    expect(tp.layers.map((l) => l.color)).toEqual(["#0000ff", "#ff0000"]);
    const cuts = tp.segments.filter((s) => s.cut);
    expect(cuts).toHaveLength(8);
    expect(cuts.slice(0, 4).every((s) => s.layer === 0)).toBe(true);
    const last = tp.segments.at(-1)!;
    expect([last.cut, last.x1, last.y1]).toEqual([false, 0, 0]);
  });

  it("orders by nearest neighbour and starts closed shapes at the nearest vertex", () => {
    const d = docOf([rect(200, 0, 10, 10), rect(20, 0, 10, 10), rect(100, 0, 10, 10)]);
    const tp = planToolpath(d, { start: O, innerFirst: false });
    const starts = tp.segments.filter((s, i) => s.cut && !tp.segments[i - 1]?.cut).map((s) => s.x0);
    expect(starts).toEqual([20, 100, 200]);
  });

  it("reverses an open path when its far end is closer", () => {
    const d = docOf([line({ x: 50, y: 0 }, { x: 10, y: 0 })]);
    const tp = planToolpath(d, { start: O, innerFirst: false });
    const cut = tp.segments.find((s) => s.cut)!;
    expect([cut.x0, cut.x1]).toEqual([10, 50]);
  });

  it("cuts inner shapes before the shape around them", () => {
    // The outer square's corner is nearest to the start, but its hole must go first.
    const d = docOf([rect(0, 0, 100, 100), rect(40, 40, 20, 20)]);
    const first = planToolpath(d, { start: O, innerFirst: true }).segments.find((s) => s.cut)!;
    expect(first.x0).toBeGreaterThanOrEqual(40);
    const naive = planToolpath(d, { start: O, innerFirst: false }).segments.find((s) => s.cut)!;
    expect([naive.x0, naive.y0]).toEqual([0, 0]);
  });

  it("repeats a layer's geometry once per pass", () => {
    const d = updateLayer(docOf([rect(10, 10, 10, 10)]), "#000000", { passes: 3 });
    const tp = planToolpath(d, { start: O, innerFirst: true });
    expect(tp.segments.filter((s) => s.cut)).toHaveLength(12);
  });

  const travelLength = (tp: ReturnType<typeof planToolpath>) => tp.segments.filter((s) => !s.cut).reduce((n, s) => n + Math.hypot(s.x1 - s.x0, s.y1 - s.y0), 0);

  it("gives each shape all its passes before the next, innermost first", () => {
    const d = updateLayer(docOf([rect(0, 0, 100, 100), rect(40, 40, 20, 20)]), "#000000", { passes: 2 });
    const cuts = planToolpath(d, { start: O, innerFirst: true }).segments.filter((s) => s.cut);
    expect(cuts).toHaveLength(16);
    // The first 8 cuts (two passes) are all on the hole, the last 8 on the outline.
    expect(cuts.slice(0, 8).every((s) => s.x0 >= 40 && s.x0 <= 60)).toBe(true);
    expect(cuts.slice(8).every((s) => s.x0 === 0 || s.x0 === 100 || s.y0 === 0 || s.y0 === 100)).toBe(true);
  });

  it("cuts an open path back and forth on alternate passes", () => {
    const d = updateLayer(docOf([line({ x: 10, y: 0 }, { x: 20, y: 0 })]), "#000000", { passes: 2 });
    const segs = planToolpath(d, { start: O, innerFirst: true }).segments;
    const cuts = segs.filter((s) => s.cut);
    expect(cuts.map((s) => [s.x0, s.x1])).toEqual([[10, 20], [20, 10]]);
    expect(segs.filter((s) => !s.cut)).toHaveLength(2); // there and home
  });

  it("joins separate lines that meet end to end into one cut", () => {
    const sq = [line({ x: 10, y: 10 }, { x: 20, y: 10 }), line({ x: 20, y: 20 }, { x: 20, y: 10 }), line({ x: 20, y: 20 }, { x: 10, y: 20 }), line({ x: 10, y: 10 }, { x: 10, y: 20 })];
    const segs = planToolpath(docOf(sq), { start: O, innerFirst: true }).segments;
    expect(segs.filter((s) => s.cut)).toHaveLength(4);
    expect(segs.filter((s) => !s.cut)).toHaveLength(2); // one start, one return: no travel between the sides
  });

  it("2-opt fixes a nearest-neighbour zig-zag", () => {
    // Tiny marks at x = 1, -2, 4, -8 (start at 0): nearest-neighbour zig-zags 1+3+6+12 and back 8 = 30 mm;
    // going 1, 4, then -2, -8 is about 24 mm.
    const S = { x: 10, y: 10 };
    const paths = [1, -2, 4, -8].map((x) => line({ x: S.x + x, y: S.y }, { x: S.x + x, y: S.y + 0.01 }));
    const tp = planToolpath(docOf(paths), { start: S, innerFirst: true });
    expect(travelLength(tp)).toBeLessThan(26);
  });
});

describe("estimate", () => {
  const motion = { travelSpeed: 100, accel: 1000 };

  it("trapezoid: long move cruises, short move peaks", () => {
    // 100 mm at 10 mm/s with 1000 mm/s²: 0.01 s ramps each way, 0.1 mm of ramp distance in total.
    expect(trapezoid(100, 0, 0, 10, 1000)).toBeCloseTo(0.01 + 0.01 + 99.9 / 10, 9);
    // 1 mm can't reach 100 mm/s: triangle with peak sqrt(a·len) = 31.6 mm/s.
    expect(trapezoid(1, 0, 0, 100, 1000)).toBeCloseTo((2 * Math.sqrt(1000)) / 1000, 9);
  });

  it("a 100 mm square at 10 mm/s takes a bit over 40 s of cutting", () => {
    const d = updateLayer(docOf([rect(10, 10, 100, 100)]), "#000000", { speed: 10 });
    const tp = planToolpath(d, { start: O, innerFirst: true });
    const e = estimate(tp, motion);
    expect(e.cutLength).toBeCloseTo(400, 9);
    // At 10 mm/s a 90° corner is within the junction limit (√(a·δ·sin45°/(1−sin45°)) ≈ 11 mm/s), so only the
    // start and end ramps cost time: 0.01 s in total.
    expect(e.cutTime).toBeCloseTo(40.01, 6);
    // At 50 mm/s the corners slow it down noticeably.
    const fast = estimate(planToolpath(updateLayer(d, "#000000", { speed: 50 }), { start: O, innerFirst: true }), motion);
    expect(fast.cutTime).toBeGreaterThan(400 / 50 + 4 * 0.03);
    expect(e.travelLength).toBeCloseTo(2 * Math.hypot(10, 10), 9);
    expect(e.total).toBeCloseTo(e.cutTime + e.travelTime, 9);
    expect(e.endTimes.at(-1)).toBeCloseTo(e.total, 9);
    expect(e.layerTime).toEqual([e.cutTime]);
  });

  it("smooth curves keep their speed through gentle corners", () => {
    const n = 64;
    const circle: ScenePath = {
      color: "#000000",
      closed: true,
      points: Array.from({ length: n }, (_, i) => ({ x: 50 + 20 * Math.cos((2 * Math.PI * i) / n), y: 50 + 20 * Math.sin((2 * Math.PI * i) / n) })),
    };
    const d = updateLayer(docOf([circle]), "#000000", { speed: 10 });
    const e = estimate(planToolpath(d, { start: O, innerFirst: true }), motion);
    // Close to length / speed; a stop at every vertex would add 64 × 0.01 s.
    expect(e.cutTime).toBeLessThan(e.cutLength / 10 + 0.05);
  });

  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65.4)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
