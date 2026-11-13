import { describe, expect, it } from "vitest";
import { allNames, cleanName, nextNumberedName } from "../src/scene/names";
import type { SceneObject } from "../src/scene/model";

const obj = (name: string, children?: SceneObject[]): SceneObject => ({ id: name, name, paths: [], mat: [1, 0, 0, 1, 0, 0], children });

describe("nextNumberedName", () => {
  it("starts at 1", () => {
    expect(nextNumberedName([], "Sketch {n}")).toBe("Sketch 1");
    expect(nextNumberedName(["plate", "Sketchy"], "Sketch {n}")).toBe("Sketch 1");
  });
  it("takes one more than the highest, without reusing gaps", () => {
    expect(nextNumberedName(["Sketch 1", "Sketch 3"], "Sketch {n}")).toBe("Sketch 4");
  });
  it("ignores case and spacing, and works with text after the number", () => {
    expect(nextNumberedName(["sketch  7 "], "Sketch {n}")).toBe("Sketch 8");
    expect(nextNumberedName(["Эскиз 2"], "Эскиз {n}")).toBe("Эскиз 3");
    expect(nextNumberedName(["2-сызба"], "{n}-сызба")).toBe("3-сызба");
  });
  it("counts group members", () => {
    expect(nextNumberedName(allNames([obj("Group", [obj("Sketch 5")])]), "Sketch {n}")).toBe("Sketch 6");
  });
});

describe("cleanName", () => {
  it("trims, collapses spaces, and refuses empty names", () => {
    expect(cleanName("  front   panel ")).toBe("front panel");
    expect(cleanName("   ")).toBeNull();
    expect(cleanName("x".repeat(200))).toHaveLength(120);
  });
});
