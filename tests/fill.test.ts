import { describe, expect, it } from "vitest";
import { IDENTITY, type Vec } from "../src/geom/geom";
import { buildJob } from "../src/job/build";
import { MAX_FILL_PATHS, fillPaths } from "../src/job/fill";
import { activeLayers, assignColor, assignMode, migrateDoc, toggleRegionFill, updateLayer } from "../src/job/layers";
import { fillUnits, planToolpath } from "../src/job/plan";
import type { Doc, MachineProfile, ScenePath } from "../src/scene/model";
import { addEntity, addPoint, emptySketch } from "../src/sketch/model";
import { sketchPaths } from "../src/sketch/paths";

const sq = (x: number, y: number, s: number): Vec[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const box = (paths: Vec[][]) => {
  const pts = paths.flat();
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) };
};

describe("fillPaths", () => {
  const ring = [sq(0, 0, 10), sq(3, 3, 4)]; // a 10 mm square with a 4 mm hole

  it("lines: one span per scanline, two beside the hole, alternating direction", () => {
    const { paths } = fillPaths(ring, { pattern: "lines", interval: 1, angle: 0 });
    // 10 scanlines; the 4 that cross the hole (y 3.5–6.5) are split in two.
    expect(paths).toHaveLength(14);
    expect(paths[0]).toEqual([{ x: 0, y: 0.5 }, { x: 10, y: 0.5 }]);
    expect(paths[1]).toEqual([{ x: 10, y: 1.5 }, { x: 0, y: 1.5 }]);
    // Nothing burns inside the hole.
    for (const [a, b] of paths) {
      const midX = (a!.x + b!.x) / 2;
      const inHole = a!.y > 3 && a!.y < 7 && midX > 3 && midX < 7;
      expect(inHole).toBe(false);
    }
  });

  it("lines at 90° run vertically; cross-hatch is both directions", () => {
    const v = fillPaths([sq(0, 0, 10)], { pattern: "lines", interval: 1, angle: 90 }).paths;
    expect(v).toHaveLength(10);
    for (const [a, b] of v) expect(Math.abs(a!.x - b!.x)).toBeLessThan(1e-9);
    expect(fillPaths([sq(0, 0, 10)], { pattern: "cross", interval: 1, angle: 0 }).paths).toHaveLength(20);
  });

  it("dots: short burns on a grid, none in the hole", () => {
    const { paths } = fillPaths(ring, { pattern: "dots", interval: 1, angle: 0 });
    expect(paths).toHaveLength(100 - 16);
    for (const [a, b] of paths) expect(Math.hypot(b!.x - a!.x, b!.y - a!.y)).toBeCloseTo(0.1, 9);
  });

  it("offset: closed contours stepping inward, around the hole too", () => {
    const { paths } = fillPaths(ring, { pattern: "offset", interval: 1, angle: 0 });
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const p of paths) expect(p.at(-1)).toEqual(p[0]);
    expect(box([paths[0]!])).toEqual({ x0: 0.5, y0: 0.5, x1: 9.5, y1: 9.5 });
  });

  it("refuses absurdly dense fills instead of freezing", () => {
    const r = fillPaths([sq(0, 0, 500)], { pattern: "dots", interval: 0.05, angle: 0 });
    expect(r.paths).toHaveLength(0);
    expect(r.error).toMatch(/too dense/);
    expect(MAX_FILL_PATHS).toBeGreaterThan(1000);
  });
});

const path = (pts: Vec[], color: string, closed = true): ScenePath => ({ color, closed, points: pts });
const docOf = (paths: ScenePath[]): Doc => ({ objects: [{ id: "o", name: "o", mat: IDENTITY, paths }], layers: [] });
const P: MachineProfile = { name: "t", bedW: 600, bedH: 400, origin: "top-left", travelSpeed: 100, accel: 2000 };

describe("fill layers in the planner", () => {
  it("fill engraves inside, fill + outline then cuts the outline, cut follows the outline", () => {
    const base = docOf([path(sq(10, 10, 10), "#ff0000")]);
    const cuts = (mode: "cut" | "fill" | "fillCut") =>
      planToolpath(updateLayer(base, "#ff0000", { mode, fill: { pattern: "lines", interval: 1, angle: 0 } }), { start: { x: 0, y: 0 }, innerFirst: true }).segments.filter((s) => s.cut);
    expect(cuts("cut")).toHaveLength(4);
    expect(cuts("fill")).toHaveLength(10);
    const both = cuts("fillCut");
    expect(both).toHaveLength(14);
    expect(both.slice(-4).every((s) => s.x0 === 10 || s.x0 === 20)).toBe(true); // outline last
  });

  it("warns about open paths in a fill layer and blocks jobs with too-dense fills", () => {
    let d = docOf([path(sq(10, 10, 10), "#ff0000"), path([{ x: 0, y: 0 }, { x: 5, y: 0 }], "#ff0000", false)]);
    d = updateLayer(d, "#ff0000", { mode: "fill" });
    expect(planToolpath(d, { start: { x: 0, y: 0 }, innerFirst: true }).warnings[0]).toMatch(/open paths/);
    const dense = updateLayer(docOf([path(sq(0, 0, 300), "#ff0000")]), "#ff0000", { mode: "fill", fill: { pattern: "dots", interval: 0.05, angle: 0 } });
    expect(() => buildJob(dense, P, { mode: "absolute", innerFirst: true })).toThrow(/too dense/);
  });
});

