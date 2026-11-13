// Run a job on the controller: check, stream, watch, and control it.
//
// What LightBurn does (docs/PROTOCOL.md, "LightBurn job capture"): the whole job in one burst of ~255-byte writes,
// cut at command boundaries, no pacing; D8 02 / D8 03 / D8 01 pause, resume and stop a running job at once (Stop
// also sends the head back to the job start). LightBurn does not poll during a job; we poll status 0x200 for
// progress, which the controller answered fine during LightBurn's jobs.
import { t } from "../i18n";
import { chunkCommands } from "../protocol/chunk";
import {
  ADDR_BED_X,
  ADDR_BED_Y,
  ADDR_MACHINE_STATUS,
  ADDR_POSITION_X,
  ADDR_POSITION_Y,
  STATUS_MOVING,
  pauseJob,
  readMemory,
  resumeJob,
  stopJob,
} from "../protocol/encode";
import { decodeJob } from "../protocol/jobDecode";
import type { RuidaLink } from "./link";

/** Status 0x200 bits seen during jobs: 0x10401 running, 0x10403 paused, 0x10600 done (docs/PROTOCOL.md). */
export const STATUS_JOB_ACTIVE = 0x01;
export const STATUS_JOB_PAUSED = 0x02;

/** LightBurn's write size. */
export const JOB_CHUNK_BYTES = 255;

/** "stopping": Stop was sent but the controller still reports the job; the job stays active until it ends. */
export type JobPhase = "checking" | "sending" | "starting" | "running" | "paused" | "stopping" | "done" | "stopped" | "failed";

export interface JobProgress {
  phase: JobPhase;
  /** Seconds since the job was sent. */
  elapsed: number;
  /** Head position, µm. */
  pos: { x: number; y: number } | null;
  status: number | null;
  error?: string;
}

export interface JobBounds {
  mode: "absolute" | "current";
  /** µm, in job coordinates (machine coordinates for absolute jobs, offsets from the head for current ones). */
  min: { x: number; y: number };
  max: { x: number; y: number };
}

/** Mode and bounds of a job, from its commands. Throws if the stream is not a complete job. */
export function inspectJob(commands: Uint8Array[]): JobBounds {
  const first = commands[0];
  if (!first || first[0] !== 0xd8 || !(first[1] === 0x10 || first[1] === 0x12)) {
    throw new Error("Not a job: it must start with D8 10 (absolute) or D8 12 (current position)");
  }
  if (commands.at(-1)?.[0] !== 0xd7) throw new Error("Not a job: it must end with D7");
  const job = decodeJob(commands);
  const pts = job.layers.flatMap((l) => l.paths.flat());
  if (pts.length === 0) throw new Error("The job has no moves");
  const min = { x: Infinity, y: Infinity };
  const max = { x: -Infinity, y: -Infinity };
  for (const p of pts) {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
  }
  return { mode: job.mode, min, max };
}

/** Where on the bed a job will run, in machine µm, given the head position (for current-position jobs). */
export function placeJob(b: JobBounds, head: { x: number; y: number }): { min: { x: number; y: number }; max: { x: number; y: number } } {
  if (b.mode === "absolute") return { min: b.min, max: b.max };
  return { min: { x: head.x + b.min.x, y: head.y + b.min.y }, max: { x: head.x + b.max.x, y: head.y + b.max.y } };
}

export class JobRunner {
  private phase_: JobPhase | null = null;
  private stopRequested = false;

  constructor(
    private link: RuidaLink,
    private opts: { pollMs?: number; startTimeoutMs?: number; chunkBytes?: number; lostAfterMs?: number } = {},
  ) {}

  get phase(): JobPhase | null {
    return this.phase_;
  }

  get active(): boolean {
    return this.phase_ !== null && !["done", "stopped", "failed"].includes(this.phase_);
  }

  private async read(addr: number): Promise<number> {
    const r = (await this.link.query(readMemory(addr), 800, "job")).find((x) => x.addr === addr);
    if (!r) throw new Error(`No reply reading 0x${addr.toString(16)}`);
    return r.value;
  }

  private async snapshot(): Promise<{ status: number; pos: { x: number; y: number } }> {
    const status = await this.read(ADDR_MACHINE_STATUS);
    const pos = { x: await this.read(ADDR_POSITION_X), y: await this.read(ADDR_POSITION_Y) };
    return { status, pos };
  }

