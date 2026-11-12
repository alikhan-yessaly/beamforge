import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY } from "../src/geom/geom";
import { buildJob, buildRdFile, designOrigin } from "../src/job/build";
import { inspectJob, placeJob } from "../src/controller/jobRunner";
import { encodeJobCommands } from "../src/protocol/jobEncode";
import { relativeToolpath } from "../src/workspace/placement";
import { updateLayer } from "../src/job/layers";
import type { Doc, MachineProfile } from "../src/scene/model";

const RUIDA: MachineProfile = { name: "RDC644XS", bedW: 1300, bedH: 900, origin: "top-right", travelSpeed: 100, accel: 2000 };

// LightBurn's 100 mm test square: machine X 460–560, Y 350–450 (origin top-right), red layer, 10 mm/s, 10/15 %.
// Internal bed coords are top-left based, so machine X 460 is internal 1300 − 460 = 840. The points are listed so
// that, starting at the corner nearest home, the cut runs along +X first, as LightBurn's did.
function squareDoc(): Doc {
  const d: Doc = {
    objects: [
      {
        id: "sq",
        name: "square",
        mat: IDENTITY,
        paths: [{ color: "#ff0000", closed: true, points: [{ x: 840, y: 350 }, { x: 740, y: 350 }, { x: 740, y: 450 }, { x: 840, y: 450 }] }],
      },
    ],
    layers: [],
  };
  return updateLayer(d, "#ff0000", { speed: 10, minPower: 10, maxPower: 15 });
}

