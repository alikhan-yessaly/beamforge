// Job state for the workspace: the planned toolpath, its time estimate, and the preview.
import { computed, effect, signal } from "@preact/signals";
import { type Estimate, estimate } from "../job/estimate";
import { type Toolpath, planToolpath } from "../job/plan";
import { moveBounds } from "../job/build";
import { type Check, runChecks } from "../job/checks";
import { type LayerDepth, depthReport } from "../job/depth";
import type { Doc, MachineProfile } from "../scene/model";
import { doc, prefs, profile } from "../scene/store";
import { relativeToolpath } from "./placement";

/** The document as of the last pause in editing; live drags change `doc` many times per second. */
const settledDoc = signal<Doc>(doc.value);
let timer: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  const d = doc.value;
  clearTimeout(timer);
  timer = setTimeout(() => (settledDoc.value = d), 150);
});

/** Where the head starts and ends: the machine origin corner (internal bed coords). */
export const homePoint = (p: MachineProfile) => ({ x: p.origin.endsWith("right") ? p.bedW : 0, y: p.origin.startsWith("bottom") ? p.bedH : 0 });

/** Plan a document the way the job will be built (start, order, overscan bounds), before any relative shift. */
function planFor(d: Doc): Toolpath {
  const p = profile.value;
  const pr = prefs.value;
  return planToolpath(d, { start: homePoint(p), innerFirst: pr.innerFirst, order: pr.jobOrder, motion: p, bounds: moveBounds(d, p, pr.startFrom) });
}

const planned = computed<Toolpath>(() => planFor(settledDoc.value));

export const toolpath = computed<Toolpath>(() => {
  const tp = planned.value;
  return prefs.value.startFrom === "current" ? relativeToolpath(tp, settledDoc.value, profile.value) : tp;
});

/** Checks before the job runs (uneven engraving and its fixes); computed only while something shows them. */
export const jobChecks = computed<Check[]>(() => {
  try {
    return planned.value.errors.length ? [] : runChecks(settledDoc.value, planned.value, profile.value, planFor);
  } catch {
    return [];
  }
});
export const jobEstimate = computed<Estimate>(() => estimate(toolpath.value, profile.value));

/** Toolpath preview: on/off and the scrub time in seconds (Infinity = whole job). */
export const preview = signal<{ on: boolean; t: number }>({ on: false, t: Infinity });
export const togglePreview = () => (preview.value = { on: !preview.value.on, t: Infinity });

/** Depth evenness of each fill layer of the planned job. */
export const jobDepth = computed<LayerDepth[]>(() => depthReport(planned.value, profile.value));
