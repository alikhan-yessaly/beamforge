import { beforeAll, describe, expect, it } from "vitest";
import { type Sketch, addConstraint, addEntity, addPoint, emptySketch, entity, pt } from "../src/sketch/model";
import { chainOf, chamferAt, filletAt, mirrorItems, offsetAt, offsetDistance, trimAt, trimPieceAt } from "../src/sketch/modify";
import { sketchPaths } from "../src/sketch/paths";
import { loadSolver, measure, solve } from "../src/sketch/solver";
import { drawPoint } from "../src/sketch/draw";
import { snap } from "../src/sketch/pick";

beforeAll(async () => {
  await loadSolver("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm");
});

function rect(s: Sketch, x: number, y: number, w: number, h: number) {
  const ids: string[] = [];
  for (const p of [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]) {
    const r = addPoint(s, p);
    s = r.s;
    ids.push(r.id);
  }
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = addEntity(s, { kind: "line", p1: ids[i]!, p2: ids[(i + 1) % 4]! });
    s = r.s;
    lines.push(r.id);
  }
  for (const [i, t] of [[0, "horizontal"], [1, "vertical"], [2, "horizontal"], [3, "vertical"]] as const) s = addConstraint(s, { type: t, refs: [lines[i]!] }).s;
  return { s, pts: ids, lines };
}

function line(s: Sketch, a: { x: number; y: number }, b: { x: number; y: number }) {
  const p = addPoint(s, a);
  const q = addPoint(p.s, b);
  const l = addEntity(q.s, { kind: "line", p1: p.id, p2: q.id });
  return { s: l.s, id: l.id, p1: p.id, p2: q.id };
}

const ok = (r: ReturnType<typeof trimAt>) => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

function mark(s: Sketch, pos: { x: number; y: number }) {
  const sn = snap(s, pos, 0.1);
  if (!sn || sn.kind !== "curve") throw new Error("Expected a curve snap");
  return drawPoint(s, { pos, snap: sn });
}