describe("buildJob", () => {
  it("a workspace document produces LightBurn's exact 100 mm square job", () => {
    const ours = buildRdFile(squareDoc(), RUIDA, { mode: "absolute", innerFirst: true });
    const theirs = new Uint8Array(readFileSync(join(__dirname, "fixtures", "lightburn-square-100-absolute.rd")));
    expect(Buffer.from(ours).equals(Buffer.from(theirs))).toBe(true);
  });

  it("current-position jobs are relative to the design's corner nearest home", () => {
    const { input, designOrigin } = buildJob(squareDoc(), RUIDA, { mode: "current", innerFirst: true });
    expect(designOrigin).toEqual({ x: 460000, y: 350000 });
    expect(input.mode).toBe("current");
    expect(input.layers[0]!.paths[0]).toEqual([
      { x: 0, y: 0 }, { x: 100000, y: 0 }, { x: 100000, y: 100000 }, { x: 0, y: 100000 }, { x: 0, y: 0 },
    ]);
  });

  it.each([
    ["top-left", { x: 740000, y: 350000 }],
    ["top-right", { x: 460000, y: 350000 }],
    ["bottom-left", { x: 740000, y: 450000 }],
    ["bottom-right", { x: 460000, y: 450000 }],
  ] as const)("uses the visible paths' nearest %s corner independent of output", (origin, expected) => {
    const p = { ...RUIDA, origin };
    const d = squareDoc();
    d.objects.push({ id: "off", name: "disabled", mat: IDENTITY, paths: [{ color: "#0000ff", closed: false, points: [{ x: 1, y: 1 }, { x: 1200, y: 800 }] }] });
    const disabled = updateLayer(d, "#0000ff", { output: false });
    const before = buildJob(d, p, { mode: "current", innerFirst: true });
    const job = buildJob(disabled, p, { mode: "current", innerFirst: true });
    expect(job.designOrigin).toEqual(before.designOrigin);
    expect(designOrigin(disabled, p)).toEqual(before.designOrigin);
    const hidden = updateLayer(disabled, "#0000ff", { show: false });
    const changed = buildJob(hidden, p, { mode: "current", innerFirst: true });
    expect(changed.designOrigin).toEqual(expected);
    expect(changed.input.layers.flatMap((l) => l.paths.flat()).every((pt) => pt.x >= 0 && pt.y >= 0)).toBe(true);
  });

  it("encodes cut offsets from the visible design and preserves them in frame bounds", () => {
    let d = squareDoc();
    d.objects.push({ id: "reference", name: "reference", mat: IDENTITY, paths: [
      { color: "#0000ff", closed: false, points: [{ x: 900, y: 300 }, { x: 910, y: 310 }] },
    ] });
    const both = buildJob(d, RUIDA, { mode: "current", innerFirst: true });
    d = updateLayer(d, "#0000ff", { output: false });
    const job = buildJob(d, RUIDA, { mode: "current", innerFirst: true });
    expect(job.designOrigin).toEqual(both.designOrigin);
    expect(job.input.layers).toHaveLength(1);
    const bounds = inspectJob(encodeJobCommands(job.input));
    expect(bounds.min).toEqual({ x: 70000, y: 50000 });
    expect(placeJob(bounds, { x: 100000, y: 200000 }).min).toEqual({ x: 170000, y: 250000 });
    const preview = relativeToolpath(job.toolpath, d, RUIDA);
    expect(preview.start).toEqual({ x: 910, y: 300 });
    expect(preview.segments[0]).toMatchObject({ cut: false, x0: 910, y0: 300 });
    d = updateLayer(d, "#0000ff", { show: false });
    expect(buildJob(d, RUIDA, { mode: "current", innerFirst: true }).designOrigin).toEqual({ x: 460000, y: 350000 });
  });

  it("refuses relative jobs with no visible origin or unsupported negative hidden-output offsets", () => {
    const hidden = updateLayer(squareDoc(), "#ff0000", { show: false });
    expect(() => buildJob(hidden, RUIDA, { mode: "current", innerFirst: true })).toThrow(/Show at least one layer/);
    const d: Doc = { ...hidden, objects: [...hidden.objects, { id: "ref", name: "ref", mat: IDENTITY, paths: [
      { color: "#0000ff", closed: false, points: [{ x: 700, y: 500 }, { x: 690, y: 510 }] },
    ] }] };
    const reference = updateLayer(d, "#0000ff", { output: false });
    expect(() => buildJob(reference, RUIDA, { mode: "current", innerFirst: true })).toThrow(/hidden output layer lies beyond/);
    expect(() => buildJob(reference, RUIDA, { mode: "absolute", innerFirst: true })).not.toThrow();
  });
  it("refuses designs outside the bed and empty jobs", () => {
    const d = squareDoc();
    const off: Doc = { ...d, objects: [{ ...d.objects[0]!, mat: [1, 0, 0, 1, 500, 0] }] };
    expect(() => buildJob(off, RUIDA, { mode: "absolute", innerFirst: true })).toThrow(/outside the bed/);
    const none = updateLayer(d, "#ff0000", { output: false });
    expect(() => buildJob(none, RUIDA, { mode: "absolute", innerFirst: true })).toThrow(/Nothing to cut/);
  });

  it.each(["top-left", "top-right", "bottom-left", "bottom-right"] as const)(
    "builds a relative job outside the editing bed with a %s home",
    (origin) => {
      const p = { ...RUIDA, origin };
      const d = squareDoc();
      const shifted: Doc = { ...d, objects: [{ ...d.objects[0]!, mat: [1, 0, 0, 1, 2000, -1800] }] };
      expect(() => buildJob(shifted, p, { mode: "absolute", innerFirst: true })).toThrow(/outside the bed/);
      const relative = buildJob(shifted, p, { mode: "current", innerFirst: true });
      const points = relative.input.layers.flatMap((l) => l.paths.flat());
      expect(Math.min(...points.map((pt) => pt.x))).toBe(0);
      expect(Math.min(...points.map((pt) => pt.y))).toBe(0);
      expect(Math.max(...points.map((pt) => pt.x))).toBe(100000);
      expect(Math.max(...points.map((pt) => pt.y))).toBe(100000);
      expect(buildRdFile(shifted, p, { mode: "current", innerFirst: true }).length).toBeGreaterThan(0);
    },
  );
});
