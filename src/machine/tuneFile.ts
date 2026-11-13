// `.beamtune` tuning files: one machine profile and its material library, for backup and for moving a machine's
// tuning to another browser. JSON, versioned like project files.
import { t } from "../i18n";
import type { MachineProfile } from "../scene/model";
import { type MaterialPreset, validPreset } from "./presets";

export const TUNE_EXT = ".beamtune";
export const TUNE_FORMAT = "beamtune";
export const TUNE_VERSION = 1;

export interface TuneFile {
  format: typeof TUNE_FORMAT;
  version: number;
  savedAt: string;
  profile: MachineProfile;
  materials: MaterialPreset[];
}

export function serializeTune(profile: MachineProfile, materials: MaterialPreset[], now = new Date()): string {
  const file: TuneFile = { format: TUNE_FORMAT, version: TUNE_VERSION, savedAt: now.toISOString(), profile, materials };
  return JSON.stringify(file, null, 1);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and check a tuning file. Throws an Error with a readable message. */
export function parseTune(text: string): TuneFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(t("Not a tuning file (not valid JSON)"));
  }
  if (!isObj(raw) || raw.format !== TUNE_FORMAT) throw new Error(t("Not a .beamtune tuning file"));
  if (!isNum(raw.version) || raw.version < 1) throw new Error(t("Unknown tuning file version"));
  if (raw.version > TUNE_VERSION) throw new Error(t("This tuning file was saved by a newer version of the app; update the app to open it"));
  const p = raw.profile;
  if (!isObj(p) || typeof p.name !== "string" || !isNum(p.bedW) || !isNum(p.bedH) || !isNum(p.travelSpeed) || !isNum(p.accel) || p.bedW <= 0 || p.bedH <= 0 || p.travelSpeed <= 0 || p.accel <= 0) {
    throw new Error(t("The tuning file's machine profile is invalid"));
  }
  if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(p.origin as string)) throw new Error(t("The tuning file's machine profile is invalid"));
  for (const k of ["startSpeed", "minFirePower", "frameSpeed"] as const) if (p[k] !== undefined && !isNum(p[k])) throw new Error(t("The tuning file's machine profile is invalid"));
  if (p.scanOffsets !== undefined && (!Array.isArray(p.scanOffsets) || !p.scanOffsets.every((e) => isObj(e) && isNum(e.speed) && isNum(e.offset)))) throw new Error(t("The tuning file's machine profile is invalid"));
  const materials = Array.isArray(raw.materials) ? raw.materials : [];
  if (!materials.every((m) => isObj(m) && typeof m.id === "string" && typeof m.name === "string" && typeof m.machine === "string" && validPreset(m as unknown as MaterialPreset))) {
    throw new Error(t("The tuning file's materials are invalid"));
  }
  return { format: TUNE_FORMAT, version: raw.version, savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "", profile: p as unknown as MachineProfile, materials: materials as unknown as MaterialPreset[] };
}
