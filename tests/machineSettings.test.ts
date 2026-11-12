import { describe, expect, it } from "vitest";
import { parseMachineOrigins, readBedDimensions } from "../src/app/machineSettings";
import { RuidaLink } from "../src/controller/link";
import { SimulatorTransport } from "../src/transport/simulator";
import { TrafficLog } from "../src/transport/trafficLog";
import { ADDR_BED_X } from "../src/protocol/encode";

describe("machine settings", () => {
  it("reads verified simulator bed dimensions without sending motion commands", async () => {
    const sim = new SimulatorTransport({ replyDelayMs: 1 });
    const log = new TrafficLog();
    const link = new RuidaLink(sim, log);
    await link.connect();
    await expect(readBedDimensions(link)).rejects.toThrow(/Verify/);
    await link.verify();
    expect(await readBedDimensions(link)).toEqual({ width: 1300, height: 900 });
    expect(log.entries.filter((e) => e.note === "bed dimensions").every((e) => e.plain?.[0] === 0xda && e.plain?.[1] === 0)).toBe(true);
    await link.disconnect();
  });

  it("reports missing or invalid values instead of applying partial dimensions", async () => {
    const sim = new SimulatorTransport({ replyDelayMs: 1 });
    const link = new RuidaLink(sim, new TrafficLog());
    await link.connect();
    await link.verify();
    const query = link.query.bind(link);
    link.query = async (command, timeout, note) => {
      const results = await query(command, timeout, note);
      return results.map((r) => r.addr === ADDR_BED_X ? { ...r, value: 0xf2390000 } : r);
    };
    await expect(readBedDimensions(link)).rejects.toThrow(/invalid bed width/);
    link.query = async () => [];
    await expect(readBedDimensions(link)).rejects.toThrow(/No reply/);
    await link.disconnect();
  });

  it("validates saved named origins", () => {
    const entry = { name: "Laser A", cardId: 0x65106510, origin: "top-right" };
    expect(parseMachineOrigins(JSON.stringify([entry]))).toEqual([entry]);
    expect(parseMachineOrigins(null)).toEqual([]);
    expect(() => parseMachineOrigins(JSON.stringify([{ ...entry, origin: "middle" }]))).toThrow();
    expect(() => parseMachineOrigins("broken")).toThrow();
  });

  it("stops a stale read before querying a replacement connection", async () => {
    const link = new RuidaLink(new SimulatorTransport({ replyDelayMs: 1 }), new TrafficLog());
    await link.connect();
    await link.verify();
    const query = link.query.bind(link);
    let active = true;
    let count = 0;
    link.query = async (command, timeout, note) => {
      count++;
      const result = await query(command, timeout, note);
      active = false;
      return result;
    };
    await expect(readBedDimensions(link, () => active)).rejects.toThrow(/connection changed/);
    expect(count).toBe(1);
    await link.disconnect();
  });
});
