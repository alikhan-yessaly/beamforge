import { describe, expect, it } from "vitest";
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
