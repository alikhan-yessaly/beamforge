import { describe, expect, it } from "vitest";
import { IDENTITY, type Vec } from "../src/geom/geom";
import { runChecks } from "../src/job/checks";
import { DEEPER, depthReport, uneven } from "../src/job/depth";
import { chainEnd, chainSpeeds, estimate } from "../src/job/estimate";
import { kerfRings } from "../src/job/kerf";
import { updateLayer } from "../src/job/layers";
import { type Toolpath, planToolpath } from "../src/job/plan";
import { MACHINE_CLASSES, applyClass, seedsFor } from "../src/machine/classes";
import { energyRatio, overscanLength, rampDistance, scanOffsetAt, suggestCornerPower } from "../src/machine/motion";
import { type MaterialPreset } from "../src/machine/presets";
import { parseTune, serializeTune } from "../src/machine/tuneFile";
import { compareMaterials, parseProject, serializeProject } from "../src/project/format";
import { DEFAULT_PROFILE, type Doc, type Layer, type MachineProfile } from "../src/scene/model";
import { addMachine, identifyController, machinePrompt, machines, profile } from "../src/scene/store";
import { type FillCardParams, accelFromStrip, colorsNeeded, fillParams, gridParams, kerfParams, makeCard, rampLengths, scanParams } from "../src/tuning/cards";
import { cardsIn, freeColors, onlyCard, placeCard } from "../src/tuning/place";

const F = "#00e000";
const G = "#0000ff";
const O = { x: 0, y: 0 };
const M: MachineProfile = { ...DEFAULT_PROFILE, accel: 2000, startSpeed: 10, minFirePower: 10 };
const sq = (x: number, y: number, s: number): Vec[] => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const len = (s: { x0: number; y0: number; x1: number; y1: number }) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0);

/** A doc with filled squares on layer F (engraving 200 mm/s, 30 %, rows 1 mm apart). */
function fillDoc(squares: Vec[][], patch: Partial<Omit<Layer, "color">> = {}): Doc {
  const d: Doc = { objects: [{ id: "o", name: "o", mat: IDENTITY, paths: squares.map((points) => ({ color: F, closed: true, points, fill: F })) }], layers: [] };
  return updateLayer(d, F, { mode: "fill", fill: { pattern: "lines", interval: 1, angle: 0 }, speed: 200, minPower: 30, maxPower: 30, linkPower: false, ...patch });
}
const plan = (d: Doc, m: MachineProfile = M, extra: Partial<Parameters<typeof planToolpath>[1]> = {}) => planToolpath(d, { start: O, innerFirst: true, order: "layer", motion: m, ...extra });
const burns = (tp: Toolpath) => tp.segments.filter((s) => s.cut);
const leads = (tp: Toolpath) => tp.segments.filter((s) => s.lead);

describe("motion helpers", () => {
  it("suggests the corner power that keeps energy per mm even, floored at the lowest firing power", () => {
    expect(suggestCornerPower(30, 20, M)).toBe(15);
    expect(suggestCornerPower(30, 300, M)).toBe(10);
    expect(suggestCornerPower(30, 5, M)).toBe(30);
    // With that corner power the ramp gives constant energy wherever the head is above the start speed.
    const l = { speed: 20, minPower: 15, maxPower: 30 };
    for (const v of [10, 12, 15, 20]) expect(energyRatio(v, l, 10)).toBeCloseTo(1, 6);
    expect(energyRatio(10, { speed: 200, minPower: 30, maxPower: 30 }, 10)).toBeCloseTo(20, 6);
  });

  it("works out the run-up and the auto overscan", () => {
    expect(rampDistance(200, M)).toBeCloseTo((200 * 200 - 100) / 4000, 6);
    expect(overscanLength("auto", 200, M)).toBe(10);
    expect(overscanLength("off", 200, M)).toBe(0);
    expect(overscanLength(3, 200, M)).toBe(3);
    expect(overscanLength("auto", 5, M)).toBe(0);
  });

  it("interpolates scan offsets by speed and holds them flat outside the table", () => {
    const table = [{ speed: 300, offset: 0.3 }, { speed: 100, offset: 0.1 }];
    expect(scanOffsetAt(50, table)).toBe(0.1);
    expect(scanOffsetAt(200, table)).toBeCloseTo(0.2, 6);
    expect(scanOffsetAt(500, table)).toBe(0.3);
    expect(scanOffsetAt(200, undefined)).toBe(0);
  });
});

