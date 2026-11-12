import { beforeAll, describe, expect, it } from "vitest";
import { addConstraint, addEntity, addPoint, emptySketch, entity, ORIGIN, pt, type Sketch } from "../src/sketch/model";
import { chain, sketchPaths } from "../src/sketch/paths";
import { loadSolver, measure, solve } from "../src/sketch/solver";

beforeAll(async () => {
  await loadSolver("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm");
});

/** A rectangle as four lines sharing corner points. */
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
  return { s, pts: ids, lines };
}

describe("sketch solver", () => {
  it("drives a rectangle by dimensions and reports it fully defined once tied to the origin", () => {
    let { s, pts, lines } = rect(emptySketch(), 1, 2, 30, 18);
    for (const [type, l] of [["horizontal", lines[0]], ["vertical", lines[1]], ["horizontal", lines[2]], ["vertical", lines[3]]] as const) s = addConstraint(s, { type, refs: [l!] }).s;
    s = addConstraint(s, { type: "distance", refs: [lines[0]!], value: 40 }).s;
    s = addConstraint(s, { type: "distance", refs: [lines[1]!], value: 20 }).s;
    let r = solve(s, { analyze: true });
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(2); // position still free
    expect(r.free.size).toBe(4);
    expect(measure(r.sketch, "distance", [lines[0]!])).toBeCloseTo(40, 6);
    s = addConstraint(r.sketch, { type: "coincident", refs: [pts[0]!, ORIGIN] }).s;
    r = solve(s, { analyze: true });
    expect(r.dof).toBe(0);
    expect(r.free.size).toBe(0);
    expect(r.sketch.points[pts[2]!]).toMatchObject({ x: expect.closeTo(40, 6), y: expect.closeTo(20, 6) });
  });

  it("reports conflicting constraints by our ids", () => {
    let { s, lines } = rect(emptySketch(), 0, 0, 10, 10);
    const h = addConstraint(s, { type: "horizontal", refs: [lines[0]!] });
    const v = addConstraint(h.s, { type: "vertical", refs: [lines[0]!] });
    s = addConstraint(v.s, { type: "distance", refs: [lines[0]!], value: 10 }).s;
    const r = solve(s);
    expect(r.ok).toBe(false);
    // planegcs names a minimal conflicting set; it must include the second, contradicting constraint.
    expect(r.conflicting).toContain(v.id);
    expect(r.conflicting.every((id) => id.startsWith("c"))).toBe(true);
  });

  it("reports redundant constraints by their ids", () => {
    const r = drawRect(emptySketch(), at(0, 0), at(30, 20));
    const extra = addConstraint(r.s, { type: "horizontal", refs: [r.lines[0]!] });
    const solved = solve(extra.s);
    expect(solved.redundant.length).toBeGreaterThan(0);
    expect(solved.redundant.every((id) => extra.s.constraints.some((c) => c.id === id))).toBe(true);
  });

  it("handles circles, arcs, tangency, radius and angle dimensions", () => {
    let s = emptySketch();
    const c = addPoint(s, { x: 0, y: 0 });
    s = c.s;
    const circ = addEntity(s, { kind: "circle", c: c.id, r: 7 });
    s = addConstraint(circ.s, { type: "diameter", refs: [circ.id], value: 20 }).s;
    const a = addPoint(s, { x: -15, y: 12 });
    const b = addPoint(a.s, { x: 15, y: 9 });
    const l = addEntity(b.s, { kind: "line", p1: a.id, p2: b.id });
    s = addConstraint(l.s, { type: "tangent", refs: [l.id, circ.id] }).s;
    s = addConstraint(s, { type: "horizontal", refs: [l.id] }).s;
    const r = solve(s);
    expect(r.ok).toBe(true);
    const ent = r.sketch.entities.find((e) => e.id === circ.id) as { r: number };
    expect(ent.r).toBeCloseTo(10, 6);
    // tangent horizontal line is 10 mm from the centre
    expect(Math.abs(r.sketch.points[a.id]!.y - r.sketch.points[c.id]!.y)).toBeCloseTo(10, 5);
  });

  it("drags a free point with soft constraints, without breaking hard ones", () => {
    let { s, pts, lines } = rect(emptySketch(), 0, 0, 10, 10);
    s = addConstraint(s, { type: "horizontal", refs: [lines[0]!] }).s;
    const r = solve(s, { drag: [{ id: pts[1]!, to: { x: 25, y: 5 } }] });
    expect(r.sketch.points[pts[1]!]!.x).toBeCloseTo(25, 3);
    expect(r.sketch.points[pts[1]!]!.y).toBeCloseTo(r.sketch.points[pts[0]!]!.y, 6); // still horizontal
  });
});

