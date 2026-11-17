import { beforeAll, describe, expect, it } from "vitest";
import { addConstraint, addEntity, addPoint, emptySketch, entity, pt } from "../src/sketch/model";
import { sketchPaths } from "../src/sketch/paths";
import { circularPattern, drawPolygon, drawSlot, linearPattern } from "../src/sketch/shapes";
import { loadSolver, measure, solve } from "../src/sketch/solver";

beforeAll(async () => {
  await loadSolver("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm");
});

const click = (x: number, y: number) => ({ pos: { x, y }, snap: null });

describe("slot", () => {
  it("draws a closed slot that solves with 5 degrees of freedom (two centres and the width)", () => {
    const r = drawSlot(emptySketch(), click(0, 0), click(30, 0), 5)!;
    const sol = solve(r.s, { analyze: true });
    expect(sol.ok).toBe(true);
    expect(sol.dof).toBe(5);
    const paths = sketchPaths(sol.sketch);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.closed).toBe(true);
    const xs = paths[0]!.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-5, 1);
    expect(Math.max(...xs)).toBeCloseTo(35, 1);
  });

  it("keeps its shape when one end's radius is dimensioned", () => {
    let s = drawSlot(emptySketch(), click(0, 0), click(20, 10), 4)!.s;
    const arc = s.entities.find((e) => e.kind === "arc")!;
    s = addConstraint(s, { type: "radius", refs: [arc.id], value: 6 }).s;
    const sol = solve(s);
    expect(sol.ok).toBe(true);
    for (const a of sol.sketch.entities) if (a.kind === "arc") expect(a.r).toBeCloseTo(6, 5);
    // The straight sides stay parallel to and as long as the centre line.
    const axis = sol.sketch.entities.find((e) => e.kind === "line" && e.construction)!;
    for (const l of sol.sketch.entities) if (l.kind === "line" && !l.construction) expect(measure(sol.sketch, "distance", [l.id])).toBeCloseTo(measure(sol.sketch, "distance", [axis.id]), 4);
  });
});

describe("polygon", () => {
  it("draws a hexagon with equal sides, free to move, size and turn (4 DOF)", () => {
    const r = drawPolygon(emptySketch(), click(0, 0), { x: 10, y: 0 }, 6)!;
    const sol = solve(r.s, { analyze: true });
    expect(sol.ok).toBe(true);
    expect(sol.dof).toBe(4);
    const lines = sol.sketch.entities.filter((e) => e.kind === "line");
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(measure(sol.sketch, "distance", [l.id])).toBeCloseTo(10, 6);
  });
});