describe("machine classes", () => {
  it("scales seed powers by tube power within 5–90 %", () => {
    const desktop = MACHINE_CLASSES.find((c) => c.id === "desktop")!;
    const large = MACHINE_CLASSES.find((c) => c.id === "large")!;
    const cut = (c: typeof desktop) => seedsFor(c).find((s) => s.material === "3 mm plywood" && s.op === "cut")!.power;
    expect(cut(desktop)).toBeGreaterThan(cut(large));
    for (const c of MACHINE_CLASSES) for (const s of seedsFor(c)) expect(s.power).toBeGreaterThanOrEqual(5), expect(s.power).toBeLessThanOrEqual(90);
  });

  it("keeps a bed read from the controller", () => {
    const c = MACHINE_CLASSES.find((x) => x.id === "large")!;
    expect(applyClass({ ...M, bedW: 700, bedH: 500 }, c, true)).toMatchObject({ bedW: 700, bedH: 500, class: "large", accel: c.defaults.accel });
    expect(applyClass({ ...M, bedW: 700, bedH: 500 }, c, false)).toMatchObject({ bedW: 1300, bedH: 900 });
  });
});

describe("overscan and scan offset in the plan", () => {
  it("adds laser-off run-ups in line with each row, of the auto length", () => {
    const tp = plan(fillDoc([sq(100, 100, 10)], { overscan: "auto" }));
    const rows = burns(tp);
    const ls = leads(tp);
    expect(rows.length).toBeGreaterThan(5);
    expect(ls.length).toBe(rows.length * 2);
    for (const s of ls) {
      expect(s.cut).toBe(false);
      expect(s.y0).toBe(s.y1);
      expect(len(s)).toBeCloseTo(10, 6);
    }
    // Leads count as time.
    expect(estimate(tp, M).total).toBeGreaterThan(estimate(plan(fillDoc([sq(100, 100, 10)])), M).total);
  });

  it("keeps run-ups inside the bounds", () => {
    const tp = plan(fillDoc([sq(2, 100, 10)], { overscan: "auto" }), M, { bounds: { minX: 0, minY: 0, maxX: 600, maxY: 400 } });
    for (const s of leads(tp)) expect(Math.min(s.x0, s.x1)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...leads(tp).map(len))).toBeCloseTo(10, 6);
  });

  it("shifts each burn back by half the scan offset along its direction", () => {
    const plain = burns(plan(fillDoc([sq(100, 100, 10)])));
    const shifted = burns(plan(fillDoc([sq(100, 100, 10)]), { ...M, scanOffsets: [{ speed: 200, offset: 0.4 }] }));
    expect(shifted.length).toBe(plain.length);
    plain.forEach((p, i) => {
      const s = shifted[i]!;
      const dir = Math.sign(p.x1 - p.x0);
      expect(s.x0).toBeCloseTo(p.x0 - 0.2 * dir, 6);
      expect(s.x1).toBeCloseTo(p.x1 - 0.2 * dir, 6);
    });
    // A layer's own value overrides the profile's.
    const own = burns(plan(fillDoc([sq(100, 100, 10)], { scanOffset: 0 }), { ...M, scanOffsets: [{ speed: 200, offset: 0.4 }] }));
    expect(own[0]!.x0).toBeCloseTo(plain[0]!.x0, 6);
  });
});

describe("sweep modes", () => {
  // Two squares side by side sharing rows, 5 mm apart.
  const two = [sq(100, 100, 10), sq(115, 100, 10)];

  it("sweeps areas that share rows together or each on its own", () => {
    expect(plan(fillDoc(two, { sweep: "together" })).sweeps?.[0]).toEqual([2]);
    expect(plan(fillDoc(two, { sweep: "separate" })).sweeps?.[0]).toEqual([1, 1]);
  });

  it("crosses gaps inside a row together as lead moves", () => {
    const tp = plan(fillDoc(two, { sweep: "together" }));
    const gaps = leads(tp).filter((s) => Math.min(s.x0, s.x1) >= 110 - 1e-6 && Math.max(s.x0, s.x1) <= 115 + 1e-6);
    expect(gaps.length).toBeGreaterThan(5);
  });
});

