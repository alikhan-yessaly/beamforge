// Gathers the diagnostics text and copies it; keeps a short log of warnings, errors and uncaught failures for it.
import { effect } from "@preact/signals";
import { t } from "../i18n";
import { lang } from "../i18n";
import { formatDiagnostics } from "../app/diagnostics";
import { currentBrowser } from "../app/env";
import { connKind, connMessage, connProblem, linkState } from "../app/connection";
import { doc, messages, notify, profile } from "../scene/store";

const log: { time: string; kind: string; text: string }[] = [];
const seen = new Set<number>();

function record(kind: string, text: string): void {
  log.push({ time: new Date().toLocaleTimeString("en-GB"), kind, text: text.slice(0, 300) });
  if (log.length > 30) log.shift();
}

effect(() => {
  for (const m of messages.value) {
    if (m.kind === "info" || seen.has(m.id)) continue;
    seen.add(m.id);
    record(m.kind, m.text);
  }
});
if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => record("uncaught", e.message));
  window.addEventListener("unhandledrejection", (e) => record("uncaught", e.reason instanceof Error ? e.reason.message : String(e.reason)));
}

export function diagnosticsText(): string {
  const b = currentBrowser();
  return formatDiagnostics({
    build: __BUILD__,
    browser: b,
    userAgent: navigator.userAgent,
    lang: lang.value,
    connection: { kind: connKind.value, state: linkState.value, problem: connProblem.value, message: connMessage.value },
    machine: profile.value as unknown as Record<string, unknown>,
    objects: doc.value.objects.length,
    layers: doc.value.layers.length,
    log,
  });
}

export async function copyDiagnostics(): Promise<void> {
  const text = diagnosticsText();
  try {
    await navigator.clipboard.writeText(text);
    notify(t("Diagnostics copied. Paste them into your bug report."));
  } catch {
    window.prompt(t("Copy the diagnostics:"), text);
  }
}
