// The "Getting started" checklist: the steps from a blank page to a first job, and which are done.
// Pure: the facts come in, the step list goes out. Steps that are events (prepared, framed, started) are remembered by the caller.
import { DEFAULT_LAYER, type Doc, type Layer } from "../scene/model";

export type StepId = "machine" | "drawing" | "layers" | "prepare" | "connect" | "frame" | "start";

export interface FirstJobFacts {
  /** A machine kind is chosen. */
  machineKind: boolean;
  doc: Doc;
  /** Connected and verified (machine or simulator). */
  connected: boolean;
  /** Events seen at least once. */
  seen: ReadonlySet<StepId>;
}

export interface Step {
  id: StepId;
  done: boolean;
}

export const STEP_ORDER: readonly StepId[] = ["machine", "drawing", "layers", "prepare", "connect", "frame", "start"];

const SETTINGS: (keyof Layer)[] = ["speed", "minPower", "maxPower", "passes", "mode"];

/** A layer someone set up: a material preset, or any setting changed from the defaults. */
export function layerIsSet(l: Layer): boolean {
  if (l.material) return true;
  const def = DEFAULT_LAYER as Partial<Layer>;
  return SETTINGS.some((k) => l[k] !== undefined && l[k] !== def[k] && !(k === "mode" && l[k] === "cut"));
}

export function firstJobSteps(f: FirstJobFacts): Step[] {
  const done: Record<StepId, boolean> = {
    machine: f.machineKind,
    drawing: f.doc.objects.length > 0,
    layers: f.doc.layers.some((l) => l.output && layerIsSet(l)),
    prepare: f.seen.has("prepare"),
    connect: f.connected,
    frame: f.seen.has("frame"),
    start: f.seen.has("start"),
  };
  return STEP_ORDER.map((id) => ({ id, done: done[id] }));
}
