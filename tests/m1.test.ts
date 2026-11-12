import { describe, expect, it } from "vitest";
import { buildJog } from "../src/controller/jog";
import { countReplies, planStress, runStressTest } from "../src/controller/stress";
import { splitCommands } from "../src/protocol/chunk";
import {
  ADDR_POSITION_X,
  ADDR_POSITION_Y,
  addrFromBytes,
  addrToHex,
  moveRel,
  queryStatus,
  rapidMoveXY,
  readMemory,
  setSpeed,
} from "../src/protocol/encode";
import { TrafficLog } from "../src/transport/trafficLog";
import { portFilters } from "../src/transport/webSerial";
import { parseHex, toHex } from "../src/ui/hex";

const hx = (b: Uint8Array) => toHex(b).replace(/ /g, "").toLowerCase();

describe("M1 encoders", () => {
  it("position addresses map to wire bytes 04 21 / 04 31", () => {
    expect(hx(readMemory(ADDR_POSITION_X))).toBe("da000421");
    expect(hx(readMemory(ADDR_POSITION_Y))).toBe("da000431");
    expect(addrToHex(ADDR_POSITION_X)).toBe("04 21");
    expect(addrFromBytes(0x05, 0x7e)).toBe(0x2fe);
  });

  it("rapid move and speed", () => {
    expect(hx(rapidMoveXY(0x02, 1000, -1))).toBe("d91002" + "00000007" + "68" + "7f7f7f7f7f");
    expect(hx(setSpeed(100))).toBe("c902" + "0000060d20");
  });

  it("moveRel rejects values that do not fit 14 bits", () => {
    expect(() => moveRel(8192, 0)).toThrow(RangeError);
    expect(() => moveRel(0, -8192)).toThrow(RangeError);
    expect(hx(moveRel(8191, -8191))).toBe("89" + "3f7f" + "4001");
  });
});

describe("buildJog", () => {
  it("relative: splits long steps into several 89 moves that add up", () => {
    const { bytes } = buildJog({ mode: "rel89", dxMm: 20, dyMm: -5 });
    const cmds = splitCommands(bytes);
    expect(cmds).toHaveLength(3);
    const dec = (hi: number, lo: number) => { const u = (hi << 7) | lo; return u >= 8192 ? u - 16384 : u; };
    const sum = cmds.reduce((a, c) => [a[0]! + dec(c[1]!, c[2]!), a[1]! + dec(c[3]!, c[4]!)], [0, 0]);
    expect(sum).toEqual([20000, -5000]);
  });

  it("absolute: needs a position and adds the step", () => {
    expect(() => buildJog({ mode: "abs88", dxMm: 1, dyMm: 0 })).toThrow(/position/);
    const j = buildJog({ mode: "abs88", dxMm: 1, dyMm: -2, fromUm: { x: 5000, y: 5000 } });
    expect(j.targetUm).toEqual({ x: 6000, y: 3000 });
    expect(j.bytes[0]).toBe(0x88);
  });

  it("rapid relative jog sends the step, not a target (verified on hardware)", () => {
    const d9 = buildJog({ mode: "rapidRel", dxMm: 0, dyMm: -1, fromUm: { x: 77494, y: 115664 } });
    expect(hx(d9.bytes)).toBe("d91002" + "0000000000" + "7f7f7f7818");
    expect(d9.targetUm).toBeUndefined();
  });

  it("prefixes speed and enforces limits", () => {
    const j = buildJog({ mode: "rel89", dxMm: 1, dyMm: 0, speedMmS: 10 });
    expect(j.bytes[0]).toBe(0xc9);
    expect(j.bytes[7]).toBe(0x89);
    expect(() => buildJog({ mode: "rel89", dxMm: 101, dyMm: 0 })).toThrow(/limited/);
    expect(() => buildJog({ mode: "rel89", dxMm: 1, dyMm: 0, speedMmS: 0 })).toThrow(/Speed/);
  });
});

describe("stress test", () => {
  it("plans chunks at command boundaries", () => {
    const chunks = planStress(queryStatus(), 10, 9);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length === 8)).toBe(true);
    expect(() => planStress(queryStatus(), 0, 9)).toThrow();
  });

  it("times writes, counts replies and honours abort", async () => {
    const log = new TrafficLog();
    let clock = 0;
    const sent: Uint8Array[] = [];
    const link = {
      log,
      async send(plain: Uint8Array) {
        sent.push(plain);
        clock += sent.length === 2 ? 80 : 1; // second write "blocks"
        const n = splitCommands(plain).length;
        const reply = new Uint8Array(n * 9);
        for (let i = 0; i < n; i++) reply.set([0xda, 0x01, 0x04, 0x00, 0, 0, 0, 0, 0], i * 9);
        log.add({ dir: "RX", plain: reply });
      },
    };
    const r = await runStressTest(link, {
      payload: queryStatus(),
      repeat: 6,
      chunkSize: 8,
      delayMs: 5,
      now: () => clock,
      sleep: async () => {},
    });
    expect(r.chunks).toBe(3);
    expect(r.chunksSent).toBe(3);
    expect(r.bytesSent).toBe(24);
    expect(r.slowWrites).toBe(1);
    expect(r.writeMsMax).toBe(80);
    expect(r.expectedReplies).toBe(6);
    expect(r.repliesSeen).toBe(6);

    const ac = new AbortController();
    ac.abort();
    const r2 = await runStressTest(link, { payload: queryStatus(), repeat: 2, chunkSize: 4, delayMs: 0, signal: ac.signal, sleep: async () => {} });
    expect(r2.chunksSent).toBe(0);
    expect(r2.aborted).toBe(true);
  });

  it("reports a send error instead of throwing", async () => {
    const link = { log: new TrafficLog(), send: async () => { throw new Error("Not verified"); } };
    const r = await runStressTest(link, { payload: Uint8Array.of(0xd8, 0x00), repeat: 1, chunkSize: 4, delayMs: 0, sleep: async () => {} });
    expect(r.error).toMatch(/Not verified/);
  });

  it("countReplies", () => {
    expect(countReplies([0xda, 0x01, 1, 0xda, 0x01, 0xda])).toBe(2);
  });
});

describe("helpers", () => {
  it("parseHex", () => {
    expect(Array.from(parseHex("DA 00, 0x04 00"))).toEqual([0xda, 0, 4, 0]);
    expect(() => parseHex("DA 0")).toThrow();
  });

  it("port filters", () => {
    expect(portFilters("all")).toEqual([]);
    expect(portFilters("ftdi")).toEqual([{ usbVendorId: 0x0403 }]);
    expect(portFilters("ft245r")).toEqual([{ usbVendorId: 0x0403, usbProductId: 0x6001 }]);
  });
});