describe("trim", () => {
  it("uses placed points as line boundaries and retains the points and solvable geometry", () => {
    const h = line(emptySketch(), { x: 0, y: 0 }, { x: 30, y: 0 });
    const a = mark(h.s, { x: 10, y: 0 });
    const b = mark(a.s, { x: 20, y: 0 });
    const markerA = entity(b.s, a.point)!;
    const markerB = entity(b.s, b.point)!;
    if (markerA.kind !== "point" || markerB.kind !== "point") throw new Error("Expected points");
    expect(trimPieceAt(b.s, h.id, { x: 15, y: 0 })).toEqual({ kind: "line", a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
    const after = ok(trimAt(b.s, h.id, { x: 15, y: 0 })).s;
    const pieces = after.entities.filter((e) => e.kind === "line");
    expect(pieces).toHaveLength(2);
    expect(pieces.some((e) => e.kind === "line" && e.p2 === markerA.p)).toBe(true);
    expect(pieces.some((e) => e.kind === "line" && e.p1 === markerB.p)).toBe(true);
    expect(solve(after, { analyze: true }).ok).toBe(true);
    const one = ok(trimAt(a.s, h.id, { x: 5, y: 0 })).s;
    expect(entity(one, h.id)).toMatchObject({ p1: markerA.p });
    expect(solve(one, { analyze: true }).ok).toBe(true);
  });

  it("uses points on circles and arcs as boundaries and preserves solver validity", () => {
    const center = addPoint(emptySketch(), { x: 0, y: 0 });
    const circle = addEntity(center.s, { kind: "circle", c: center.id, r: 10 });
    const a = mark(circle.s, { x: 0, y: 10 });
    expect(trimPieceAt(a.s, circle.id, { x: -10, y: 0 })).toHaveProperty("error");
    const b = mark(a.s, { x: 0, y: -10 });
    const preview = trimPieceAt(b.s, circle.id, { x: 10, y: 0 });
    if (!("kind" in preview) || preview.kind !== "arc") throw new Error("Expected an arc preview");
    expect(preview.a0).toBeCloseTo(3 * Math.PI / 2);
    expect(preview.a1).toBeCloseTo(5 * Math.PI / 2);
    const trimmed = ok(trimAt(b.s, circle.id, { x: 10, y: 0 })).s;
    expect(entity(trimmed, circle.id)?.kind).toBe("arc");
    expect(solve(trimmed, { analyze: true }).ok).toBe(true);
    const middle = mark(trimmed, { x: -10, y: 0 });
    const part = trimPieceAt(middle.s, circle.id, { x: -7.0710678119, y: 7.0710678119 });
    if (!("kind" in part) || part.kind !== "arc") throw new Error("Expected an arc preview");
    expect(part.a1 - part.a0).toBeCloseTo(Math.PI / 2);
    const shortened = ok(trimAt(middle.s, circle.id, { x: -7.0710678119, y: 7.0710678119 })).s;
    expect(solve(shortened, { analyze: true }).ok).toBe(true);
  });

  it("ignores nearby points off the curve and combines points with crossings", () => {
    const h = line(emptySketch(), { x: 0, y: 0 }, { x: 30, y: 0 });
    const off = addPoint(h.s, { x: 12, y: 0.01 });
    const offEntity = addEntity(off.s, { kind: "point", p: off.id });
    const point = mark(offEntity.s, { x: 10, y: 0 });
    const cross = line(point.s, { x: 20, y: -5 }, { x: 20, y: 5 });
    expect(trimPieceAt(cross.s, h.id, { x: 15, y: 0 })).toEqual({ kind: "line", a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
    expect(solve(ok(trimAt(cross.s, h.id, { x: 15, y: 0 })).s, { analyze: true }).ok).toBe(true);
  });

  it("previews the same line interval that is removed on either side of crossings", () => {
    const h = line(emptySketch(), { x: 0, y: 0 }, { x: 30, y: 0 });
    const v1 = line(h.s, { x: 10, y: -5 }, { x: 10, y: 5 });
    const v2 = line(v1.s, { x: 20, y: -5 }, { x: 20, y: 5 });
    for (const [x, a, b] of [[5, 0, 10], [15, 10, 20], [25, 20, 30]] as const) {
      expect(trimPieceAt(v2.s, h.id, { x, y: 0 })).toEqual({ kind: "line", a: { x: a, y: 0 }, b: { x: b, y: 0 } });
      const after = ok(trimAt(v2.s, h.id, { x, y: 0 })).s;
      const remaining = after.entities.filter((e) => e.kind === "line" && pt(after, e.p1).y === 0 && pt(after, e.p2).y === 0);
      expect(remaining.some((e) => e.kind === "line" && pt(after, e.p1).x < x && pt(after, e.p2).x > x)).toBe(false);
    }
    expect(trimPieceAt(v2.s, h.id, { x: 10, y: 0 })).toEqual({ kind: "line", a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
    expect(trimPieceAt(h.s, h.id, { x: 5, y: 0 })).toEqual({ kind: "line", a: { x: 0, y: 0 }, b: { x: 30, y: 0 } });
  });

  it("previews cyclic circle intervals, whole circles and untrimmable tangencies", () => {
    const c = addPoint(emptySketch(), { x: 0, y: 0 });
    const circle = addEntity(c.s, { kind: "circle", c: c.id, r: 10 });
    const crossing = line(circle.s, { x: 0, y: -20 }, { x: 0, y: 20 });
    expect(trimPieceAt(crossing.s, circle.id, { x: 10, y: 0 })).toEqual({
      kind: "arc", c: { x: 0, y: 0 }, r: 10, a0: 3 * Math.PI / 2, a1: 5 * Math.PI / 2,
    });
    expect(trimPieceAt(crossing.s, circle.id, { x: -10, y: 0 })).toEqual({
      kind: "arc", c: { x: 0, y: 0 }, r: 10, a0: Math.PI / 2, a1: 3 * Math.PI / 2,
    });
    expect(trimPieceAt(crossing.s, circle.id, { x: 0, y: 10 })).toEqual({
      kind: "arc", c: { x: 0, y: 0 }, r: 10, a0: Math.PI / 2, a1: 3 * Math.PI / 2,
    });
    expect(trimPieceAt(circle.s, circle.id, { x: 10, y: 0 })).toEqual({
      kind: "arc", c: { x: 0, y: 0 }, r: 10, a0: 0, a1: 2 * Math.PI,
    });
    const tangent = line(circle.s, { x: -20, y: 10 }, { x: 20, y: 10 });
    expect(trimPieceAt(tangent.s, circle.id, { x: 0, y: 10 })).toEqual(trimAt(tangent.s, circle.id, { x: 0, y: 10 }));
    const duplicate = line(tangent.s, { x: 0, y: 10 }, { x: 0, y: 20 });
    expect(trimPieceAt(duplicate.s, circle.id, { x: 0, y: 10 })).toEqual(trimAt(duplicate.s, circle.id, { x: 0, y: 10 }));
  });

  it("previews the middle and end portions of an intersected arc", () => {
    const c = addPoint(emptySketch(), { x: 0, y: 0 });
    const start = addPoint(c.s, { x: 10, y: 0 });
    const end = addPoint(start.s, { x: -10, y: 0 });
    const arc = addEntity(end.s, { kind: "arc", c: c.id, r: 10, start: start.id, end: end.id });
    const right = line(arc.s, { x: 5, y: 0 }, { x: 5, y: 20 });
    const left = line(right.s, { x: -5, y: 0 }, { x: -5, y: 20 });
    const middle = trimPieceAt(left.s, arc.id, { x: 0, y: 10 });
    if (!("kind" in middle) || middle.kind !== "arc") throw new Error("Expected an arc preview");
    expect(middle.a0).toBeCloseTo(Math.PI / 3);
    expect(middle.a1).toBeCloseTo(2 * Math.PI / 3);
    const after = ok(trimAt(left.s, arc.id, { x: 0, y: 10 })).s;
    expect(after.entities.filter((e) => e.kind === "arc")).toHaveLength(2);
    const first = trimPieceAt(left.s, arc.id, { x: 10, y: 0 });
    if (!("kind" in first) || first.kind !== "arc") throw new Error("Expected an arc preview");
    expect(first.a0).toBeCloseTo(0);
    expect(first.a1).toBeCloseTo(Math.PI / 3);
  });

  it("removes the middle of a line crossed twice, leaving two collinear pieces that still solve", () => {
    let s = emptySketch();
    const h = line(s, { x: 0, y: 0 }, { x: 30, y: 0 });
    s = addConstraint(h.s, { type: "horizontal", refs: [h.id] }).s;
    const v1 = line(s, { x: 10, y: -5 }, { x: 10, y: 5 });
    const v2 = line(v1.s, { x: 20, y: -5 }, { x: 20, y: 5 });
    const r = ok(trimAt(v2.s, h.id, { x: 15, y: 0 }));
    const lines = r.s.entities.filter((e) => e.kind === "line");
    expect(lines).toHaveLength(4);
    const kept = entity(r.s, h.id)!;
    expect(kept.kind === "line" && pt(r.s, kept.p2).x).toBeCloseTo(10, 6);
    const sol = solve(r.s, { analyze: true });
    expect(sol.ok).toBe(true);
    // The cut ends stay on the crossing lines.
    expect(r.s.constraints.filter((c) => c.type === "pointOnLine").length).toBeGreaterThanOrEqual(3);
  });

  it("shortens a line at its end and deletes a line with no crossings", () => {
    let s = emptySketch();
    const h = line(s, { x: 0, y: 0 }, { x: 30, y: 0 });
    const v = line(h.s, { x: 10, y: -5 }, { x: 10, y: 5 });
    const r = ok(trimAt(v.s, h.id, { x: 25, y: 0 }));
    const kept = entity(r.s, h.id)!;
    expect(kept.kind === "line" && pt(r.s, kept.p2).x).toBeCloseTo(10, 6);
    const lone = line(emptySketch(), { x: 0, y: 0 }, { x: 5, y: 5 });
    expect(ok(trimAt(lone.s, lone.id, { x: 2, y: 2 })).s.entities).toHaveLength(0);
    s = r.s;
  });

  it("turns a circle cut by a line into an arc", () => {
    const c = addPoint(emptySketch(), { x: 0, y: 0 });
    const circ = addEntity(c.s, { kind: "circle", c: c.id, r: 10 });
    const l = line(circ.s, { x: -20, y: 0 }, { x: 20, y: 0 });
    const r = ok(trimAt(l.s, circ.id, { x: 0, y: -10 }));
    const arc = entity(r.s, circ.id)!;
    expect(arc.kind).toBe("arc");
    // The bottom half (y > 0) remains: its middle is at angle π/2.
    const paths = sketchPaths(r.s);
    const ys = paths.flatMap((p) => p.points.map((q) => q.y));
    expect(Math.max(...ys)).toBeCloseTo(10, 3);
    expect(solve(r.s).ok).toBe(true);
  });
});

describe("fillet and chamfer", () => {
  it("rounds a rectangle corner with a tangent arc and keeps it solvable at the new radius", () => {
    const { s, pts } = rect(emptySketch(), 0, 0, 40, 20);
    const r = ok(filletAt(s, pts[1]!, 5));
    const arc = r.s.entities.find((e) => e.kind === "arc")!;
    expect(arc.kind === "arc" && arc.r).toBe(5);
    expect(r.s.points[pts[1]!]).toBeUndefined(); // the sharp corner is gone
    const dim = r.s.constraints.find((c) => c.id === r.dimension)!;
    const sol = solve({ ...r.s, constraints: r.s.constraints.map((c) => (c.id === dim.id ? { ...c, value: 8 } : c)) }, { analyze: true });
    expect(sol.ok).toBe(true);
    expect(measure(sol.sketch, "radius", [arc.id])).toBeCloseTo(8, 5);
    // Tangent: the arc's centre is 8 from the (still horizontal) top edge, whose end is the arc's start.
    const a = sol.sketch.entities.find((e) => e.kind === "arc")!;
    if (a.kind !== "arc") throw new Error();
    expect(pt(sol.sketch, a.c).y - pt(sol.sketch, a.start).y).toBeCloseTo(8, 4);
  });

  it("rejects a radius too big for the corner", () => {
    const { s, pts } = rect(emptySketch(), 0, 0, 10, 10);
    expect("error" in filletAt(s, pts[0]!, 20)).toBe(true);
  });

  it("chamfers a corner and the distance dimension drives both legs", () => {
    const { s, pts } = rect(emptySketch(), 0, 0, 40, 20);
    const r = ok(chamferAt(s, pts[1]!, 4));
    const sol = solve({ ...r.s, constraints: r.s.constraints.map((c) => (c.id === r.dimension ? { ...c, value: 6 } : c)) });
    expect(sol.ok).toBe(true);
    const cut = sol.sketch.entities.filter((e) => e.kind === "line" && !e.construction).at(-1)!;
    expect(cut.kind === "line" && measure(sol.sketch, "distance", [cut.id])).toBeCloseTo(6 * Math.SQRT2, 4);
  });
});

describe("mirror", () => {
  it("mirrors a circle and a line across a vertical axis with symmetric constraints", () => {
    let s = emptySketch();
    const axis = line(s, { x: 0, y: -20 }, { x: 0, y: 20 });
    const l = line(axis.s, { x: 5, y: 0 }, { x: 15, y: 5 });
    const c = addPoint(l.s, { x: 10, y: 10 });
    const circ = addEntity(c.s, { kind: "circle", c: c.id, r: 3 });
    s = { ...circ.s, points: { ...circ.s.points, [axis.p1]: { ...circ.s.points[axis.p1]!, fixed: true }, [axis.p2]: { ...circ.s.points[axis.p2]!, fixed: true } } };
    const r = ok(mirrorItems(s, [l.id, circ.id], axis.id));
    expect(r.s.entities).toHaveLength(5);
    const mc = r.s.entities.at(-1)!;
    expect(mc.kind === "circle" && pt(r.s, mc.c).x).toBeCloseTo(-10, 6);
    expect(r.s.constraints.filter((x) => x.type === "symmetric")).toHaveLength(3);
    // Moving the original drags the copy.
    const moved = solve(r.s, { drag: [{ id: c.id, to: { x: 12, y: 10 } }] });
    expect(mc.kind === "circle" && pt(moved.sketch, mc.c).x).toBeCloseTo(-pt(moved.sketch, c.id).x, 4);
  });

  it("needs a line to mirror about", () => {
    const l = line(emptySketch(), { x: 0, y: 0 }, { x: 1, y: 1 });
    expect("error" in mirrorItems(l.s, [l.id], "nope")).toBe(true);
  });
});

describe("offset", () => {
  it("finds a closed chain and offsets a rectangle outwards, rigid under one dimension", () => {
    const { s, lines } = rect(emptySketch(), 0, 0, 40, 20);
    const ch = chainOf(s, lines[0]!)!;
    expect(ch.closed).toBe(true);
    expect(ch.steps).toHaveLength(4);
    // Cursor above the top edge (y < 0) is outside.
    const d = offsetDistance(s, lines[0]!, { x: 20, y: -3 });
    const r = ok(offsetAt(s, lines[0]!, d));
    const box = sketchPaths(r.s).flatMap((p) => p.points);
    expect(Math.min(...box.map((q) => q.y))).toBeCloseTo(-3, 6);
    expect(Math.max(...box.map((q) => q.x))).toBeCloseTo(43, 6);
    // Changing the visible dimension (and its hidden followers) moves every side.
    const master = r.dimension!;
    const cs = r.s.constraints.map((c) => (c.id === master || c.link === master ? { ...c, value: 5 } : c));
    const sol = solve({ ...r.s, constraints: cs }, { analyze: true });
    expect(sol.ok).toBe(true);
    // Every side of the copy is now 5 from its original (the shapes may move together; they're not anchored).
    const outer = sol.sketch.entities.slice(4).filter((e) => e.kind === "line");
    for (const [i, o] of outer.entries()) if (o.kind === "line") expect(measure(sol.sketch, "pointLineDistance", [o.p1, lines[i]!])).toBeCloseTo(5, 4);
    expect(r.s.constraints.filter((c) => c.hidden)).toHaveLength(3);
  });

  it("offsets a filleted rectangle and still re-solves when the distance changes (tangent joints)", () => {
    const { s, pts, lines } = rect(emptySketch(), 0, 0, 45, 30);
    const f = ok(filletAt(s, pts[1]!, 8));
    const d = offsetDistance(f.s, lines[3]!, { x: -4.8, y: 15 });
    expect(d).toBeCloseTo(-4.8, 6);
    const r = ok(offsetAt(f.s, lines[3]!, d));
    const first = solve(r.s, { analyze: true });
    expect(first.ok).toBe(true);
    expect(first.redundant).toEqual([]);
    const cs = r.s.constraints.map((c) => (c.id === r.dimension || c.link === r.dimension ? { ...c, value: 4 } : c));
    const sol = solve({ ...r.s, constraints: cs }, { analyze: true });
    expect(sol.ok).toBe(true);
    const arcs = sol.sketch.entities.filter((e) => e.kind === "arc");
    expect(arcs.map((a) => (a.kind === "arc" ? a.r : 0)).sort((a, b) => a - b)).toEqual([expect.closeTo(8, 4), expect.closeTo(12, 4)]);
  });

  it("offsets a circle inwards and refuses to go past its centre", () => {
    const c = addPoint(emptySketch(), { x: 0, y: 0 });
    const circ = addEntity(c.s, { kind: "circle", c: c.id, r: 10 });
    const r = ok(offsetAt(circ.s, circ.id, 2));
    expect(r.s.entities.at(-1)!.kind === "circle" && (r.s.entities.at(-1) as { r: number }).r).toBe(8);
    expect("error" in offsetAt(circ.s, circ.id, 12)).toBe(true);
  });
});
