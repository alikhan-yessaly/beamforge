import { describe, expect, it } from "vitest";
import { translate } from "../src/geom/geom";
import { type Doc, type MachineProfile, type SceneObject, anchorPoint, fromUser, toUser } from "../src/scene/model";
import {
  align,
  centerOnBed,
  duplicateSelected,
  groupSelected,
  mirror,
  objectScale,
  objectBox,
  pasteObjects,
  rotateAbout,
  selectionBox,
  setObjectScale,
  setSelectionBox,
  transformSelected,
  ungroupSelected,
} from "../src/scene/ops";
import { importDxf } from "../src/scene/importDxf";

const rect = (id: string, w: number, h: number, x = 0, y = 0): SceneObject => ({
  id,
  name: id,
  mat: translate(x, y),
  paths: [{ color: "#000000", closed: true, points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }],
});

const TL: MachineProfile = { name: "t", bedW: 600, bedH: 400, origin: "top-left", travelSpeed: 100, accel: 2000 };
const BR: MachineProfile = { ...TL, origin: "bottom-right" };

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("user coordinates", () => {
  it("round-trips for every origin corner", () => {
    for (const origin of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      const p = { ...TL, origin };
      const v = { x: 12, y: 34 };
      expect(fromUser(p, toUser(p, v))).toEqual(v);
    }
    expect(toUser(BR, { x: 0, y: 0 })).toEqual({ x: 600, y: 400 });
  });

  it("puts the anchor near the origin corner", () => {
    const b = { minX: 10, minY: 20, maxX: 30, maxY: 60 };
    expect(anchorPoint(TL, b, { fx: 0, fy: 0 })).toEqual({ x: 10, y: 20 });
    expect(anchorPoint(BR, b, { fx: 0, fy: 0 })).toEqual({ x: 30, y: 60 });
  });
});

describe("ops", () => {
  const doc: Doc = { objects: [rect("a", 100, 50, 10, 10), rect("b", 20, 20, 200, 100)], layers: [] };
  const A = new Set(["a"]);
  const AB = new Set(["a", "b"]);

  it("computes selection boxes", () => {
    expect(selectionBox(doc, A)).toEqual({ minX: 10, minY: 10, maxX: 110, maxY: 60 });
    expect(selectionBox(doc, AB)).toEqual({ minX: 10, minY: 10, maxX: 220, maxY: 120 });
    expect(selectionBox(doc, new Set())).toBeNull();
  });

  it("sets position and size from the anchor (top-left origin)", () => {
    const d = setSelectionBox(doc, A, TL, { fx: 0, fy: 0 }, { x: 50, y: 70 }, 200, 25);
    expect(objectBox(d.objects[0]!)).toEqual({ minX: 50, minY: 70, maxX: 250, maxY: 95 });
    expect(d.objects[1]).toBe(doc.objects[1]); // untouched objects are shared
  });

  it("sets position with a centre anchor and a bottom-right origin", () => {
    // User (100,100) from bottom-right = internal (500,300).
    const d = setSelectionBox(doc, A, BR, { fx: 0.5, fy: 0.5 }, fromUser(BR, { x: 100, y: 100 }), 100, 50);
    const b = objectBox(d.objects[0]!);
    close((b.minX + b.maxX) / 2, 500);
    close((b.minY + b.maxY) / 2, 300);
  });

  it("aligns to a reference box", () => {
    const bed = { minX: 0, minY: 0, maxX: 600, maxY: 400 };
    const d = align(doc, AB, "right", bed);
    expect(objectBox(d.objects[0]!).maxX).toBe(600);
    expect(objectBox(d.objects[1]!).maxX).toBe(600);
    const c = align(doc, A, "vcenter", bed);
    close(objectBox(c.objects[0]!).minY, 175);
  });

  it("centres the selection on the bed", () => {
    const b = selectionBox(centerOnBed(doc, AB, TL), AB)!;
    close((b.minX + b.maxX) / 2, 300);
    close((b.minY + b.maxY) / 2, 200);
  });

  it("rotates about a point and keeps the size", () => {
    const d = transformSelected(doc, A, rotateAbout({ x: 60, y: 35 }, 90));
    const b = objectBox(d.objects[0]!);
    close(b.maxX - b.minX, 50);
    close(b.maxY - b.minY, 100);
    close((b.minX + b.maxX) / 2, 60);
  });

  it("mirrors in place", () => {
    const d = mirror(doc, A, "h");
    expect(objectBox(d.objects[0]!)).toEqual(objectBox(doc.objects[0]!));
    expect(d.objects[0]!.mat[0]).toBe(-1);
  });

  it("duplicates, groups and ungroups", () => {
    const dup = duplicateSelected(doc, A);
    expect(dup.doc.objects).toHaveLength(3);
    expect(objectBox(dup.doc.objects[2]!).minX).toBe(15);

    const g = groupSelected(doc, AB);
    expect(g.doc.objects).toHaveLength(1);
    expect(objectBox(g.doc.objects[0]!)).toEqual(selectionBox(doc, AB));

    const u = ungroupSelected(g.doc, g.ids);
    expect(u.doc.objects).toHaveLength(2);
    expect(selectionBox(u.doc, u.ids)).toEqual(selectionBox(doc, AB));
  });

  it("preserves nested groups and transformed member geometry through serialization and ungrouping", () => {
    const inner = groupSelected(doc, AB);
    const extra = rect("c", 30, 30, 300, 100);
    const combined: Doc = { ...inner.doc, objects: [...inner.doc.objects, extra] };
    const outer = groupSelected(combined, new Set(combined.objects.map((o) => o.id)));
    const moved = transformSelected(outer.doc, outer.ids, translate(10, 20));
    const restored: Doc = JSON.parse(JSON.stringify(moved));
    const first = ungroupSelected(restored, outer.ids);
    expect(first.doc.objects.map((o) => o.name)).toEqual(["Group", "c"]);
    expect(first.doc.objects[0]!.children).toHaveLength(2);
    const second = ungroupSelected(first.doc, new Set([first.doc.objects[0]!.id]));
    expect(second.doc.objects.map((o) => o.name)).toEqual(["a", "b", "c"]);
    expect(objectBox(second.doc.objects[0]!)).toEqual({ minX: 20, minY: 30, maxX: 120, maxY: 80 });
    expect(objectBox(second.doc.objects[1]!)).toEqual({ minX: 210, minY: 120, maxX: 230, maxY: 140 });
    expect(objectBox(second.doc.objects[2]!)).toEqual({ minX: 310, minY: 120, maxX: 340, maxY: 150 });
  });

  it("duplicates and pastes groups with distinct nested identities", () => {
    const grouped = groupSelected(doc, AB);
    const original = grouped.doc.objects[0]!;
    const pasted = pasteObjects(grouped.doc, [original], 10, 15);
    const copy = pasted.doc.objects[1]!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.children!.map((o) => o.id).every((id) => !original.children!.some((c) => c.id === id))).toBe(true);
    const expanded = ungroupSelected(pasted.doc, pasted.ids);
    expect(expanded.doc.objects).toHaveLength(3);
    expect(new Set(expanded.doc.objects.map((o) => o.id)).size).toBe(3);
    expect(objectBox(expanded.doc.objects[1]!)).toEqual({ minX: 20, minY: 25, maxX: 120, maxY: 75 });
  });

  it("retains path-splitting for older flattened objects", () => {
    const old = { ...rect("old", 10, 10), paths: [...rect("a", 10, 10).paths, ...rect("b", 20, 20).paths] };
    const result = ungroupSelected({ objects: [old], layers: [] }, new Set(["old"]));
    expect(result.doc.objects).toHaveLength(2);
    expect(result.doc.objects.every((o) => o.paths.length === 1)).toBe(true);
  });
});

