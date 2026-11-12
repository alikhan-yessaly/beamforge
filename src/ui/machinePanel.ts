import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Crosshair, type LucideIcon, Navigation, OctagonX, Pause, Play, RefreshCw, Square } from "lucide-preact";
import { iconify } from "./icons";
import { type Signal, effect } from "@preact/signals";
import type { JobRunner } from "../controller/jobRunner";
import { MAX_SPEED_MM_S, Motion, StoppedError } from "../controller/motion";
import type { LinkState, RuidaLink } from "../controller/link";
import { formatStress, runStressTest } from "../controller/stress";
import type { MemoryReply } from "../protocol/decode";
import {
  ADDR_MACHINE_STATUS,
  ADDR_POSITION_X,
  ADDR_POSITION_Y,
  JOG_KEY,
  type JogKey,
  addrFromBytes,
  addrToHex,
  queryStatus,
  readMemory,
} from "../protocol/encode";
import { parseHex, toHex } from "./hex";

/**
 * M1 hardware bring-up panel: STOP/Pause/Resume, status + position poller, jog, send stress test.
 * Everything that transmits is disabled until the link is verified (Card ID decoded).
 */

const CSS = `
.mp-stopbar { display: flex; gap: .5rem; align-items: center; }
.mp-stop { background: #b91c1c; color: #fff; font-weight: 700; padding: .55rem 1rem; border: 0; border-radius: 6px; cursor: pointer; }
.mp-stop:disabled { background: #d99; cursor: not-allowed; }
.mp-stopbar .mp-state { font-size: .8rem; max-width: 9rem; }
.mp-table { border-collapse: collapse; font-family: ui-monospace, monospace; font-size: .85rem; margin-top: .5rem; }
.mp-table td, .mp-table th { border: 1px solid #ccc; padding: .2rem .5rem; text-align: left; }
.mp-addr { width: 4.5rem; font-family: ui-monospace, monospace; }
.mp-num { width: 5.5rem; }
.mp-jog { display: grid; grid-template-columns: repeat(3, 4.5rem); gap: .3rem; margin: .5rem 0; }
.mp-jog button { padding: .6rem 0; font-weight: 600; }
.mp-unverified { color: #a00; font-weight: 700; }
fieldset.mp-gate { border: 0; margin: 0; padding: 0; min-width: 0; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const { cls, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
};
const row = (...kids: (Node | string)[]) => el("div", { cls: "row" }, ...kids);
const label = (text: string, input: HTMLElement) => el("label", {}, text + " ", input);
const num = (value: number, min: number, max: number, step = 1) =>
  el("input", { type: "number", value: String(value), min: String(min), max: String(max), step: String(step), cls: "mp-num" });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function mountMachinePanel(
  container: HTMLElement,
  link: RuidaLink,
  shared: { motion?: Motion; runner?: JobRunner; atMachine?: Signal<boolean>; jogSpeed?: Signal<number> } = {},
): () => void {
  if (!document.getElementById("mp-style")) document.head.append(el("style", { id: "mp-style", textContent: CSS }));

  const cleanups: (() => void)[] = [];
  let stressAbort: AbortController | null = null;

  // ---------- STOP / Pause / Resume (fixed, always visible) ----------
  // Share Motion with the workspace so one STOP cancels every queued segment, whoever started the move.
  const motion = shared.motion ?? new Motion(link);
  const stopBtn = iconify(
    el("button", { cls: "mp-stop" }),
    OctagonX,
    "Software STOP (Esc). Not an emergency stop: stops jobs and jogs, cancels queued move segments, sends D8 01. Cannot halt a frame or a move segment already running.",
    22,
  );
  const stopState = el("span", { cls: "mp-state small" });
  const stopbar = el("div", { cls: "mp-stopbar" }, stopBtn, stopState);
  stopbar.id = "software-stop";
  document.body.append(stopbar);
  cleanups.push(() => stopbar.remove());

  const doStop = async () => {
    stressAbort?.abort();
    const operations: Promise<void>[] = [];
    if (shared.runner?.active) operations.push(shared.runner.stop());
    operations.push(motion.stop());
    const results = await Promise.allSettled(operations);
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    stopState.textContent = errors.length
      ? `STOP failed: ${errors.map((e) => errText(e.reason)).join("; ")}`
      : `STOP sent ${new Date().toLocaleTimeString()}`;
  };
  stopBtn.onclick = () => void doStop();
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && link.verified) {
      ev.preventDefault();
      void doStop();
    }
  };
  window.addEventListener("keydown", onKey);
  cleanups.push(() => window.removeEventListener("keydown", onKey));

  // ---------- Status / position poller ----------
  const addrStatus = el("input", { value: addrToHex(ADDR_MACHINE_STATUS), cls: "mp-addr" });
  const addrX = el("input", { value: addrToHex(ADDR_POSITION_X), cls: "mp-addr" });
  const addrY = el("input", { value: addrToHex(ADDR_POSITION_Y), cls: "mp-addr" });
  const interval = num(500, 100, 10000, 100);
  const pollBtn = iconify(el("button"), Play, "Start polling");
  const readOnceBtn = iconify(el("button"), RefreshCw, "Read once");
  const pollInfo = el("span", { cls: "small" });
  const liveInfo = el("p", { cls: "small", textContent: "Status and position not yet read." });
  const tbody = el("tbody");
  const table = el(
    "table",
    { cls: "mp-table" },
    el("thead", {}, el("tr", {}, ...["Item", "Addr", "Raw 5 bytes", "Value", "Hex", "÷1000 (mm if µm)"].map((h) => el("th", {}, h)))),
    tbody,
  );
  let lastPosUm: { x: number; y: number } | null = null;
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollCount = 0;
  let missCount = 0;

  const parseAddr = (input: HTMLInputElement) => {
    const b = parseHex(input.value);
    if (b.length !== 2 || b[0]! > 0x7f || b[1]! > 0x7f) throw new Error(`Address "${input.value}" must be two bytes 00-7F, e.g. 04 21`);
    return addrFromBytes(b[0]!, b[1]!);
  };

  const renderRow = (name: string, addr: number, r: MemoryReply | undefined, extra = "") => {
    const cells = r
      ? [name, addrToHex(addr), toHex(r.data), String(r.value), "0x" + (r.value >>> 0).toString(16), (r.value / 1000).toFixed(3) + extra]
      : [name, addrToHex(addr), "no reply", "", "", ""];
    return el("tr", {}, ...cells.map((c) => el("td", {}, c)));
  };

  async function readOnce(): Promise<void> {
    const items: [string, number][] = [
      ["Status", parseAddr(addrStatus)],
      ["X position", parseAddr(addrX)],
      ["Y position", parseAddr(addrY)],
    ];
    const results: (MemoryReply | undefined)[] = [];
    for (const [, addr] of items) {
      const q = addr === ADDR_MACHINE_STATUS ? queryStatus() : readMemory(addr);
      const replies = await link.query(q, 500, "poll");
      results.push(replies.find((x) => x.addr === addr));
    }
    pollCount++;
    if (results.some((r) => !r)) missCount++;
    const [st, x, y] = results;
    lastPosUm = x && y ? { x: x.value, y: y.value } : null;
    const standard = items[0]![1] === ADDR_MACHINE_STATUS && items[1]![1] === ADDR_POSITION_X && items[2]![1] === ADDR_POSITION_Y;
    liveInfo.textContent = standard
      ? `Status ${st ? "0x" + st.value.toString(16) : "no reply"} · X ${x ? (x.value / 1000).toFixed(2) + " mm" : "no reply"} · Y ${y ? (y.value / 1000).toFixed(2) + " mm" : "no reply"}`
      : "Custom diagnostic addresses selected; see diagnostics for readings.";
    const stBits = st ? `  bits ${(st.value >>> 0).toString(2).padStart(8, "0")}${st.value & 0x10 ? " (0x10 set: moving?)" : ""}` : "";
    tbody.replaceChildren(
      renderRow(items[0]![0], items[0]![1], st),
      el("tr", {}, el("td", { colSpan: 6 }, stBits || "—")),
      renderRow(items[1]![0], items[1]![1], x),
      renderRow(items[2]![0], items[2]![1], y),
    );
    pollInfo.textContent = `${pollCount} reads, ${missCount} with a missing reply, last ${new Date().toLocaleTimeString()}`;
  }

  const stopPolling = () => {
    polling = false;
    clearTimeout(pollTimer);
    iconify(pollBtn, Play, "Start polling");
  };
  const pollLoop = async () => {
    if (!polling) return;
    if (!stressAbort) {
      try {
        await readOnce();
      } catch (e) {
        pollInfo.textContent = `Poll error: ${errText(e)}`;
        liveInfo.textContent = pollInfo.textContent;
        stopPolling();
        return;
      }
    }
    if (polling) pollTimer = setTimeout(pollLoop, Math.max(100, Number(interval.value) || 500));
  };
  pollBtn.onclick = () => {
    if (polling) return stopPolling();
    polling = true;
    iconify(pollBtn, Pause, "Stop polling");
    void pollLoop();
  };
  readOnceBtn.onclick = () => readOnce().catch((e) => { pollInfo.textContent = `Error: ${errText(e)}`; liveInfo.textContent = pollInfo.textContent; });
  cleanups.push(stopPolling);

  const pollSection = el(
    "section",
    {},
    el("h2", {}, "Machine status"),
    el(
      "p",
      { cls: "small" },
      "Reads ",
      el("code", {}, "DA 00 <addr>"),
      " for each address. Addresses are the two wire bytes after DA 00. ",
      "X/Y position (04 21 / 04 31, in µm from home) are verified on hardware.",
    ),
    row(label("Status", addrStatus), label("X", addrX), label("Y", addrY), label("Interval ms", interval)),
    row(pollInfo),
    table,
  );

  // ---------- Jog / Go to (verified commands, see controller/motion.ts) ----------
  const atMachine = el("input", { type: "checkbox" });
  const speed = num(20, 1, MAX_SPEED_MM_S);
  const continuous = el("input", { type: "checkbox", checked: true });
  const stepSel = el("select");
  [0.1, 1, 5, 10, 50].forEach((st) => stepSel.add(new Option(`${st} mm`, String(st), st === 1, st === 1)));
  const jogInfo = el("pre", { cls: "result" });
  const showErr = (e: unknown) => {
    if (!(e instanceof StoppedError)) jogInfo.textContent = `Error: ${errText(e)}`;
  };
  const speedVal = () => Number(speed.value);
  // Arrow keys as the controller keypad defines them. Measured on an origin-top-right machine:
  // left = +X, right = -X, up = -Y, down = +Y (machine coordinates).
  const STEP_DIR: Record<JogKey, [number, number]> = { 0: [1, 0], 1: [-1, 0], 2: [0, -1], 3: [0, 1] };
  const jogBtn = (text: string, key: JogKey, icon: LucideIcon) => {
    const b = iconify(el("button"), icon, `Jog ${text}`);
    let held = false;
    const release = () => {
      if (!held) return;
      held = false;
      motion.jogRelease().catch(showErr);
    };
    b.onpointerdown = (ev) => {
      if (!continuous.checked) return;
      try {
        b.setPointerCapture(ev.pointerId);
      } catch {
        /* synthetic events have no active pointer; pointerup/leave still release */
      }
      held = true;
      jogInfo.textContent = `Jogging ${text} at ${speedVal()} mm/s (release to stop)`;
      motion.jogPress(key, speedVal()).catch((e) => {
        held = false;
        showErr(e);
      });
    };
    b.onpointerup = release;
    b.onpointercancel = release;
    b.onlostpointercapture = release;
    b.onpointerleave = release;
    b.onclick = async () => {
      if (continuous.checked) return;
      try {
        const step = Number(stepSel.value) * 1000;
        const [dx, dy] = STEP_DIR[key];
        const p = await motion.position();
        jogInfo.textContent = `Step ${text} ${stepSel.value} mm`;
        await motion.moveTo({ x: p.x + dx * step, y: p.y + dy * step }, speedVal());
        const q = await motion.position();
        jogInfo.textContent = `At X ${(q.x / 1000).toFixed(3)}  Y ${(q.y / 1000).toFixed(3)} mm`;
      } catch (e) {
        showErr(e);
      }
    };
    return b;
  };
  const releaseAll = () => void motion.jogRelease().catch(showErr);
  window.addEventListener("blur", releaseAll);
  cleanups.push(() => window.removeEventListener("blur", releaseAll));
  const blank = () => el("span");
  const jogGrid = el(
    "div",
    { cls: "mp-jog" },
    blank(), jogBtn("up", JOG_KEY.up, ArrowUp), blank(),
    jogBtn("left", JOG_KEY.left, ArrowLeft), blank(), jogBtn("right", JOG_KEY.right, ArrowRight),
    blank(), jogBtn("down", JOG_KEY.down, ArrowDown), blank(),
  );
  const goX = num(0, 0, 10000, 0.1);
  const goY = num(0, 0, 10000, 0.1);
  const goBtn = iconify(el("button"), Navigation, "Go to this position");
  const hereBtn = iconify(el("button"), Crosshair, "Use the current head position");
  goBtn.onclick = async () => {
    try {
      jogInfo.textContent = `Moving to ${goX.value}, ${goY.value} mm…`;
      await motion.moveTo({ x: Number(goX.value) * 1000, y: Number(goY.value) * 1000 }, speedVal(), (p) => {
        jogInfo.textContent = `Moving… X ${(p.x / 1000).toFixed(1)}  Y ${(p.y / 1000).toFixed(1)} mm`;
      });
      jogInfo.textContent = `Arrived at ${goX.value}, ${goY.value} mm`;
    } catch (e) {
      if (e instanceof StoppedError) jogInfo.textContent = "Stopped.";
      else showErr(e);
    }
  };
  hereBtn.onclick = async () => {
    try {
      const p = await motion.position();
      goX.value = (p.x / 1000).toFixed(2);
      goY.value = (p.y / 1000).toFixed(2);
    } catch (e) {
      showErr(e);
    }
  };
  const jogControls = el(
    "fieldset",
    { cls: "mp-gate" },
    row(label("Speed mm/s", speed), label("Hold to jog", continuous), label("Step", stepSel)),
    jogGrid,
    row(el("strong", {}, "Go to (machine mm)"), label("X", goX), label("Y", goY), goBtn, hereBtn),
    jogInfo,
  );
  const jogSection = el(
    "section",
    {},
    el("h2", {}, "Jog"),
    el(
      "p",
      { cls: "small" },
      "Hold an arrow to move; release to stop. Go to moves in short steps, so STOP (or Esc) halts it.",
    ),
    row(label("I'm at the machine, the lid is closed and the path is clear", atMachine)),
    jogControls,
  );

  // ---------- Stress test ----------
  const payloadSel = el("select");
  payloadSel.add(new Option("Status query DA 00 04 00 (read-only)", "status"));
  payloadSel.add(new Option("Custom hex (repeated)", "custom"));
  const customHex = el("input", { placeholder: "unswizzled hex, e.g. DA 00 05 7E", size: 34 });
  const repeat = num(200, 1, 100000);
  const chunkSize = num(1024, 1, 65536);
  const delay = num(0, 0, 10000);
  const settle = num(1000, 0, 10000, 100);
  const runBtn = iconify(el("button"), Play, "Run stress test");
  const abortBtn = iconify(el("button", { disabled: true }), Square, "Abort the stress test");
  const stressInfo = el("pre", { cls: "result" });
  runBtn.onclick = async () => {
    let payload: Uint8Array;
    try {
      payload = payloadSel.value === "status" ? queryStatus() : parseHex(customHex.value);
      if ((payload[0]! & 0x80) === 0) throw new Error("Payload must start with a command byte (>= 0x80)");
    } catch (e) {
      stressInfo.textContent = errText(e);
      return;
    }
    stressAbort = new AbortController();
    runBtn.disabled = true;
    abortBtn.disabled = false;
    stressInfo.textContent = "Running…";
    try {
      const r = await runStressTest(link, {
        payload,
        repeat: Number(repeat.value),
        chunkSize: Number(chunkSize.value),
        delayMs: Number(delay.value),
        settleMs: Number(settle.value),
        signal: stressAbort.signal,
        onProgress: (n, total) => (stressInfo.textContent = `Running… ${n}/${total} chunks`),
      });
      stressInfo.textContent = formatStress(r).replace(/; /g, "\n");
    } catch (e) {
      stressInfo.textContent = `Not run: ${errText(e)}`;
    } finally {
      stressAbort = null;
      abortBtn.disabled = true;
      update(link.state);
    }
  };
  abortBtn.onclick = () => stressAbort?.abort();
  const stressControls = el(
    "fieldset",
    { cls: "mp-gate" },
    row(label("Payload", payloadSel), customHex),
    row(label("Repeat", repeat), label("Chunk bytes", chunkSize), label("Delay ms", delay), label("Count replies for ms", settle)),
    row(runBtn, abortBtn),
  );
  const stressSection = el(
    "section",
    {},
    el("h2", {}, "Send stress test"),
    el(
      "p",
      { cls: "small" },
      "Sends the payload Repeat times in chunks (cut at command boundaries) and times every write. A write over 50 ms counts as blocked. With the status query, every query should get one reply: fewer replies than queries means the controller dropped data. Polling pauses during the test. Custom payloads go through the same safety checks as everything else (no memory writes).",
    ),
    stressControls,
    stressInfo,
  );

  const statusSection = el("section", { cls: "dev-only" }, el("h2", {}, "Status and position"), row(readOnceBtn, pollBtn), liveInfo);
  const root = el("div", { id: "machine-panel" }, statusSection, jogSection);
  container.append(root);
  const diagnostics = document.getElementById("diagnostics-machine");
  if (!diagnostics) throw new Error("Missing diagnostics container");
  diagnostics.append(pollSection, stressSection);
  cleanups.push(() => { pollSection.remove(); stressSection.remove(); });
  cleanups.push(() => root.remove());

  // ---------- Gating ----------
  const gated: HTMLElement[] = [readOnceBtn, pollBtn];
  function update(s: LinkState) {
    const ok = s === "verified";
    stopBtn.disabled = !ok;
    stopState.textContent = ok ? "Link verified" : s === "connected" ? "Read the Card ID to enable" : "Disconnected";
    gated.forEach((b) => ((b as HTMLButtonElement).disabled = !ok));
    if (!ok) {
      stopPolling();
      liveInfo.textContent = "Status and position not yet read.";
      stressAbort?.abort();
      atMachine.checked = false;
      lastPosUm = null;
      motion.bed = null;
    }
    atMachine.disabled = !ok;
    jogControls.disabled = !(ok && atMachine.checked);
    stressControls.disabled = !ok;
    runBtn.disabled = !ok || !!stressAbort;
  }
  atMachine.onchange = () => {
    shared.atMachine && (shared.atMachine.value = atMachine.checked);
    update(link.state);
  };
  speed.addEventListener("input", () => shared.jogSpeed && (shared.jogSpeed.value = Number(speed.value) || 20));
  // Keyboard jog or a disconnect can change the shared state; mirror it here.
  if (shared.atMachine) {
    const stop = effect(() => {
      const on = shared.atMachine!.value;
      if (atMachine.checked !== on) {
        atMachine.checked = on;
        update(link.state);
      }
    });
    cleanups.push(stop);
  }
  cleanups.push(link.onStateChange(update));
  update(link.state);

  return () => cleanups.forEach((c) => c());
}
