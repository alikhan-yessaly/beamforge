// Checks before a job goes to the machine: fill layers predicted to burn unevenly, with the fixes and what each
// costs in time. Nothing is changed here; the Device view offers each fix as one click.
//
// - uneven: a fill layer's row ends (and small areas) burn deeper than the middle (`depth.ts`). Fixes: overscan
//   (laser off while speeding up; costs time), overscan with the areas swept together (rows share one run-up),
//   and a lower corner power (free, limited by the tube's lowest power).
// - mixed: some areas of a fill layer are swept together and others alone, so they burn differently. Fixes: sweep
//   all together, or each on its own.
// - tune: either of the above on a machine whose motion values are still class defaults: the fill test card makes
//   the prediction this machine's own.
import { type Doc, type Layer, type MachineProfile } from "../scene/model";
import { suggestCornerPower } from "../machine/motion";
import { type LayerDepth, depthReport, uneven } from "./depth";
import { estimate } from "./estimate";
import { updateLayer } from "./layers";
import type { Toolpath } from "./plan";

export type FixKind = "overscan" | "overscanTogether" | "corner" | "together" | "separate";

export interface Fix {
  kind: FixKind;
  patch: Partial<Omit<Layer, "color">>;
  /** Job time change, seconds (positive = slower). */
  seconds: number;
  /** The layer's depth with the fix. */
  after?: LayerDepth;
}

export interface Check {
  /** Stable id, e.g. "uneven:#00e000" or "tune". */
  id: string;
  kind: "uneven" | "mixed" | "tune";
  color?: string;
  depth?: LayerDepth;
  fixes: Fix[];
}

/**
 * Checks for the job planned from `doc`. `plan` plans a document the same way the job will be (start point,
 * order, bounds); `tp` is its result for `doc` itself.
 */
export function runChecks(doc: Doc, tp: Toolpath, profile: MachineProfile, plan: (d: Doc) => Toolpath): Check[] {
  const out: Check[] = [];
  const base = estimate(tp, profile).total;
  const depths = depthReport(tp, profile);
  const fixFor = (layer: Layer, kind: FixKind, patch: Partial<Omit<Layer, "color">>, timed: boolean): Fix => {
    if (!timed) {
      const changed = { ...tp, layers: tp.layers.map((l) => (l.color === layer.color ? { ...l, ...patch } : l)) };
      return { kind, patch, seconds: 0, after: depthReport(changed, profile).find((d) => tp.layers[d.layer]!.color === layer.color) };
    }
    const next = plan(updateLayer(doc, layer.color, patch));
    const li = next.layers.findIndex((l) => l.color === layer.color);
    return { kind, patch, seconds: estimate(next, profile).total - base, after: depthReport(next, profile).find((d) => d.layer === li) };
  };
  const fixOrder = profile.tuning?.fillFix;
  tp.layers.forEach((layer, li) => {
    if ((layer.mode ?? "cut") === "cut") return;
    const depth = depths.find((d) => d.layer === li);
    const overscanOff = (layer.overscan ?? "off") === "off";
    if (depth && uneven(depth) && fixOrder !== "none") {
      const fixes: Fix[] = [];
      const corner = suggestCornerPower(layer.maxPower, layer.speed, profile);
      if (corner < layer.minPower - 0.05) fixes.push(fixFor(layer, "corner", { minPower: corner, linkPower: false }, false));
      if (overscanOff) {
        fixes.push(fixFor(layer, "overscan", { overscan: "auto" }, true));
        // Areas that share rows share one run-up per row end when swept together: often far cheaper.
        if ((layer.sweep ?? "quick") !== "together" && (tp.sweeps?.[li]?.length ?? 0) > 1) {
          const both = fixFor(layer, "overscanTogether", { overscan: "auto", sweep: "together" }, true);
          if (both.seconds < fixes.at(-1)!.seconds - 1) fixes.push(both);
        }
      }
      if (fixOrder === "corner") fixes.sort((a, b) => (a.kind === "corner" ? -1 : b.kind === "corner" ? 1 : 0));
      if (fixes.length) out.push({ id: `uneven:${layer.color}`, kind: "uneven", color: layer.color, depth, fixes });
    }
    // Mixed sweeps only matter while row ends burn deeper (overscan off).
    const sizes = tp.sweeps?.[li] ?? [];
    if (overscanOff && (layer.sweep ?? "quick") === "quick" && sizes.some((n) => n > 1) && sizes.some((n) => n === 1) && depth && depth.peak >= 1.1) {
      out.push({ id: `mixed:${layer.color}`, kind: "mixed", color: layer.color, depth, fixes: [fixFor(layer, "together", { sweep: "together" }, true), fixFor(layer, "separate", { sweep: "separate" }, true)] });
    }
  });
  const dismissed = new Set(profile.tuning?.dismissed ?? []);
  if (out.length && !profile.tuning?.fill && !dismissed.has("tune")) out.push({ id: "tune", kind: "tune", fixes: [] });
  return out.filter((c) => !dismissed.has(c.id));
}
