import { describe, expect, it } from "vitest";
import { layerStrokeStyle } from "../src/workspace/render";

describe("layer stroke style", () => {
  it.each([
    [true, true, 1, []],
    [true, false, 0.5, []],
    [false, true, 0.5, [2, 4]],
    [false, false, 0.5, [2, 4]],
  ] as const)("renders show=%s and output=%s", (show, output, alpha, dash) => {
    expect(layerStrokeStyle({ show, output })).toEqual({ alpha, dash });
  });

  it("shows legacy layers at full intensity by default", () => {
    expect(layerStrokeStyle({ output: true })).toEqual({ alpha: 1, dash: [] });
    expect(layerStrokeStyle(undefined)).toEqual({ alpha: 1, dash: [] });
  });
});
