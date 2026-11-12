import { beforeAll, describe, expect, it } from "vitest";
import { pathsBox } from "../src/geom/geom";
import { importDxf } from "../src/scene/importDxf";
import { DEFAULT_PROFILE } from "../src/scene/model";
import { pathsToSketch } from "../src/sketch/fromPaths";
import { sketchPaths } from "../src/sketch/paths";
import { loadSolver, solve } from "../src/sketch/solver";

beforeAll(async () => {
  await loadSolver("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm");
});

function dxf(entities: (string | number)[][]) {
  const lines: (string | number)[] = [];
  const pairs = (ps: (string | number)[][]) => ps.forEach(([c, v]) => lines.push(c!, v!));
  pairs([[0, "SECTION"], [2, "HEADER"], [9, "$INSUNITS"], [70, 4], [0, "ENDSEC"]]);
  pairs([[0, "SECTION"], [2, "ENTITIES"], ...entities, [0, "ENDSEC"], [0, "EOF"]]);
  return lines.join("\r\n") + "\r\n";
}

// A 20 × 20 square whose top edge is a semicircle (bulge 1), a circle, an arc and an ellipse.
const DRAWING = dxf([
  [0, "LWPOLYLINE"], [90, 4], [70, 1],
  [10, 0], [20, 0],
  [10, 20], [20, 0],
  [10, 20], [20, 20], [42, 1],
  [10, 0], [20, 20],
  [0, "CIRCLE"], [10, 40], [20, 10], [40, 5],
  [0, "ARC"], [10, 60], [20, 10], [40, 5], [50, 0], [51, 90],
  [0, "ELLIPSE"], [10, 80], [20, 10], [11, 6], [21, 0], [40, 0.5], [41, 0], [42, 6.283185307179586],
]);

describe("DXF to sketch", () => {
  it("keeps lines, arcs and circles from the DXF on the imported paths", () => {
    const r = importDxf(DRAWING, "t", DEFAULT_PROFILE);
    const segs = r.object!.paths.map((p) => p.segs);
    expect(segs[0]!.map((g) => g.kind)).toEqual(["line", "line", "arc", "line"]);
    expect(segs[1]![0]!.kind).toBe("circle");
    expect(segs[2]![0]!.kind).toBe("arc");
    expect(segs[3]).toBeNull(); // the ellipse
  });

  it("converts to an editable sketch that redraws the same shape", () => {
    const o = importDxf(DRAWING, "t", DEFAULT_PROFILE).object!;
    const { sketch, editable, reference } = pathsToSketch(o.paths, "#000000");
    expect(editable).toBe(6);
    expect(reference).toBe(1);
    expect(sketch.entities.filter((e) => e.kind === "arc")).toHaveLength(2);
    // Corners are shared: the square's 4 sides and the semicircle form one closed loop.
    const paths = sketchPaths(sketch);
    const before = pathsBox(o.paths);
    const after = pathsBox(paths);
    for (const k of ["minX", "minY", "maxX", "maxY"] as const) expect(after[k]).toBeCloseTo(before[k], 2);
    expect(paths.filter((p) => p.closed)).toHaveLength(3); // square+semicircle, circle, ellipse
    // Horizontal/vertical sides and the tangent semicircle are constrained; it all solves.
    expect(sketch.constraints.filter((c) => c.type === "horizontal" || c.type === "vertical")).toHaveLength(3);
    expect(sketch.constraints.filter((c) => c.type === "tangent")).toHaveLength(2);
    const sol = solve(sketch, { analyze: true });
    expect(sol.ok).toBe(true);
  });

  it("turns old imports (no line/arc data) into lines, or reference geometry when they're long curves", () => {
    const square = { color: "#ff0000", closed: true, points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }] };
    const curve = { color: "#ff0000", closed: false, points: Array.from({ length: 40 }, (_, i) => ({ x: i, y: Math.sin(i / 10) })) };
    const r = pathsToSketch([square, curve], "#000000");
    expect(r.sketch.entities.filter((e) => e.kind === "line")).toHaveLength(4);
    expect(r.sketch.entities.filter((e) => e.kind === "ref")).toHaveLength(1);
    expect(r.sketch.entities[0]!.color).toBe("#ff0000");
  });
});
