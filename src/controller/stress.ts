import { chunkCommands, splitCommands } from "../protocol/chunk";
import type { TrafficLog } from "../transport/trafficLog";

/**
 * Send-path stress test (docs/PROTOCOL.md item 2): send a stream in chunks with a delay
 * between them, time every write, and count replies to see whether the controller kept up.
 */
export interface StressLink {
  send(plain: Uint8Array, note?: string): Promise<void>;
  readonly log: TrafficLog;
}

export interface StressOptions {
  /** One unit of unswizzled bytes, repeated `repeat` times. */
  payload: Uint8Array;
  repeat: number;
  /** Max bytes per write; chunks break at command boundaries. */
  chunkSize: number;
  /** Pause between writes. */
  delayMs: number;
  /** How long to keep counting replies after the last write. */
  settleMs?: number;
  /** A write slower than this counts as blocked. */
  slowWriteMs?: number;
  signal?: AbortSignal;
  onProgress?: (sentChunks: number, totalChunks: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface StressResult {
  chunks: number;
  chunksSent: number;
  bytesSent: number;
  totalMs: number;
  writeMsMin: number;
  writeMsAvg: number;
  writeMsMax: number;
  /** Writes slower than slowWriteMs: the write call blocked. */
  slowWrites: number;
  /** DA 00 queries sent, so DA 01 replies expected. */
  expectedReplies: number;
  repliesSeen: number;
  rxBytes: number;
  aborted: boolean;
  error?: string;
}

export const MAX_STRESS_BYTES = 1_000_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Count DA 01 reply headers in an unswizzled byte stream. */
export function countReplies(plain: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i + 1 < plain.length; i++) if (plain[i] === 0xda && plain[i + 1] === 0x01) n++;
  return n;
}

export function planStress(payload: Uint8Array, repeat: number, chunkSize: number): Uint8Array[] {
  if (payload.length === 0) throw new Error("Payload is empty");
  if (!(repeat >= 1) || !Number.isInteger(repeat)) throw new Error("Repeat count must be a positive integer");
  if (!(chunkSize >= 1)) throw new Error("Chunk size must be at least 1 byte");
  if (payload.length * repeat > MAX_STRESS_BYTES) throw new Error(`Stream limited to ${MAX_STRESS_BYTES} bytes`);
  const stream = new Uint8Array(payload.length * repeat);
  for (let i = 0; i < repeat; i++) stream.set(payload, i * payload.length);
  return chunkCommands(splitCommands(stream), chunkSize);
}

export async function runStressTest(link: StressLink, o: StressOptions): Promise<StressResult> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? defaultSleep;
  const slowMs = o.slowWriteMs ?? 50;
  const chunks = planStress(o.payload, o.repeat, o.chunkSize);
  const expectedReplies = chunks.reduce(
    (n, c) => n + splitCommands(c).filter((cmd) => cmd[0] === 0xda && cmd[1] === 0x00).length,
    0,
  );

  const rx: number[] = [];
  const off = link.log.subscribe((e) => {
    if (e.dir === "RX" && e.plain) for (const b of e.plain) rx.push(b);
  });

  const times: number[] = [];
  let bytesSent = 0;
  let error: string | undefined;
  const t0 = now();
  link.log.add({
    dir: "INFO",
    note: `Stress test start: ${chunks.length} chunks, ${o.payload.length * o.repeat} bytes, chunk ${o.chunkSize} B, delay ${o.delayMs} ms`,
  });
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (o.signal?.aborted) break;
      const c = chunks[i]!;
      const ts = now();
      await link.send(c, `stress ${i + 1}/${chunks.length}`);
      times.push(now() - ts);
      bytesSent += c.length;
      o.onProgress?.(i + 1, chunks.length);
      if (o.delayMs > 0 && i < chunks.length - 1) await sleep(o.delayMs);
    }
    if (!o.signal?.aborted) await sleep(o.settleMs ?? 1000);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    off();
  }

  const result: StressResult = {
    chunks: chunks.length,
    chunksSent: times.length,
    bytesSent,
    totalMs: now() - t0,
    writeMsMin: times.length ? Math.min(...times) : 0,
    writeMsAvg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    writeMsMax: times.length ? Math.max(...times) : 0,
    slowWrites: times.filter((t) => t > slowMs).length,
    expectedReplies,
    repliesSeen: countReplies(rx),
    rxBytes: rx.length,
    aborted: !!o.signal?.aborted,
    error,
  };
  link.log.add({ dir: "INFO", note: `Stress test result: ${formatStress(result)}` });
  return result;
}

export function formatStress(r: StressResult): string {
  const f = (n: number) => n.toFixed(1);
  return [
    `${r.chunksSent}/${r.chunks} chunks, ${r.bytesSent} B in ${f(r.totalMs)} ms`,
    `write ms min/avg/max ${f(r.writeMsMin)}/${f(r.writeMsAvg)}/${f(r.writeMsMax)}, blocked writes ${r.slowWrites}`,
    `replies ${r.repliesSeen}/${r.expectedReplies} (${r.rxBytes} RX bytes)`,
    r.aborted ? "ABORTED" : "",
    r.error ? `ERROR: ${r.error}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
