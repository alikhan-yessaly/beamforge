import { describe, expect, it } from "vitest";
import { frameJob } from "../src/controller/frame";
import { inspectJob } from "../src/controller/jobRunner";
import { RuidaLink } from "../src/controller/link";
import { Motion } from "../src/controller/motion";
import { splitCommands } from "../src/protocol/chunk";
import { frameCommands, rapidMoveAbs } from "../src/protocol/encode";
import { encodeJobCommands } from "../src/protocol/jobEncode";
import { unswizzle } from "../src/protocol/swizzle";
import { SimulatorTransport } from "../src/transport/simulator";
import { TrafficLog } from "../src/transport/trafficLog";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

describe("frameCommands", () => {
  it("is byte for byte LightBurn's frame of a 72 mm square at 10 mm/s (captures/lightburn-2026-11-11.log)", () => {
    const lightburn = [
      "c9 02 00 00 00 00 00", "c6 01 00 00", "c6 02 00 00", "c6 21 00 00", "c6 22 00 00",
      "d9 10 00 00 00 17 5f 08 00 00 15 07 28",
      "c9 02 00 00 00 4e 10",
      "d9 10 00 00 00 17 5f 08 00 00 19 39 68",
      "d9 10 00 00 00 1c 11 48 00 00 19 39 68",
      "d9 10 00 00 00 1c 11 48 00 00 15 07 28",
      "d9 10 00 00 00 17 5f 08 00 00 15 07 28",
      "c9 02 00 00 00 00 00",
      "d9 10 00 00 00 05 6b 62 00 00 05 6c 53",
    ].join(" ");
    const ours = frameCommands({ x: 389000, y: 345000 }, { x: 461000, y: 417000 }, 10, { x: 95714, y: 95827 });
    expect(hex(ours)).toBe(lightburn);
  });
});

describe("Motion.frame on the simulator", () => {
  async function setup() {
    const sim = new SimulatorTransport({ replyDelayMs: 1, startUm: { x: 10000, y: 10000 }, defaultSpeedUmS: 300000 });
    const link = new RuidaLink(sim, new TrafficLog());
    await link.connect();
    await link.verify();
    const writes: Uint8Array[][] = [];
    const orig = sim.write.bind(sim);
    sim.write = async (w) => {
      const cmds = splitCommands(unswizzle(w));
      if (!(cmds[0]?.[0] === 0xda && cmds[0][1] === 0x00)) writes.push(cmds);
      return orig(w);
    };
    return { sim, motion: new Motion(link), writes };
  }

  it("sends the whole frame in one write, waits until idle, and ends back at the start", async () => {
    const { sim, motion, writes } = await setup();
    const seen: { x: number; y: number }[] = [];
    await motion.frame({ x: 20000, y: 20000 }, { x: 30000, y: 25000 }, 100, (p) => seen.push(p));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.filter((c) => c[0] === 0xd9)).toHaveLength(6);
    expect(sim.position()).toEqual({ x: 10000, y: 10000 });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("frames a current-position job around the head, and refuses frames off the bed", async () => {
    const { sim, motion, writes } = await setup();
    const job = encodeJobCommands({ mode: "current", layers: [{ speed: 10, minPower: 10, maxPower: 15, color: "#000000", paths: [[{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }]] }] });
    await frameJob(motion, inspectJob(job), 100);
    const moves = writes[0]!.filter((c) => c[0] === 0xd9);
    // The job's corner sits at the head (10, 10 mm), so the frame's far corner is at 15, 15 mm.
    expect(hex(moves[0]!)).toBe(hex(rapidMoveAbs(10000, 10000)));
    expect(hex(moves[2]!)).toBe(hex(rapidMoveAbs(15000, 15000)));
    expect(sim.position()).toEqual({ x: 10000, y: 10000 });
    await expect(motion.frame({ x: 1290000, y: 0 }, { x: 1310000, y: 10000 }, 100)).rejects.toThrow(/outside the bed/);
  });
});
