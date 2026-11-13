import { describe, expect, it } from "vitest";
import { firstJobSteps, layerIsSet } from "../src/app/firstJob";
import { DEFAULT_LAYER, type Doc } from "../src/scene/model";

const empty: Doc = { objects: [], layers: [] };

describe("firstJobSteps", () => {
  it("starts with nothing done", () => {
    const s = firstJobSteps({ machineKind: false, doc: empty, connected: false, seen: new Set() });
    expect(s.map((x) => x.id)).toEqual(["machine", "drawing", "layers", "prepare", "connect", "frame", "start"]);
    expect(s.every((x) => !x.done)).toBe(true);
  });

  it("reads live facts and remembered events", () => {
    const doc = { objects: [{ id: "a" }], layers: [{ ...DEFAULT_LAYER, color: "#f00", speed: 15 }] } as unknown as Doc;
    const s = firstJobSteps({ machineKind: true, doc, connected: true, seen: new Set(["prepare", "frame"]) });
    expect(s.filter((x) => !x.done).map((x) => x.id)).toEqual(["start"]);
  });
});

describe("layerIsSet", () => {
  it("is false for an untouched layer and true once edited or from a preset", () => {
    expect(layerIsSet({ ...DEFAULT_LAYER, color: "#f00" })).toBe(false);
    expect(layerIsSet({ ...DEFAULT_LAYER, color: "#f00", mode: "cut" })).toBe(false);
    expect(layerIsSet({ ...DEFAULT_LAYER, color: "#f00", maxPower: 60 })).toBe(true);
    expect(layerIsSet({ ...DEFAULT_LAYER, color: "#f00", material: "ply3" })).toBe(true);
  });
});
