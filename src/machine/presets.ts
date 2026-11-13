// Material presets: one setting (speed, power, passes, and for cuts the kerf) for one material and operation, in a
// machine profile's library. Pure; the library itself lives in src/workspace/materials.ts (localStorage).
import { t } from "../i18n";
import type { Layer, MachineProfile } from "../scene/model";
import type { MaterialOp } from "./classes";

export interface MaterialPreset {
  id: string;
  name: string;
  /** Machine profile name (older presets match by it). */
  machine: string;
  /** Machine profile id; presets belong to that machine's library. */
  machineId?: string;
  /** Material the preset is for, e.g. "3 mm plywood"; presets of one material are listed together. */
  material?: string;
  /** What the preset does: picking it on a layer also sets the layer's mode (engrave = fill). */
  op?: MaterialOp;
  speed: number;
  minPower: number;
  maxPower: number;
  passes: number;
  /** Cut presets: kerf width in mm (from the kerf test card), applied as kerf compensation. */
  kerf?: number;
}

export function validPreset(p: MaterialPreset): boolean {
  return !!p.id && !!p.name.trim() && !!p.machine.trim() &&
    Number.isFinite(p.speed) && p.speed >= 0.1 &&
    Number.isFinite(p.minPower) && p.minPower >= 0 && p.minPower <= 100 &&
    Number.isFinite(p.maxPower) && p.maxPower >= p.minPower && p.maxPower <= 100 &&
    Number.isInteger(p.passes) && p.passes >= 1 && p.passes <= 99 &&
    (p.kerf === undefined || (Number.isFinite(p.kerf) && p.kerf >= 0 && p.kerf <= 2));
}

export function parsePresets(raw: string | null): MaterialPreset[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((p: unknown) =>
    typeof p === "object" && p !== null &&
    typeof (p as MaterialPreset).id === "string" &&
    typeof (p as MaterialPreset).name === "string" &&
    typeof (p as MaterialPreset).machine === "string" && validPreset(p as MaterialPreset),
  )) throw new Error(t("Saved material presets are invalid"));
  return parsed as MaterialPreset[];
}

/** The layer settings a preset sets; corner power is linked when the preset's two powers are equal. */
export function presetSettings(p: MaterialPreset): Partial<Omit<Layer, "color">> {
  if (!validPreset(p)) throw new Error(t("Material preset settings are invalid"));
  const out: Partial<Omit<Layer, "color">> = { speed: p.speed, minPower: p.minPower, maxPower: p.maxPower, passes: p.passes, linkPower: p.minPower === p.maxPower };
  if (p.op) out.mode = p.op === "engrave" ? "fill" : "cut";
  if (p.op === "cut") out.kerf = p.kerf ?? 0;
  return out;
}

/** Whether a preset belongs to a machine profile (by id; older presets by name). */
export const presetOf = (p: MaterialPreset, m: Pick<MachineProfile, "id" | "name">) => (p.machineId ? p.machineId === m.id : p.machine === m.name);
