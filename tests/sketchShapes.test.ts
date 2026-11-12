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
    const r = linearPattern(s, lines, { x: 10, y: 0 }, 3, { x: 0, y: 8 }, 2);
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
    expect("error" in linearPattern(emptySketch(), [], { x: 1, y: 0 }, 3, { x: 0, y: 1 }, 1)).toBe(true);
  });
});
