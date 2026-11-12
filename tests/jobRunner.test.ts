import { describe, expect, it } from "vitest";
import { frameJob } from "../src/controller/frame";
import { type JobPhase, JobRunner, inspectJob, placeJob } from "../src/controller/jobRunner";
import { RuidaLink } from "../src/controller/link";
import { Motion } from "../src/controller/motion";
import { splitCommands } from "../src/protocol/chunk";
import { encodeJobCommands, type RdJobInput } from "../src/protocol/jobEncode";
import { unswizzle } from "../src/protocol/swizzle";
import { SimulatorTransport } from "../src/transport/simulator";
import { TrafficLog } from "../src/transport/trafficLog";
import { relativeHeadOnDrawing } from "../src/workspace/placement";

const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }];
const jobOf = (mode: RdJobInput["mode"], path: { x: number; y: number }[], speed = 100) =>
  encodeJobCommands({ mode, layers: [{ speed, minPower: 10, maxPower: 15, color: "#000000", paths: [path] }] });

async function setup() {
  const sim = new SimulatorTransport({ replyDelayMs: 1, startUm: { x: 10000, y: 10000 }, defaultSpeedUmS: 300000 });
  const link = new RuidaLink(sim, new TrafficLog());
  await link.connect();
  expect(await link.verify()).not.toBeNull();
  return { sim, link, runner: new JobRunner(link, { pollMs: 20, startTimeoutMs: 1000 }) };
}

describe("inspectJob / placeJob", () => {
  it("reads mode and bounds; places current-position jobs at the head", () => {
    const b = inspectJob(jobOf("current", square(0, 0, 5000)));
    expect(b).toEqual({ mode: "current", min: { x: 0, y: 0 }, max: { x: 5000, y: 5000 } });
    expect(placeJob(b, { x: 100, y: 200 })).toEqual({ min: { x: 100, y: 200 }, max: { x: 5100, y: 5200 } });
  });
  it("refuses streams that are not jobs", () => {
    expect(() => inspectJob([Uint8Array.of(0xd8, 0x00), Uint8Array.of(0xd7)])).toThrow(/Not a job/);
  });
});

describe("JobRunner on the simulator", () => {
  it("sends in ≤255-byte writes, follows the job to the end", async () => {
    const { sim, link, runner } = await setup();
    const writes: number[] = [];
    const orig = sim.write.bind(sim);
    sim.write = async (w) => {
      if (splitCommands(unswizzle(w))[0]?.[1] !== 0x00) writes.push(w.length);
      return orig(w);
    };
    const phases: JobPhase[] = [];
    const end = await runner.run(jobOf("absolute", square(20000, 20000, 4000)), (p) => phases.push(p.phase));
    expect(end).toBe("done");
    expect(sim.jobs).toHaveLength(1);
    expect(Math.max(...writes)).toBeLessThanOrEqual(255);
    expect(phases[0]).toBe("checking");
    expect(phases).toContain("running");
    expect(phases.at(-1)).toBe("done");
    await link.disconnect();
  });

  it("pause holds the head, resume continues, stop ends the job", async () => {
    const { sim, runner } = await setup();
    const done = runner.run(jobOf("absolute", square(20000, 20000, 20000), 20)); // 4 s of cutting
    await until(() => runner.phase === "running");
    await runner.pause();
    await until(() => runner.phase === "paused");
    const held = sim.position();
    await sleep(150);
    expect(sim.position()).toEqual(held);
    await runner.resume();
    await until(() => runner.phase === "running");
    await runner.stop();
    expect(await done).toBe("stopped");
  });

  it("projects simulator current-position progress using the captured job start", async () => {
    const { link, runner } = await setup();
    const positions: { x: number; y: number }[] = [];
    let start: { x: number; y: number } | null = null;
    await runner.run(jobOf("current", square(0, 0, 4000)), (p) => {
      if (p.phase === "sending") start = p.pos;
      if (p.pos && start) positions.push(relativeHeadOnDrawing(p.pos, start, { x: 460000, y: 350000 }));
    });
    expect(start).toEqual({ x: 10000, y: 10000 });
    expect(positions[0]).toEqual({ x: 460000, y: 350000 });
    expect(positions.some((p) => p.x > 460000 || p.y > 350000)).toBe(true);
    expect(positions.at(-1)).toEqual({ x: 460000, y: 350000 });
    await link.disconnect();
  });

  it("refuses jobs off the bed and when the machine is busy", async () => {
    const { runner } = await setup();
    await expect(runner.run(jobOf("absolute", square(1299000, 10000, 5000)))).rejects.toThrow(/outside the bed/);
    // Current-position job of 1.2 m starting at the head (10 mm from home): too big for the 900 mm Y travel.
    await expect(runner.run(jobOf("current", square(0, 0, 1200000)))).rejects.toThrow(/outside the bed/);
    expect(runner.phase).toBe("failed");
  });

  it("rejects a relative frame outside the real machine bed before moving", async () => {
    const { sim, link } = await setup();
    const motion = new Motion(link);
    const start = sim.position();
    await expect(frameJob(motion, inspectJob(jobOf("current", square(0, 0, 1200000))), 100)).rejects.toThrow(/outside the bed/);
    expect(sim.position()).toEqual(start);
    await link.disconnect();
  });

  it("frames a job and returns to the start", async () => {
    const { sim, link } = await setup();
    const motion = new Motion(link);
    const visited: { x: number; y: number }[] = [];
    const starts: { x: number; y: number }[] = [];
    await frameJob(motion, inspectJob(jobOf("absolute", square(20000, 20000, 5000))), 300, (p) => visited.push(p), (p) => starts.push(p));
    expect(starts).toEqual([{ x: 10000, y: 10000 }]);
    expect(visited.length).toBeGreaterThan(0); // sampled positions; corners are checked in frame.test.ts
    expect(sim.position()).toEqual({ x: 10000, y: 10000 });
    expect(sim.jobs).toHaveLength(0); // laser off: no job was sent
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3000) {
  const t = performance.now();
  while (!f()) {
    if (performance.now() - t > ms) throw new Error("timeout");
    await sleep(5);
  }
}

describe("JobRunner resilience", () => {
  it("keeps watching through missed replies, and reports lost contact only after a while", async () => {
    const sim = new SimulatorTransport({ replyDelayMs: 1, startUm: { x: 10000, y: 10000 }, defaultSpeedUmS: 300000 });
    const link = new RuidaLink(sim, new TrafficLog());
    await link.connect();
    await link.verify();
    // Drop every reply while `deaf` is set.
    let deaf = false;
    const orig = sim.onData.bind(sim);
    sim.onData = (cb) => orig((b) => !deaf && cb(b));
    // The link subscribes to onData when it connects, so reconnect to pick up the filter.
    await link.disconnect();
    await link.connect();
    await link.verify();
    const runner = new JobRunner(link, { pollMs: 20, startTimeoutMs: 1000, lostAfterMs: 2500 });
    const done = runner.run(jobOf("absolute", square(20000, 20000, 20000), 20));
    await until(() => runner.phase === "running");
    deaf = true;
    await sleep(1000); // ~1 s of silence: still watching
    expect(runner.phase).toBe("running");
    deaf = false;
    await runner.stop();
    expect(await done).toBe("stopped");

    const again = runner.run(jobOf("absolute", square(20000, 20000, 20000), 20));
    await until(() => runner.phase === "running");
    deaf = true;
    await expect(again).rejects.toThrow(/Lost contact/);
  }, 15000);
});
