import type { Transport } from "./transport";

export const FTDI_VID = 0x0403;
export const FT245R_PID = 0x6001;

/** Port picker filter: the FT245R only, any FTDI chip, or every serial port. */
export type PortFilter = "ft245r" | "ftdi" | "all";

export interface WebSerialOptions {
  /** Required by the API; ignored by the FT245R FIFO chip. */
  baudRate?: number;
  portFilter?: PortFilter;
}

export function portFilters(f: PortFilter): SerialPortFilter[] {
  if (f === "all") return [];
  if (f === "ftdi") return [{ usbVendorId: FTDI_VID }];
  return [{ usbVendorId: FTDI_VID, usbProductId: FT245R_PID }];
}

function matches(info: SerialPortInfo, f: PortFilter): boolean {
  return portFilters(f).every((x) => info.usbVendorId === x.usbVendorId && (x.usbProductId === undefined || info.usbProductId === x.usbProductId));
}

/** An Error carrying a DOMException's name, so callers can tell the reasons apart. */
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

/** Chrome rejects requestPort() with NotFoundError both when the user cancels and when the browser has no chooser at all. */
export function explainOpenError(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === "NotFoundError") {
    return named(
      err.name,
      "No port was chosen. If no port chooser appeared, this browser cannot pick serial ports (embedded previews cannot): open the page in Chrome or Edge.",
    );
  }
  if (err.name === "InvalidStateError") return named(err.name, "The port is already open (another tab or program is using it). Close it there and retry.");
  if (err.name === "NetworkError") return named(err.name, "Failed to open the port: it is busy or was unplugged. Close other programs using it (LightBurn, RDWorks) and retry.");
  return err;
}

export class WebSerialTransport implements Transport {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private dataCbs = new Set<(b: Uint8Array) => void>();
  private closeCbs = new Set<(r?: Error) => void>();
  private closing = false;

  constructor(private opts: WebSerialOptions = {}) {}

  /** Which ports the browser picker lists on the next open(). Default "ftdi". */
  get portFilter(): PortFilter {
    return this.opts.portFilter ?? "ftdi";
  }
  set portFilter(f: PortFilter) {
    this.opts.portFilter = f;
  }

  get isOpen(): boolean {
    return this.port !== null;
  }

  /** When true, the next open() always shows the browser's port chooser instead of reusing a granted port. */
  forceChooser = false;
  /** Info of the port opened last (for logging). */
  lastPortInfo: SerialPortInfo | null = null;

  /**
   * Reuses the single previously granted port that matches the filter (no chooser, survives reloads);
   * otherwise shows the chooser, which must happen inside a user gesture.
   */
  async open(): Promise<void> {
    if (!("serial" in navigator)) throw named("NotSupportedError", "Web Serial is not available (use Chrome/Edge on localhost or HTTPS)");
    let port: SerialPort | undefined;
    if (!this.forceChooser) {
      const granted = (await navigator.serial.getPorts()).filter((p) => matches(p.getInfo(), this.portFilter));
      if (granted.length === 1) port = granted[0];
    }
    this.forceChooser = false;
    try {
      port ??= await navigator.serial.requestPort({ filters: portFilters(this.portFilter) });
      await port.open({ baudRate: this.opts.baudRate ?? 115200 });
    } catch (e) {
      throw explainOpenError(e);
    }
    this.lastPortInfo = port.getInfo();
    this.port = port;
    this.closing = false;
    this.writer = port.writable!.getWriter();
    this.reader = port.readable!.getReader();
    void this.readLoop(this.reader);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.teardown();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("Port is not open");
    await this.writer.write(bytes);
  }

  onData(cb: (bytes: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (reason?: Error) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    let failure: Error | undefined;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) this.dataCbs.forEach((cb) => cb(value));
      }
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    if (!this.closing) {
      await this.teardown();
      this.closeCbs.forEach((cb) => cb(failure));
    }
  }

  private async teardown(): Promise<void> {
    const { port, reader, writer } = this;
    this.port = this.reader = this.writer = null;
    try { await reader?.cancel(); } catch { /* already closed */ }
    try { reader?.releaseLock(); } catch { /* already released */ }
    try { writer?.releaseLock(); } catch { /* already released */ }
    try { await port?.close(); } catch { /* already closed */ }
  }
}
