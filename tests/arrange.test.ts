import { describe, expect, it } from "vitest";
import { mul, rotate, translate } from "../src/geom/geom";
import type { Doc, MachineProfile, SceneObject } from "../src/scene/model";
import { areaFromBox, autoArrange, bestFitAngle, distribute, linearArray, userArea } from "../src/scene/arrange";
import { objectBox } from "../src/scene/ops";

const rect = (id: string, w: number, h: number, x = 0, y = 0): SceneObject => ({
  id,
  name: id,
  mat: translate(x, y),
  paths: [{ color: "#000000", closed: true, points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }],
});
const bed = (origin: MachineProfile["origin"] = "top-left", bedW = 600, bedH = 400): MachineProfile => ({ name: "t", bedW, bedH, origin, travelSpeed: 100, accel: 2000 });
const doc = (...objects: SceneObject[]): Doc => ({ objects, layers: [] });
const box = (d: Doc, id: string) => objectBox(d.objects.find((o) => o.id === id)!);
const r2 = (n: number) => Math.round(n * 100) / 100;
const overlap = (d: Doc, gap: number) => {
  const bs = d.objects.map(objectBox);
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]!, b = bs[j]!;
      if (a.minX < b.maxX + gap - 1e-6 && b.minX < a.maxX + gap - 1e-6 && a.minY < b.maxY + gap - 1e-6 && b.minY < a.maxY + gap - 1e-6) return true;
    }
  return false;
};

describe("distribute", () => {
  const d = doc(rect("a", 10, 10, 0, 0), rect("c", 30, 10, 100, 5), rect("b", 20, 10, 40, 20));
  const all = new Set(["a", "b", "c"]);

  it("puts a set gap between neighbours in their order along x, first one fixed", () => {
    const r = distribute(d, all, "x", 5);
    expect([box(r, "a").minX, box(r, "b").minX, box(r, "c").minX]).toEqual([0, 15, 40]);
    expect(box(r, "b").minY).toBe(20); // the other axis is untouched
  });

  it("spaces evenly between the outer two with no gap set", () => {
    const r = distribute(d, all, "x", null);
    expect(box(r, "a").minX).toBe(0);
    expect(box(r, "c").maxX).toBe(130);
    expect(r2(box(r, "b").minX - box(r, "a").maxX)).toBe(r2(box(r, "c").minX - box(r, "b").maxX));
  });

  it("works along y and needs two objects", () => {
    const y = distribute(d, all, "y", 0);
    expect([box(y, "a").minY, box(y, "c").minY, box(y, "b").minY]).toEqual([0, 10, 20]);
    expect(distribute(d, new Set(["a"]), "x", 5)).toBe(d);
  });
});

describe("linear pattern on the bed", () => {
  it("copies the selection as a block into a grid with gaps", () => {
    const r = linearArray(doc(rect("a", 10, 5, 0, 0), rect("b", 10, 5, 20, 0)), new Set(["a", "b"]), 3, 2, 2, 1);
    if ("error" in r) throw new Error(r.error);
    expect(r.doc.objects).toHaveLength(12);
    expect(r.ids.size).toBe(12);
    // Block is 30 × 5: steps of 32 and 6.
    const xs = [...new Set(r.doc.objects.map((o) => objectBox(o).minX))].sort((p, q) => p - q);
    expect(xs).toEqual([0, 20, 32, 52, 64, 84]);
    expect([...new Set(r.doc.objects.map((o) => objectBox(o).minY))].sort((p, q) => p - q)).toEqual([0, 6]);
    expect(new Set(r.doc.objects.map((o) => o.id)).size).toBe(12);
  });

  it("refuses an empty selection or too many copies", () => {
    expect("error" in linearArray(doc(rect("a", 1, 1)), new Set(), 2, 2, 0, 0)).toBe(true);
    expect("error" in linearArray(doc(rect("a", 1, 1)), new Set(["a"]), 100, 100, 0, 0)).toBe(true);
  });
});

