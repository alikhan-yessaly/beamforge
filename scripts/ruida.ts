// Command the laser from a terminal through the dev bridge (npm run bridge) or the simulator.
// Uses the same RuidaLink + Motion code as the app: Card ID is verified first, memory writes are refused,
// moves are clamped to the bed and split into short segments, and Ctrl-C sends STOP.
//
// npm run ruida -- <command> [args] [--sim] [--speed mm/s] [--url ws://127.0.0.1:8765]
//   status                      card ID, status, head position, bed size
//   pos                         head position (mm)
//   goto X Y                    absolute move, machine mm
//   move DX DY                  relative move, mm
//   jog left|right|up|down S    hold-to-jog for S seconds (max 5)
//   frame X0 Y0 X1 Y1           trace a rectangle (laser off), smooth; Ctrl-C cannot halt it
//   stop                        STOP: release jog keys, D8 01
//   read ADDR...                read memory, ADDR as two 7-bit hex bytes ("04 21") or 14-bit hex (0x221)
//   watch [SECONDS]             print position/status every 200 ms
//   make-square SIZE OUT.rd [X Y]  write a square job (SIZE mm); at machine X Y, or at the head if X Y are omitted
//                               (--speed cut mm/s, default 20; --power MIN/MAX %, default 10/15)
//   frame-job FILE.rd           trace the job's bounding box (laser off) and return; smooth, not haltable
//   run FILE.rd                 run a job (fires the laser!); Ctrl-C stops it
import { readFileSync, writeFileSync } from "node:fs";
import { frameJob } from "../src/controller/frame";
import { JobRunner, inspectJob } from "../src/controller/jobRunner";
import { RuidaLink } from "../src/controller/link";
import { Motion, StoppedError } from "../src/controller/motion";
import { ADDR_MACHINE_STATUS, JOG_KEY, type JogKey, readMemory } from "../src/protocol/encode";
import { encodeJob } from "../src/protocol/jobEncode";
import { parseRd } from "../src/protocol/rd";
import { SimulatorTransport } from "../src/transport/simulator";
import { TrafficLog } from "../src/transport/trafficLog";
import { DEFAULT_BRIDGE_URL, WebSocketTransport } from "../src/transport/webSocket";

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && a !== "--sim" && a !== "--verbose") {
      flags.set(a, next);
      i++;
    } else flags.set(a, true);
  } else pos.push(a);
}
const [cmd, ...rest] = pos;
const speed = Number(flags.get("--speed") ?? 20);
const mm = (um: number) => (um / 1000).toFixed(3);
const num = (s: string | undefined, what: string) => {
  const v = Number(s);
  if (s === undefined || !Number.isFinite(v)) throw new Error(`${what} must be a number`);
  return v;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Offline commands: no connection needed. */
function offline(): boolean {
  if (cmd !== "make-square") return false;
  const size = num(rest[0], "SIZE") * 1000;
  const out = rest[1];
  if (!out) throw new Error("make-square SIZE OUT.rd [X Y]");
  if (!(size > 0 && size <= 300000)) throw new Error("SIZE must be 0-300 mm");
  const at = rest[2] !== undefined ? { x: num(rest[2], "X") * 1000, y: num(rest[3], "Y") * 1000 } : null;
  const [minP, maxP] = String(flags.get("--power") ?? "10/15").split("/").map(Number) as [number, number];
  if (!(minP >= 0 && maxP >= minP && maxP <= 100)) throw new Error("--power MIN/MAX in %, e.g. 10/15");
  const o = at ?? { x: 0, y: 0 };
  const path = [o, { x: o.x + size, y: o.y }, { x: o.x + size, y: o.y + size }, { x: o.x, y: o.y + size }, o];
  const bytes = encodeJob({ mode: at ? "absolute" : "current", layers: [{ speed, minPower: minP, maxPower: maxP, color: "#000000", paths: [path] }] });
  writeFileSync(out, bytes);
  console.log(`${out}: ${size / 1000} mm square, ${at ? `absolute at X ${mm(o.x)} Y ${mm(o.y)}` : "at the head (current position)"}, ${speed} mm/s, ${minP}/${maxP} %`);
  return true;
}

function loadJob(file: string | undefined) {
  if (!file) throw new Error("give an .rd file");
  const commands = parseRd(new Uint8Array(readFileSync(file))).commands;
  const b = inspectJob(commands);
  console.log(`${file}: ${b.mode} job, X ${mm(b.min.x)}–${mm(b.max.x)}  Y ${mm(b.min.y)}–${mm(b.max.y)} mm${b.mode === "current" ? " (from the head)" : ""}`);
  return { commands, bounds: b };
}

async function main() {
  if (offline()) return;
  if (!cmd) {
    console.log("usage: npm run ruida -- <status|pos|goto X Y|move DX DY|jog DIR S|frame X0 Y0 X1 Y1|stop|read ADDR…|watch [S]|make-square SIZE OUT.rd [X Y]|frame-job FILE.rd|run FILE.rd> [--sim] [--speed mm/s]");
    process.exit(2);
  }
  const log = new TrafficLog();
  const transport = flags.has("--sim") ? new SimulatorTransport() : new WebSocketTransport(String(flags.get("--url") ?? DEFAULT_BRIDGE_URL));
  if (flags.has("--verbose")) log.subscribe((e) => console.error(TrafficLog.formatEntry(e)));
  const link = new RuidaLink(transport, log);
  await link.connect();
  if ((await link.verify()) === null) throw new Error("No valid Card ID reply (wrong model/magic, or controller off)");
  const motion = new Motion(link);
  const runner = new JobRunner(link);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.error("\nCtrl-C: sending STOP");
    (runner.active ? runner.stop() : motion.stop())
      .catch(() => {})
      .finally(() => setTimeout(() => process.exit(130), runner.active ? 3000 : 300));
  });

  const where = async () => {
    const p = await motion.position();
    return `X ${mm(p.x)}  Y ${mm(p.y)} mm${(await motion.isMoving()) ? "  (moving)" : ""}`;
  };
  const progress = (p: { x: number; y: number }) => process.stderr.write(`\r  → X ${mm(p.x)}  Y ${mm(p.y)}   `);

  try {
    switch (cmd) {
      case "status": {
        const bed = await motion.bedSize();
        const st = (await link.query(readMemory(ADDR_MACHINE_STATUS), 500))[0]?.value ?? NaN;
        console.log(`card 0x${link.cardId!.toString(16)}  status 0x${st.toString(16)}  bed ${mm(bed.x)} × ${mm(bed.y)} mm`);
        console.log(await where());
        break;
      }
      case "pos":
        console.log(await where());
        break;
      case "goto": {
        await motion.moveTo({ x: num(rest[0], "X") * 1000, y: num(rest[1], "Y") * 1000 }, speed, progress);
        process.stderr.write("\n");
        console.log(await where());
        break;
      }
      case "move": {
        const p = await motion.position();
        await motion.moveTo({ x: p.x + num(rest[0], "DX") * 1000, y: p.y + num(rest[1], "DY") * 1000 }, speed, progress);
        process.stderr.write("\n");
        console.log(await where());
        break;
      }
      case "jog": {
        const key = JOG_KEY[rest[0] as keyof typeof JOG_KEY] as JogKey | undefined;
        if (key === undefined) throw new Error("jog direction: left|right|up|down");
        const s = num(rest[1] ?? "0.5", "seconds");
        if (!(s > 0 && s <= 5)) throw new Error("jog time must be 0-5 s");
        await motion.jogPress(key, speed);
        await sleep(s * 1000);
        await motion.jogRelease();
        await sleep(100);
        console.log(await where());
        break;
      }
      case "frame": {
        const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => num(rest[i], "frame coordinate") * 1000) as [number, number, number, number];
        console.error("Framing: one queued move, smooth. Ctrl-C can't halt it; use the machine's Stop if needed.");
        await motion.frame({ x: Math.min(x0, x1), y: Math.min(y0, y1) }, { x: Math.max(x0, x1), y: Math.max(y0, y1) }, speed, progress);
        process.stderr.write("\n");
        console.log(await where());
        break;
      }
      case "frame-job": {
        const { bounds } = loadJob(rest[0]);
        console.error("Framing: one queued move, smooth. Ctrl-C can't halt it; use the machine's Stop if needed.");
        await frameJob(motion, bounds, speed, progress);
        process.stderr.write("\n");
        console.log(await where());
        break;
      }
      case "run": {
        const { commands } = loadJob(rest[0]);
        const end = await runner.run(commands, (p) => {
          const at = p.pos ? `X ${mm(p.pos.x)} Y ${mm(p.pos.y)}` : "";
          const st = p.status !== null ? `status 0x${p.status.toString(16)}` : "";
          process.stderr.write(`\r  ${p.phase.padEnd(8)} ${p.elapsed.toFixed(1).padStart(6)} s  ${at}  ${st}   `);
        });
        process.stderr.write("\n");
        console.log(`Job ${end}.`);
        console.log(await where());
        break;
      }
      case "stop":
        await motion.stop();
        console.log("STOP sent");
        break;
      case "read": {
        for (const a of rest.length ? [rest.join(" ")].flatMap((s) => s.split(",")) : []) {
          const t = a.trim();
          const b = t.split(/\s+/);
          const addr = b.length === 2 ? ((parseInt(b[0]!, 16) & 0x7f) << 7) | (parseInt(b[1]!, 16) & 0x7f) : parseInt(t, 16);
          const r = (await link.query(readMemory(addr), 500)).find((x) => x.addr === addr);
          console.log(`0x${addr.toString(16).padStart(3, "0")}: ${r ? `${r.value} (0x${(r.value >>> 0).toString(16)})` : "no reply"}`);
        }
        break;
      }
      case "watch": {
        const until = Date.now() + num(rest[0] ?? "5", "seconds") * 1000;
        while (Date.now() < until) {
          console.log(`${new Date().toISOString().slice(11, 23)}  ${await where()}`);
          await sleep(200);
        }
        break;
      }
      default:
        throw new Error(`Unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof StoppedError) console.error("\nStopped.");
    else throw e;
  } finally {
    await link.disconnect();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
