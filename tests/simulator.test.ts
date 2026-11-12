import { describe, expect, it } from "vitest";
import { RuidaLink } from "../src/controller/link";
import { Motion, StoppedError } from "../src/controller/motion";
import { jogKeyDown, jogKeyUp, motionPreamble, rapidMoveAbs, rapidMoveRel, stopJob } from "../src/protocol/encode";
import { SIM_CARD_ID, SimulatorTransport } from "../src/transport/simulator";
import { TrafficLog } from "../src/transport/trafficLog";
import { swizzle } from "../src/protocol/swizzle";

function clock() {
  let t = 0;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

async function verifiedLink(sim: SimulatorTransport) {
  const link = new RuidaLink(sim, new TrafficLog());
  await link.connect();
  expect(await link.verify()).toBe(SIM_CARD_ID);
  return link;
}

describe("SimulatorTransport", () => {
  it("answers reads like the RDC644XS", async () => {
    const link = await verifiedLink(new SimulatorTransport({ replyDelayMs: 0 }));
    const m = new Motion(link);
    expect(await m.bedSize()).toEqual({ x: 1300000, y: 900000 });
    expect(await m.position()).toEqual({ x: 100000, y: 100000 });
    expect(await m.isMoving()).toBe(false);
  });

  it("does not answer a query swizzled with the wrong magic", async () => {
    const link = new RuidaLink(new SimulatorTransport({ replyDelayMs: 0 }), new TrafficLog());
    link.setMagic(0x11);
    await link.connect();
    expect(await link.verify()).toBeNull();
  }, 3000);

  it("runs absolute and relative rapid moves at the commanded speed, queued", async () => {
    const c = clock();
    const sim = new SimulatorTransport({ replyDelayMs: 0, now: c.now, startUm: { x: 0, y: 0 } });
    await sim.open();
    const send = (b: Uint8Array) => sim.write(swizzle(b, 0x88));
    await send(motionPreamble(10)); // 10 mm/s
    await send(rapidMoveAbs(20000, 0)); // 2 s
    await send(rapidMoveRel(0, 10000)); // 1 s, relative to the end of the first move
    c.tick(1000);
    expect(sim.position()).toEqual({ x: 10000, y: 0 });
    expect(sim.moving).toBe(true);
    c.tick(1500);
    expect(sim.position()).toEqual({ x: 20000, y: 5000 });
    c.tick(1000);
    expect(sim.position()).toEqual({ x: 20000, y: 10000 });
    expect(sim.moving).toBe(false);
  });

  it("ignores D8 01 during a rapid move, like the hardware", async () => {
    const c = clock();
    const sim = new SimulatorTransport({ replyDelayMs: 0, now: c.now, startUm: { x: 0, y: 0 } });
    await sim.open();
    const send = (b: Uint8Array) => sim.write(swizzle(b, 0x88));
    await send(motionPreamble(10));
    await send(rapidMoveAbs(30000, 0));
    c.tick(1000);
    await send(stopJob());
    await send(jogKeyUp(0));
    c.tick(5000);
    expect(sim.position().x).toBe(30000);
  });

  it("jogs while a key is held and stops on key-up; clamps to the bed", async () => {
    const c = clock();
    const sim = new SimulatorTransport({ replyDelayMs: 0, now: c.now, startUm: { x: 0, y: 0 } });
    await sim.open();
    const send = (b: Uint8Array) => sim.write(swizzle(b, 0x88));
    await send(new Uint8Array([...motionPreamble(10), ...jogKeyDown(0)])); // left = +X
    c.tick(1000);
    await send(jogKeyUp(0));
    c.tick(1000);
    expect(sim.position()).toEqual({ x: 10000, y: 0 });
    await send(jogKeyDown(2)); // up = -Y, already at 0
    c.tick(1000);
    await send(jogKeyUp(2));
    expect(sim.position()).toEqual({ x: 10000, y: 0 });
  });
});

describe("Motion against the simulator", () => {
  it("segmented move reaches the target; STOP halts within one segment", async () => {
    const sim = new SimulatorTransport({ replyDelayMs: 1, startUm: { x: 0, y: 0 } });
    const link = await verifiedLink(sim);
    const m = new Motion(link);
    await m.moveTo({ x: 20000, y: 0 }, 200); // 50 mm segments → one segment, 0.1 s
    expect(await m.position()).toEqual({ x: 20000, y: 0 });

    const run = m.moveTo({ x: 1000000, y: 0 }, 100); // 25 mm segments of 0.25 s
    await new Promise((r) => setTimeout(r, 400));
    await m.stop();
    await expect(run).rejects.toBeInstanceOf(StoppedError);
    await new Promise((r) => setTimeout(r, 400));
    const x = (await m.position()).x;
    expect(x).toBeGreaterThan(20000);
    expect(x).toBeLessThanOrEqual(20000 + 3 * 25000);
    expect(await m.isMoving()).toBe(false);
  }, 10000);
});
