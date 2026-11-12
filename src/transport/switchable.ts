import type { Transport } from "./transport";

/**
 * A Transport that forwards to one of several backends (USB, simulator, bridge), chosen while closed.
 * Lets RuidaLink and the UI keep a single transport object.
 */
export class SwitchableTransport<K extends string> implements Transport {
  private dataCbs = new Set<(b: Uint8Array) => void>();
  private closeCbs = new Set<(r?: Error) => void>();
  private unsub: (() => void)[] = [];
  private _kind: K;

  constructor(
    private readonly backends: Record<K, Transport>,
    initial: K,
  ) {
    this._kind = initial;
  }

  get kind(): K {
    return this._kind;
  }

  get current(): Transport {
    return this.backends[this._kind];
  }

  select(kind: K): void {
    if (this.isOpen) throw new Error("Disconnect before switching the connection type");
    this._kind = kind;
  }

  get isOpen(): boolean {
    return this.current.isOpen;
  }

  /** USB port info of the open port, when the backend has one (for the traffic log). */
  get lastPortInfo(): SerialPortInfo | null {
    return (this.current as { lastPortInfo?: SerialPortInfo | null }).lastPortInfo ?? null;
  }

  async open(): Promise<void> {
    const t = this.current;
    await t.open();
    this.unsub = [
      t.onData((b) => this.dataCbs.forEach((cb) => cb(b))),
      t.onClose((r) => {
        this.detach();
        this.closeCbs.forEach((cb) => cb(r));
      }),
    ];
  }

  async close(): Promise<void> {
    this.detach();
    await this.current.close();
  }

  write(bytes: Uint8Array): Promise<void> {
    return this.current.write(bytes);
  }

  onData(cb: (b: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (r?: Error) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  private detach(): void {
    this.unsub.forEach((u) => u());
    this.unsub = [];
  }
}
