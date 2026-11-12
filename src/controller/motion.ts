import {
  ADDR_BED_X,
  ADDR_BED_Y,
  ADDR_MACHINE_STATUS,
  ADDR_POSITION_X,
  ADDR_POSITION_Y,
  JOG_KEY,
  type JogKey,
  STATUS_MOVING,
  jogKeyDown,
  frameCommands,
  jogKeyUp,
  motionPreamble,
  rapidMoveAbs,
  readMemory,
  stopJob,
} from "../protocol/encode";
import type { RuidaLink } from "./link";

/**
 * Head motion with a working STOP.
 *
 * Verified on hardware (docs/PROTOCOL.md): a D9 10 rapid move cannot be interrupted over USB, neither by D8 01
 * nor by keypad commands. So nothing here sends a long rapid move. Instead:
 *  - jog = keypad key-down / key-up (stops instantly on key-up),
 *  - long moves are split into short absolute segments, sent one at a time after the previous one finished;
 *    stop() cancels the remaining segments, so the head stops within one segment (~SEGMENT_S seconds).
 */

export const MAX_SPEED_MM_S = 300;
/** Target duration of one move segment; bounds how far the head can coast after STOP. */
export const SEGMENT_S = 0.25;
export const MIN_SEGMENT_MM = 2;

export interface Vec2 {
  x: number;
  y: number;
}

/** Split a straight move into absolute waypoints (um), each at most segLen apart. Pure, for tests. */
export function segmentMove(from: Vec2, to: Vec2, segLenUm: number): Vec2[] {
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(d / Math.max(1, segLenUm)));
  const pts: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    pts.push({ x: Math.round(from.x + ((to.x - from.x) * i) / n), y: Math.round(from.y + ((to.y - from.y) * i) / n) });
  }
  return pts;
}

export function segmentLengthUm(speedMmS: number): number {
  return Math.max(MIN_SEGMENT_MM, speedMmS * SEGMENT_S) * 1000;
}

export class StoppedError extends Error {
  constructor() {
    super("Stopped");
    this.name = "StoppedError";
  }
}

export class Motion {
  private generation = 0;
  private heldKey: JogKey | null = null;
  bed: Vec2 | null = null;

  constructor(private link: RuidaLink) {}

  private async read(addr: number): Promise<number> {
    const replies = await this.link.query(readMemory(addr), 500, "motion");
    const r = replies.find((x) => x.addr === addr);
    if (!r) throw new Error(`No reply reading 0x${addr.toString(16)}`);
    return r.value;
  }

  async position(): Promise<Vec2> {
    return { x: await this.read(ADDR_POSITION_X), y: await this.read(ADDR_POSITION_Y) };
  }

  async isMoving(): Promise<boolean> {
    return ((await this.read(ADDR_MACHINE_STATUS)) & STATUS_MOVING) !== 0;
  }

  /** Bed size in um from the controller (cached). */
  async bedSize(): Promise<Vec2> {
    this.bed ??= { x: await this.read(ADDR_BED_X), y: await this.read(ADDR_BED_Y) };
    return this.bed;
  }

  /** Start moving while a jog key is held. Always pair with jogRelease(); stop() also releases. */
  async jogPress(key: JogKey, speedMmS: number): Promise<void> {
    checkSpeed(speedMmS);
    if (this.heldKey !== null) await this.jogRelease();
    this.heldKey = key;
    await this.link.send(new Uint8Array([...motionPreamble(speedMmS), ...jogKeyDown(key)]), "jog press");
  }

  async jogRelease(): Promise<void> {
    const k = this.heldKey;
    this.heldKey = null;
    if (k !== null) await this.link.send(jogKeyUp(k), "jog release");
  }

  /**
   * Move to an absolute machine position (um) in short segments. Rejects with StoppedError if stop() is called.
   * The target is clamped to the bed read from the controller.
   */
  moveTo(target: Vec2, speedMmS: number, onProgress?: (p: Vec2) => void): Promise<void> {
    return this.path([target], speedMmS, onProgress);
  }

  /** Visit absolute points (um) in order, e.g. a frame outline; every leg is segmented. */
  async path(points: Vec2[], speedMmS: number, onProgress?: (p: Vec2) => void): Promise<void> {
    checkSpeed(speedMmS);
    const gen = ++this.generation;
    const bed = await this.bedSize();
    const segLen = segmentLengthUm(speedMmS);
    let from = await this.position();
    await this.link.send(motionPreamble(speedMmS), "move speed");
    for (const target of points) {
      const to = { x: clamp(target.x, 0, bed.x), y: clamp(target.y, 0, bed.y) };
      for (const wp of segmentMove(from, to, segLen)) {
        if (gen !== this.generation) throw new StoppedError();
        await this.link.send(rapidMoveAbs(wp.x, wp.y), "move segment");
        await this.waitIdle(gen, (segLen / 1000 / speedMmS) * 4 + 2);
        onProgress?.(wp);
      }
      from = to;
    }
  }

  /**
   * Trace a rectangle (absolute µm) smoothly, LightBurn-style: the whole frame goes out in one write and the
   * controller queues it. Returns when the head is idle again. NOT interruptible from software: a running D9 10
   * cannot be stopped over USB (verified), so stop() does not halt a frame; use the machine's Stop or E-stop.
   */
  async frame(min: Vec2, max: Vec2, speedMmS: number, onProgress?: (p: Vec2) => void): Promise<void> {
    checkSpeed(speedMmS);
    const bed = await this.bedSize();
    if (min.x < 0 || min.y < 0 || max.x > bed.x || max.y > bed.y) throw new Error("The frame is outside the bed");
    const start = await this.position();
    await this.link.send(frameCommands(min, max, speedMmS, start), "frame");
    // Generous bound: the sides at the frame speed, approach and return at no less than 10 mm/s, plus slack.
    const perimeter = 2 * (max.x - min.x + max.y - min.y);
    const approach = Math.hypot(min.x - start.x, min.y - start.y);
    const timeoutMs = perimeter / speedMmS + (2 * approach) / 10 + 15000; // µm ÷ mm/s = ms
    const t0 = performance.now();
    let seenMoving = false;
    for (;;) {
      await sleep(100);
      const moving = await this.isMoving();
      onProgress?.(await this.position());
      if (moving) seenMoving = true;
      // The controller may report idle for a moment before it starts the queued moves.
      if (!moving && (seenMoving || performance.now() - t0 > 1000)) return;
      if (performance.now() - t0 > timeoutMs) throw new Error("Frame did not finish in time; check the machine");
    }
  }

  private async waitIdle(gen: number, timeoutS: number): Promise<void> {
    const t0 = performance.now();
    // The first status read may come before the controller starts the segment; require a short minimum wait.
    await sleep(30);
    for (;;) {
      if (gen !== this.generation) throw new StoppedError();
      if (!(await this.isMoving())) return;
      if (performance.now() - t0 > timeoutS * 1000) throw new Error("Move segment timed out");
    }
  }

  /** Cancel queued segments, release any held jog key (all axes) and send D8 01. */
  async stop(): Promise<void> {
    this.generation++;
    this.heldKey = null;
    const keys = Object.values(JOG_KEY) as JogKey[];
    await this.link.send(new Uint8Array(keys.flatMap((k) => [...jogKeyUp(k)])), "STOP keys up");
    await this.link.send(stopJob(), "STOP");
  }
}

function checkSpeed(v: number): void {
  if (!(v > 0 && v <= MAX_SPEED_MM_S)) throw new Error(`Speed must be 0-${MAX_SPEED_MM_S} mm/s`);
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