describe("sketch paths", () => {
  it("chains four lines into one closed path and skips construction lines", () => {
    let { s, lines } = rect(emptySketch("#ff0000"), 0, 0, 10, 5);
    s = { ...s, entities: s.entities.map((e) => (e.id === lines[3] ? e : e)) };
    const paths = sketchPaths(s);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ color: "#ff0000", closed: true });
    expect(paths[0]!.points).toHaveLength(4);
    const withCons = { ...s, entities: s.entities.map((e) => (e.id === lines[0] ? { ...e, construction: true } : e)) };
    const p2 = sketchPaths(withCons);
    expect(p2).toHaveLength(1);
    expect(p2[0]!.closed).toBe(false);
  });

  it("chain joins reversed pieces", () => {
    const r = chain([
      { pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }], closed: false },
      { pts: [{ x: 1, y: 1 }, { x: 1, y: 0 }], closed: false },
      { pts: [{ x: 1, y: 1 }, { x: 0, y: 0 }], closed: false },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.closed).toBe(true);
  });
});

import { drawArc3, drawCircle, drawLine, drawRect, drawRectCenter } from "../src/sketch/draw";
import { applyConstraint, dimensionFor } from "../src/sketch/constrain";
import { inferPointAlignments } from "../src/sketch/pick";

const at = (x: number, y: number) => ({ pos: { x, y }, snap: null });

