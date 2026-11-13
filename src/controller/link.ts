import { splitCommands } from "../protocol/chunk";
import { t } from "../i18n";
import { decodeReplies, type MemoryReply } from "../protocol/decode";
import { ADDR_CARD_ID, hasForbiddenParamWrite, queryCardId } from "../protocol/encode";
import { DEFAULT_MAGIC, swizzle, unswizzle } from "../protocol/swizzle";
import type { Transport } from "../transport/transport";
import type { TrafficLog } from "../transport/trafficLog";

const isReadQuery = (b: Uint8Array) => {
  const cmds = splitCommands(b);
  return cmds.length > 0 && cmds.every((c) => c[0] === 0xda && c[1] === 0x00);
};

/** 14-bit addresses of the DA 00 queries in an unswizzled stream. */
const queriedAddrs = (b: Uint8Array) => splitCommands(b).map((c) => ((c[2] ?? 0) << 7) | (c[3] ?? 0));

export type LinkState = "disconnected" | "connected" | "verified";

/**
 * Swizzling, logging and reply matching on top of a Transport.
 * A wrong magic makes the controller decode garbage commands (docs/PROTOCOL.md), so
 * nothing except read-only queries is sent until a Card ID reply decoded with the current magic.
 */
export class RuidaLink {
  magic = DEFAULT_MAGIC;
  /** Developer mode: allows arbitrary bytes, including memory writes. Off by default. */
  devMode = false;
  cardId: number | null = null;

  private rx: number[] = [];
  private pending: ((r: MemoryReply[]) => void) | null = null;
  /** For exchange(): receives every complete command the controller sends. */
  private rawWaiter: ((cmd: Uint8Array) => void) | null = null;
  private rawRx: number[] = [];
  /** Serialises query() calls so concurrent callers (poller, buttons) don't steal each other's replies. */
  private queryChain: Promise<unknown> = Promise.resolve();
  private offData: (() => void) | null = null;
  private offClose: (() => void) | null = null;
  private stateCbs = new Set<(s: LinkState) => void>();
  private lastState: LinkState = "disconnected";

  constructor(
    readonly transport: Transport,
    readonly log: TrafficLog,
  ) {}

  get verified(): boolean {
    return this.cardId !== null && this.transport.isOpen;
  }

  get state(): LinkState {
    if (!this.transport.isOpen) return "disconnected";
    return this.cardId !== null ? "verified" : "connected";
  }

