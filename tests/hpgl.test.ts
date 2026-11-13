import { describe, expect, it } from "vitest";
import { parseHpgl, penColor } from "../src/import/hpgl";
import { FLATTEN_TOLERANCE_MM } from "../src/import/types";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("parseHpgl", () => {
  it("reads a square drawn with PU/PD, 40 units per mm, y flipped", () => {
    const r = parseHpgl("IN;SP1;PU0,0;PD400,0,400,400,0,400,0,0;PU;");
    expect(r.warnings).toEqual([]);
    expect(r.paths).toHaveLength(1);
    const p = r.paths[0]!;
    expect(p.closed).toBe(true);
    expect(p.points).toHaveLength(4);
    expect(p.stroke).toBe("#000000");
    expect(p.fill).toBeNull();
    // Start (0,0) is the bottom of the drawing: after the flip it has y = 10 mm.
    expect(p.points[0]).toEqual({ x: 0, y: 10 });
    expect(p.points[1]).toEqual({ x: 10, y: 10 });
    expect(p.points[2]).toEqual({ x: 10, y: 0 });
    expect(p.points[3]).toEqual({ x: 0, y: 0 });
  });

  it("handles relative moves and mode switching", () => {
    const r = parseHpgl("PU;PA40,40;PR;PD40,0,0,40;");
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.closed).toBe(false);
    expect(r.paths[0]!.points).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 0 },
    ]);
  });

  it("accepts newlines, lowercase and commands without separators", () => {
    const a = parseHpgl("IN;SP1;PU100,100;PD200,200,300,200;");
    const b = parseHpgl("in\nsp1\npu 100 100\npd200,200,300,200\n");
    const c = parseHpgl("IN;SP1;PU100,100;PD100,200,300,400;");
    expect(b.paths).toEqual(a.paths);
    expect(a.paths[0]!.points).toHaveLength(3);
    expect(c.paths[0]!.points).toHaveLength(3); // start + two coordinate pairs
  });

  it("starts a new polyline after every pen up", () => {
    const r = parseHpgl("PU0,0;PD40,0;PU80,0;PD120,0;");
    expect(r.paths).toHaveLength(2);
  });

  it("maps pen numbers to colours", () => {
    const r = parseHpgl("SP1;PU0,0;PD40,0;SP2;PU0,40;PD40,40;SP3;PU0,80;PD40,80;SP9;PU0,120;PD40,120;");
    expect(r.paths.map((p) => p.stroke)).toEqual(["#000000", "#ff0000", "#00e000", penColor(9)]);
    expect(penColor(4)).toBe("#0000ff");
    expect(penColor(5)).toBe("#00e0e0");
    expect(penColor(6)).toBe("#ff00ff");
    expect(penColor(7)).toBe("#d0d000");
    expect(penColor(8)).not.toBe(penColor(9));
  });

  it("closes a polyline whose end meets its start within 0.01 mm", () => {
    const r = parseHpgl("PU0,0;PD400,0,400,400,0,400,0,0;PU0,0;PD400,0,400,400,0,400,0,0;");
    expect(r.paths.every((p) => p.closed)).toBe(true);
    const near = parseHpgl("PU0,0;PD400,0,400,400,0,400,0,0.2;");
    expect(near.paths[0]!.closed).toBe(true);
    const far = parseHpgl("PU0,0;PD400,0,400,400,0,400,0,8;");
    expect(far.paths[0]!.closed).toBe(false);
  });

  it("draws a circle around the pen position within tolerance", () => {
    const r = parseHpgl("IN;PU400,400;CI200;");
    expect(r.paths).toHaveLength(1);
    const p = r.paths[0]!;
    expect(p.closed).toBe(true);
    // Centre is (10, 10) mm raw; the drawing spans y 5..15, so the flipped centre is (10, 5).
    for (const pt of p.points) close(Math.hypot(pt.x - 10, pt.y - 5), 5);
    for (let i = 0; i < p.points.length; i++) {
      const a = p.points[i]!;
      const b = p.points[(i + 1) % p.points.length]!;
      const mid = Math.hypot((a.x + b.x) / 2 - 10, (a.y + b.y) / 2 - 5);
      expect(5 - mid).toBeLessThanOrEqual(FLATTEN_TOLERANCE_MM + 1e-6);
    }
  });

  it("draws arcs (AA) counter-clockwise and moves the pen to the end", () => {
    const r = parseHpgl("PU0,0;PD;AA0,400,90;");
    const p = r.paths[0]!;
    expect(p.closed).toBe(false);
    close(p.points[0]!.x, 0);
    close(p.points[0]!.y, 10);
    const last = p.points[p.points.length - 1]!;
    close(last.x, 10);
    close(last.y, 0);
    for (const pt of p.points) close(Math.hypot(pt.x, pt.y), 10, 1e-6); // flipped centre is (0, 0)
  });

  it("draws relative arcs (AR)", () => {
    const r = parseHpgl("PU400,0;PD;AR0,400,-90;");
    const last = r.paths[0]!.points.at(-1)!;
    // Centre (10, 10), start angle -90 degrees, sweeping clockwise to angle -180: (0, 10).
    close(last.x, 0);
    close(last.y, 0, 1e-6); // flipped: raw y 10 is the top
  });

  it("draws rectangles as closed paths", () => {
    const r = parseHpgl("PU0,0;EA400,200;PU0,0;ER40,40;");
    expect(r.paths).toHaveLength(2);
    expect(r.paths.every((p) => p.closed && p.points.length === 4)).toBe(true);
    const xs = r.paths[0]!.points.map((q) => q.x);
    const ys = r.paths[0]!.points.map((q) => q.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(10);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(5);
  });

  it("converts 1016 units to 25.4 mm and keeps y non-negative", () => {
    const r = parseHpgl("PU-40,-40;PD1016,1016;");
    const pts = r.paths[0]!.points;
    for (const pt of pts) expect(pt.y).toBeGreaterThanOrEqual(0);
    close(pts[1]!.x - pts[0]!.x, (1016 + 40) / 40);
  });

  it("warns once about unknown commands and lists them", () => {
    const r = parseHpgl("IN;XX1;PU0,0;PD40,0;YY;XX2;LT2;");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("XX");
    expect(r.warnings[0]).toContain("YY");
    expect(r.warnings[0]).not.toContain("LT");
  });

  it("warns when there is no drawing", () => {
    const r = parseHpgl("IN;SP1;");
    expect(r.paths).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
