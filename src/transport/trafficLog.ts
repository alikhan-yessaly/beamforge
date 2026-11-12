export type Direction = "TX" | "RX" | "INFO";

export interface LogEntry {
  t: number;
  dir: Direction;
  /** Bytes as seen on the wire (swizzled). */
  wire?: Uint8Array;
  /** Same bytes after unswizzling with the active magic. */
  plain?: Uint8Array;
  note?: string;
}

const hex = (b?: Uint8Array) => (b ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ") : "");

export class TrafficLog {
  readonly entries: LogEntry[] = [];
  private cbs = new Set<(e: LogEntry) => void>();

  add(e: Omit<LogEntry, "t">): void {
    const entry = { t: Date.now(), ...e };
    this.entries.push(entry);
    this.cbs.forEach((cb) => cb(entry));
  }

  subscribe(cb: (e: LogEntry) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  clear(): void {
    this.entries.length = 0;
  }

  static formatEntry(e: LogEntry): string {
    const time = new Date(e.t).toISOString().slice(11, 23);
    if (e.dir === "INFO") return `${time} INFO ${e.note ?? ""}`;
    const lines = [`${time} ${e.dir} ${e.wire?.length ?? 0}B${e.note ? ` (${e.note})` : ""}`];
    lines.push(`    wire : ${hex(e.wire)}`);
    lines.push(`    plain: ${hex(e.plain)}`);
    return lines.join("\n");
  }

  toText(): string {
    return this.entries.map(TrafficLog.formatEntry).join("\n") + "\n";
  }
}
