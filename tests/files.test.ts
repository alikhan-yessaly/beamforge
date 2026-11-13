import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deleteFileOnController, listFiles, saveJobToController } from "../src/controller/files";
import { RuidaLink } from "../src/controller/link";
import { splitCommands } from "../src/protocol/chunk";
import { deleteFiles, normalizeFileName, parseFileNameReply, readFileName, storeJobHeader } from "../src/protocol/encode";
import { encodeJobCommands } from "../src/protocol/jobEncode";
import { DEFAULT_MAGIC, unswizzle } from "../src/protocol/swizzle";
import { SimulatorTransport } from "../src/transport/simulator";
import { TrafficLog } from "../src/transport/trafficLog";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }, { x, y }];
const job = () => encodeJobCommands({ mode: "absolute", layers: [{ speed: 10, minPower: 10, maxPower: 20, color: "#000000", paths: [square(50000, 50000, 20000)] }] });

async function connected() {
  const sim = new SimulatorTransport({ replyDelayMs: 0 });
  const link = new RuidaLink(sim, new TrafficLog());
  await link.connect();
  expect(await link.verify()).not.toBeNull();
  return { sim, link };
}

describe("stored-file commands (LightBurn Send trace, 2026-11-12)", () => {
  it("encodes the header LightBurn wrote for BFTEST1", () => {
    expect(hex(storeJobHeader("BFTEST1"))).toBe("e802" + "e701" + "42465445535431" + "00");
  });

  it("reads a name reply", () => {
    expect(hex(readFileName(2))).toBe("e8010002");
    expect(parseFileNameReply(Uint8Array.of(0xe8, 0x01, 0x00, 0x01, 0x52, 0x55, 0x4e, 0x20, 0x31, 0x00))).toEqual({ index: 1, name: "RUN 1" });
    expect(parseFileNameReply(Uint8Array.of(0xe8, 0x01, 0x00, 0x01, 0x52))).toBeNull();
  });

  it("normalises names like LightBurn and rejects what it can't store", () => {
    expect(normalizeFileName(" job-test ")).toBe("JOB-TEST");
    expect(normalizeFileName("")).toBeNull();
    expect(normalizeFileName("ПЛАСТИНА")).toBeNull();
    expect(normalizeFileName("A".repeat(17))).toBeNull();
    expect(() => storeJobHeader("lower")).toThrow();
  });
});

describe("saving a job on the controller (simulator)", () => {
  it("lists the stored files", async () => {
    const { link } = await connected();
    expect(await listFiles(link)).toEqual(["RUN 1", "RUN 2"]);
  });

  it("stores the job under the name without running it, header and job as LightBurn sends them", async () => {
    const { sim, link } = await connected();
    const cmds = job();
    const progress: number[] = [];
    const r = await saveJobToController(link, cmds, "plate 1", (i) => progress.push(i), { settleMs: 0 });
    expect(r).toEqual({ name: "PLATE 1", before: 2, after: 3 });
    expect(sim.files.map((f) => f.name)).toEqual(["RUN 1", "RUN 2", "PLATE 1"]);
    expect(sim.files[2]!.cmds.map(hex)).toEqual(cmds.map(hex));
    expect(sim.jobs).toHaveLength(0);
    expect(sim.moving).toBe(false);
    // First write: exactly the header; the job follows in ≤255-byte writes.
    const tx = link.log.entries.filter((e) => e.dir === "TX" && e.plain && !(e.plain[0] === 0xda && e.plain[1] === 0x00) && !(e.plain[0] === 0xe8 && e.plain[1] === 0x01));
    expect(hex(tx[0]!.plain!)).toBe(hex(storeJobHeader("PLATE 1")));
    expect(tx.slice(1).every((e) => e.plain!.length <= 255)).toBe(true);
    expect(progress.at(-1)).toBe(tx.length - 1);
  });

  it("deletes one file as LightBurn does (E8 00 i i, traced 2026-11-13), after checking its name", async () => {
    expect(hex(deleteFiles(4))).toBe("e80000040004");
    expect(hex(deleteFiles(130, 131))).toBe("e800010201" + "03");
    const { sim, link } = await connected();
    await saveJobToController(link, job(), "A", () => {}, { settleMs: 0 });
    await saveJobToController(link, job(), "B", () => {}, { settleMs: 0 });
    expect(await listFiles(link)).toEqual(["RUN 1", "RUN 2", "A", "B"]);
    await expect(deleteFileOnController(link, 3, "B", { settleMs: 0 })).rejects.toThrow(/changed/);
    expect(await deleteFileOnController(link, 3, "A", { settleMs: 0 })).toEqual({ before: 4, after: 3 });
    expect(await listFiles(link)).toEqual(["RUN 1", "RUN 2", "B"]);
    expect(sim.files.map((f) => f.name)).toEqual(["RUN 1", "RUN 2", "B"]);
  });

  it("refuses a name the controller already has", async () => {
    const { sim, link } = await connected();
    await expect(saveJobToController(link, job(), "run 1", undefined, { settleMs: 0 })).rejects.toThrow(/already has a file named RUN 1/);
    expect(sim.files).toHaveLength(2);
  });

  it("refuses an absolute job outside the bed", async () => {
    const { link } = await connected();
    const far = encodeJobCommands({ mode: "absolute", layers: [{ speed: 10, minPower: 10, maxPower: 20, color: "#000000", paths: [square(5_000_000, 50000, 20000)] }] });
    await expect(saveJobToController(link, far, "FAR", undefined, { settleMs: 0 })).rejects.toThrow(/fit/);
  });

  it("the job body equals LightBurn's Start stream for the same design", () => {
    // The traced Send of job-test.lbrn2 was the 12-byte header followed by exactly this fixture's bytes.
    const fixture = unswizzle(new Uint8Array(readFileSync("tests/fixtures/lightburn-two-layer-absolute.rd")), DEFAULT_MAGIC);
    expect(splitCommands(fixture)[0]![0]).toBe(0xd8);
  });
});