describe("fill regions and clusters", () => {
  const F = "#00e000";
  const start = { x: 0, y: 0 };

  it("engraves a tagged region on the fill colour, leaving the holes inside it empty, and still cuts the outlines", () => {
    // A 20 mm square (cut, red) filled green, with a 10 mm hole (cut, red) inside.
    const outer = { ...path(sq(0, 0, 20), "#ff0000"), fill: F };
    const d = updateLayer(docOf([outer, path(sq(5, 5, 10), "#ff0000")]), F, { mode: "fill", fill: { pattern: "lines", interval: 1, angle: 0 } });
    expect(activeLayers(d).map((l) => l.color).sort()).toEqual([F, "#ff0000"].sort());
    const tp = planToolpath(d, { start, innerFirst: true });
    const fillLayer = tp.layers.findIndex((l) => l.color === F);
    const hatch = tp.segments.filter((s) => s.cut && s.layer === fillLayer);
    // 20 rows; the 10 rows beside the hole are split in two.
    expect(hatch).toHaveLength(30);
    expect(hatch.some((s) => s.y0 > 5 && s.y0 < 15 && Math.min(s.x0, s.x1) < 14 && Math.max(s.x0, s.x1) > 6)).toBe(false);
    expect(tp.segments.filter((s) => s.cut && s.layer !== fillLayer)).toHaveLength(8);
  });

  it("sweeps near neighbours together and far ones separately", () => {
    const s = { pattern: "lines" as const, interval: 1, angle: 0 };
    const near = fillUnits([[sq(0, 0, 10)], [sq(10.2, 0, 10)]], s, start);
    expect(near.units).toHaveLength(1);
    const far = fillUnits([[sq(0, 0, 10)], [sq(60, 0, 10)]], s, start);
    expect(far.units).toHaveLength(2);
    // Different rows (one above the other) never share a sweep.
    expect(fillUnits([[sq(0, 0, 10)], [sq(0, 20, 10)]], s, start).units).toHaveLength(2);
  });

  it("gives each separate area all of its passes before the next", () => {
    let d = docOf([path(sq(0, 0, 10), F), path(sq(60, 0, 10), F)]);
    d = updateLayer(d, F, { mode: "fill", passes: 2, fill: { pattern: "lines", interval: 1, angle: 0 } });
    const xs = planToolpath(d, { start, innerFirst: true }).segments.filter((s) => s.cut).map((s) => s.x0 < 30);
    // 20 cuts on the left square (2 passes × 10 rows), then 20 on the right.
    expect(xs.slice(0, 20).every(Boolean)).toBe(true);
    expect(xs.slice(20).every((v) => !v)).toBe(true);
  });
});