describe("depth model", () => {
  it("finds row ends burning deeper, and overscan or the corner power evening them out", () => {
    const d = fillDoc([sq(100, 100, 10)]);
    const [base] = depthReport(plan(d), M);
    expect(uneven(base!)).toBe(true);
    expect(base!.peak).toBeGreaterThanOrEqual(DEEPER);
    const [over] = depthReport(plan(updateLayer(d, F, { overscan: "auto" })), M);
    expect(over!.deepShare).toBeLessThan(0.01);
    const corner = suggestCornerPower(30, 200, M);
    const [low] = depthReport(plan(updateLayer(d, F, { minPower: corner })), M);
    expect(low!.peak).toBeLessThan(base!.peak);
  });

  it("speeds a chain at the burn speed, run-ups up to the travel speed", () => {
    const tp = plan(fillDoc([sq(100, 100, 10)], { overscan: "auto" }));
    const i = tp.segments.findIndex((s) => s.lead);
    const j = chainEnd(tp.segments, i);
    const { cap } = chainSpeeds(tp.segments, i, j, 200, M.accel, 250);
    tp.segments.slice(i, j).forEach((s, k) => expect(cap[k]).toBe(s.cut ? 200 : 250));
  });

  it("offers fixes with their time cost before the job runs", () => {
    const d = fillDoc([sq(100, 100, 10)]);
    const checks = runChecks(d, plan(d), M, (x) => plan(x));
    const c = checks.find((x) => x.kind === "uneven")!;
    expect(c.color).toBe(F);
    const kinds = c.fixes.map((f) => f.kind);
    expect(kinds).toContain("overscan");
    expect(kinds).toContain("corner");
    expect(c.fixes.find((f) => f.kind === "overscan")!.seconds).toBeGreaterThan(0);
    expect(c.fixes.find((f) => f.kind === "corner")!.seconds).toBe(0);
    // Overscan on: nothing to suggest.
    const fixed = updateLayer(d, F, { overscan: "auto" });
    expect(runChecks(fixed, plan(fixed), M, (x) => plan(x)).filter((x) => x.kind === "uneven")).toEqual([]);
  });
});

describe("kerf compensation", () => {
  it("grows outlines and shrinks holes by half the kerf", () => {
    const [outer, hole] = kerfRings([sq(0, 0, 10), sq(3, 3, 4)], 0.2);
    const span = (r: Vec[][]) => Math.max(...r[0]!.map((p) => p.x)) - Math.min(...r[0]!.map((p) => p.x));
    expect(span(outer!)).toBeCloseTo(10.2, 3);
    expect(span(hole!)).toBeCloseTo(3.8, 3);
    expect(kerfRings([sq(0, 0, 10)], 0)).toEqual([[sq(0, 0, 10)]]);
  });
});

describe("test cards", () => {
  const colors = (n: number) => ["#a00000", "#00a000", "#0000a0", "#a0a000", "#00a0a0", "#a000a0", "#505050", "#a05000", "#0050a0", "#50a000", "#a00050", "#00a050", "#5000a0", "#a0a050", "#50a0a0", "#a050a0"].slice(0, n);

  it("builds every kind with its own layers and clickable patches", () => {
    const params = [fillParams(M, 200, 20, colors(colorsNeeded("fill"))), scanParams(200, 20, colors(colorsNeeded("scan"))), gridParams("ply", { speed: 200, power: 20 }, { speed: 15, power: 60 }, colors(colorsNeeded("grid"))), kerfParams("ply", { speed: 15, power: 60, passes: 1 }, colors(colorsNeeded("kerf")))];
    for (const p of params) {
      const card = makeCard(p);
      expect(card.patches.length).toBeGreaterThan(2);
      expect(card.layers.length).toBeLessThanOrEqual(p.colors.length);
      for (const path of card.paths) expect(p.colors).toContain(path.color);
      expect(makeCard(p)).toEqual(card);
    }
  });

  it("reads the acceleration off the shortest strip with a lighter middle", () => {
    const p: FillCardParams = fillParams({ ...M, accel: 1000 }, 200, 20, colors(colorsNeeded("fill")));
    const lens = rampLengths(p);
    // A strip twice the run-up long: back to the acceleration it was drawn for.
    expect(accelFromStrip(p, (200 * 200 - 100) / 1000)).toBe(1000);
    expect(accelFromStrip(p, lens[0]!)).toBeGreaterThan(1000);
    expect(accelFromStrip(p, "all")).toBeGreaterThan(accelFromStrip(p, lens[0]!));
    expect(accelFromStrip(p, "none")).toBeLessThan(accelFromStrip(p, lens.at(-1)!));
  });

  it("places a card on free colours near the home corner and runs it alone", () => {
    const d = fillDoc([sq(100, 100, 10)]);
    const p = scanParams(200, 20, freeColors(d, colorsNeeded("scan")));
    expect(p.colors).not.toContain(F);
    const { doc: next, id } = placeCard(d, p, { ...M, origin: "top-right" });
    const obj = next.objects.find((o) => o.id === id)!;
    expect(obj.mat[4]).toBeGreaterThan(500);
    expect(cardsIn(next, "scan")).toHaveLength(1);
    const alone = onlyCard(next, p);
    expect(alone.layers.find((l) => l.color === F)?.output).toBe(false);
    expect(() => freeColors(d, 99)).toThrow();
  });
});