describe("patterns", () => {
  function square() {
    let s = emptySketch();
    const ids: string[] = [];
    for (const p of [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }]) {
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
    s = addConstraint(s, { type: "horizontal", refs: [lines[0]!] }).s;
    s = addConstraint(s, { type: "vertical", refs: [lines[1]!] }).s;
    s = addConstraint(s, { type: "horizontal", refs: [lines[2]!] }).s;
    s = addConstraint(s, { type: "vertical", refs: [lines[3]!] }).s;
    const dim = addConstraint(s, { type: "distance", refs: [lines[0]!], value: 4 });
    return { s: dim.s, lines, pts: ids, dim: dim.id };
  }

  it("makes a 3 × 2 grid whose copies follow the original's size and position", () => {
    const { s, lines, pts, dim } = square();
    const r = linearPattern(s, lines, 3, 10, 2, 8);
    if ("error" in r) throw new Error(r.error);
    expect(r.s.entities).toHaveLength(24);
    // Resize the original: hidden copies of its dimension follow; move it: the copies keep their spacing.
    let next = { ...r.s, constraints: r.s.constraints.map((c) => (c.id === dim || c.link === dim ? { ...c, value: 6 } : c)) };
    next = { ...next, points: { ...next.points, [pts[0]!]: { x: 1, y: 1, fixed: true } } };
    const sol = solve(next, { analyze: true });
    expect(sol.ok).toBe(true);
    const last = sol.sketch.entities.at(-4)!;
    expect(last.kind === "line" && measure(sol.sketch, "distance", [last.id])).toBeCloseTo(6, 5);
    expect(last.kind === "line" && pt(sol.sketch, last.p1).x).toBeCloseTo(21, 5);
    expect(last.kind === "line" && pt(sol.sketch, last.p1).y).toBeCloseTo(9, 5);
  });

  it("keeps one visible X and Y spacing dimension that drives every copy", () => {
    const { s, lines, pts } = square();
    const r = linearPattern(s, lines, 3, 10, 2, 8);
    if ("error" in r || !r.dimX || !r.dimY) throw new Error("no dimensions");
    const visible = r.s.constraints.filter((c) => (c.type === "distanceX" || c.type === "distanceY") && !c.hidden);
    expect(visible.map((c) => c.id).sort()).toEqual([r.dimX, r.dimY].sort());
    // Edit the spacing afterwards the way the dimension editor does: linked steps follow.
    const edit = (sk: typeof r.s, id: string, v: number) => ({ ...sk, constraints: sk.constraints.map((c) => (c.id === id || c.link === id ? { ...c, value: v } : c)) });
    const edited = edit(edit(r.s, r.dimX, 15), r.dimY, 20);
    const sol = solve({ ...edited, points: { ...edited.points, [pts[0]!]: { x: 0, y: 0, fixed: true } } });
    expect(sol.ok).toBe(true);
    const last = sol.sketch.entities.at(-4)!;
    expect(last.kind === "line" && pt(sol.sketch, last.p1).x).toBeCloseTo(30, 5);
    expect(last.kind === "line" && pt(sol.sketch, last.p1).y).toBeCloseTo(20, 5);
  });

  it("spreads copies around a centre, dropping horizontal/vertical", () => {
    const { s, lines } = square();
    const c = addPoint(s, { x: -10, y: 2 });
    const r = circularPattern(c.s, lines, c.id, 4);
    if ("error" in r) throw new Error(r.error);
    expect(r.s.entities).toHaveLength(16);
    // The copy opposite the original (180°) has its first corner at (-20, 4).
    const opposite = entity(r.s, r.s.entities[8]!.id)!;
    expect(opposite.kind === "line" && pt(r.s, opposite.p1).x).toBeCloseTo(-20, 6);
    expect(opposite.kind === "line" && pt(r.s, opposite.p1).y).toBeCloseTo(4, 6);
    const hv = r.s.constraints.filter((x) => x.type === "horizontal" || x.type === "vertical");
    expect(hv).toHaveLength(4);
    expect(solve(r.s).ok).toBe(true);
  });

  it("asks for a selection", () => {
    expect("error" in linearPattern(emptySketch(), [], 3, 1, 1, 1)).toBe(true);
  });

  it("makes a one-direction row, held at its spacing, and refuses a single copy", () => {
    const { s, lines, pts } = square();
    const r = linearPattern(s, lines, 1, 0, 4, 12);
    if ("error" in r) throw new Error(r.error);
    expect(r.s.entities).toHaveLength(16);
    expect(sketchPaths(r.s).filter((p) => p.closed)).toHaveLength(4);
    // Move the original: the last copy follows, 36 mm below it.
    const moved = { ...r.s, points: { ...r.s.points, [pts[0]!]: { x: 5, y: -3, fixed: true } } };
    const sol = solve(moved);
    expect(sol.ok).toBe(true);
    const last = sol.sketch.entities.at(-4)!;
    expect(last.kind === "line" && pt(sol.sketch, last.p1).x).toBeCloseTo(5, 5);
    expect(last.kind === "line" && pt(sol.sketch, last.p1).y).toBeCloseTo(33, 5);
    expect("error" in linearPattern(s, lines, 1, 1, 1, 1)).toBe(true);
    expect("error" in linearPattern(s, lines, 3, 0, 1, 0)).toBe(true);
  });

  it("spreads a partial sweep from the original to the end angle", () => {
    const { s, lines } = square();
    const c = addPoint(s, { x: -10, y: 0 });
    const r = circularPattern(c.s, lines, c.id, 3, 90);
    if ("error" in r) throw new Error(r.error);
    expect(r.s.entities).toHaveLength(12);
    // Corner (0, 0) is 10 mm from the centre: 45° and 90° turns put it at these points.
    const first = (k: number) => {
      const e = r.s.entities[k * 4]!;
      return e.kind === "line" ? pt(r.s, e.p1) : null;
    };
    expect(first(1)!.x).toBeCloseTo(-10 + 10 * Math.cos(Math.PI / 4), 6);
    expect(first(1)!.y).toBeCloseTo(10 * Math.sin(Math.PI / 4), 6);
    expect(first(2)!.x).toBeCloseTo(-10, 6);
    expect(first(2)!.y).toBeCloseTo(10, 6);
  });

  it("patterns a circle around a centre; copies keep the original's linked size", () => {
    const cp = addPoint(emptySketch(), { x: 20, y: 0 });
    const circ = addEntity(cp.s, { kind: "circle", c: cp.id, r: 3 });
    const dim = addConstraint(circ.s, { type: "radius", refs: [circ.id], value: 3 });
    const centre = addPoint(dim.s, { x: 0, y: 0 });
    const r = circularPattern(centre.s, [circ.id], centre.id, 6);
    if ("error" in r) throw new Error(r.error);
    const circles = r.s.entities.filter((e) => e.kind === "circle");
    expect(circles).toHaveLength(6);
    for (const e of circles) expect(e.kind === "circle" && Math.hypot(pt(r.s, e.c).x, pt(r.s, e.c).y)).toBeCloseTo(20, 6);
    const next = { ...r.s, constraints: r.s.constraints.map((c) => (c.id === dim.id || c.link === dim.id ? { ...c, value: 5 } : c)) };
    const sol = solve(next);
    expect(sol.ok).toBe(true);
    for (const e of sol.sketch.entities) if (e.kind === "circle") expect(e.r).toBeCloseTo(5, 5);
  });
});
