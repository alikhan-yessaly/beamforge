import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeInt14, decodeInt35 } from "../src/protocol/numbers";
import { checksumCommand, parseRd, rdChecksum } from "../src/protocol/rd";
import { swizzle } from "../src/protocol/swizzle";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

// Subset of EduTech "Example 1, Simple Rect" (swizzled with the default magic).
const RECT = [
  "d810", "f0", "e601", "f10200", "d800",
  "e70300000b5112" + "0000021258",
  "e707000011164c" + "0000064e02",
  "ca2200",
  "8800001116500000021256",
  "a800000b51120000021256",
  "da01062000000002470000000247",
  "d7",
].join("");

describe("parseRd (synthetic)", () => {
  const raw = swizzle(hex(RECT), 0x88);

  it("detects the magic, bounds and layers", () => {
    const job = parseRd(raw);
    expect(job.magic).toBe(0x88);
    expect(job.bbox).toEqual({ x0: 190610, y0: 35160, x1: 281420, y1: 108290 });
    expect(job.layerCount).toBe(1);
    expect(job.hasForbiddenWrite).toBe(false);
    expect(job.commands.at(-1)![0]).toBe(0xd7);
  });

  it("rejects a stream that does not end in D7", () => {
    expect(() => parseRd(raw.subarray(0, raw.length - 3), 0x88)).toThrow(/End-of-File/);
  });
});

describe("golden .rd fixtures", () => {
  const dir = join(__dirname, "fixtures");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".rd")) : [];

  if (files.length === 0) it.skip("no fixtures in tests/fixtures/*.rd yet", () => {});

  for (const f of files) {
    it(`${f}: parses, re-swizzles to identical bytes, no stray memory writes`, () => {
      const raw = new Uint8Array(readFileSync(join(dir, f)));
      const job = parseRd(raw);
      const rebuilt = swizzle(Uint8Array.from(job.commands.flatMap((c) => Array.from(c))), job.magic);
      expect(Buffer.from(rebuilt).equals(Buffer.from(raw))).toBe(true);
      expect(job.bbox).not.toBeNull();
      expect(job.hasForbiddenWrite).toBe(false);
    });
  }
});

describe("LightBurn job captures (2026-11-11)", () => {
  const load = (f: string) => parseRd(new Uint8Array(readFileSync(join(__dirname, "fixtures", f))));
  const find = (cmds: Uint8Array[], a: number, b?: number) =>
    cmds.filter((c) => c[0] === a && (b === undefined || c[1] === b));
  const files = [
    "lightburn-two-layer-absolute.rd",
    "lightburn-two-layer-current.rd",
    "lightburn-square-100-absolute.rd",
  ];

  for (const f of files) {
    it(`${f}: E5 05 checksum is the byte sum of everything else`, () => {
      const job = load(f);
      const ck = find(job.commands, 0xe5, 0x05)[0]!;
      expect(Array.from(ck)).toEqual(Array.from(checksumCommand(rdChecksum(job.commands))));
      expect(job.commands.at(-2)).toBe(ck);
    });
  }

  it("absolute jobs start D8 10 E6 01, current-position jobs D8 12", () => {
    const abs = load("lightburn-two-layer-absolute.rd").commands;
    const cur = load("lightburn-two-layer-current.rd").commands;
    expect(abs.slice(0, 3).map((c) => Array.from(c))).toEqual([[0xd8, 0x10], [0xe6, 0x01], [0xf0]]);
    expect(cur.slice(0, 2).map((c) => Array.from(c))).toEqual([[0xd8, 0x12], [0xf0]]);
    // Current position: coordinates are relative to the job origin, so the bounds start at 0,0.
    expect(load("lightburn-two-layer-current.rd").bbox).toEqual({ x0: 0, y0: 0, x1: 45000, y1: 20000 });
    expect(load("lightburn-two-layer-absolute.rd").bbox).toEqual({ x0: 390000, y0: 390000, x1: 435000, y1: 410000 });
  });

  it("layer settings: speed in µm/s, power as 14-bit fraction of 100 %", () => {
    const cmds = load("lightburn-two-layer-absolute.rd").commands;
    const speeds = find(cmds, 0xc9, 0x02).map((c) => decodeInt35(c, 2));
    expect(speeds).toEqual([20000, 10000]);
    const pct = (c: Uint8Array) => Math.round((decodeInt14(c, 2) / 0x3fff) * 1000) / 10;
    expect(find(cmds, 0xc6, 0x01).map(pct)).toEqual([10, 12]);
    expect(find(cmds, 0xc6, 0x02).map(pct)).toEqual([15, 18]);
  });

  it("passes are emitted as repeated geometry", () => {
    const cuts = find(load("lightburn-two-layer-absolute.rd").commands, 0xa9);
    expect(cuts).toHaveLength(128); // the Ø10 circle, 64 segments, 2 passes
    expect(cuts.slice(0, 64).map((c) => Array.from(c))).toEqual(cuts.slice(64).map((c) => Array.from(c)));
  });
});