describe("Fill tool and migration", () => {
  const F = "#00e000";
  it("fills a region with a new fill colour placed first, clears it on a second click, and refuses cut colours", () => {
    const d = docOf([path(sq(0, 0, 20), "#ff0000"), path(sq(5, 5, 10), "#ff0000")]);
    const r = toggleRegionFill(d, "o", 0, F);
    if ("error" in r) throw new Error(r.error);
    expect(r.created).toBe(true);
    expect(r.doc.objects[0]!.paths[0]!.fill).toBe(F);
    expect(activeLayers(r.doc)[0]).toMatchObject({ color: F, mode: "fill" });
    const again = toggleRegionFill(r.doc, "o", 0, F);
    if ("error" in again) throw new Error(again.error);
    expect(again.cleared).toBe(true);
    expect(again.doc.objects[0]!.paths[0]!.fill).toBeUndefined();
    expect("error" in toggleRegionFill(d, "o", 0, "#ff0000")).toBe(true);
  });

  it("keeps a sketch's fill on its loop when the sketch's paths are regenerated", () => {
    let s = emptySketch("#ff0000");
    const ids: string[] = [];
    for (const q of sq(0, 0, 10)) {
      const r = addPoint(s, q);
      s = r.s;
      ids.push(r.id);
    }
    for (let i = 0; i < 4; i++) s = addEntity(s, { kind: "line", p1: ids[i]!, p2: ids[(i + 1) % 4]! }).s;
    const d: Doc = { objects: [{ id: "k", name: "k", mat: IDENTITY, sketch: s, paths: sketchPaths(s) }], layers: [] };
    const r = toggleRegionFill(d, "k", 0, F);
    if ("error" in r) throw new Error(r.error);
    const k = r.doc.objects[0]!;
    expect(k.sketch!.fills).toHaveLength(1);
    // Move a corner: the loop is the same entities, so the regenerated path is still filled.
    const moved = { ...k.sketch!, points: { ...k.sketch!.points, [ids[2]!]: { x: 14, y: 12 } } };
    expect(sketchPaths(moved)[0]!.fill).toBe(F);
  });

  it("turns an old Fill + outline layer into a cut layer plus a fill colour on the same regions", () => {
    let d = docOf([path(sq(0, 0, 20), "#ff0000"), path(sq(5, 5, 10), "#ff0000"), path(sq(8, 8, 4), "#ff0000")]);
    d = updateLayer(d, "#ff0000", { mode: "fillCut", speed: 77, fill: { pattern: "cross", interval: 0.3, angle: 45 } });
    const m = migrateDoc(d);
    const [outer, hole, island] = m.objects[0]!.paths;
    const F2 = outer!.fill!;
    expect(F2).toBeTruthy();
    expect(hole!.fill).toBeUndefined();
    expect(island!.fill).toBe(F2);
    const layers = activeLayers(m);
    expect(layers[0]).toMatchObject({ color: F2, mode: "fill", speed: 77, fill: { pattern: "cross" } });
    expect(layers.find((l) => l.color === "#ff0000")!.mode).toBe("cut");
    expect(migrateDoc(m)).toBe(m); // nothing left to migrate
  });
});

describe("assignMode (Fill / Cut selection)", () => {
  it("moves closed paths to a new fill layer placed first, and back to a cut layer", () => {
    const d = docOf([path(sq(10, 10, 10), "#000000"), path([{ x: 0, y: 0 }, { x: 5, y: 0 }], "#000000", false)]);
    const f = assignMode(d, new Set(["o"]), "fill")!;
    expect(f.created).toBe(true);
    const layers = activeLayers(f.doc);
    expect(layers[0]).toMatchObject({ color: f.color, mode: "fill", speed: 100, maxPower: 15 });
    expect(f.doc.objects[0]!.paths.map((p) => p.color)).toEqual([f.color, "#000000"]); // the open line stays a cut
    const again = assignMode(f.doc, new Set(["o"]), "fill");
    expect(again).toBeNull(); // nothing left to move
    const c = assignMode(f.doc, new Set(["o"]), "cut")!;
    expect(c.color).toBe("#000000");
    expect(c.created).toBe(false);
    expect(c.doc.objects[0]!.paths.every((p) => p.color === "#000000")).toBe(true);
  });

  it("recolours nested group members too", () => {
    const child = { id: "c", name: "c", mat: IDENTITY, paths: [path(sq(0, 0, 5), "#000000")] };
    const d: Doc = { objects: [{ id: "g", name: "g", mat: IDENTITY, paths: [path(sq(0, 0, 5), "#000000")], children: [child] }], layers: [] };
    const f = assignMode(d, new Set(["g"]), "fill")!;
    expect(f.doc.objects[0]!.children![0]!.paths[0]!.color).toBe(f.color);
  });
});

describe("assignColor (palette)", () => {
  it("moves everything to a cut colour, only closed paths to a fill colour, and reuses stored settings", () => {
    const d: Doc = {
      objects: [{ id: "o", name: "o", mat: IDENTITY, paths: [path(sq(0, 0, 5), "#000000"), path([{ x: 0, y: 0 }, { x: 5, y: 0 }], "#000000", false)] }],
      layers: [{ color: "#00e000", speed: 7, minPower: 30, maxPower: 30, passes: 1, output: true, mode: "fill" }],
    };
    const cut = assignColor(d, new Set(["o"]), "#0000ff")!;
    expect(cut.created).toBe(true);
    expect(cut.doc.objects[0]!.paths.map((p) => p.color)).toEqual(["#0000ff", "#0000ff"]);
    // #00e000 has stored fill settings (no paths yet): only the closed path moves, and it keeps speed 7.
    const fill = assignColor(d, new Set(["o"]), "#00e000")!;
    expect(fill.doc.objects[0]!.paths.map((p) => p.color)).toEqual(["#00e000", "#000000"]);
    expect(activeLayers(fill.doc).find((l) => l.color === "#00e000")).toMatchObject({ speed: 7, mode: "fill" });
    expect(assignColor(cut.doc, new Set(["o"]), "#0000ff")).toBeNull();
  });
});
