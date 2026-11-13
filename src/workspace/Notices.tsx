// Notices across the top of the workspace: this browser can't drive the laser. Each can be dismissed for good.
import { signal } from "@preact/signals";
import { MonitorSmartphone, RefreshCw, Usb, X } from "lucide-preact";
import { t } from "../i18n";
import { currentBrowser } from "../app/env";
import { connKind, linkState, selectConnKind } from "../app/connection";
import { notify } from "../scene/store";
import { type BuildInfo, newerBuild, parseBuild } from "../app/update";
import { machineBusy } from "./mode";
import { dirty } from "../project/state";

const KEY = "ruida-web.dismissed.v1";

function loadDismissed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export const dismissed = signal<ReadonlySet<string>>(loadDismissed());

export function dismiss(id: string): void {
  const next = new Set(dismissed.value).add(id);
  dismissed.value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* not remembered: it shows again next time */
  }
}

/** Switch to the simulator, if no machine is connected. */
export function useSimulator(): void {
  if (linkState.value !== "disconnected") return;
  try {
    selectConnKind("sim");
    notify(t("Connection set to the simulator: press the plug icon (top right) to connect to it."));
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  }
}

function Notice(props: { id: string; icon: typeof X; tone?: "warn" | "info"; children: preact.ComponentChildren }) {
  const Icon = props.icon;
  return (
    <div class={`ws-notice ${props.tone ?? "warn"}`} role="status">
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
      <div class="ws-notice-text">{props.children}</div>
      <button type="button" class="ib" title={t("Dismiss")} aria-label={t("Dismiss")} onClick={() => dismiss(props.id)}>
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/** No Web Serial (Safari, Firefox, phones): say so up front, before the person tries to connect. */
function BrowserNotice() {
  const b = currentBrowser();
  if (b.mobile && !dismissed.value.has("mobile")) {
    return (
      <Notice id="mobile" icon={MonitorSmartphone}>
        {t("BeamForge is made for a computer with a mouse and a wide screen. On this device you can look around, but drawing and connecting to the laser need a computer with Chrome or Edge.")}
      </Notice>
    );
  }
  if (b.serial || dismissed.value.has("no-serial")) return null;
  return (
    <Notice id="no-serial" icon={Usb}>
      {t("{browser} can't connect to the laser over USB (it has no Web Serial). You can still draw, prepare jobs, export, and try everything on the simulator. To cut, open BeamForge in Chrome or Edge on a computer.", { browser: b.name === "Unknown browser" ? t("This browser") : b.name })}{" "}
      {connKind.value !== "sim" && (
        <button type="button" class="ws-link-btn" onClick={useSimulator}>
          {t("Use the simulator")}
        </button>
      )}
    </Notice>
  );
}

// ---------- A newer build on the site ----------

const update = signal<BuildInfo | null>(null);
const CHECK_EVERY_MS = 30 * 60 * 1000;

async function checkForUpdate(): Promise<void> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}version.json`, { cache: "no-store" });
    if (!r.ok) return;
    const found = newerBuild(__BUILD__, parseBuild(await r.json()));
    if (found) update.value = found;
  } catch {
    /* offline: try again later */
  }
}

if (import.meta.env.PROD && typeof window !== "undefined") {
  setTimeout(() => void checkForUpdate(), 20_000);
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void checkForUpdate());
}

function UpdateNotice() {
  const u = update.value;
  if (!u || dismissed.value.has(`update:${u.id}`)) return null;
  const busy = machineBusy();
  return (
    <Notice id={`update:${u.id}`} icon={RefreshCw} tone="info">
      {u.notes ? t("A new version of BeamForge is ready: {notes}", { notes: u.notes }) : t("A new version of BeamForge is ready.")}{" "}
      <button
        type="button"
        class="ws-link-btn"
        disabled={busy}
        title={busy ? t("Wait until the machine has finished.") : undefined}
        onClick={() => {
          if (dirty.value && !window.confirm(t("Reload now? Your drawing is kept in this browser, but save the project file first if you want it on disk."))) return;
          location.reload();
        }}
      >
        {t("Reload to update")}
      </button>
    </Notice>
  );
}

export function Notices() {
  return (
    <>
      <UpdateNotice />
      <BrowserNotice />
    </>
  );
}
