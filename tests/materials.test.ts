import { describe, expect, it } from "vitest";
import { parsePresets, presetSettings, validPreset } from "../src/workspace/materials";

const preset = { id: "p1", name: "Test", machine: "Laser", speed: 20, minPower: 10, maxPower: 20, passes: 2 };

describe("material presets", () => {
  it("round-trips saved presets and extracts only layer settings", () => {
    expect(parsePresets(JSON.stringify([preset]))).toEqual([preset]);
    expect(presetSettings(preset)).toEqual({ speed: 20, minPower: 10, maxPower: 20, passes: 2, linkPower: false });
    expect(presetSettings({ ...preset, minPower: 20 }).linkPower).toBe(true);
    expect(parsePresets(null)).toEqual([]);
  });

  it("rejects malformed or unsafe settings instead of accepting them", () => {
    for (const patch of [
      { name: " " }, { speed: 0 }, { minPower: -1 }, { maxPower: 101 }, { minPower: 30, maxPower: 20 },
      { passes: 0 }, { passes: 1.5 }, { passes: 100 },
    ]) {
      expect(validPreset({ ...preset, ...patch })).toBe(false);
      expect(() => parsePresets(JSON.stringify([{ ...preset, ...patch }]))).toThrow();
    }
    expect(() => parsePresets("not json")).toThrow();
    expect(() => parsePresets(JSON.stringify([null]))).toThrow();
  });
});

describe("presets on layers", () => {
  it("flags a layer as edited once its values differ from the preset, and keeps the link through edits", async () => {
    const { matchesPreset } = await import("../src/workspace/materials");
    const { activeLayers, updateLayer } = await import("../src/job/layers");
    const { IDENTITY } = await import("../src/geom/geom");
    const doc = {
      objects: [{ id: "o", name: "o", mat: IDENTITY, paths: [{ color: "#ff0000", closed: true, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }] }],
      layers: [],
    };
    let d = updateLayer(doc, "#ff0000", { ...presetSettings(preset), material: preset.id });
    expect(activeLayers(d)[0]!.material).toBe("p1");
    expect(matchesPreset(activeLayers(d)[0]!, preset)).toBe(true);
    d = updateLayer(d, "#ff0000", { speed: 25 });
    expect(activeLayers(d)[0]!.material).toBe("p1");
    expect(matchesPreset(activeLayers(d)[0]!, preset)).toBe(false);
  });
});
