import { describe, expect, it } from "vitest";
import { parseDxf } from "../src/dxf/parse";
import { aciToHex } from "../src/dxf/aci";
import { pathsBox, pathLength } from "../src/geom/geom";

/** Build an ASCII DXF from [code, value] pairs for the ENTITIES section (plus optional extra sections). */
function dxf(entities: (string | number)[][], opts: { units?: number; tables?: (string | number)[][]; blocks?: (string | number)[][] } = {}) {
  const lines: (string | number)[] = [];
  const pairs = (ps: (string | number)[][]) => ps.forEach(([c, v]) => lines.push(c!, v!));
  if (opts.units !== undefined) pairs([[0, "SECTION"], [2, "HEADER"], [9, "$INSUNITS"], [70, opts.units], [0, "ENDSEC"]]);
  if (opts.tables) pairs([[0, "SECTION"], [2, "TABLES"], ...opts.tables, [0, "ENDSEC"]]);
  if (opts.blocks) pairs([[0, "SECTION"], [2, "BLOCKS"], ...opts.blocks, [0, "ENDSEC"]]);
  pairs([[0, "SECTION"], [2, "ENTITIES"], ...entities, [0, "ENDSEC"], [0, "EOF"]]);
  return lines.join("\r\n") + "\r\n";
}

describe("parseDxf", () => {
  it("reads a LINE and the units", () => {
    const r = parseDxf(dxf([[0, "LINE"], [8, "cut"], [62, 1], [10, 1], [20, 2], [11, 4], [21, 6]], { units: 1 }));
    expect(r.units).toBe("in");
    expect(r.unitScale).toBe(25.4);
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.points).toEqual([{ x: 1, y: 2 }, { x: 4, y: 6 }]);
    expect(r.paths[0]!.color).toBe("#ff0000");
    expect(r.paths[0]!.layer).toBe("cut");
    expect(r.warnings).toEqual([]);
  });

  it("warns when units are missing", () => {
    const r = parseDxf(dxf([[0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 1]]));
    expect(r.unitScale).toBe(1);
    expect(r.warnings.join()).toMatch(/assumed millimetres/);
  });

  it("tessellates a CIRCLE closely", () => {
    const r = parseDxf(dxf([[0, "CIRCLE"], [10, 10], [20, 10], [40, 5]], { units: 4 }));
    const p = r.paths[0]!;
    expect(p.closed).toBe(true);
    const b = pathsBox([p]);
    expect(b.minX).toBeCloseTo(5, 3);
    expect(b.maxY).toBeCloseTo(15, 1); // within the 0.01 mm chord tolerance
    expect(pathLength(p)).toBeCloseTo(2 * Math.PI * 5, 1);
    for (const pt of p.points) expect(Math.hypot(pt.x - 10, pt.y - 10)).toBeCloseTo(5, 6);
  });

  it("draws an ARC counter-clockwise from start to end angle", () => {
    const r = parseDxf(dxf([[0, "ARC"], [10, 0], [20, 0], [40, 1], [50, 0], [51, 90]], { units: 4 }));
    const pts = r.paths[0]!.points;
    expect(pts[0]!.x).toBeCloseTo(1);
    expect(pts[0]!.y).toBeCloseTo(0);
    expect(pts.at(-1)!.x).toBeCloseTo(0);
    expect(pts.at(-1)!.y).toBeCloseTo(1);
    expect(pathLength(r.paths[0]!)).toBeCloseTo(Math.PI / 2, 2);
  });

  it("handles LWPOLYLINE bulges (semicircle) and the closed flag", () => {
    // Square 0..2 with the top edge replaced by a semicircle bulging upward.
    const r = parseDxf(
      dxf(
        [
          [0, "LWPOLYLINE"], [90, 4], [70, 1],
          [10, 0], [20, 0],
          [10, 2], [20, 0],
          [10, 2], [20, 2], [42, 1],
          [10, 0], [20, 2],
        ],
        { units: 4 },
      ),
    );
    const p = r.paths[0]!;
    expect(p.closed).toBe(true);
    const b = pathsBox([p]);
    expect(b.maxY).toBeCloseTo(3, 3); // semicircle radius 1 above y=2
    expect(pathLength(p)).toBeCloseTo(6 + Math.PI, 1);
  });

  it("reads old-style POLYLINE / VERTEX / SEQEND", () => {
    const r = parseDxf(
      dxf([
        [0, "POLYLINE"], [66, 1], [70, 0],
        [0, "VERTEX"], [10, 0], [20, 0],
        [0, "VERTEX"], [10, 3], [20, 4],
        [0, "SEQEND"],
        [0, "LINE"], [10, 0], [20, 0], [11, 1], [21, 0],
      ]),
    );
    expect(r.paths).toHaveLength(2);
    expect(pathLength(r.paths[0]!)).toBeCloseTo(5);
  });

  it("evaluates a SPLINE through its end control points (clamped)", () => {
    const r = parseDxf(
      dxf([
        [0, "SPLINE"], [70, 8], [71, 3], [72, 8], [73, 4],
        [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1],
        [10, 0], [20, 0], [10, 1], [20, 2], [10, 3], [20, 2], [10, 4], [20, 0],
      ]),
    );
    const pts = r.paths[0]!.points;
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts.at(-1)!.x).toBeCloseTo(4);
    expect(pts.at(-1)!.y).toBeCloseTo(0);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(1.5, 2); // Bezier peak
  });

  it("expands INSERT with scale, rotation and BYLAYER colours", () => {
    const r = parseDxf(
      dxf([[0, "INSERT"], [8, "L1"], [2, "B"], [10, 10], [20, 0], [41, 2], [42, 2], [50, 90]], {
        tables: [[0, "TABLE"], [2, "LAYER"], [0, "LAYER"], [2, "L1"], [62, 5], [0, "ENDTAB"]],
        blocks: [[0, "BLOCK"], [2, "B"], [10, 0], [20, 0], [0, "LINE"], [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0], [0, "ENDBLK"]],
      }),
    );
    const p = r.paths[0]!;
    expect(p.points[0]!.x).toBeCloseTo(10);
    expect(p.points[1]!.x).toBeCloseTo(10);
    expect(p.points[1]!.y).toBeCloseTo(2);
    expect(p.layer).toBe("L1"); // layer 0 inherits the insert's layer
    expect(p.color).toBe("#0000ff");
  });

  it("mirrors entities with extrusion 0,0,-1", () => {
    const r = parseDxf(dxf([[0, "CIRCLE"], [10, 5], [20, 0], [40, 1], [230, -1]]));
    const b = pathsBox(r.paths);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(-5);
  });

  it("reports unsupported entities", () => {
    const r = parseDxf(dxf([[0, "TEXT"], [1, "hi"], [0, "TEXT"], [1, "x"]], { units: 4 }));
    expect(r.paths).toHaveLength(0);
    expect(r.warnings).toEqual(["Skipped 2 TEXT entities"]);
  });

  it("rejects non-DXF input", () => {
    expect(() => parseDxf("hello\nworld\n")).toThrow();
  });
});

describe("aciToHex", () => {
  it("maps base colours", () => {
    expect(aciToHex(1)).toBe("#ff0000");
    expect(aciToHex(5)).toBe("#0000ff");
    expect(aciToHex(10)).toBe("#ff0000");
    expect(aciToHex(90)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
