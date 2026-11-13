import { splitCommands } from "../protocol/chunk";
import { decodeJob } from "../protocol/jobDecode";
import { decodeInt35, encodeInt35 } from "../protocol/numbers";
import { swizzle, unswizzle } from "../protocol/swizzle";
import type { Transport } from "./transport";

/**
 * Simulated Ruida controller, modelled on what the real RDC644XS did on 2026-11-11 (docs/PROTOCOL.md):
 * - replies to DA 00 reads (Card ID 0x65106510, status, head position, bed size, Z/U),
 * - executes D9 10 rapid moves (opt 0x00 absolute, 0x02 relative) at the last C9 02 speed, queued, constant speed,
 * - keypad jog D9 D8 2k / D9 D8 3k (left = +X, right = -X, up = -Y, down = +Y; origin top-right),
 * - D8 01 and keypad commands do NOT interrupt a running D9 10 move (same as the hardware),
 * - commands swizzled with a different magic decode to garbage and get no reply,
 * - runs jobs (D8 1x … D7, possibly over several writes): travels at the default speed, cuts at the layer speed,
 *   then returns to where the job started. D8 02 pauses and D8 03 resumes at once; D8 01 ends the job at once and
 *   the head returns to the start (as observed with LightBurn, 2026-11-11). Status 0x200 reads as on the hardware.
 * Positions are in um and clamped to the bed. No acceleration is modelled.
 */

export interface SimOptions {
  magic?: number;
  bedUm?: { x: number; y: number };
  startUm?: { x: number; y: number };
  /** Reply latency; the hardware answers in ~7-18 ms. 0 = next microtask (tests). */
  replyDelayMs?: number;
  /** Speed used when C9 02 is 0 (LightBurn sends 0 for frame travel moves). */
  defaultSpeedUmS?: number;
  now?: () => number;
}

export const SIM_CARD_ID = 0x65106510;
export const SIM_STATUS_MOVING = 0x1020000;
/** Status 0x200 values seen on the RDC644XS during a LightBurn job (docs/PROTOCOL.md). */
export const SIM_STATUS_JOB = { running: 0x10401, paused: 0x10403, done: 0x10600, stopped: 0x510600 } as const;
export type SimJobState = keyof typeof SIM_STATUS_JOB;
const JUNK = 0xf2390000;

interface ActiveMove {
  from: { x: number; y: number };
  to: { x: number; y: number };
  start: number;
  dur: number;
}
interface Jog {
  dir: { x: number; y: number };
  from: { x: number; y: number };
  start: number;
  speed: number;
}

export class SimulatorTransport implements Transport {
  readonly magic: number;
  readonly bed: { x: number; y: number };
  /** Every command received (unswizzled), for tests and debugging. */
  readonly received: { t: number; cmd: Uint8Array }[] = [];

  private pos: { x: number; y: number };
  private speedUmS: number;
  private queue: { to: { x: number; y: number }; speed: number }[] = [];
  private active: ActiveMove | null = null;
  private jog: Jog | null = null;
  /** Commands of a job being received (between D8 1x and D7). */
  private jobCmds: Uint8Array[] | null = null;
  /** Jobs stored in "memory" (like the RDC644XS in the LightBurn trace, which held RUN 1 and RUN 2). */
  readonly files: { name: string; cmds: Uint8Array[] }[] = [
    { name: "RUN 1", cmds: [] },
    { name: "RUN 2", cmds: [] },
  ];
  /** E8 02 + E7 01 <name>: the next job is stored under this name instead of run. */
  private storeAs: string | null = null;
  private jobState: SimJobState | null = null;
  private jobStart = { x: 0, y: 0 };
  private paused: { to: { x: number; y: number }; speed: number }[] = [];
  /** Jobs received completely, decoded, for tests. */
  readonly jobs: ReturnType<typeof decodeJob>[] = [];
  private open_ = false;
  private dataCbs = new Set<(b: Uint8Array) => void>();
  private closeCbs = new Set<(r?: Error) => void>();
  private readonly now: () => number;
  private readonly replyDelayMs: number;
  private readonly defaultSpeed: number;

  constructor(opts: SimOptions = {}) {
    this.magic = opts.magic ?? 0x88;
    this.bed = opts.bedUm ?? { x: 1300000, y: 900000 };
    this.pos = { ...(opts.startUm ?? { x: 100000, y: 100000 }) };
    this.now = opts.now ?? (() => performance.now());
    this.replyDelayMs = opts.replyDelayMs ?? 10;
    this.defaultSpeed = opts.defaultSpeedUmS ?? 100000;
    this.speedUmS = this.defaultSpeed;
  }

  get isOpen(): boolean {
    return this.open_;
  }

  async open(): Promise<void> {
    this.open_ = true;
  }

  async close(): Promise<void> {
    this.open_ = false;
  }

