// "Can't connect?": what the last failure most likely means, then the usual checks in order.
import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { msg, t } from "../i18n";
import type { ConnProblem } from "../app/troubleshoot";
import { connKind, connMessage, connProblem, linkState } from "../app/connection";
import { useSimulator } from "./Notices";
import { copyDiagnostics } from "./diagnostics";

export const connHelpOpen = signal(false);

const LIKELY: Record<ConnProblem, string> = {
  "no-serial": msg("This browser can't use USB serial ports. Open BeamForge in Chrome or Edge on a computer, or try the simulator."),
  "no-port": msg("No port was chosen. Press “Choose a USB port…” and pick the one named USB Serial, FT232R or CH340. If the list is empty, check the cable, power and driver below."),
  busy: msg("The port is in use. Close LightBurn, RDWorks and other BeamForge tabs, then connect again."),
  "no-answer": msg("The port opened, but the controller did not answer as expected. Check that the machine is on and the cable goes to the controller, then try again. If it still fails, the controller model may be wrong (Machine tab, developer mode)."),
  bridge: msg("The dev bridge is not answering. Start it in a terminal with npm run bridge, or switch the connection to USB."),
  other: msg("Something unexpected went wrong. Work through the checks below, then copy the diagnostics if it still fails."),
};

const CHECKS: [string, string][] = [
  [msg("Power"), msg("The machine is switched on and the controller panel is lit.")],
  [msg("Cable"), msg("A USB cable from the computer to the controller's PC port (not the USB-stick port on the panel). Try another cable or socket, and avoid hubs.")],
  [msg("Driver"), msg("Windows may need the FTDI or CH340 driver for the controller's USB chip; macOS and Linux usually don't. On Linux, your user may need to be in the dialout group.")],
  [msg("One program at a time"), msg("Only one program can hold the port: close LightBurn, RDWorks, and other tabs with BeamForge.")],
  [msg("Browser"), msg("Use Chrome or Edge on a computer. Phones, Safari and Firefox can't use serial ports.")],
];

export function ConnectionHelp() {
  const ref = useRef<HTMLDialogElement>(null);
  const open = connHelpOpen.value;
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  if (!open) return null;
  const problem = linkState.value === "verified" ? null : connProblem.value;
  return (
    <dialog ref={ref} class="ws-dialog ws-conn-help" aria-labelledby="ws-conn-help-title" onClose={() => (connHelpOpen.value = false)} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h3 id="ws-conn-help-title">{t("Connection help")}</h3>
      {problem && (
        <div class="ws-conn-likely">
          <b>{t("Most likely")}</b>
          <p>{t(LIKELY[problem])}</p>
          {connMessage.value && <small>{connMessage.value}</small>}
        </div>
      )}
      <ol class="ws-conn-checks">
        {CHECKS.map(([title, text]) => (
          <li key={title}>
            <b>{t(title)}</b>
            <span>{t(text)}</span>
          </li>
        ))}
      </ol>
      <div class="ws-row ws-conn-help-actions">
        {connKind.value !== "sim" && linkState.value === "disconnected" && (
          <button type="button" onClick={() => (useSimulator(), (connHelpOpen.value = false))}>
            {t("Use the simulator")}
          </button>
        )}
        <button type="button" onClick={() => void copyDiagnostics()}>
          {t("Copy diagnostics")}
        </button>
        <span class="ws-grow" />
        <button type="button" class="ws-primary" onClick={() => (connHelpOpen.value = false)}>
          {t("Close")}
        </button>
      </div>
    </dialog>
  );
}
