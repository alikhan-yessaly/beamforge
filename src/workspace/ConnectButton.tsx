// Top-bar connection button: shows the machine state at a glance; its popover connects (and verifies the
// Card ID in the same step), picks the connection type, and shows bed size and head position.
import { msg, t } from "../i18n";
import { Cable, ChevronDown, Monitor, Plug, PlugZap, TriangleAlert, Unplug, Usb } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type ConnKind,
  bedLoad,
  connBusy,
  connKind,
  connMessage,
  connProblem,
  connectAndVerify,
  disconnectMachine,
  headPos,
  linkState,
  selectConnKind,
  watchHeadPosition,
} from "../app/connection";
import { IconButton } from "../ui/icons";
import { connHelpOpen } from "./ConnectionHelp";
import { framing } from "./RunPanel";

const KINDS: { kind: ConnKind; icon: typeof Usb; label: string }[] = [
  { kind: "usb", icon: Usb, label: msg("USB (Chrome or Edge)") },
  { kind: "bridge", icon: Cable, label: msg("Dev bridge (npm run bridge)") },
  { kind: "sim", icon: Monitor, label: msg("Simulator (no hardware)") },
];

export type MachineState = "ok" | "warn" | "off";

export function machineState(): MachineState {
  if (linkState.value === "disconnected") return "off";
  return linkState.value === "verified" && bedLoad.value.state === "ready" ? "ok" : "warn";
}

export function machineText(): string {
  if (linkState.value === "verified") {
    return bedLoad.value.state === "ready" ? t("connected") : bedLoad.value.state === "error" ? t("bed size read failed") : t("reading bed size…");
  }
  if (connBusy.value) return t("connecting…");
  return linkState.value === "connected" ? t("connected, Card ID not verified") : t("disconnected");
}

const mm = (um: number) => (um / 1000).toFixed(1);

/** Short visible text on the top-bar button, so the state reads without hovering or relying on colour. */
function buttonText(state: MachineState): string {
  if (connBusy.value) return t("Connecting…");
  if (state === "off") return t("Connect");
  if (connKind.value === "sim") return t("Simulator");
  return state === "ok" ? t("Machine connected") : t("Machine: check");
}

/** Disconnecting closes the link only: a running job or frame carries on in the controller. */
async function disconnect(): Promise<void> {
  if (framing.value && !window.confirm(t("A frame is running. Disconnecting does not stop it. Disconnect anyway?"))) return;
  await disconnectMachine();
}

export function ConnectButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const state = machineState();
  const connected = linkState.value !== "disconnected";

  useEffect(() => {
    if (!open) return;
    const unwatch = watchHeadPosition();
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      unwatch();
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const icon = connected && connKind.value === "sim" ? Monitor : state === "ok" ? PlugZap : state === "warn" ? TriangleAlert : Unplug;
  const pos = headPos.value;
  return (
    <div class="ws-connect" ref={ref}>
      <div class="ws-split">
        <IconButton
          icon={icon}
          class={`ws-machine-status ${state}${connected && connKind.value === "sim" ? " sim" : ""}`}
          label={connected ? t("Machine: {state}", { state: machineText() }) : t("Connect to the machine ({kind}); Card ID is checked automatically", { kind: t(KINDS.find((k) => k.kind === connKind.value)?.label ?? "") })}
          disabled={connBusy.value}
          onClick={() => (connected ? setOpen(!open) : void connectAndVerify().then((ok) => !ok && connProblem.value && setOpen(true)))}
        >
          <span class="ib-text">{buttonText(state)}</span>
        </IconButton>
        <IconButton icon={ChevronDown} class="ws-split-more" label={t("Connection options")} pressed={open} onClick={() => setOpen(!open)} />
      </div>
      {open && (
        <div class="ws-popover" role="dialog" aria-label={t("Machine connection")}>
          <div class="ws-popover-head">
            <span class={`ws-dot ${state}`} />
            <b>{connKind.value === "sim" ? t("Simulator: {state}", { state: machineText() }) : t("Machine: {state}", { state: machineText() })}</b>
          </div>
          {connected && connKind.value === "sim" && <p class="ws-hint ws-sim-note">{t("Simulated controller: no hardware moves and no laser fires. A job that runs here is not proof it is safe on a real machine.")}</p>}
          <div class="ws-segmented" role="group" aria-label={t("Connection type")}>
            {KINDS.map((k) => (
              <IconButton
                key={k.kind}
                icon={k.icon}
                label={t(k.label)}
                pressed={connKind.value === k.kind}
                disabled={connected}
                onClick={() => {
                  try {
                    selectConnKind(k.kind);
                  } catch (e) {
                    connMessage.value = e instanceof Error ? e.message : String(e);
                  }
                }}
              />
            ))}
          </div>
          <dl class="ws-popover-facts">
            <dt>{t("Via")}</dt>
            <dd>{t(KINDS.find((k) => k.kind === connKind.value)?.label ?? "")}</dd>
            {bedLoad.value.state === "ready" && (
              <>
                <dt>{t("Bed")}</dt>
                <dd>{bedLoad.value.message.replace(/^Machine bed: /, "")}</dd>
              </>
            )}
            {pos && (
              <>
                <dt>{t("Head")}</dt>
                <dd>
                  X {mm(pos.x)} · Y {mm(pos.y)} mm
                </dd>
              </>
            )}
          </dl>
          {connMessage.value && <p class="ws-hint">{connMessage.value}</p>}
          {connProblem.value && !connected && (
            <button type="button" class="ws-link-btn" onClick={() => ((connHelpOpen.value = true), setOpen(false))}>
              {t("Can't connect? Step-by-step help")}
            </button>
          )}
          <div class="ws-row">
            {connected ? (
              <IconButton icon={Unplug} label={t("Disconnect")} onClick={() => void disconnect()} />
            ) : (
              <>
                <IconButton icon={Plug} class="ws-primary" label={t("Connect and verify the Card ID")} disabled={connBusy.value} onClick={() => void connectAndVerify()} />
                {connKind.value === "usb" && (
                  <IconButton icon={Usb} label={t("Choose a USB port…")} disabled={connBusy.value} onClick={() => void connectAndVerify({ chooser: true })} />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
