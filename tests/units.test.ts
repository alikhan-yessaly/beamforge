import { describe, expect, it } from "vitest";
import { SNAP_STEPS, formatLength, fromUnits, gridSteps, stepLabel, toUnits } from "../src/scene/units";

describe("units", () => {
  it("converts both ways", () => {
    expect(toUnits(25.4, "in")).toBeCloseTo(1);
    expect(fromUnits(2, "in")).toBeCloseTo(50.8);
    expect(toUnits(12, "mm")).toBe(12);
  });
  it("formats with sensible precision", () => {
    expect(formatLength(10, "mm")).toBe("10");
    expect(formatLength(10, "in")).toBe("0.394");
    expect(formatLength(25.4, "in", true)).toBe("1.000");
  });
  it("labels inch snap steps as fractions", () => {
    expect(SNAP_STEPS.in.map((s) => stepLabel(s, "in"))).toEqual(["1/16", "1/8", "1/4", "1/2", "1"]);
    expect(stepLabel(0.5, "mm")).toBe("0.5");
  });
  it("keeps the mm grid and puts inch majors on whole inches", () => {
    expect(gridSteps(1)).toEqual({ minor: 10, major: 100 });
    expect(gridSteps(8)).toEqual({ minor: 1, major: 10 });
    const g = gridSteps(4, "in");
    expect(g.major / 25.4).toBeCloseTo(1);
  });
});
