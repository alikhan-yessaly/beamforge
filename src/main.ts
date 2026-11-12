import { type ConnKind, atMachine, jogSpeed, connKind as connKindSignal, connMessage, connectAndVerify, disconnectMachine, link, log, motion, runner, selectConnKind, transport, usb } from "./app/connection";
import { effect } from "@preact/signals";
import { MODEL_MAGICS, cardCode, magicForCardId } from "./protocol/cards";
import { queryStatus } from "./protocol/encode";
import { TrafficLog } from "./transport/trafficLog";
import type { PortFilter } from "./transport/webSerial";
import { Activity, BadgeCheck, Download, Eraser, Plug, Send, Unplug, Usb } from "lucide-preact";
import { iconify } from "./ui/icons";
import { mountMachinePanel } from "./ui/machinePanel";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Icon faces for the static connection and log buttons in index.html.
for (const [id, icon, label] of [
  ["connect", Plug, "Connect (reuses the port you picked before)"],
  ["choose-port", Usb, "Choose port… (always show the browser's port chooser)"],
  ["disconnect", Unplug, "Disconnect"],
  ["q-card", BadgeCheck, "Read Card ID (verifies the model)"],
  ["q-status", Activity, "Read status"],
  ["send-hex", Send, "Send hex bytes"],
  ["log-download", Download, "Download the traffic log"],
  ["log-clear", Eraser, "Clear the traffic log"],
] as const) iconify($<HTMLButtonElement>(id), icon, label);


const model = $<HTMLSelectElement>("model");
MODEL_MAGICS.forEach((m, i) => model.add(new Option(m.label, String(i))));
const MODEL_KEY = "ruida-web.model.v1";
try {
  const saved = localStorage.getItem(MODEL_KEY);
  if (saved !== null && MODEL_MAGICS[Number(saved)]) model.value = saved;
} catch {
  /* private mode */
}
const currentMagic = () => MODEL_MAGICS[Number(model.value)]!.magic;
link.setMagic(currentMagic());

const logEl = $("log");
log.subscribe((e) => {
  logEl.textContent += TrafficLog.formatEntry(e) + "\n";
  logEl.scrollTop = logEl.scrollHeight;
});

const connKind = $<HTMLSelectElement>("conn-kind");
connKind.value = transport.kind;
const syncConnKind = () => ($("usb-row").hidden = transport.kind !== "usb");
syncConnKind();
connKind.onchange = () => {
  try {
    selectConnKind(connKind.value as ConnKind);
  } catch (e) {
    connKind.value = transport.kind;
    fail(e);
  }
  syncConnKind();
};
// The top-bar popover can change the type too; keep this select in step.
effect(() => {
  connKind.value = connKindSignal.value;
  syncConnKind();
});

function setConnected(on: boolean, verified = false) {
  connKind.disabled = on;
  $("state").textContent = on ? (verified ? "Connected, verified" : "Connected") : "Disconnected";
  $<HTMLButtonElement>("connect").disabled = on;
  $<HTMLButtonElement>("choose-port").disabled = on;
  $<HTMLButtonElement>("disconnect").disabled = !on;
  $<HTMLButtonElement>("q-card").disabled = !on;
  $<HTMLButtonElement>("q-status").disabled = !on;
  $<HTMLButtonElement>("send-hex").disabled = !on;
}

// Keeps the UI in sync, including when the cable is pulled or the controller powers off.
link.onStateChange((s) => setConnected(s !== "disconnected", s === "verified"));
mountMachinePanel($("machine-panel-root"), link, { motion, runner, atMachine, jogSpeed });

const show = (msg: string) => ($("result").textContent = msg);
effect(() => {
  if (connMessage.value) show(connMessage.value);
});
const fail = (e: unknown) => show(`Error: ${e instanceof Error ? e.message : String(e)}`);

model.onchange = () => {
  link.setMagic(currentMagic());
  try {
    localStorage.setItem(MODEL_KEY, model.value);
  } catch {
    /* private mode */
  }
};

$("choose-port").onclick = () => {
  usb.portFilter = $<HTMLSelectElement>("port-filter").value as PortFilter;
  void connectAndVerify({ chooser: true });
};

$("connect").onclick = () => {
  usb.portFilter = $<HTMLSelectElement>("port-filter").value as PortFilter;
  void connectAndVerify();
};

$("disconnect").onclick = () => void disconnectMachine();

$("q-card").onclick = async () => {
  try {
    const id = await link.verify();
    if (id === null) {
      show("No valid Card ID reply. Check the model selection (magic), cable and power.");
      return;
    }
    const hint = magicForCardId(id);
    const match = hint === link.magic ? "matches" : `DIFFERS from (table suggests 0x${hint.toString(16)})`;
    show(`Card ID = 0x${id.toString(16)} (card code 0x${cardCode(id).toString(16)}); selected magic 0x${link.magic.toString(16)} ${match} the card table.`);
  } catch (e) {
    fail(e);
  }
};

$("q-status").onclick = async () => {
  try {
    const [r] = await link.query(queryStatus());
    show(r ? `Status = 0x${r.value.toString(16)} (raw ${Array.from(r.data, (b) => b.toString(16).padStart(2, "0")).join(" ")})` : "No reply.");
  } catch (e) {
    fail(e);
  }
};

const dev = $<HTMLInputElement>("dev");
dev.onchange = () => {
  link.devMode = dev.checked;
  $("dev-panel").hidden = !dev.checked;
};
document.querySelector<HTMLDetailsElement>(".diagnostics")!.addEventListener("toggle", (event) => {
  if (!(event.currentTarget as HTMLDetailsElement).open && dev.checked) {
    dev.checked = false;
    dev.dispatchEvent(new Event("change"));
  }
});

$("send-hex").onclick = async () => {
  try {
    const text = $<HTMLInputElement>("hex").value.replace(/[\s,]|0x/gi, "");
    if (!/^([0-9a-f]{2})+$/i.test(text)) throw new Error("Enter hex bytes, e.g. DA 00 05 7E");
    await link.send(Uint8Array.from(text.match(/../g)!.map((h) => parseInt(h, 16))), "manual");
  } catch (e) {
    fail(e);
  }
};

$("log-clear").onclick = () => {
  log.clear();
  logEl.textContent = "";
};

$("log-download").onclick = () => {
  const url = URL.createObjectURL(new Blob([log.toText()], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `ruida-traffic-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  a.click();
  URL.revokeObjectURL(url);
};
