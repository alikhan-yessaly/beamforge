import { t } from "../i18n";
import { signal } from "@preact/signals";
import type { Layer } from "../scene/model";

export const MATERIALS_KEY = "ruida-web.materials.v1";

export interface MaterialPreset {
  id: string;
  name: string;
  machine: string;
  speed: number;
  minPower: number;
  maxPower: number;
  passes: number;
}

export function validPreset(p: MaterialPreset): boolean {
  return !!p.id && !!p.name.trim() && !!p.machine.trim() &&
    Number.isFinite(p.speed) && p.speed >= 0.1 &&
    Number.isFinite(p.minPower) && p.minPower >= 0 && p.minPower <= 100 &&
    Number.isFinite(p.maxPower) && p.maxPower >= p.minPower && p.maxPower <= 100 &&
    Number.isInteger(p.passes) && p.passes >= 1 && p.passes <= 99;
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
export function presetSettings(p: MaterialPreset): Pick<Layer, "speed" | "minPower" | "maxPower" | "passes" | "linkPower"> {
  if (!validPreset(p)) throw new Error(t("Material preset settings are invalid"));
  return { speed: p.speed, minPower: p.minPower, maxPower: p.maxPower, passes: p.passes, linkPower: p.minPower === p.maxPower };
}

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

/** Presets of one machine profile, sorted by name. */
export const presetsFor = (machine: string) =>
  presets.value.filter((p) => p.machine === machine).sort((a, b) => a.name.localeCompare(b.name));

/** True if the layer's settings still equal the preset's. */
export function matchesPreset(l: Pick<Layer, "speed" | "minPower" | "maxPower" | "passes">, p: MaterialPreset): boolean {
  return l.speed === p.speed && l.minPower === p.minPower && l.maxPower === p.maxPower && l.passes === p.passes;
}