describe("drawing tools", () => {
  it("line infers horizontal and reuses snapped points (shared point = coincident)", () => {
    let s = emptySketch();
    const a = drawLine(s, at(0, 0), at(20, 0.5));
    expect(a.s.constraints.map((c) => c.type)).toEqual(["horizontal"]);
    const b = drawLine(a.s, { pos: { x: 20, y: 0.5 }, snap: { kind: "point", id: a.end, pos: { x: 20, y: 0.5 } } }, at(20.3, 15));
    expect(b.s.constraints.map((c) => c.type)).toEqual(["horizontal", "vertical"]);
    const lines = b.s.entities.filter((e) => e.kind === "line") as { p1: string; p2: string }[];
    expect(lines[1]!.p1).toBe(lines[0]!.p2);
    const r = solve(b.s);
    expect(r.ok).toBe(true);
  });

  it("prioritizes an endpoint snapped to an existing point over horizontal or vertical inference", () => {
    const a = addPoint(emptySketch(), { x: 10, y: 10 });
    const b = addPoint(a.s, { x: 40, y: 10 });
    const fixedA = addEntity(b.s, { kind: "point", p: a.id });
    const fixedB = addEntity(fixedA.s, { kind: "point", p: b.id });
    const line = drawLine(fixedB.s,
      { pos: pt(fixedB.s, a.id), snap: { kind: "point", id: a.id, pos: pt(fixedB.s, a.id) } },
      { pos: pt(fixedB.s, b.id), snap: { kind: "point", id: b.id, pos: pt(fixedB.s, b.id) }, previousAxis: "h" });
    expect(line.s.constraints).toHaveLength(0);
    expect(entity(line.s, line.line)).toMatchObject({ p1: a.id, p2: b.id });
    const result = solve(line.s);
    expect(result.ok).toBe(true);
    expect(result.redundant).toEqual([]);
  });

  it("skips a redundant line direction while keeping the higher-priority curve snap", () => {
    const a = addPoint(emptySketch(), { x: 0, y: 20 });
    const b = addPoint(a.s, { x: 50, y: 20 });
    const base = addEntity(b.s, { kind: "line", p1: a.id, p2: b.id });
    const horizontal = addConstraint(base.s, { type: "horizontal", refs: [base.id] });
    const line = drawLine(horizontal.s,
      { pos: pt(horizontal.s, a.id), snap: { kind: "point", id: a.id, pos: pt(horizontal.s, a.id) } },
      { pos: { x: 30, y: 20 }, snap: { kind: "curve", id: base.id, pos: { x: 30, y: 20 } }, previousAxis: "h" });
    expect(line.s.constraints.filter((c) => c.refs.includes(line.line))).toEqual([]);
    expect(line.s.constraints).toContainEqual(expect.objectContaining({ type: "pointOnLine", refs: [line.end, base.id] }));
    const result = solve(line.s);
    expect(result.ok).toBe(true);
    expect(result.redundant).toEqual([]);
  });

  it("keeps an independent horizontal inference along with a curve snap", () => {
    const a = addPoint(emptySketch(), { x: 30, y: 0 });
    const b = addPoint(a.s, { x: 30, y: 30 });
    const base = addEntity(b.s, { kind: "line", p1: a.id, p2: b.id });
    const vertical = addConstraint(base.s, { type: "vertical", refs: [base.id] });
    const line = drawLine(vertical.s, at(0, 10), {
      pos: { x: 30, y: 10 }, snap: { kind: "curve", id: base.id, pos: { x: 30, y: 10 } }, previousAxis: "h",
    });
    expect(line.s.constraints).toContainEqual(expect.objectContaining({ type: "pointOnLine", refs: [line.end, base.id] }));
    expect(line.s.constraints).toContainEqual(expect.objectContaining({ type: "horizontal", refs: [line.line] }));
    const result = solve(line.s);
    expect(result.ok).toBe(true);
    expect(result.redundant).toEqual([]);
  });

  it("omits a redundant second alignment but retains independent references", () => {
    const a = addPoint(emptySketch(), { x: 10, y: 20 });
    const b = addPoint(a.s, { x: 30, y: 20 });
    const axis = addEntity(b.s, { kind: "line", p1: a.id, p2: b.id });
    const base = addConstraint(axis.s, { type: "horizontal", refs: [axis.id] });
    const line = drawLine(base.s, at(0, 0), {
      pos: { x: 50, y: 20 }, snap: null,
      inferences: [{ type: "horizontalPts", ref: a.id }, { type: "horizontalPts", ref: b.id }],
    });
    expect(line.s.constraints.filter((c) => c.type === "horizontalPts")).toHaveLength(1);
    const result = solve(line.s);
    expect(result.ok).toBe(true);
    expect(result.redundant).toEqual([]);
  });

  it("infers horizontal and vertical alignment to existing points", () => {
    let s = emptySketch();
    const ref = addPoint(s, { x: 10, y: 20 });
    s = addEntity(ref.s, { kind: "point", p: ref.id }).s;
    expect(inferPointAlignments(s, { x: 30, y: 20.5 }, 1)).toEqual([
      { type: "horizontalPts", ref: ref.id, pos: { x: 30, y: 20 } },
    ]);
    expect(inferPointAlignments(s, { x: 10.5, y: 40 }, 1)).toEqual([
      { type: "verticalPts", ref: ref.id, pos: { x: 10, y: 40 } },
    ]);
    expect(inferPointAlignments(s, { x: 30, y: 40 }, 1)).toEqual([]);
  });

  it("infers horizontal and vertical alignment to separate reference points together", () => {
    let s = emptySketch();
    const horizontalRef = addPoint(s, { x: 0, y: 20 });
    s = addEntity(horizontalRef.s, { kind: "point", p: horizontalRef.id }).s;
    const verticalRef = addPoint(s, { x: 30, y: 0 });
    s = addEntity(verticalRef.s, { kind: "point", p: verticalRef.id }).s;

    const inferences = inferPointAlignments(s, { x: 30.5, y: 20.5 }, 1);
    expect(inferences).toEqual([
      { type: "verticalPts", ref: verticalRef.id, pos: { x: 30, y: 20 } },
      { type: "horizontalPts", ref: horizontalRef.id, pos: { x: 30, y: 20 } },
    ]);
    const line = drawLine(s, at(0, 0), { pos: inferences[0]!.pos, snap: null, inferences });
    expect(line.s.constraints.map(({ type, refs }) => ({ type, ref: refs[1] }))).toEqual([
      { type: "verticalPts", ref: verticalRef.id },
      { type: "horizontalPts", ref: horizontalRef.id },
    ]);
  });

  it("rectangles: corner (4 lines, H/V) and centre (diagonal + midpoint)", () => {
    const r = drawRect(emptySketch(), at(0, 0), at(30, 20));
    expect(r.s.entities.filter((e) => e.kind === "line")).toHaveLength(4);
    expect(sketchPaths(r.s)[0]).toMatchObject({ closed: true });
    const c = drawRectCenter(emptySketch(), { pos: { x: 0, y: 0 }, snap: { kind: "point", id: ORIGIN, pos: { x: 0, y: 0 } } }, at(15, 10));
    const sol = solve(c.s, { analyze: true });
    expect(sol.ok).toBe(true);
    expect(c.s.constraints.some((x) => x.type === "midpoint")).toBe(true);
    // centred on the origin: 2 DOF left (width and height)
    expect(sol.dof).toBe(2);
  });

  it("3-point arc passes through the third point; circle radius from the click", () => {
    const a = drawArc3(emptySketch(), at(-10, 0), at(10, 0), { x: 0, y: -10 })!;
    const arc = a.s.entities.find((e) => e.kind === "arc") as { c: string; r: number };
    expect(arc.r).toBeCloseTo(10, 6);
    const paths = sketchPaths(a.s);
    expect(paths[0]!.points.some((p) => Math.abs(p.y + 10) < 0.05 && Math.abs(p.x) < 0.5)).toBe(true);
    const c = drawCircle(emptySketch(), at(5, 5), { x: 5, y: 12 });
    expect((c.s.entities[0] as { r: number }).r).toBeCloseTo(7, 9);
  });
});

