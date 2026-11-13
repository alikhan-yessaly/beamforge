import { describe, expect, it } from "vitest";
import { planToolpath } from "../src/job/plan";
import { objectBox } from "../src/scene/ops";
import { DEFAULT_PROFILE } from "../src/scene/model";
import { SAMPLE_CUT, SAMPLE_FILL, sampleDoc } from "../src/project/sample";

describe("sampleDoc", () => {
  const doc = sampleDoc({ bedW: 600, bedH: 400 }, "Sample tag");

  it("is one named object centred on the bed", () => {
    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0]!.name).toBe("Sample tag");
    const b = objectBox(doc.objects[0]!);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(300, 0);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(200, 0);
  });

  it("engraves before it cuts, and plans without errors", () => {
    expect(doc.layers.map((l) => l.color)).toEqual([SAMPLE_FILL, SAMPLE_CUT]);
    const tp = planToolpath(doc, { start: { x: 0, y: 0 }, innerFirst: true });
    expect(tp.errors).toEqual([]);
    expect(tp.layers.map((l) => l.color)).toEqual([SAMPLE_FILL, SAMPLE_CUT]);
  });

  it("fits a small desktop bed", () => {
    const small = sampleDoc({ bedW: 300, bedH: 200 }, "x");
    const b = objectBox(small.objects[0]!);
    expect(b.minX).toBeGreaterThan(0);
    expect(b.maxY).toBeLessThan(DEFAULT_PROFILE.bedH);
  });
});
