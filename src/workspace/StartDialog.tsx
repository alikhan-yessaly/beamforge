import { msg, t, tp } from "../i18n";
import { signal } from "@preact/signals";
import { Play, TriangleAlert } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";

export interface StartSummary {
  time: string;
  layers: number;
  where: string;
  warnings: string[];
}

const request = signal<{ summary: StartSummary; resolve: (ok: boolean) => void } | null>(null);

/** Show the job summary and safety reminders before starting. */
export function confirmStart(summary: StartSummary): Promise<boolean> {
  return new Promise((resolve) => (request.value = { summary, resolve }));
}

const CHECKS = [
  msg("Material is in place and the job area is clear"),
  msg("Lid is closed"),
  msg("Air assist and water cooling are on"),
  msg("Someone stays at the machine with the E-stop in reach"),
];

export function StartDialog() {
  const r = request.value;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!r) return;
    ref.current?.showModal();
  }, [r]);
  if (!r) return null;
  const finish = (ok: boolean) => {
    ref.current?.close();
    request.value = null;
    r.resolve(ok);
  };
  return (
    <dialog
      ref={ref}
      class="ws-dialog ws-start-dialog"
      onCancel={(e) => {
        e.preventDefault();
        finish(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") finish(false);
      }}
    >
      <h3>{t("Start the job?")}</h3>
      <p>
        <b>{r.summary.time}</b> · {tp(["{n} layer", "{n} layers"], r.summary.layers)} · {r.summary.where}. {t("This fires the laser.")}
      </p>
      {r.summary.warnings.map((w) => (
        <p key={w} class="ws-plan-msg">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> {w}
        </p>
      ))}
      <p>{t("Before starting, confirm that:")}</p>
      <ul class="ws-checklist">
        {CHECKS.map((c) => (
          <li key={c}>{t(c)}</li>
        ))}
      </ul>
      <div class="ws-row ws-dialog-actions">
        <button type="button" autofocus onClick={() => finish(false)}>
          {t("Cancel")}
        </button>
        <button type="button" class="ws-start-confirm" onClick={() => finish(true)}>
          <Play size={14} strokeWidth={2} aria-hidden="true" /> {t("Confirm and start")}
        </button>
      </div>
    </dialog>
  );
}
