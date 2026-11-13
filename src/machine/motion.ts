// What the machine profile says about motion and firing, for planning, the depth model and suggestions.
//
// How a Ruida fires along a cut: at or below its start speed vs it uses the corner power, rising linearly to the
// layer power P at the layer speed V. Depth follows energy per mm, power ÷ speed. Constant energy needs power
// proportional to speed, which that ramp gives exactly when corner power = P × vs ÷ V; the tube's lowest reliable
// power caps how low that can go, and overscan (laser off while speeding up) covers the rest.
import { ASSUMED_MIN_FIRE_POWER, ASSUMED_START_SPEED, type MachineProfile } from "../scene/model";

export type MotionProfile = Pick<MachineProfile, "travelSpeed" | "accel" | "startSpeed" | "minFirePower" | "scanOffsets">;

export const startSpeedOf = (m: Pick<MachineProfile, "startSpeed">) => Math.max(0, m.startSpeed ?? ASSUMED_START_SPEED);
export const minFireOf = (m: Pick<MachineProfile, "minFirePower">) => Math.min(100, Math.max(0, m.minFirePower ?? ASSUMED_MIN_FIRE_POWER));

/** Corner power that keeps energy per mm constant from the start speed up, never below the tube's lowest power. */
export function suggestCornerPower(power: number, speed: number, m: Pick<MachineProfile, "startSpeed" | "minFirePower">): number {
  const vs = startSpeedOf(m);
  if (speed <= vs || power <= 0) return power;
  const ideal = (power * vs) / speed;
  return Math.min(power, Math.max(minFireOf(m), Math.round(ideal * 10) / 10));
}

/** Distance (mm) to speed up from the start speed to `speed`: the run-up "auto" overscan adds at each row end. */
export function rampDistance(speed: number, m: Pick<MachineProfile, "accel" | "startSpeed">): number {
  const vs = startSpeedOf(m);
  if (speed <= vs) return 0;
  return (speed * speed - vs * vs) / (2 * Math.max(1, m.accel));
}

/** Overscan length in mm for a layer setting: auto rounds the run-up up to 0.5 mm. */
export function overscanLength(setting: "off" | "auto" | number | undefined, speed: number, m: Pick<MachineProfile, "accel" | "startSpeed">): number {
  if (setting === undefined || setting === "off") return 0;
  if (setting === "auto") {
    const d = rampDistance(speed, m);
    return d > 0 ? Math.ceil(d * 2) / 2 : 0;
  }
  return Math.max(0, Math.min(100, setting));
}

/** Scan offset (mm) at `speed`, interpolated between the measured speeds (held flat beyond them). */
export function scanOffsetAt(speed: number, table: MachineProfile["scanOffsets"]): number {
  const pts = [...(table ?? [])].filter((p) => Number.isFinite(p.speed) && Number.isFinite(p.offset)).sort((a, b) => a.speed - b.speed);
  if (!pts.length) return 0;
  if (speed <= pts[0]!.speed) return pts[0]!.offset;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    if (speed <= b.speed) return b.speed === a.speed ? b.offset : a.offset + ((b.offset - a.offset) * (speed - a.speed)) / (b.speed - a.speed);
  }
  return pts.at(-1)!.offset;
}

/**
 * Energy per mm at speed v relative to full speed (1 = as deep as the middle of a long row), for a layer at power
 * `max` and corner power `min`, speed V. Below the start speed the head never goes slower than vs.
 */
export function energyRatio(v: number, layer: { speed: number; minPower: number; maxPower: number }, vs: number): number {
  const V = Math.max(0.1, layer.speed);
  if (layer.maxPower <= 0) return 1;
  const s = Math.max(v, vs, 0.1);
  const p = V <= vs || s <= vs ? layer.minPower : layer.minPower + ((layer.maxPower - layer.minPower) * (Math.min(s, V) - vs)) / (V - vs);
  return (p / s) / (layer.maxPower / V);
}