  /** Subscribe to state changes (connect, verify, magic change, disconnect, unexpected close). */
  onStateChange(cb: (s: LinkState) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  async connect(): Promise<void> {
    if (this.transport.isOpen) throw new Error(t("Already connected"));
    this.unsubscribe();
    await this.transport.open();
    this.offData = this.transport.onData((b) => this.handleRx(b));
    this.offClose = this.transport.onClose((e) => {
      this.log.add({ dir: "INFO", note: `Link closed unexpectedly${e ? `: ${e.message}` : ""}` });
      this.reset();
    });
    const info = (this.transport as { lastPortInfo?: SerialPortInfo | null }).lastPortInfo;
    const id = info?.usbVendorId !== undefined ? ` (USB ${info.usbVendorId.toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")})` : "";
    this.log.add({ dir: "INFO", note: `Port opened${id}` });
    this.emitState();
  }

  async disconnect(): Promise<void> {
    this.unsubscribe();
    this.cardId = null;
    await this.transport.close();
    this.log.add({ dir: "INFO", note: "Port closed" });
    this.emitState();
  }

  setMagic(magic: number): void {
    this.magic = magic;
    this.cardId = null;
    this.emitState();
  }

  /** Send unswizzled bytes. */
  async send(plain: Uint8Array, note?: string): Promise<void> {
    if (!this.devMode) {
      if (!isReadQuery(plain)) {
        if (!this.verified) throw new Error(t("Not verified: read the Card ID successfully before sending commands"));
        if (hasForbiddenParamWrite(splitCommands(plain))) throw new Error(t("Memory writes are only available in developer mode"));
      }
    }
    const wire = swizzle(plain, this.magic);
    this.log.add({ dir: "TX", wire, plain, note });
    await this.transport.write(wire);
  }

  /**
   * Send read-only DA 00 queries and wait until a reply for every queried address decoded.
   * On timeout resolves to whatever replies decoded so far (possibly []).
   */
  query(plain: Uint8Array, timeoutMs = 1000, note = "query"): Promise<MemoryReply[]> {
    if (!isReadQuery(plain)) return Promise.reject(new Error("query() is for read-only DA 00 queries"));
    const run = () => this.runQuery(plain, timeoutMs, note);
    const p = this.queryChain.then(run, run);
    this.queryChain = p.catch(() => undefined);
    return p;
  }

  private async runQuery(plain: Uint8Array, timeoutMs: number, note: string): Promise<MemoryReply[]> {
    const want = new Set(queriedAddrs(plain));
    this.rx = [];
    let latest: MemoryReply[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = new Promise<MemoryReply[]>((resolve) => {
      const finish = (r: MemoryReply[]) => {
        clearTimeout(timer);
        this.pending = null;
        resolve(r);
      };
      timer = setTimeout(() => {
        this.log.add({ dir: "INFO", note: `No complete reply within ${timeoutMs} ms (${latest.length}/${want.size} decoded)` });
        finish(latest);
      }, timeoutMs);
      this.pending = (r) => {
        latest = r;
        if ([...want].every((a) => r.some((x) => x.addr === a))) finish(r);
      };
    });
    try {
      await this.send(plain, note);
    } catch (e) {
      clearTimeout(timer);
      this.pending = null;
      throw e;
    }
    return result;
  }

  /**
   * Send a command and wait for a reply that is not a memory read (for example E8 01, a stored file's name).
   * Resolves with the first complete reply command `accept` takes, or null after `timeoutMs`. Serialised with query().
   */
  exchange(plain: Uint8Array, accept: (cmd: Uint8Array) => boolean, timeoutMs = 1000, note = "exchange"): Promise<Uint8Array | null> {
    const run = () =>
      new Promise<Uint8Array | null>((resolve, reject) => {
        this.rawRx = [];
        const finish = (r: Uint8Array | null) => {
          clearTimeout(timer);
          this.rawWaiter = null;
          resolve(r);
        };
        const timer = setTimeout(() => {
          this.log.add({ dir: "INFO", note: `No reply within ${timeoutMs} ms (${note})` });
          finish(null);
        }, timeoutMs);
        this.rawWaiter = (c) => accept(c) && finish(c);
        this.send(plain, note).catch((e) => {
          clearTimeout(timer);
          this.rawWaiter = null;
          reject(e);
        });
      });
    const p = this.queryChain.then(run, run);
    this.queryChain = p.catch(() => undefined);
    return p;
  }

  /** Read the Card ID with the current magic; marks the link verified on a valid reply. */
  async verify(): Promise<number | null> {
    this.cardId = null;
    this.emitState();
    const replies = await this.query(queryCardId(), 1000, "card id");
    const r = replies.find((x) => x.addr === ADDR_CARD_ID);
    if (!r) return null;
    this.cardId = r.value;
    this.log.add({ dir: "INFO", note: `Card ID reply: 0x${r.value.toString(16)} (magic 0x${this.magic.toString(16)})` });
    this.emitState();
    return r.value;
  }

  private handleRx(wire: Uint8Array): void {
    const plain = unswizzle(wire, this.magic);
    this.log.add({ dir: "RX", wire, plain });
    if (this.rawWaiter) {
      for (const b of plain) this.rawRx.push(b);
      // A command is complete once the next one has started; a reply ending in 00 (a name) is complete on its own.
      const cmds = splitCommands(Uint8Array.from(this.rawRx));
      cmds.forEach((c, i) => {
        if (i < cmds.length - 1 || c.at(-1) === 0x00) this.rawWaiter?.(c);
      });
    }
    if (!this.pending) return;
    for (const b of plain) this.rx.push(b);
    const { replies } = decodeReplies(Uint8Array.from(this.rx));
    if (replies.length > 0) this.pending(replies);
  }

  private unsubscribe(): void {
    this.offData?.();
    this.offClose?.();
    this.offData = this.offClose = null;
  }

  private reset(): void {
    this.unsubscribe();
    this.cardId = null;
    this.emitState();
  }

  private emitState(): void {
    const s = this.state;
    if (s === this.lastState) return;
    this.lastState = s;
    this.stateCbs.forEach((cb) => cb(s));
  }
}
