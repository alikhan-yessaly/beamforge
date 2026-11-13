// Prepare / Device modes, like a slicer: edit the design in Prepare, then "Prepare job" plans it and switches to
// Device, a read-only preview of the planned job where the machine is connected, framed, started or given the file.
import { t } from "../i18n";
import { signal } from "@preact/signals";
import { runner } from "../app/connection";
import { notify, selection } from "../scene/store";
import { jobEstimate, preview, toolpath } from "./job";
import { stopFillTool } from "./fillTool";
import { framing } from "./RunPanel";
import { session as sketchSession } from "./sketch/state";

export type AppMode = "prepare" | "device";
export const appMode = signal<AppMode>("prepare");
/** True while a job is being stored on the controller. */
export const savingToMachine = signal(false);

/** Machine work in progress: the job can't be edited (or the mode changed) until it ends. */
export const machineBusy = () => runner.active || framing.value || savingToMachine.value;

/** Why the design can't be prepared as a job, or null. */
export function prepareProblem(): string | null {
  if (toolpath.value.errors.length) return toolpath.value.errors[0]!;
  if (jobEstimate.value.cutLength <= 0) return t("Nothing to cut: import a drawing and turn on Output for a layer.");
  return null;
}

/** Plan the job and switch to the Device view with its preview. */
export function enterDevice(): void {
  if (sketchSession.value) return;
  const problem = prepareProblem();
  if (problem) {
    notify(problem, "warn");
    return;
  }
  stopFillTool();
  selection.value = new Set();
  preview.value = { on: true, t: Infinity };
  appMode.value = "device";
}

/** Back to editing. Not while the machine is working on this job. */
export function enterPrepare(): void {
  if (machineBusy()) {
    notify(t("Wait until the machine has finished (or stop it) before editing."), "warn");
    return;
  }
  preview.value = { on: false, t: Infinity };
  appMode.value = "prepare";
}
