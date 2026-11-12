// Start checklist: a short summary of the job and four checks that must be ticked before the laser fires.
// Replaces the browser's confirm box, which is easy to click through.
import { signal } from "@preact/signals";
import { Play, TriangleAlert } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";

export interface StartSummary {
  time: string;
  layers: number;
  where: string;
  warnings: string[];
}

const request = signal<{ summary: StartSummary; resolve: (ok: boolean) => void } | null>(null);

/** Show the checklist; resolves true only if the user ticks everything and clicks Start. */
export function confirmStart(summary: StartSummary): Promise<boolean> {
  return new Promise((resolve) => (request.value = { summary, resolve }));
}

const CHECKS = [
  "Material is in place and the job area is clear",
  "Lid is closed",
  "Air assist and water cooling are on",
  "Someone stays at the machine with the E-stop in reach",
];

export function StartDialog() {
  const r = request.value;
  const ref = useRef<HTMLDialogElement>(null);
  const [ticked, setTicked] = useState<boolean[]>(CHECKS.map(() => false));
  useEffect(() => {
    if (!r) return;
    setTicked(CHECKS.map(() => false));
    ref.current?.showModal();
  }, [r]);
  if (!r) return null;
  const all = ticked.every(Boolean);
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
        if (e.key === "Enter" && all) {
          e.preventDefault();
          finish(true);
        }
      }}
    >
      <h3>Start the job?</h3>
      <p>
        <b>{r.summary.time}</b> · {r.summary.layers} layer{r.summary.layers === 1 ? "" : "s"} · {r.summary.where}. This fires the laser.
      </p>
      {r.summary.warnings.map((w) => (
        <p key={w} class="ws-plan-msg">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> {w}
        </p>
      ))}
      <div class="ws-checklist">
        {CHECKS.map((c, i) => (
          <label key={c}>
            <input type="checkbox" checked={ticked[i]} onChange={(e) => {
                const on = e.currentTarget.checked;
                setTicked((prev) => prev.map((t, k) => (k === i ? on : t)));
              }} />
            {c}
          </label>
        ))}
      </div>
      <div class="ws-row ws-dialog-actions">
        <button type="button" onClick={() => finish(false)}>
          Cancel
        </button>
        <button type="button" class="ws-start-confirm" disabled={!all} onClick={() => finish(true)} title={all ? "Start (Enter)" : "Tick every check first"}>
          <Play size={14} strokeWidth={2} aria-hidden="true" /> Start
        </button>
      </div>
    </dialog>
  );
}
