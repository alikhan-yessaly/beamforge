import { describe, expect, it } from "vitest";
import { IDENTITY } from "../src/geom/geom";
import { PROJECT_VERSION, parseProject, projectName, serializeProject } from "../src/project/format";
import type { Doc } from "../src/scene/model";

const doc: Doc = {
  objects: [
    {
      id: "g",
      name: "group",
      mat: IDENTITY,
      paths: [{ color: "#ff0000", closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
      children: [{ id: "c", name: "child", mat: IDENTITY, paths: [{ color: "#ff0000", closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] }],
    },
  ],
  layers: [{ color: "#ff0000", speed: 100, minPower: 15, maxPower: 15, passes: 1, output: true, mode: "fill", fill: { pattern: "lines", interval: 0.1, angle: 45 } }],
};
const job = { startFrom: "current" as const, innerFirst: false };
const machine = { driver: "ruida", model: "card 0x65106510", profileName: "Ruida laser" };

describe(".laserproj", () => {
  it("brings out-of-range layer values into range and renumbers repeated object ids", () => {
    const f = JSON.parse(serializeProject(doc, job, machine));
    f.doc.layers = [{ color: "#ff0000", speed: 0, minPower: 40, maxPower: 500, passes: 1.6, output: true, kerf: 9, mode: "fill", fill: { pattern: "lines", interval: 0, angle: 0 } }];
    f.doc.objects.push(structuredClone(f.doc.objects[0]));
    const p = parseProject(JSON.stringify(f));
    expect(p.doc.layers![0]).toMatchObject({ speed: 0.1, minPower: 40, maxPower: 100, passes: 2, kerf: 2, fill: { interval: 0.01 } });
    const ids = (os: Doc["objects"]): string[] => os.flatMap((o) => [o.id, ...ids(o.children ?? [])]);
    expect(new Set(ids(p.doc.objects)).size).toBe(4);
  });

  it("round-trips the drawing, layers (incl. fill settings), job options and machine entry", () => {
    const text = serializeProject(doc, job, machine, new Date("2026-11-12T10:00:00Z"));
    const p = parseProject(text);
    expect(p).toMatchObject({ format: "laserproj", version: PROJECT_VERSION, savedAt: "2026-11-12T10:00:00.000Z", machine, job });
    expect(p.doc).toEqual(doc);
  });

  it("rejects other files with readable messages", () => {
    expect(() => parseProject("{oops")).toThrow(/not valid JSON/);
    expect(() => parseProject(JSON.stringify({ format: "other" }))).toThrow(/Not a .laserproj/);
    expect(() => parseProject(JSON.stringify({ format: "laserproj", version: 99, doc: { objects: [] } }))).toThrow(/newer version/);
    const bad = JSON.parse(serializeProject(doc, job, machine));
    bad.doc.objects[0].paths[0].points[0].x = "1";
    expect(() => parseProject(JSON.stringify(bad))).toThrow(/Invalid point/);
  });

  it("fills in defaults for missing optional parts and names projects from file names", () => {
    const p = parseProject(JSON.stringify({ format: "laserproj", version: 1, doc: { objects: [] } }));
    expect(p.job).toEqual({ startFrom: "absolute", innerFirst: true, order: "auto" });
    expect(p.doc.layers).toEqual([]);
    expect(projectName("plate.laserproj")).toBe("plate");
    expect(projectName(".laserproj")).toBe("Untitled");
  });
});
