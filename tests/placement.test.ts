import { describe, expect, it } from "vitest";
import { IDENTITY } from "../src/geom/geom";
import { fromUser, type MachineProfile } from "../src/scene/model";
import { type Toolpath } from "../src/job/plan";
import { relativeHeadOnDrawing, relativeToolpath } from "../src/workspace/placement";

describe("relative workplane head", () => {
  it.each(["top-left", "top-right", "bottom-left", "bottom-right"] as const)(
    "aligns the starting head and motion with the drawing for %s",
    (origin) => {
      const p: MachineProfile = { name: "test", bedW: 1300, bedH: 900, origin, travelSpeed: 100, accel: 2000 };
      const anchor = { x: 460000, y: 350000 };
      const start = { x: 100000, y: 200000 };
      expect(relativeHeadOnDrawing(start, start, anchor)).toEqual(anchor);
      const mapped = relativeHeadOnDrawing({ x: 120000, y: 210000 }, start, anchor);
      expect(mapped).toEqual({ x: 480000, y: 360000 });
      const a = fromUser(p, { x: anchor.x / 1000, y: anchor.y / 1000 });
      const b = fromUser(p, { x: mapped.x / 1000, y: mapped.y / 1000 });
      expect(b.x - a.x).toBe(origin.endsWith("right") ? -20 : 20);
      expect(b.y - a.y).toBe(origin.startsWith("bottom") ? -10 : 10);
    },
  );

  it("rebases preview travel onto the job origin without changing cut order", () => {
    const p: MachineProfile = { name: "test", bedW: 1300, bedH: 900, origin: "top-right", travelSpeed: 100, accel: 2000 };
    const tp: Toolpath = { start: { x: 1300, y: 0 }, layers: [], errors: [], warnings: [], segments: [
      { x0: 1300, y0: 0, x1: 800, y1: 360, cut: false, layer: -1 },
      { x0: 800, y0: 360, x1: 840, y1: 350, cut: true, layer: 0 },
      { x0: 840, y0: 350, x1: 800, y1: 360, cut: false, layer: -1 },
      { x0: 800, y0: 360, x1: 780, y1: 400, cut: true, layer: 0 },
      { x0: 780, y0: 400, x1: 1300, y1: 0, cut: false, layer: -1 },
    ] };
    const doc = { objects: [{ id: "o", name: "o", mat: IDENTITY, paths: [
      { color: "#000000", closed: false, points: [{ x: 800, y: 360 }, { x: 840, y: 350 }, { x: 780, y: 400 }] },
    ] }], layers: [] };
    const relative = relativeToolpath(tp, doc, p);
    expect(relative.start).toEqual({ x: 840, y: 350 });
    expect(relative.segments[0]).toEqual({ x0: 840, y0: 350, x1: 800, y1: 360, cut: false, layer: -1 });
    expect(relative.segments.at(-1)).toEqual({ x0: 780, y0: 400, x1: 840, y1: 350, cut: false, layer: -1 });
    expect(relative.segments.filter((s) => s.cut)).toEqual(tp.segments.filter((s) => s.cut));
    expect(tp.start).toEqual({ x: 1300, y: 0 });
  });
});
