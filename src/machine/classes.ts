// Machine classes: simulated defaults for the common kinds of CO2 laser, so a machine that is never tuned still
// gets sensible motion values and starting material settings. Values are typical, not measured; the tuning wizard
// replaces them with this machine's own.
import { msg } from "../i18n";
import { DEFAULT_PROFILE, type MachineProfile } from "../scene/model";

export interface MachineClass {
  id: string;
  /** English name (translate with t()). */
  name: string;
  /** Typical tube power, W: material powers are scaled from an 80 W reference. */
  tube: number;
  defaults: Pick<MachineProfile, "bedW" | "bedH" | "travelSpeed" | "accel" | "startSpeed" | "minFirePower" | "frameSpeed">;
}

export const MACHINE_CLASSES: MachineClass[] = [
  { id: "desktop", name: msg("40–60 W desktop (about 500 × 300 mm)"), tube: 50, defaults: { bedW: 500, bedH: 300, travelSpeed: 150, accel: 1500, startSpeed: 10, minFirePower: 10, frameSpeed: 30 } },
  { id: "mid", name: msg("60–100 W (600 × 400 to 900 × 600 mm)"), tube: 80, defaults: { bedW: 600, bedH: 400, travelSpeed: 150, accel: 2000, startSpeed: 10, minFirePower: 10, frameSpeed: 30 } },
  { id: "large", name: msg("100–150 W large bed (1300 × 900 mm and up)"), tube: 130, defaults: { bedW: 1300, bedH: 900, travelSpeed: 200, accel: 1500, startSpeed: 15, minFirePower: 12, frameSpeed: 40 } },
  { id: "other", name: msg("Other / not sure"), tube: 80, defaults: { bedW: DEFAULT_PROFILE.bedW, bedH: DEFAULT_PROFILE.bedH, travelSpeed: DEFAULT_PROFILE.travelSpeed, accel: DEFAULT_PROFILE.accel, startSpeed: 10, minFirePower: 10, frameSpeed: 30 } },
];

export const classById = (id: string | undefined) => MACHINE_CLASSES.find((c) => c.id === id);

/** What a material operation does on a layer. */
export type MaterialOp = "cut" | "engrave" | "score";

export interface MaterialSeed {
  /** English material name (translated where shown). */
  material: string;
  op: MaterialOp;
  speed: number;
  /** % at the 80 W reference. */
  power: number;
  passes: number;
}

/** Starting settings at 80 W; `seedsFor` scales power to the class's tube. Starting points: test each material. */
export const MATERIAL_SEEDS: MaterialSeed[] = [
  { material: msg("3 mm plywood"), op: "cut", speed: 15, power: 60, passes: 1 },
  { material: msg("3 mm plywood"), op: "engrave", speed: 200, power: 18, passes: 1 },
  { material: msg("3 mm plywood"), op: "score", speed: 100, power: 15, passes: 1 },
  { material: msg("3 mm acrylic"), op: "cut", speed: 12, power: 60, passes: 1 },
  { material: msg("3 mm acrylic"), op: "engrave", speed: 250, power: 15, passes: 1 },
  { material: msg("2 mm cardboard"), op: "cut", speed: 40, power: 30, passes: 1 },
  { material: msg("2 mm leather"), op: "cut", speed: 20, power: 45, passes: 1 },
  { material: msg("2 mm leather"), op: "engrave", speed: 300, power: 20, passes: 1 },
];

/** Seed settings for a class: power scaled by tube power (80 W reference), within 5–90 %. */
export function seedsFor(c: MachineClass): MaterialSeed[] {
  const k = 80 / c.tube;
  return MATERIAL_SEEDS.map((s) => ({ ...s, power: Math.round(Math.min(90, Math.max(5, s.power * k))) }));
}

/**
 * A profile with a class's defaults: motion values and frame speed always, the bed only when it wasn't read from
 * the controller (`keepBed`).
 */
export function applyClass(p: MachineProfile, c: MachineClass, keepBed: boolean): MachineProfile {
  const { bedW, bedH, ...motion } = c.defaults;
  return { ...p, ...motion, ...(keepBed ? {} : { bedW, bedH }), class: c.id };
}
