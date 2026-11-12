import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeJob } from "../src/protocol/jobDecode";
import { colorValue, encodeJob, encodeJobCommands, powerValue } from "../src/protocol/jobEncode";
import { parseRd } from "../src/protocol/rd";

const fixture = (f: string) => new Uint8Array(readFileSync(join(__dirname, "fixtures", f)));
const hex = (c: Uint8Array) => Array.from(c, (b) => b.toString(16).padStart(2, "0")).join(" ");

describe("encodeJob reproduces LightBurn's job files", () => {
  for (const f of ["lightburn-two-layer-absolute.rd", "lightburn-two-layer-current.rd", "lightburn-square-100-absolute.rd"]) {
    it(`${f}: decode → encode is byte-identical`, () => {
      const raw = fixture(f);
      const input = decodeJob(parseRd(raw).commands);
      const ours = encodeJobCommands(input).map(hex);
      const theirs = parseRd(raw).commands.map(hex);
      expect(ours).toEqual(theirs); // per-command diff on failure
      expect(Buffer.from(encodeJob(input)).equals(Buffer.from(raw))).toBe(true);
    });
  }

  it("decodes LightBurn's layer settings", () => {
    const job = decodeJob(parseRd(fixture("lightburn-two-layer-absolute.rd")).commands);
    expect(job.mode).toBe("absolute");
    expect(job.layers.map((l) => [l.speed, Math.round(l.minPower), Math.round(l.maxPower), l.color, l.paths.length])).toEqual([
      [20, 10, 15, "#000000", 1],
      [10, 12, 18, "#0000ff", 1],
    ]);
    // Two passes of the 64-segment circle continue one path: 1 move + 128 cuts.
    expect(job.layers[1]!.paths[0]).toHaveLength(129);
  });
});

describe("job encoder details", () => {
  const square = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y },
  ];

  it("power and colour encodings match LightBurn", () => {
    expect([10, 12, 15, 18].map(powerValue)).toEqual([1638, 1966, 2457, 2949]); // bytes 0C 66, 0F 2E, 13 19, 17 05
    expect(colorValue("#0000ff")).toBe(0xff0000);
    expect(colorValue("#ff0000")).toBe(0x0000ff);
  });

  it("uses relative cuts for short steps and absolute ones beyond ±8.191 mm", () => {
    const cmds = encodeJobCommands({
      mode: "absolute",
      layers: [{ speed: 10, minPower: 10, maxPower: 20, color: "#000000", paths: [square(1000, 1000, 5000), square(20000, 1000, 9000)] }],
    });
    const ops = cmds.map((c) => c[0]).filter((b) => b === 0x88 || b === 0xa8 || b === 0xa9);
    expect(ops).toEqual([0x88, 0xa9, 0xa9, 0xa9, 0xa9, 0x88, 0xa8, 0xa8, 0xa8, 0xa8]);
  });

  it("skips the move when a path starts where the head is, and writes the floor of the path length", () => {
    const p = square(0, 0, 10000);
    const cmds = encodeJobCommands({ mode: "current", layers: [{ speed: 10, minPower: 10, maxPower: 20, color: "#000000", paths: [p, p] }] });
    expect(cmds.filter((c) => c[0] === 0x88)).toHaveLength(1);
    const da = cmds.find((c) => c[0] === 0xda)!;
    expect(hex(da)).toBe("da 01 06 20 00 00 00 00 50 00 00 00 00 50"); // 80 mm
    expect(cmds.at(-1)![0]).toBe(0xd7);
  });

  it("refuses an empty job", () => {
    expect(() => encodeJobCommands({ mode: "absolute", layers: [] })).toThrow(/Nothing to cut/);
  });
});
