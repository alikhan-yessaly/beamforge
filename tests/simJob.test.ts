import { describe, expect, it } from "vitest";
import { encodeJob } from "../src/protocol/jobEncode";
import { readMemory } from "../src/protocol/encode";
import { decodeInt35 } from "../src/protocol/numbers";
import { swizzle, unswizzle } from "../src/protocol/swizzle";
import { SimulatorTransport } from "../src/transport/simulator";
import { IDENTITY } from "../src/geom/geom";
import { buildRdFile } from "../src/job/build";
import { updateLayer } from "../src/job/layers";
import type { Doc, MachineProfile } from "../src/scene/model";

const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }];

function sim() {
  let t = 0;
  const s = new SimulatorTransport({ replyDelayMs: 0, now: () => t, startUm: { x: 10000, y: 10000 }, defaultSpeedUmS: 100000 });
  return { s, at: (ms: number) => (t = ms) };
}

describe("simulator runs jobs", () => {
  // 20 mm square at 10 mm/s at machine (50, 50) mm: travel ≈ 0.57 s, cut 8 s, return ≈ 0.57 s.
  const job = encodeJob({ mode: "absolute", layers: [{ speed: 10, minPower: 10, maxPower: 20, color: "#000000", paths: [square(50000, 50000, 20000)] }] });

  it("runs an absolute job sent in ~255-byte writes and returns to the start", async () => {
    const { s, at } = sim();
    await s.open();
    for (let i = 0; i < job.length; i += 255) await s.write(job.subarray(i, i + 255));
    expect(s.jobs).toHaveLength(1);
    expect(s.job).toBe("running");
    at(600 + 4000); // travel + half the cut (two sides)
    const p = s.position();
    expect(p.x).toBeCloseTo(70000, -3);
    expect(p.y).toBeGreaterThan(50000);
    at(20000);
    expect(s.job).toBe("done");
    expect(s.position()).toEqual({ x: 10000, y: 10000 });
  });

  it("pauses, resumes and stops at once; stop returns to the start", async () => {
    const { s, at } = sim();
    await s.open();
    await s.write(job);
    at(2000);
    await s.write(swizzle(Uint8Array.of(0xd8, 0x02)));
    const held = s.position();
    at(5000);
    expect(s.position()).toEqual(held);
    expect(s.job).toBe("paused");
    await s.write(swizzle(Uint8Array.of(0xd8, 0x03)));
    at(6000);
    expect(s.position()).not.toEqual(held);
    await s.write(swizzle(Uint8Array.of(0xd8, 0x01)));
    expect(s.job).toBe("stopped");
    at(60000);
    expect(s.position()).toEqual({ x: 10000, y: 10000 });
  });

  it("runs a current-position job relative to the head", async () => {
    const { s, at } = sim();
    await s.open();
    const rel = encodeJob({ mode: "current", layers: [{ speed: 10, minPower: 10, maxPower: 20, color: "#000000", paths: [square(0, 0, 20000)] }] });
    await s.write(rel);
    at(2000); // the job starts at the head, so 2 s at 10 mm/s is 20 mm along the first side
    expect(s.position()).toEqual({ x: 30000, y: 10000 });
  });

  it("runs an output layer at its offset from an output-off visible reference", async () => {
    const profile: MachineProfile = { name: "test", bedW: 600, bedH: 400, origin: "top-left", travelSpeed: 100, accel: 2000 };
    const doc: Doc = { layers: [], objects: [{ id: "o", name: "o", mat: IDENTITY, paths: [
      { color: "#ff0000", closed: false, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
      { color: "#0000ff", closed: false, points: [{ x: 20, y: 10 }, { x: 40, y: 10 }] },
    ] }] };
    const output = updateLayer(doc, "#ff0000", { output: false });
    const { s, at } = sim();
    await s.open();
    await s.write(buildRdFile(output, profile, { mode: "current", innerFirst: false }));
    expect(s.jobs[0]!.layers.map((l) => l.color)).toEqual(["#0000ff"]);
    at(100);
    expect(s.position().x).toBeLessThan(30000);
    expect(s.position().y).toBeLessThan(20000);
    at(300);
    expect(s.position().x).toBeCloseTo(30000 + (300 - Math.sqrt(50000)) * 20, 5);
    expect(s.position().y).toBe(20000);
  });

  it("reports job status in register 0x200 like the hardware", async () => {
    const { s, at } = sim();
    await s.open();
    const status = async () => {
      const got = new Promise<Uint8Array>((r) => {
        const off = s.onData((b) => (off(), r(unswizzle(b))));
      });
      await s.write(swizzle(readMemory(0x200)));
      return decodeInt35(await got, 4);
    };
    expect(await status()).toBe(0);
    await s.write(job);
    expect(await status()).toBe(0x10401);
    await s.write(swizzle(Uint8Array.of(0xd8, 0x02)));
    expect(await status()).toBe(0x10403);
    await s.write(swizzle(Uint8Array.of(0xd8, 0x03)));
    at(30000);
    expect(await status()).toBe(0x10600);
  });
});
