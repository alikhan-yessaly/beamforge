import type { Transport } from "./transport";

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8765";

/**
 * Talks to `npm run bridge` (scripts/serial-bridge.ts), which owns the serial port and relays raw wire bytes
 * as binary WebSocket frames. Dev only: lets browsers without Web Serial (e.g. embedded previews) reach the laser.
 */
export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private dataCbs = new Set<(b: Uint8Array) => void>();
  private closeCbs = new Set<(r?: Error) => void>();
  private closing = false;
  /** Port path reported by the bridge after connecting. */
  portName: string | null = null;

  constructor(public url: string = DEFAULT_BRIDGE_URL) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      let opened = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Bridge did not answer at ${this.url}. Start it with: npm run bridge`));
      }, 3000);
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          // Control messages: {"ready": "/dev/cu..."} or {"error": "..."}
          let msg: { ready?: string; error?: string } = {};
          try {
            msg = JSON.parse(ev.data);
          } catch {
            /* ignore */
          }
          if (msg.ready && !opened) {
            opened = true;
            clearTimeout(timer);
            this.ws = ws;
            this.closing = false;
            this.portName = msg.ready;
            resolve();
          } else if (msg.error) {
            clearTimeout(timer);
            if (!opened) reject(new Error(`Bridge: ${msg.error}`));
          }
          return;
        }
        const b = new Uint8Array(ev.data as ArrayBuffer);
        if (b.length) this.dataCbs.forEach((cb) => cb(b));
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          reject(new Error(`Cannot reach the bridge at ${this.url}. Start it with: npm run bridge`));
        }
      };
      ws.onclose = (ev) => {
        const wasOpen = this.ws === ws;
        this.ws = null;
        if (wasOpen && !this.closing) {
          this.closeCbs.forEach((cb) => cb(new Error(`Bridge connection closed${ev.reason ? `: ${ev.reason}` : ""}`)));
        }
      };
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Bridge is not connected");
    this.ws.send(new Uint8Array(bytes));
  }

  onData(cb: (b: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (r?: Error) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
}