describe("auto arrange", () => {
  it("packs from the home corner with the minimum gap, without overlaps", () => {
    const objs = Array.from({ length: 12 }, (_, i) => rect(`r${i}`, 20 + (i % 4) * 15, 10 + (i % 3) * 12, 300 + i * 7, 200 - i * 3));
    const r = autoArrange(doc(...objs), new Set(objs.map((o) => o.id)), bed(), { gap: 3, rotate: false });
    expect(r.left).toBe(0);
    expect(overlap(r.doc, 3)).toBe(false);
    for (const o of r.doc.objects) {
      const b = objectBox(o);
      expect(b.minX).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(b.minY).toBeGreaterThanOrEqual(3 - 1e-9);
      expect(b.maxX).toBeLessThanOrEqual(597 + 1e-9);
    }
    expect(Math.min(...r.doc.objects.map((o) => objectBox(o).minX))).toBeCloseTo(3);
  });

  it("starts at the right edge for a top-right origin", () => {
    const r = autoArrange(doc(rect("a", 50, 20, 100, 100)), new Set(["a"]), bed("top-right"), { gap: 2, rotate: false });
    expect(box(r.doc, "a")).toEqual({ minX: 548, minY: 2, maxX: 598, maxY: 22 });
  });

  it("leaves what doesn't fit where it was and counts it", () => {
    const r = autoArrange(doc(rect("big", 500, 300), rect("huge", 700, 50, 10, 10)), new Set(["big", "huge"]), bed(), { gap: 0, rotate: false });
    expect(r.left).toBe(1);
    expect(box(r.doc, "huge").minX).toBe(10);
  });

  it("turns a part that only fits sideways when rotation is on", () => {
    const tall = rect("t", 30, 500);
    expect(autoArrange(doc(tall), new Set(["t"]), bed(), { gap: 0, rotate: false }).left).toBe(1);
    const r = autoArrange(doc(tall), new Set(["t"]), bed(), { gap: 0, rotate: true });
    expect(r.left).toBe(0);
    const b = box(r.doc, "t");
    expect(r2(b.maxX - b.minX)).toBe(500);
    expect(r2(b.maxY - b.minY)).toBe(30);
  });

  it("finds the angle that un-tilts a rotated rectangle", () => {
    const o = rect("a", 40, 10);
    const tilted = { ...o, mat: mul(rotate((30 * Math.PI) / 180), o.mat) };
    // Turning by −30° (150°) or +60° squares it up again.
    expect([60, 150]).toContain(Math.round(bestFitAngle(tilted)));
    const r = autoArrange(doc(tilted), new Set(["a"]), bed(), { gap: 0, rotate: true });
    const b = box(r.doc, "a");
    expect(r2((b.maxX - b.minX) * (b.maxY - b.minY))).toBeCloseTo(400, 0);
  });

  it("packs into a scrap area, from its corner nearest home, and leaves what doesn't fit", () => {
    const objs = [rect("a", 40, 30), rect("b", 40, 30), rect("c", 40, 30)];
    const area = userArea(bed("top-right"), { x: 100, y: 50, w: 90, h: 40 });
    expect(area).toEqual({ minX: 410, minY: 50, maxX: 500, maxY: 90 });
    expect(areaFromBox(bed("top-right"), area)).toEqual({ x: 100, y: 50, w: 90, h: 40 });
    const r = autoArrange(doc(...objs), new Set(["a", "b", "c"]), bed("top-right"), { gap: 2, rotate: false, area });
    expect(r.left).toBe(1);
    const placed = r.doc.objects.map(objectBox).filter((b) => b.minY >= 50);
    expect(placed).toHaveLength(2);
    for (const b of placed) {
      expect(b.minX).toBeGreaterThanOrEqual(412 - 1e-9);
      expect(b.maxX).toBeLessThanOrEqual(498 + 1e-9);
      expect(b.maxY).toBeLessThanOrEqual(88 + 1e-9);
    }
    expect(Math.max(...placed.map((b) => b.maxX))).toBeCloseTo(498);
  });
});