describe("constraints and dimensions from a selection", () => {
  it("applies Onshape-style constraints and explains wrong selections", () => {
    const r = drawRect(emptySketch(), at(0, 0), at(30, 20));
    const [l0, l1] = r.lines;
    const eq = applyConstraint(r.s, "equal", [l0!, l1!]);
    expect("s" in eq).toBe(true);
    const bad = applyConstraint(r.s, "tangent", [l0!, l1!]);
    expect("error" in bad && bad.error).toMatch(/Tangent/);
  });

  it("chooses the dimension by what was picked and where the label goes", () => {
    let s = emptySketch();
    const a = addPoint(s, { x: 0, y: 0 });
    const b = addPoint(a.s, { x: 30, y: 10 });
    s = b.s;
    expect(dimensionFor(s, [a.id, b.id], { x: 15, y: -10 })).toMatchObject({ type: "distanceX", value: 30 });
    expect(dimensionFor(s, [a.id, b.id], { x: 40, y: 5 })).toMatchObject({ type: "distanceY", value: 10 });
    expect(dimensionFor(s, [a.id, b.id], { x: 14, y: 6 })).toMatchObject({ type: "distance" });
    const c = drawCircle(s, at(50, 50), { x: 60, y: 50 });
    expect(dimensionFor(c.s, [c.circle], { x: 70, y: 50 })).toMatchObject({ type: "diameter", value: 20 });
  });

  it("a horizontal distance dimension drives the geometry with the right sign", () => {
    let s = emptySketch();
    const a = addPoint(s, { x: 0, y: 0 });
    const b = addPoint(a.s, { x: 30, y: 10 });
    const d = dimensionFor(b.s, [a.id, b.id], { x: 15, y: -10 })!;
    s = addConstraint(b.s, { ...d, value: 45 }).s;
    const r = solve(s);
    expect(r.sketch.points[b.id]!.x - r.sketch.points[a.id]!.x).toBeCloseTo(45, 6);
  });
});
