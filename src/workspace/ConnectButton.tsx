// Top-bar connection button: shows the machine state at a glance; its popover connects (and verifies the
// Card ID in the same step), picks the connection type, and shows bed size and head position.
import { Cable, ChevronDown, Monitor, Plug, PlugZap, TriangleAlert, Unplug, Usb } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type ConnKind,
  bedLoad,
  connBusy,
  connKind,
  connMessage,
  connectAndVerify,
  disconnectMachine,
  headPos,
  linkState,
  selectConnKind,
  watchHeadPosition,
} from "../app/connection";
import { IconButton } from "../ui/icons";

const KINDS: { kind: ConnKind; icon: typeof Usb; label: string }[] = [
  { kind: "usb", icon: Usb, label: "USB (Chrome or Edge)" },
  { kind: "bridge", icon: Cable, label: "Dev bridge (npm run bridge)" },
  { kind: "sim", icon: Monitor, label: "Simulator (no hardware)" },
];

export type MachineState = "ok" | "warn" | "off";

export function machineState(): MachineState {
  if (linkState.value === "disconnected") return "off";
  return linkState.value === "verified" && bedLoad.value.state === "ready" ? "ok" : "warn";
}

export function machineText(): string {
  if (linkState.value === "verified") {
    return bedLoad.value.state === "ready" ? "connected" : bedLoad.value.state === "error" ? "bed size read failed" : "reading bed size…";
  }
  if (connBusy.value) return "connecting…";
  return linkState.value === "connected" ? "connected, Card ID not verified" : "disconnected";
}

const mm = (um: number) => (um / 1000).toFixed(1);

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

  const icon = state === "ok" ? PlugZap : state === "warn" ? TriangleAlert : Unplug;
  const pos = headPos.value;
  return (
    <div class="ws-connect" ref={ref}>
      <div class="ws-split">
        <IconButton
          icon={icon}
          class={`ws-machine-status ${state}`}
          label={connected ? `Machine: ${machineText()}` : `Connect to the machine (${KINDS.find((k) => k.kind === connKind.value)?.label}); Card ID is checked automatically`}
          disabled={connBusy.value}
          onClick={() => (connected ? setOpen(!open) : void connectAndVerify())}
        />
        <IconButton icon={ChevronDown} class="ws-split-more" label="Connection options" pressed={open} onClick={() => setOpen(!open)} />
      </div>
      {open && (
        <div class="ws-popover" role="dialog" aria-label="Machine connection">
          <div class="ws-popover-head">
            <span class={`ws-dot ${state}`} />
            <b>Machine {machineText()}</b>
          </div>
          <div class="ws-segmented" role="group" aria-label="Connection type">
            {KINDS.map((k) => (
              <IconButton
                key={k.kind}
                icon={k.icon}
                label={k.label}
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
            <dt>Via</dt>
            <dd>{KINDS.find((k) => k.kind === connKind.value)?.label}</dd>
            {bedLoad.value.state === "ready" && (
              <>
                <dt>Bed</dt>
                <dd>{bedLoad.value.message.replace(/^Machine bed: /, "")}</dd>
              </>
            )}
            {pos && (
              <>
                <dt>Head</dt>
                <dd>
                  X {mm(pos.x)} · Y {mm(pos.y)} mm
                </dd>
              </>
            )}
          </dl>
          {connMessage.value && <p class="ws-hint">{connMessage.value}</p>}
          <div class="ws-row">
            {connected ? (
              <IconButton icon={Unplug} label="Disconnect" onClick={() => void disconnectMachine()} />
            ) : (
              <>
                <IconButton icon={Plug} class="ws-primary" label="Connect and verify the Card ID" disabled={connBusy.value} onClick={() => void connectAndVerify()} />
                {connKind.value === "usb" && (
                  <IconButton icon={Usb} label="Choose a USB port…" disabled={connBusy.value} onClick={() => void connectAndVerify({ chooser: true })} />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
