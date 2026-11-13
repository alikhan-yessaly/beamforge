// Engraving depth model: where a fill layer burns deeper than the middle of a long row.
//
// Along each chain of burns the speed comes from the estimator's motion model (`chainSpeeds`); energy per mm is
// power ÷ speed, with the Ruida's power ramp from corner power at the start speed to power at the layer speed
// (`energyRatio`). Wherever the head is slower than v* (the speed at which energy is `DEEPER` × the full-speed
// value) the engraving comes out noticeably deeper. Depth is not exactly proportional to energy, so the numbers
// rank settings rather than predict millimetres.
import { type MotionProfile, energyRatio, startSpeedOf } from "../machine/motion";
import { chainEnd, chainSpeeds } from "./estimate";
import type { Toolpath } from "./plan";

/** Energy ratio that counts as visibly deeper. */
export const DEEPER = 1.25;

export interface LayerDepth {
  /** Index into Toolpath.layers. */
  layer: number;
  /** Engraved length, mm. */
  burnLength: number;
  /** Share of the engraved length that burns at least DEEPER × the middle (0–1). */
  deepShare: number;
  /** Deepest spot relative to the middle of a long row (1 = even). */
  peak: number;
}

/** Depth evenness of each fill layer in the toolpath (cut layers are left out). */
export function depthReport(tp: Toolpath, m: MotionProfile): LayerDepth[] {
  const vs = startSpeedOf(m);
  const a = Math.max(1, m.accel);
  const per = tp.layers.map((l, layer) => ({ layer, burnLength: 0, deep: 0, peak: 1, fill: (l.mode ?? "cut") !== "cut" }));
  // v* per layer: below it, energy ≥ DEEPER × full speed (energyRatio falls as speed rises).
  const vStar = tp.layers.map((l) => {
    const V = Math.max(0.1, l.speed);
    if (energyRatio(vs, l, vs) < DEEPER) return 0;
    let [lo, hi] = [vs, V];
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (energyRatio(mid, l, vs) >= DEEPER) lo = mid;
      else hi = mid;
    }
    return hi;
  });
  const segs = tp.segments;
  let i = 0;
  while (i < segs.length) {
    const s = segs[i]!;
    if ((!s.cut && !s.lead) || !per[s.layer]?.fill) {
      i++;
      continue;
    }
    const j = chainEnd(segs, i);
    const l = tp.layers[s.layer]!;
    const V = Math.max(0.1, l.speed);
    const { len, vj } = chainSpeeds(segs, i, j, V, a, Math.max(V, m.travelSpeed));
    const r = per[s.layer]!;
    const vt = vStar[s.layer]!;
    for (let k = 0; k < len.length; k++) {
      if (!segs[i + k]!.cut) continue;
      const L = len[k]!;
      const [vi, vo] = [vj[k]!, vj[k + 1]!];
      r.burnLength += L;
      r.peak = Math.max(r.peak, energyRatio(Math.min(vi, vo), l, vs));
      if (vt <= 0) continue;
      // Distance from each end over which the head is still below v*.
      const d1 = vi < vt ? (vt * vt - vi * vi) / (2 * a) : 0;
      const d2 = vo < vt ? (vt * vt - vo * vo) / (2 * a) : 0;
      r.deep += Math.min(L, d1 + d2);
    }
    i = j;
  }
  return per.filter((r) => r.fill && r.burnLength > 0).map((r) => ({ layer: r.layer, burnLength: r.burnLength, deepShare: r.deep / r.burnLength, peak: r.peak }));
}

/** Whether a layer's report counts as uneven enough to mention. */
export const uneven = (d: LayerDepth) => d.deepShare > 0.05 && d.peak >= DEEPER;