  async write(wire: Uint8Array): Promise<void> {
    if (!this.open_) throw new Error("Port is not open");
    const cmds = splitCommands(unswizzle(wire, this.magic));
    const t = this.now();
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i]!;
      this.received.push({ t, cmd: c.slice() });
      // Keypad: a bare D9 followed by D8 2k / D8 3k.
      if (c.length === 1 && c[0] === 0xd9 && cmds[i + 1]?.[0] === 0xd8) {
        const k = cmds[i + 1]!;
        this.received.push({ t, cmd: k.slice() });
        this.keypad(k[1] ?? 0);
        i++;
        continue;
      }
      this.exec(c);
    }
  }

  onData(cb: (b: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (r?: Error) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  /** Simulate the cable being pulled. */
  unplug(): void {
    this.open_ = false;
    this.closeCbs.forEach((cb) => cb(new Error("Simulated device lost")));
  }

  /** Current head position in um (advances the motion model). */
  position(): { x: number; y: number } {
    this.advance();
    return { ...this.pos };
  }

  get moving(): boolean {
    this.advance();
    return this.active !== null || this.jog !== null;
  }

  /** Job state, or null before the first job. Advances the motion model. */
  get job(): SimJobState | null {
    this.advance();
    return this.jobState;
  }

  private exec(c: Uint8Array): void {
    const [a, b] = [c[0], c[1]];
    if (a === 0xda && b === 0x00 && c.length >= 4) return this.reply(((c[2]! & 0x7f) << 7) | (c[3]! & 0x7f));
    if (this.jobCmds) {
      this.jobCmds.push(c.slice());
      if (a === 0xd7) {
        const cmds = this.jobCmds;
        this.jobCmds = null;
        if (this.storeAs !== null) {
          this.files.push({ name: this.storeAs, cmds });
          this.storeAs = null;
        } else this.runJob(cmds);
      }
      return;
    }
    if (a === 0xe8 && b === 0x00 && c.length >= 6) {
      // Delete stored files from..to (1-based, inclusive).
      const from = (c[2]! << 7) | c[3]!;
      const to = (c[4]! << 7) | c[5]!;
      if (from >= 1 && to >= from) this.files.splice(from - 1, to - from + 1);
      return;
    }
    if (a === 0xe8 && b === 0x02) {
      this.storeAs = "";
      return;
    }
    if (a === 0xe7 && b === 0x01 && this.storeAs !== null) {
      this.storeAs = String.fromCharCode(...c.subarray(2, c.length - 1));
      return;
    }
    if (a === 0xe8 && b === 0x01 && c.length >= 4) {
      const i = (c[2]! << 7) | c[3]!;
      const f = this.files[i - 1];
      if (f) this.send(Uint8Array.of(0xe8, 0x01, c[2]!, c[3]!, ...Array.from(f.name, (ch) => ch.charCodeAt(0)), 0x00));
      return;
    }
    if (a === 0xd8 && (b === 0x10 || b === 0x11 || b === 0x12)) {
      this.jobCmds = [c.slice()];
      return;
    }
    if (a === 0xd8 && b !== undefined && b <= 0x03) return this.jobControl(b);
    if (a === 0xc9 && b === 0x02 && c.length >= 7) {
      const v = decodeInt35(c, 2);
      this.speedUmS = v > 0 ? v : this.defaultSpeed;
      return;
    }
    if (a === 0xd9 && b === 0x10 && c.length >= 13) {
      const opt = c[2]!;
      const x = decodeInt35(c, 3);
      const y = decodeInt35(c, 8);
      this.advance();
      const base = this.queue.at(-1)?.to ?? this.active?.to ?? this.pos;
      const to = opt === 0x02 ? { x: base.x + x, y: base.y + y } : { x, y };
      this.queue.push({ to: this.clamp(to), speed: this.speedUmS });
      this.advance();
      return;
    }
    // D8 0x (start/stop/pause/resume), C6 power, D0 29 etc.: accepted, no effect on rapid moves.
  }

  private runJob(cmds: Uint8Array[]): void {
    const job = decodeJob(cmds);
    this.jobs.push(job);
    this.advance();
    if (this.active || this.queue.length || this.jog) return; // busy: the hardware would not start it either
    const off = job.mode === "current" ? { ...this.pos } : { x: 0, y: 0 };
    this.jobStart = { ...this.pos };
    for (const l of job.layers) {
      const speed = Math.max(1, Math.round(l.speed * 1000));
      for (const path of l.paths) {
        path.forEach((p, i) => this.queue.push({ to: this.clamp({ x: p.x + off.x, y: p.y + off.y }), speed: i === 0 ? this.defaultSpeed : speed }));
      }
    }
    this.queue.push({ to: { ...this.jobStart }, speed: this.defaultSpeed });
    this.jobState = "running";
    this.advance();
  }

  private jobControl(code: number): void {
    this.advance();
    const st = this.jobState;
    if (code === 0x02 && st === "running") {
      this.paused = [...(this.active ? [{ to: this.active.to, speed: this.speedOf(this.active) }] : []), ...this.queue];
      this.active = null;
      this.queue = [];
      this.jobState = "paused";
    } else if (code === 0x03 && st === "paused") {
      this.queue = this.paused;
      this.paused = [];
      this.jobState = "running";
      this.advance();
    } else if (code === 0x01 && (st === "running" || st === "paused")) {
      this.active = null;
      this.paused = [];
      this.queue = [{ to: { ...this.jobStart }, speed: this.defaultSpeed }];
      this.jobState = "stopped";
      this.advance();
    }
  }

  private speedOf(m: ActiveMove): number {
    const dist = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
    return m.dur > 0 ? (dist / m.dur) * 1000 : this.defaultSpeed;
  }

  private keypad(code: number): void {
    const key = code & 0x0f;
    const dirs = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 0, y: 1 },
    ];
    this.advance();
    if ((code & 0xf0) === 0x20 && key < 4) {
      if (this.active || this.queue.length) return; // busy: ignored
      this.jog = { dir: dirs[key]!, from: { ...this.pos }, start: this.now(), speed: this.speedUmS };
    } else if ((code & 0xf0) === 0x30 && this.jog) {
      this.pos = this.jogPos(this.now());
      this.jog = null;
    }
  }

  private jogPos(t: number): { x: number; y: number } {
    const j = this.jog!;
    const d = (j.speed * (t - j.start)) / 1000;
    return this.clamp({ x: j.from.x + j.dir.x * d, y: j.from.y + j.dir.y * d });
  }

  /** Time up to which the queued moves have been simulated. */
  private cursorT = 0;

  /** Run the motion model up to now: queued moves run back to back at their own speed. */
  private advance(): void {
    const t = this.now();
    for (;;) {
      if (!this.active) {
        const next = this.queue.shift();
        if (!next) break;
        const dist = Math.hypot(next.to.x - this.pos.x, next.to.y - this.pos.y);
        this.active = { from: { ...this.pos }, to: next.to, start: this.cursorT, dur: (dist / next.speed) * 1000 };
      }
      const m = this.active;
      if (t >= m.start + m.dur) {
        this.pos = { ...m.to };
        this.cursorT = m.start + m.dur;
        this.active = null;
        continue;
      }
      const f = m.dur > 0 ? (t - m.start) / m.dur : 1;
      this.pos = { x: m.from.x + (m.to.x - m.from.x) * f, y: m.from.y + (m.to.y - m.from.y) * f };
      return;
    }
    // Idle: queued moves start from now.
    this.cursorT = t;
    if (this.jobState === "running") this.jobState = "done";
    if (this.jog) this.pos = this.jogPos(t);
  }

  private clamp(p: { x: number; y: number }) {
    return { x: Math.min(this.bed.x, Math.max(0, Math.round(p.x))), y: Math.min(this.bed.y, Math.max(0, Math.round(p.y))) };
  }

  private value(addr: number): number {
    this.advance();
    switch (addr) {
      case 0x2fe:
        return SIM_CARD_ID;
      case 0x200:
        if (this.jobState === "running" || this.jobState === "paused") return SIM_STATUS_JOB[this.jobState];
        // After a job the job bits stay; a rapid move adds the moving bit (a guess: not seen on hardware yet).
        return (this.active || this.jog ? SIM_STATUS_MOVING : 0) | (this.jobState ? SIM_STATUS_JOB[this.jobState] : 0);
      case 0x204:
        return 0x1000;
      case 0x205:
        return this.files.length;
      case 0x221:
        return Math.round(this.pos.x);
      case 0x231:
        return Math.round(this.pos.y);
      case 0x241:
        return 3000000;
      case 0x251:
        return 10000001;
      case 0x026:
        return this.bed.x;
      case 0x036:
        return this.bed.y;
      case 0x021:
      case 0x031:
        return 0x55f118;
      case 0x004:
      case 0x010:
      case 0x01e:
      case 0x226:
        return 0;
      default:
        return JUNK;
    }
  }

  private reply(addr: number): void {
    const v = this.value(addr);
    this.send(Uint8Array.of(0xda, 0x01, (addr >> 7) & 0x7f, addr & 0x7f, ...encodeInt35(v)));
  }

  private send(plain: Uint8Array): void {
    const wire = swizzle(plain, this.magic);
    const deliver = () => {
      if (this.open_) this.dataCbs.forEach((cb) => cb(wire));
    };
    if (this.replyDelayMs > 0) setTimeout(deliver, this.replyDelayMs);
    else queueMicrotask(deliver);
  }
}
