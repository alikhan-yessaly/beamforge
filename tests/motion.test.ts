import { describe, expect, it } from "vitest";
import { Motion, StoppedError, segmentLengthUm, segmentMove } from "../src/controller/motion";
import type { RuidaLink } from "../src/controller/link";
import type { MemoryReply } from "../src/protocol/decode";
import { jogKeyDown, jogKeyUp, motionPreamble, rapidMoveAbs } from "../src/protocol/encode";
import { decodeInt35 } from "../src/protocol/numbers";

const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

describe("motion encoders (captured from LightBurn 2.2.01)", () => {
  it("matches LightBurn's jog preamble at 100 mm/s", () => {
    expect(hx(motionPreamble(100))).toBe("c9 02 00 00 06 0d 20 c6 01 00 00 c6 21 00 00");
  });
  it("matches LightBurn's Move-to 200,200", () => {
    expect(hx(rapidMoveAbs(200000, 200000))).toBe("d9 10 00 00 00 0c 1a 40 00 00 0c 1a 40");
  });
  it("matches continuous-jog key codes", () => {
    expect(hx(jogKeyDown(0))).toBe("d9 d8 20");
    expect(hx(jogKeyUp(3))).toBe("d9 d8 33");
  });
});

describe("segmentMove", () => {
  it("splits into equal steps that end exactly on the target", () => {
    const pts = segmentMove({ x: 0, y: 0 }, { x: 10000, y: 0 }, 3000);
    expect(pts).toHaveLength(4);
    expect(pts.at(-1)).toEqual({ x: 10000, y: 0 });
    expect(pts[0]!.x).toBe(2500);
  });
  it("always yields at least one point", () => {
    expect(segmentMove({ x: 5, y: 5 }, { x: 5, y: 5 }, 1000)).toEqual([{ x: 5, y: 5 }]);
  });
  it("sizes segments for about a quarter second, at least 2 mm", () => {
    expect(segmentLengthUm(100)).toBe(25000);
    expect(segmentLengthUm(1)).toBe(2000);
  });
});

/** Fake controller: tracks the last absolute target and reports "moving" for one status read after each move. */
function fakeLink() {
  const sent: Uint8Array[] = [];
  const state = { x: 0, y: 0, movingReads: 0 };
  const link = {
    async send(b: Uint8Array) {
      sent.push(b);
      if (b[0] === 0xd9 && b[1] === 0x10 && b[2] === 0x00) {
        state.x = decodeInt35(b, 3);
        state.y = decodeInt35(b, 8);
        state.movingReads = 1;
      }
    },
    async query(q: Uint8Array): Promise<MemoryReply[]> {
      const addr = (q[2]! << 7) | q[3]!;
      let value = 0;
      if (addr === 0x221) value = state.x;
      if (addr === 0x231) value = state.y;
      if (addr === 0x026) value = 1300000;
      if (addr === 0x036) value = 900000;
      if (addr === 0x200) value = state.movingReads-- > 0 ? 0x1020000 : 0;
      return [{ addr, value, data: new Uint8Array(5) }];
    },
  };
  return { link: link as unknown as RuidaLink, sent, state };
}

describe("Motion", () => {
  it("moves in segments and clamps to the bed", async () => {
    const { link, sent, state } = fakeLink();
    const m = new Motion(link);
    await m.moveTo({ x: 2_000_000, y: 10_000 }, 100);
    expect(state).toMatchObject({ x: 1300000, y: 10000 });
    const segments = sent.filter((b) => b[0] === 0xd9 && b[1] === 0x10);
    expect(segments.length).toBe(Math.ceil(Math.hypot(1300000, 10000) / 25000));
  });

  it("stop() cancels the remaining segments and releases all keys", async () => {
    const { link, sent } = fakeLink();
    const m = new Motion(link);
    const run = m.moveTo({ x: 1_000_000, y: 0 }, 100, () => {
      if (sent.filter((b) => b[0] === 0xd9 && b[1] === 0x10).length === 3) void m.stop();
    });
    await expect(run).rejects.toBeInstanceOf(StoppedError);
    const segments = sent.filter((b) => b[0] === 0xd9 && b[1] === 0x10);
    expect(segments.length).toBe(3);
    const all = sent.map(hx).join(" | ");
    expect(all).toContain("d9 d8 30 d9 d8 31 d9 d8 32 d9 d8 33");
    expect(all).toContain("d8 01");
  });

  it("jog press sends speed then key-down; release sends key-up", async () => {
    const { link, sent } = fakeLink();
    const m = new Motion(link);
    await m.jogPress(2, 10);
    await m.jogRelease();
    await m.jogRelease(); // second release is a no-op
    expect(sent.map(hx)).toEqual([hx(new Uint8Array([...motionPreamble(10), 0xd9, 0xd8, 0x22])), "d9 d8 32"]);
  });
});