describe("importDxf", () => {
  it("converts to mm, flips Y and centres on the bed", () => {
    const text = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "5", "0", "ENDSEC",
      "0", "SECTION", "2", "ENTITIES",
      "0", "LINE", "10", "0", "20", "0", "11", "4", "21", "2",
      "0", "ENDSEC", "0", "EOF"].join("\n");
    const { object } = importDxf(text, "l", TL);
    const b = objectBox(object!);
    close(b.maxX - b.minX, 40); // cm → mm
    close(b.maxY - b.minY, 20);
    close(b.minX, 280);
    close(b.minY, 190);
    // DXF end point (4,2) is up-right of the start, so on screen (y down) it is the top-right corner.
    const pts = object!.paths[0]!.points;
    expect(pts[1]!.y).toBeLessThan(pts[0]!.y);
  });
});

describe("object scale", () => {
  const prof: MachineProfile = { name: "t", bedW: 600, bedH: 400, origin: "top-left", travelSpeed: 100, accel: 2000 };
  it("reads and sets an object's own scale about the anchor, keeping its rotation", () => {
    let d: Doc = { objects: [rect("a", 20, 10, 50, 50)], layers: [] };
    d = transformSelected(d, new Set(["a"]), rotateAbout({ x: 60, y: 55 }, 90));
    expect(objectScale(d.objects[0]!).sx).toBeCloseTo(1, 9);
    const before = objectBox(d.objects[0]!);
    const e = setObjectScale(d, "a", 1.5, 1.5, prof, { fx: 0, fy: 0 });
    const o = e.objects[0]!;
    expect(objectScale(o).sx).toBeCloseTo(1.5, 9);
    expect(objectScale(o).sy).toBeCloseTo(1.5, 9);
    const after = objectBox(o);
    // Top-left anchor stays; rotated 90°, the 20 × 10 drawing is 10 wide and 20 tall, now 15 × 30.
    expect(after.minX).toBeCloseTo(before.minX, 9);
    expect(after.minY).toBeCloseTo(before.minY, 9);
    expect(after.maxX - after.minX).toBeCloseTo(15, 9);
    expect(after.maxY - after.minY).toBeCloseTo(30, 9);
  });
});
