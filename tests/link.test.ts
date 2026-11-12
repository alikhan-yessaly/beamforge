import { describe, expect, it } from "vitest";
import { RuidaLink } from "../src/controller/link";
import { queryStatus, readMemory, startJob } from "../src/protocol/encode";
import { swizzle, unswizzle } from "../src/protocol/swizzle";
import type { Transport } from "../src/transport/transport";
import { TrafficLog } from "../src/transport/trafficLog";

class MockTransport implements Transport {
  isOpen = false;
  written: Uint8Array[] = [];
  dataCbs = new Set<(b: Uint8Array) => void>();
  closeCbs = new Set<(r?: Error) => void>();
  constructor(private reply?: Uint8Array | ((wire: Uint8Array) => Uint8Array | undefined)) {}
  async open() {
    this.isOpen = true;
  }
  async close() {
    this.isOpen = false;
  }
  async write(b: Uint8Array) {
    this.written.push(b);
    const r = typeof this.reply === "function" ? this.reply(b) : this.reply;
    if (r) queueMicrotask(() => this.dataCbs.forEach((cb) => cb(r)));
  }
  onData(cb: (b: Uint8Array) => void) {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }
  onClose(cb: (r?: Error) => void) {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
  /** Simulate the cable being pulled. */
  drop() {
    this.isOpen = false;
    this.closeCbs.forEach((cb) => cb(new Error("device lost")));
  }
}

const cardReply = (magic: number) => swizzle(Uint8Array.of(0xda, 0x01, 0x05, 0x7e, 0, 0, 0x01, 0x23, 0x45), magic);

describe("RuidaLink", () => {
  it("blocks non-read commands until the Card ID is verified", async () => {
    const t = new MockTransport(cardReply(0x88));
    const link = new RuidaLink(t, new TrafficLog());
    await link.connect();
    await expect(link.send(startJob())).rejects.toThrow(/Not verified/);
    expect(t.written).toHaveLength(0);

    expect(await link.verify()).not.toBeNull();
    await link.send(startJob());
    expect(t.written).toHaveLength(2);
  });

  it("does not verify when the reply is decoded with the wrong magic", async () => {
    const link = new RuidaLink(new MockTransport(cardReply(0x11)), new TrafficLog());
    await link.connect();
    expect(await link.verify()).toBeNull();
    expect(link.verified).toBe(false);
  }, 3000);

  it("rejects memory writes outside developer mode, even when verified", async () => {
    const link = new RuidaLink(new MockTransport(cardReply(0x88)), new TrafficLog());
    await link.connect();
    await link.verify();
    await expect(link.send(Uint8Array.of(0xda, 0x01, 0x00, 0x13, 0, 0, 0, 0, 1))).rejects.toThrow(/developer mode/);
  });

  it("changing the magic clears verification", async () => {
    const link = new RuidaLink(new MockTransport(cardReply(0x88)), new TrafficLog());
    await link.connect();
    await link.verify();
    link.setMagic(0x11);
    expect(link.verified).toBe(false);
  });

  it("does not stack close listeners across reconnects", async () => {
    const t = new MockTransport(cardReply(0x88));
    const log = new TrafficLog();
    const link = new RuidaLink(t, log);
    await link.connect();
    await link.disconnect();
    await link.connect();
    expect(t.closeCbs.size).toBe(1);
    expect(t.dataCbs.size).toBe(1);
    t.drop();
    expect(log.entries.filter((e) => e.note?.startsWith("Link closed"))).toHaveLength(1);
    expect(t.closeCbs.size).toBe(0);
    expect(t.dataCbs.size).toBe(0);
  });

  it("reports state changes, including an unexpected close", async () => {
    const t = new MockTransport(cardReply(0x88));
    const link = new RuidaLink(t, new TrafficLog());
    const states: string[] = [];
    link.onStateChange((s) => states.push(s));
    await link.connect();
    await link.verify();
    expect(link.state).toBe("verified");
    t.drop();
    expect(link.state).toBe("disconnected");
    expect(link.verified).toBe(false);
    expect(states).toEqual(["connected", "verified", "disconnected"]);
    await link.connect();
    await link.disconnect();
    expect(states.slice(3)).toEqual(["connected", "disconnected"]);
  });

  it("refuses to connect twice", async () => {
    const link = new RuidaLink(new MockTransport(), new TrafficLog());
    await link.connect();
    await expect(link.connect()).rejects.toThrow(/Already connected/);
  });

  it("serialises concurrent queries so each gets its own reply", async () => {
    // Reply with the address that was asked for.
    const t = new MockTransport((wire) => {
      const plain = unswizzle(wire, 0x88);
      return swizzle(Uint8Array.of(0xda, 0x01, plain[2]!, plain[3]!, 0, 0, 0, 0, plain[3]!), 0x88);
    });
    const link = new RuidaLink(t, new TrafficLog());
    await link.connect();
    const [a, b] = await Promise.all([link.query(queryStatus()), link.query(readMemory(0x221))]);
    expect(a.map((r) => r.addr)).toEqual([0x200]);
    expect(b.map((r) => r.addr)).toEqual([0x221]);
    expect(b[0]!.value).toBe(0x21);
  });
});
