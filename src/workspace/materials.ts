import { msg, t } from "../i18n";
import { signal } from "@preact/signals";
import type { Layer, MachineProfile } from "../scene/model";
import { newId } from "../scene/model";
import { type MachineClass, type MaterialOp, seedsFor } from "../machine/classes";

export const MATERIALS_KEY = "ruida-web.materials.v1";

export { type MaterialPreset, validPreset, parsePresets, presetSettings, presetOf } from "../machine/presets";
import { type MaterialPreset, parsePresets, presetOf } from "../machine/presets";

/** "20 %" for constant power, "20 % (corners 10 %)" otherwise. */
export const powerText = (p: { minPower: number; maxPower: number }) =>
  p.minPower === p.maxPower ? `${p.maxPower} %` : `${p.maxPower} % (corners ${p.minPower} %)`;

// ---------- Shared preset library (localStorage), used by layer cards and the Materials tab ----------

function load(): { items: MaterialPreset[]; error: string | null } {
  try {
    return { items: parsePresets(localStorage.getItem(MATERIALS_KEY)), error: null };
  } catch (e) {
    return { items: [], error: t("Could not load material presets: {error}. They will not be overwritten.", { error: e instanceof Error ? e.message : String(e) }) };
  }
}
const initial = load();
/** All presets, for every machine profile. */
export const presets = signal<MaterialPreset[]>(initial.items);
/** Set when the stored presets could not be read; saving is then refused so nothing is lost. */
export const presetsError = signal<string | null>(initial.error);

/** Replace the library. Returns false (and leaves it unchanged) if it could not be saved. */
export function savePresets(next: MaterialPreset[]): boolean {
  if (presetsError.value) return false;
  try {
    localStorage.setItem(MATERIALS_KEY, JSON.stringify(next));
    presets.value = next;
    return true;
  } catch {
    return false;
  }
}

/** Presets of one machine profile, sorted by material, then name. */
export const presetsFor = (m: Pick<MachineProfile, "id" | "name">) =>
  presets.value.filter((p) => presetOf(p, m)).sort((a, b) => (a.material ?? a.name).localeCompare(b.material ?? b.name) || a.name.localeCompare(b.name));

/** Display name of an operation (translate with t()). */
export const OP_NAME: Record<MaterialOp, string> = { cut: msg("cut"), engrave: msg("engrave"), score: msg("score") };

/** Starting presets for a machine of class `c` (powers scaled to its tube). */
export function seedPresets(m: Pick<MachineProfile, "id" | "name">, c: MachineClass): MaterialPreset[] {
  return seedsFor(c).map((s) => ({
    id: newId(),
    name: `${t(s.material)} · ${t(OP_NAME[s.op])}`,
    machine: m.name,
    machineId: m.id,
    material: t(s.material),
    op: s.op,
    speed: s.speed,
    minPower: s.power,
    maxPower: s.power,
    passes: s.passes,
  }));
}

/** True if the layer's settings still equal the preset's. */
export function matchesPreset(l: Pick<Layer, "speed" | "minPower" | "maxPower" | "passes">, p: MaterialPreset): boolean {
  return l.speed === p.speed && l.minPower === p.minPower && l.maxPower === p.maxPower && l.passes === p.passes;
}