  /**
   * Check the machine is idle and the job fits the bed, send it, and watch it until it ends.
   * Resolves with the final phase ("done" or "stopped"); rejects on errors (phase "failed").
   */
  async run(commands: Uint8Array[], onProgress: (p: JobProgress) => void = () => {}): Promise<"done" | "stopped"> {
    if (this.active) throw new Error(t("A job is already running"));
    if (!this.link.verified) throw new Error(t("Not connected and verified"));
    this.stopRequested = false;
    const t0 = performance.now();
    const elapsed = () => (performance.now() - t0) / 1000;
    const report = (phase: JobPhase, s: { status: number; pos: { x: number; y: number } } | null, error?: string) => {
      this.phase_ = phase;
      onProgress({ phase, elapsed: phase === "checking" || phase === "sending" ? 0 : elapsed(), pos: s?.pos ?? null, status: s?.status ?? null, error });
    };
    try {
      report("checking", null);
      const bounds = inspectJob(commands);
      const s0 = await this.snapshot();
      if (s0.status & (STATUS_JOB_ACTIVE | STATUS_MOVING)) throw new Error(t("Machine is busy (status {status})", { status: `0x${s0.status.toString(16)}` }));
      const bed = { x: await this.read(ADDR_BED_X), y: await this.read(ADDR_BED_Y) };
      const at = placeJob(bounds, s0.pos);
      if (at.min.x < 0 || at.min.y < 0 || at.max.x > bed.x || at.max.y > bed.y) {
        const mm = (v: number) => (v / 1000).toFixed(1);
        throw new Error(
          t("Job would run outside the bed: X {x0}–{x1}, Y {y0}–{y1} mm (bed {w} × {h})", {
            x0: mm(at.min.x), x1: mm(at.max.x), y0: mm(at.min.y), y1: mm(at.max.y), w: mm(bed.x), h: mm(bed.y),
          }),
        );
      }

      report("sending", s0);
      const chunks = chunkCommands(commands, this.opts.chunkBytes ?? JOB_CHUNK_BYTES);
      for (let i = 0; i < chunks.length; i++) {
        // Stop during the upload: send nothing more, and stop whatever part of the job the controller already has.
        if (this.stopRequested) {
          await this.link.send(stopJob(), "job stop (upload cut short)");
          break;
        }
        await this.link.send(chunks[i]!, `job ${i + 1}/${chunks.length}`);
      }

      // The controller may not report the job before it has parsed the start of it.
      report("starting", s0);
      const pollMs = this.opts.pollMs ?? 400;
      const startBy = performance.now() + (this.opts.startTimeoutMs ?? 5000);
      let started = false;
      let misses = 0;
      for (;;) {
        await sleep(pollMs);
        let s: { status: number; pos: { x: number; y: number } };
        try {
          s = await this.snapshot();
          misses = 0;
        } catch (e) {
          // A missed reply must not end the watch while the laser may still be cutting (seen once right after
          // D8 01 on the RDC644XS). Keep polling; give up only after several seconds without answers.
          if (++misses * (pollMs + 800) < (this.opts.lostAfterMs ?? 8000)) continue;
          throw new Error(
            t("Lost contact with the controller ({error}). The job may still be running: use the machine's Stop if needed.", { error: e instanceof Error ? e.message : String(e) }),
          );
        }
        const active = (s.status & STATUS_JOB_ACTIVE) !== 0;
        if (active) started = true;
        if (this.stopRequested) {
          if (!active) {
            report("stopped", s);
            return "stopped";
          }
          report("stopping", s);
          continue;
        }
        if (!started) {
          if (performance.now() > startBy) throw new Error(t("The job did not start (status {status})", { status: `0x${s.status.toString(16)}` }));
          report("starting", s);
          continue;
        }
        if (!active) {
          report("done", s);
          return "done";
        }
        report(s.status & STATUS_JOB_PAUSED ? "paused" : "running", s);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report("failed", null, msg);
      throw e;
    }
  }

  async pause(): Promise<void> {
    await this.link.send(pauseJob(), "job pause");
  }

  async resume(): Promise<void> {
    await this.link.send(resumeJob(), "job resume");
  }

  /** D8 01: ends a running job at once; the controller returns the head to the job start. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.link.send(stopJob(), "job stop");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