describe("tuning and project files", () => {
  const mat: MaterialPreset = { id: "m1", name: "Ply cut", machine: M.name, speed: 15, minPower: 60, maxPower: 60, passes: 1, material: "3 mm plywood", op: "cut", kerf: 0.15 };

  it("round-trips a tuning file and rejects bad ones", () => {
    const f = parseTune(serializeTune({ ...M, scanOffsets: [{ speed: 100, offset: 0.1 }] }, [mat]));
    expect(f.profile.scanOffsets).toEqual([{ speed: 100, offset: 0.1 }]);
    expect(f.materials).toEqual([mat]);
    expect(() => parseTune("{")).toThrow();
    expect(() => parseTune(JSON.stringify({ format: "laserproj" }))).toThrow();
    expect(() => parseTune(JSON.stringify({ format: "beamtune", version: 99 }))).toThrow();
    expect(() => parseTune(JSON.stringify({ format: "beamtune", version: 1, profile: { ...M, accel: -1 }, materials: [] }))).toThrow();
  });

  it("saves the materials a project uses and compares them on open", () => {
    const d = updateLayer(fillDoc([sq(0, 0, 10)]), F, { material: "m1" });
    const other: MaterialPreset = { ...mat, id: "m2", name: "Unused" };
    const file = parseProject(serializeProject(d, { startFrom: "absolute", innerFirst: true }, { driver: "ruida", model: null, profileName: M.name }, new Date(), [mat, other]));
    expect(file.materials?.map((m) => m.id)).toEqual(["m1"]);
    expect(compareMaterials([mat], [])).toEqual({ missing: [mat], differ: [] });
    expect(compareMaterials([mat], [{ ...mat, speed: 20 }]).differ).toHaveLength(1);
    expect(compareMaterials([mat], [{ ...mat }])).toEqual({ missing: [], differ: [] });
  });
});

describe("controller auto-match", () => {
  it("records the controller, switches to the profile that owns it, and asks when another machine shows up", async () => {
    const first = profile.value;
    const answer = async () => {
      for (let i = 0; i < 50 && !machinePrompt.value; i++) await Promise.resolve();
      const q = machinePrompt.value;
      machinePrompt.value = null;
      return q;
    };
    // A profile without a class is asked for one; answer it.
    const done = identifyController(111, 600, 400);
    const q1 = await answer();
    expect(q1?.kind).toBe("class");
    if (q1?.kind === "class") q1.resolve();
    await done;
    expect(profile.value.controller).toEqual({ cardId: 111, bedW: 600, bedH: 400 });

    const second = addMachine({ ...DEFAULT_PROFILE, name: "Second", class: "mid" });
    expect(profile.value.id).toBe(second.id);
    await identifyController(222, 900, 600);
    expect(profile.value.controller?.cardId).toBe(222);
    // The first controller again: switches back on its own (and asks the class again: "Later" was chosen).
    const back = identifyController(111, 600, 400);
    const q = await answer();
    if (q?.kind === "class") q.resolve();
    await back;
    expect(profile.value.id).toBe(first.id);
    // A controller no profile knows, on a bound profile: asks; "new" makes a profile (then asks its class).
    const n = machines.value.length;
    const other = identifyController(333, 1300, 900);
    const q2 = await answer();
    expect(q2?.kind).toBe("mismatch");
    if (q2?.kind === "mismatch") q2.resolve("new");
    const q3 = await answer();
    expect(q3?.kind).toBe("class");
    if (q3?.kind === "class") q3.resolve();
    await other;
    expect(machines.value.length).toBe(n + 1);
    expect(profile.value.controller?.cardId).toBe(333);
    expect(machines.value.find((m) => m.id === first.id)?.controller?.cardId).toBe(111);
  });
});
