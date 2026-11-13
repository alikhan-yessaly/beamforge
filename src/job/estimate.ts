// Job time estimate from a planned toolpath.
//
// Model: every segment accelerates and decelerates at the profile's acceleration (trapezoidal velocity). Within a
// cut, the speed at a corner is limited by the junction-deviation rule (as in grbl); a cut polyline starts and ends
// at rest. A travel move runs alone, from rest to rest, at the profile's travel speed. Lead moves (overscan, gaps
// inside an engraved row) belong to the row: they run at the layer's speed, in one chain with its burns. The controller's real planner
// is unknown, so this is an estimate; compare it with a timed job and tune `accel` in the machine profile.
import type { MachineProfile } from "../scene/model";
import type { Segment, Toolpath } from "./plan";

/** Junction deviation in mm: how far the path may round a corner at speed. */
export const JUNCTION_DEVIATION = 0.05;

export interface Estimate {
  /** seconds */
  total: number;
  cutTime: number;
  travelTime: number;
  /** mm */
  cutLength: number;
  travelLength: number;
  /** Seconds per layer (index matches Toolpath.layers), cuts only. */
  layerTime: number[];
  /** Time at which each segment ends; same length as the toolpath's segments. For the preview scrubber. */
  endTimes: Float64Array;
}

type Motion = Pick<MachineProfile, "travelSpeed" | "accel">;

export function estimate(tp: Toolpath, m: Motion): Estimate {
  const segs = tp.segments;
  const a = Math.max(1, m.accel);
  const e: Estimate = {
    total: 0,
    cutTime: 0,
    travelTime: 0,
    cutLength: 0,
    travelLength: 0,
    layerTime: tp.layers.map(() => 0),
    endTimes: new Float64Array(segs.length),
  };
  let t = 0;
  let i = 0;
  let j = 0;
  while (i < segs.length) {
    const s = segs[i]!;
    if (!s.cut && !s.lead) {
      const len = segLen(s);
      const dt = trapezoid(len, 0, 0, Math.max(0.1, m.travelSpeed), a);
      t += dt;
      e.travelTime += dt;
      e.travelLength += len;
      e.endTimes[i] = t;
      i++;
      continue;
    }
    // A run of cut (and lead) segments that joins end to start is one continuous polyline.
    j = chainEnd(segs, i);
    const v = Math.max(0.1, tp.layers[s.layer]!.speed);
    const times = chainTimes(segs, i, j, v, a, Math.max(v, m.travelSpeed));
    for (let k = i; k < j; k++) {
      const dt = times[k - i]!;
      t += dt;
      e.endTimes[k] = t;
      e.layerTime[s.layer]! += dt;
      if (segs[k]!.cut) {
        e.cutLength += segLen(segs[k]!);
        e.cutTime += dt;
      } else {
        e.travelLength += segLen(segs[k]!);
        e.travelTime += dt;
      }
    }
    i = j;
  }
  e.total = t;
  return e;
}

const segLen = (s: Segment) => Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
const joined = (p: Segment, q: Segment) => Math.abs(p.x1 - q.x0) < 1e-9 && Math.abs(p.y1 - q.y0) < 1e-9;

/** End (exclusive) of the chain starting at i: cut and lead segments of one layer, joined end to start. */
export function chainEnd(segs: Segment[], i: number): number {
  const s = segs[i]!;
  let j = i + 1;
  while (j < segs.length && (segs[j]!.cut || segs[j]!.lead) && segs[j]!.layer === s.layer && joined(segs[j - 1]!, segs[j]!)) j++;
  return j;
}

/** Times for segments [i, j) run as one chain: burns at cruise speed v, lead moves at up to `vLead`. */
function chainTimes(segs: Segment[], i: number, j: number, v: number, a: number, vLead = v): number[] {
  const { len, vj, cap } = chainSpeeds(segs, i, j, v, a, vLead);
  const out: number[] = [];
  for (let k = 0; k < len.length; k++) out.push(trapezoid(len[k]!, vj[k]!, vj[k + 1]!, cap[k]!, a));
  return out;
}

/**
 * Speeds along the chain [i, j) at cruise speed v: `vj[k]` is the speed where segment i+k starts (vj[0] = vj[n] = 0,
 * at rest), limited by corners (junction deviation) and by acceleration both ways.
 */
export function chainSpeeds(segs: Segment[], i: number, j: number, v: number, a: number, vLead = v): { len: Float64Array; vj: Float64Array; cap: Float64Array } {
  const n = j - i;
  const len = new Float64Array(n);
  const ux = new Float64Array(n);
  const uy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const s = segs[i + k]!;
    len[k] = segLen(s);
    ux[k] = len[k]! > 0 ? (s.x1 - s.x0) / len[k]! : 0;
    uy[k] = len[k]! > 0 ? (s.y1 - s.y0) / len[k]! : 0;
  }
  // Cruise speed per segment: burns at v, lead moves at up to vLead.
  const cap = new Float64Array(n);
  for (let k = 0; k < n; k++) cap[k] = segs[i + k]!.cut ? v : vLead;
  // vj[k] = speed at the junction before segment k; vj[0] = vj[n] = 0.
  const vj = new Float64Array(n + 1);
  for (let k = 1; k < n; k++) vj[k] = junctionSpeed(ux[k - 1]!, uy[k - 1]!, ux[k]!, uy[k]!, Math.min(cap[k - 1]!, cap[k]!), a);
  // Backward pass: must be able to slow down to the next junction.
  for (let k = n - 1; k >= 0; k--) vj[k] = Math.min(vj[k]!, Math.sqrt(vj[k + 1]! ** 2 + 2 * a * len[k]!));
  // Forward pass: can only speed up so much.
  for (let k = 0; k < n; k++) vj[k + 1] = Math.min(vj[k + 1]!, Math.sqrt(vj[k]! ** 2 + 2 * a * len[k]!));
  return { len, vj, cap };
}

export function junctionSpeed(ax: number, ay: number, bx: number, by: number, v: number, a: number): number {
  const cos = -(ax * bx + ay * by); // cos of the angle between the reversed incoming and the outgoing direction
  if (cos > 0.999999) return 0; // full reversal
  if (cos < -0.999999) return v; // straight on
  const sinHalf = Math.sqrt((1 - cos) / 2);
  return Math.min(v, Math.sqrt((a * JUNCTION_DEVIATION * sinHalf) / (1 - sinHalf)));
}

/** Time to cover `len` starting at vi, ending at vo, cruising at most at v, with acceleration a. */
export function trapezoid(len: number, vi: number, vo: number, v: number, a: number): number {
  if (len <= 0) return 0;
  const da = Math.max(0, (v * v - vi * vi) / (2 * a));
  const dd = Math.max(0, (v * v - vo * vo) / (2 * a));
  if (da + dd <= len) return (v - vi) / a + (v - vo) / a + (len - da - dd) / v;
  const vp = Math.sqrt(Math.max(vi * vi, vo * vo, (2 * a * len + vi * vi + vo * vo) / 2));
  return Math.max(0, (vp - vi) / a) + Math.max(0, (vp - vo) / a);
}

export function formatDuration(s: number): string {
  const r = Math.round(s);
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const sec = r % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}
