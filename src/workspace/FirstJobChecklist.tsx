// Status bar: "Getting started 3 of 7", opening the steps to a first job. Gone after the first job starts, or when hidden.
import { Check, Circle, ListChecks } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { msg, t } from "../i18n";
import { firstJobSteps, type StepId } from "../app/firstJob";
import { linkState } from "../app/connection";
import { doc, profile } from "../scene/store";
import { firstJob, hideChecklist } from "./firstJobState";
import { welcomeOpen } from "./WelcomeDialog";

const TEXT: Record<StepId, [string, string]> = {
  machine: [msg("Choose your kind of machine"), msg("In the welcome guide or the Machine tab. It sets typical speeds and presets.")],
  drawing: [msg("Put a drawing on the bed"), msg("Import a file, start a sketch, or open the sample.")],
  layers: [msg("Set speed and power per colour"), msg("In the Layers tab: pick a material preset, or type the values.")],
  prepare: [msg("Prepare the job"), msg("The Prepare job button checks the drawing and shows the path the laser will take.")],
  connect: [msg("Connect the machine"), msg("The plug icon, top right. No laser yet? Choose the simulator in its options.")],
  frame: [msg("Frame the job"), msg("The head traces the outline with the laser off, so you can check the material is under it.")],
  start: [msg("Start the job"), msg("Close the lid, turn on air assist and extraction, and stay by the machine.")],
};

export function FirstJobChecklist() {
  const state = firstJob.value;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (state.hidden || state.seen.includes("start")) return null;
  const steps = firstJobSteps({ machineKind: !!profile.value.class, doc: doc.value, connected: linkState.value === "verified", seen: new Set(state.seen) });
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;
  return (
    <div class="ws-help ws-first-job" ref={ref}>
      <button type="button" class="ws-first-job-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListChecks size={14} strokeWidth={1.75} aria-hidden="true" />
        {t("Getting started {done} of {n}", { done, n: steps.length })}
      </button>
      {open && (
        <div class="ws-help-menu ws-first-job-menu" role="dialog" aria-label={t("Getting started")}>
          <ol>
            {steps.map((s) => {
              const [title, hint] = TEXT[s.id];
              return (
                <li key={s.id} class={s.done ? "done" : s.id === next ? "next" : ""}>
                  {s.done ? <Check size={14} strokeWidth={2.25} aria-hidden="true" /> : <Circle size={14} strokeWidth={1.75} aria-hidden="true" />}
                  <div>
                    <b>{t(title)}</b>
                    {s.id === next && <small>{t(hint)}</small>}
                    {s.id === next && s.id === "machine" && (
                      <button type="button" class="ws-link-btn" onClick={() => ((welcomeOpen.value = true), setOpen(false))}>
                        {t("Open the welcome guide")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <button type="button" class="ws-link-btn ws-first-job-hide" onClick={() => hideChecklist()}>
            {t("Hide this checklist")}
          </button>
        </div>
      )}
    </div>
  );
}
