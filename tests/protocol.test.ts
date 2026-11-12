import { describe, expect, it } from "vitest";
import { chunkCommands, splitCommands } from "../src/protocol/chunk";
import { decodeReplies } from "../src/protocol/decode";
import {
  hasForbiddenParamWrite,
  moveAbs,
  moveRel,
  pauseJob,
  queryCardId,
  queryStatus,
  readMemory,
  resumeJob,
  startJob,
  stopJob,
} from "../src/protocol/encode";
import { decodeInt14, decodeInt35, encodeInt14, encodeInt35 } from "../src/protocol/numbers";
import { sum16 } from "../src/protocol/checksum";
import { KNOWN_MAGICS, swizzle, swizzleByte, unswizzle, unswizzleByte } from "../src/protocol/swizzle";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("swizzle", () => {
  it("matches the known vector", () => {
    expect(swizzleByte(0xcc, 0x88)).toBe(0xc6);
    expect(unswizzleByte(0xc6, 0x88)).toBe(0xcc);
  });

  it("round-trips every byte for every known magic", () => {
    for (const magic of KNOWN_MAGICS) {
      for (let b = 0; b < 256; b++) expect(unswizzleByte(swizzleByte(b, magic), magic)).toBe(b);
    }
  });

  it("is a bijection per magic", () => {
    const seen = new Set(Array.from({ length: 256 }, (_, b) => swizzleByte(b, 0x11)));
    expect(seen.size).toBe(256);
  });

  it("matches the UDP capture in the ruida-pa README (DA 00 05 7E)", () => {
    // Capture: 0261 d4890df7, checksum over swizzled payload.
    const payload = swizzle(hex("da00057e"), 0x88);
    expect(toHex(payload)).toBe("d4890df7");
    expect(sum16(payload)).toBe(0x0261);
    expect(toHex(unswizzle(payload, 0x88))).toBe("da00057e");
  });
});

describe("numbers", () => {
  it("encodes int35 as five 7-bit bytes", () => {
    expect(toHex(encodeInt35(190610))).toBe("00000b5112");
    expect(toHex(encodeInt35(0))).toBe("0000000000");
  });

  it("round-trips int35 including negatives", () => {
    for (const v of [0, 1, 127, 128, 190610, 1_000_000, -1, -5000, 2 ** 31 - 1, -(2 ** 31)]) {
      const e = encodeInt35(v);
      expect(e.every((b) => b < 0x80)).toBe(true);
      expect(decodeInt35(e)).toBe(v);
    }
  });

  it("round-trips int14 including negatives", () => {
    for (const v of [0, 1, 127, 128, 8191, -1, -8192]) {
      const e = encodeInt14(v);
      expect(e.every((b) => b < 0x80)).toBe(true);
      expect(decodeInt14(e)).toBe(v);
    }
  });
});

describe("encoders", () => {
  it("builds read-only queries", () => {
    expect(toHex(queryCardId())).toBe("da00057e");
    expect(toHex(queryStatus())).toBe("da000400");
    expect(toHex(readMemory(0x2fe))).toBe("da00057e");
  });

  it("builds job control commands", () => {
    expect([startJob(), stopJob(), pauseJob(), resumeJob()].map(toHex)).toEqual(["d800", "d801", "d802", "d803"]);
  });

  it("builds moves matching the EduTech example", () => {
    expect(toHex(moveAbs(190610, 35160))).toBe("88" + "00000b5112" + "0000021258");
    expect(toHex(moveRel(-1, 5))).toBe("89" + "7f7f" + "0005");
  });

  it("flags memory writes outside the document-time range", () => {
    const docTime = hex("da0106200000000247");
    const setting = hex("da0100130000000001");
    expect(hasForbiddenParamWrite([docTime])).toBe(false);
    expect(hasForbiddenParamWrite([docTime, setting])).toBe(true);
    expect(hasForbiddenParamWrite([queryCardId()])).toBe(false);
  });
});

describe("decodeReplies", () => {
  it("decodes a Card ID reply", () => {
    const { replies, rest } = decodeReplies(hex("da01057e0000012345"));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.addr).toBe(0x2fe);
    expect(replies[0]!.value).toBe(1 * 16384 + 0x23 * 128 + 0x45);
    expect(rest).toHaveLength(0);
  });

  it("splits back-to-back replies and keeps unknown bytes", () => {
    const { replies, rest } = decodeReplies(hex("da010400" + "0000000000" + "da01057e" + "0000000001" + "cc"));
    expect(replies.map((r) => r.addr)).toEqual([0x200, 0x2fe]);
    expect(toHex(rest)).toBe("cc");
  });

  it("ignores a truncated reply", () => {
    expect(decodeReplies(hex("da01057e00")).replies).toHaveLength(0);
  });
});

describe("chunking", () => {
  it("splits commands at high-bit bytes", () => {
    const cmds = splitCommands(hex("e60100" + "d810" + "f0"));
    expect(cmds.map(toHex)).toEqual(["e60100", "d810", "f0"]);
  });

  it("never splits inside a command and respects the max size", () => {
    const cmds = splitCommands(hex("88" + "00".repeat(10) + "a8" + "01".repeat(10) + "d7"));
    const chunks = chunkCommands(cmds, 12);
    expect(chunks.map((c) => c.length)).toEqual([11, 12]);
    expect(toHex(Uint8Array.from(chunks.flatMap((c) => Array.from(c))))).toBe(toHex(Uint8Array.from(cmds.flatMap((c) => Array.from(c)))));
  });

  it("puts an oversized command in its own chunk", () => {
    const chunks = chunkCommands([hex("e7" + "00".repeat(20)), hex("d7")], 8);
    expect(chunks.map((c) => c.length)).toEqual([21, 1]);
  });
});

import { cardCode, magicForCardId } from "../src/protocol/cards";

describe("card ID", () => {
  it("uses the repeated 16-bit code from a 32-bit reply (seen on hardware: 0x65106510)", () => {
    expect(cardCode(0x65106510)).toBe(0x6510);
    expect(cardCode(0x6320)).toBe(0x6320);
    expect(magicForCardId(0x63206320)).toBe(0x11);
    expect(magicForCardId(0x65106510)).toBe(0x88);
  });
});
