// Job state for the workspace: the planned toolpath, its time estimate, and the preview.
import { computed, effect, signal } from "@preact/signals";
import { type Estimate, estimate } from "../job/estimate";
import { type Toolpath, planToolpath } from "../job/plan";
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

export const toolpath = computed<Toolpath>(() => {
  const p = profile.value;
  const tp = planToolpath(settledDoc.value, { start: homePoint(p), innerFirst: prefs.value.innerFirst, order: prefs.value.jobOrder });
  return prefs.value.startFrom === "current" ? relativeToolpath(tp, settledDoc.value, p) : tp;
});
export const jobEstimate = computed<Estimate>(() => estimate(toolpath.value, profile.value));

/** Toolpath preview: on/off and the scrub time in seconds (Infinity = whole job). */
export const preview = signal<{ on: boolean; t: number }>({ on: false, t: Infinity });
export const togglePreview = () => (preview.value = { on: !preview.value.on, t: Infinity });
