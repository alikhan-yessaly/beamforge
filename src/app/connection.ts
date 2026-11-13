// The one connection the page uses, shared by the machine panel (src/main.ts) and the workspace (Preact).
import { type ConnProblem, classifyConnError } from "./troubleshoot";
import { t } from "../i18n";
import { signal } from "@preact/signals";
import { JobRunner } from "../controller/jobRunner";
import { type LinkState, RuidaLink } from "../controller/link";
import { Motion } from "../controller/motion";
import { SimulatorTransport } from "../transport/simulator";
import { SwitchableTransport } from "../transport/switchable";
import { TrafficLog } from "../transport/trafficLog";
import { WebSerialTransport } from "../transport/webSerial";
import { WebSocketTransport } from "../transport/webSocket";
import { identifyController, profile } from "../scene/store";
import { readBedDimensions } from "./machineSettings";

export type ConnKind = "usb" | "sim" | "bridge";
export const CONN_KEY = "ruida-web.conn.v1";

export const log = new TrafficLog();
export const usb = new WebSerialTransport({ baudRate: 115200 });
export const bridge = new WebSocketTransport();
const savedKind = (() => {
  try {
    const k = localStorage.getItem(CONN_KEY);
    return k === "usb" || k === "sim" || k === "bridge" ? k : null; // ignore anything else stored
  } catch {
    return null;
  }
})();
// Browsers without Web Serial (embedded previews) default to the simulator.
const initialKind: ConnKind = savedKind ?? ("serial" in navigator ? "usb" : "sim");
export const transport = new SwitchableTransport<ConnKind>({ usb, sim: new SimulatorTransport(), bridge }, initialKind);
export const link = new RuidaLink(transport, log);
export const motion = new Motion(link);
export const runner = new JobRunner(link);

/** Link state as a signal, for Preact components. */
export const linkState = signal<LinkState>(link.state);
link.onStateChange((s) => (linkState.value = s));

export const bedLoad = signal<{ state: "idle" | "loading" | "ready" | "error"; message: string }>({ state: "idle", message: "" });
let bedRequest = 0;
export async function refreshBedDimensions(): Promise<void> {
  const request = ++bedRequest;
  if (!link.verified) {
    bedLoad.value = { state: "idle", message: "" };
    return;
  }
  bedLoad.value = { state: "loading", message: t("Reading machine bed dimensions…") };
  try {
    const bed = await readBedDimensions(link, () => request === bedRequest);
    if (request !== bedRequest || !link.verified) return;
    motion.bed = { x: Math.round(bed.width * 1000), y: Math.round(bed.height * 1000) };
    // Pick (or confirm) the machine profile for this controller, then take its bed size.
    if (link.cardId !== null) await identifyController(link.cardId, bed.width, bed.height);
    if (request !== bedRequest || !link.verified) return;
    profile.value = { ...profile.value, bedW: bed.width, bedH: bed.height };
    bedLoad.value = { state: "ready", message: t("Machine bed: {w} × {h} mm", { w: bed.width, h: bed.height }) };
  } catch (e) {
    if (request !== bedRequest || !link.verified) return;
    motion.bed = null;
    bedLoad.value = { state: "error", message: t("Could not read machine bed dimensions: {error}", { error: e instanceof Error ? e.message : String(e) }) };
  }
}
link.onStateChange((s) => {
  if (s === "verified") void refreshBedDimensions();
  else {
    bedRequest++;
    bedLoad.value = { state: "idle", message: "" };
  }
});

// ---------- Connect / verify / disconnect, shared by the top-bar popover and the Machine tab ----------

/** Connection type, persisted. Changing it is only possible while disconnected. */
export const connKind = signal<ConnKind>(transport.kind);
export function selectConnKind(kind: ConnKind): void {
  transport.select(kind); // throws while connected
  connKind.value = kind;
  try {
    localStorage.setItem(CONN_KEY, kind);
  } catch {
    /* private mode */
  }
}

/** Human-readable result of the last connection action, and whether one is in progress. */
export const connMessage = signal("");
export const connBusy = signal(false);
/** Why the last connect attempt failed (null after a success, or before any attempt). */
export const connProblem = signal<ConnProblem | null>(null);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Open the port and read the Card ID (a read-only query) in one step. Nothing else is sent unless the Card ID
 * decodes with the selected model's magic (RuidaLink's gate).
 */
export async function connectAndVerify(opts: { chooser?: boolean } = {}): Promise<boolean> {
  if (connBusy.value) return false;
  connBusy.value = true;
  try {
    if (opts.chooser) usb.forceChooser = true;
    if (!transport.isOpen) await link.connect();
    const where = transport.kind === "sim" ? t("the simulator") : transport.kind === "bridge" ? t("the bridge ({port})", { port: bridge.portName ?? "" }) : "USB";
    const id = await link.verify();
    if (id === null) {
      connProblem.value = "no-answer";
      connMessage.value = t("Connected to {where}, but the Card ID did not decode. Check the controller model (Machine tab, developer mode), cable and power.", { where });
      return false;
    }
    connProblem.value = null;
    connMessage.value = t("Connected to {where}; Card ID {id} verified.", { where, id: `0x${id.toString(16)}` });
    return true;
  } catch (e) {
    connProblem.value = classifyConnError(e, transport.kind);
    connMessage.value = t("Could not connect: {error}", { error: errText(e) });
    return false;
  } finally {
    connBusy.value = false;
  }
}

export async function disconnectMachine(): Promise<void> {
  if (runner.active && !window.confirm(t("A job is running. Disconnecting does not stop it. Disconnect anyway?"))) return;
  await link.disconnect();
  connMessage.value = t("Disconnected.");
}

// ---------- Live head position, polled only while some view watches it ----------

/** Head position in machine µm, or null when unknown. */
export const headPos = signal<{ x: number; y: number } | null>(null);
let watchers = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

async function pollPosition(): Promise<void> {
  pollTimer = undefined;
  if (watchers === 0) return;
  // Jobs poll the controller themselves; don't add traffic while one runs.
  if (link.verified && !runner.active) {
    try {
      headPos.value = await motion.position();
    } catch {
      /* a missed reply: try again next tick */
    }
  } else if (!link.verified) headPos.value = null;
  if (watchers > 0) pollTimer = setTimeout(() => void pollPosition(), 1000);
}

/** Start watching the head position (1 s polls while verified). Returns the unsubscribe function. */
export function watchHeadPosition(): () => void {
  watchers++;
  if (watchers === 1 && pollTimer === undefined) void pollPosition();
  return () => {
    watchers = Math.max(0, watchers - 1);
  };
}
link.onStateChange((s) => {
  if (s !== "verified") headPos.value = null;
  else if (watchers > 0 && pollTimer === undefined) void pollPosition();
});

// ---------- Jog state shared by the Machine tab's jog pad and keyboard jog ----------

/** "I'm at the machine, the lid is closed and the path is clear": required for any jog; cleared on disconnect. */
export const atMachine = signal(false);
/** Jog speed, mm/s (the jog pad's field). */
export const jogSpeed = signal(20);
link.onStateChange((s) => {
  if (s !== "verified") atMachine.value = false;
});
