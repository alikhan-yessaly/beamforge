// `.laserproj` project files: the drawing, layers and job options in machine-neutral units (mm, mm/s, %), plus a
// separate, informational `machine` entry, so a future driver for another laser can open the same file.
import { t } from "../i18n";
import { type Doc, type Layer, type SceneObject, type ScenePath, newId } from "../scene/model";
import { migrateDoc } from "../job/layers";
import type { JobOrder } from "../job/plan";
import { type MaterialPreset, validPreset } from "../machine/presets";

export const PROJECT_EXT = ".laserproj";
export const PROJECT_FORMAT = "laserproj";
export const PROJECT_VERSION = 1;

export interface ProjectJob {
  startFrom: "absolute" | "current";
  innerFirst: boolean;
  /** Missing in older files: "auto". */
  order?: JobOrder;
}

export interface ProjectMachine {
  /** Which controller family the job was set up for, e.g. "ruida". */
  driver: string;
  /** Controller model or card ID when known, e.g. "card 0x65106510". */
  model: string | null;
  /** Name of the machine profile in use when saved (bed size and origin stay with the machine, not the file). */
  profileName: string;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  app: string;
  savedAt: string;
  machine: ProjectMachine;
  job: ProjectJob;
  doc: Doc;
  /** The material presets the layers use (a copy, so the file still opens with them on another machine). */
  materials?: MaterialPreset[];
}

export function serializeProject(doc: Doc, job: ProjectJob, machine: ProjectMachine, now = new Date(), materials: MaterialPreset[] = []): string {
  const used = new Set((doc.layers ?? []).map((l) => l.material).filter(Boolean));
  const mats = materials.filter((m) => used.has(m.id));
  const file: ProjectFile = { format: PROJECT_FORMAT, version: PROJECT_VERSION, app: "ruida-web", savedAt: now.toISOString(), machine, job, doc, ...(mats.length ? { materials: mats } : {}) };
  return JSON.stringify(file, null, 1);
}

class ProjectError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkPath(p: unknown, where: string): ScenePath {
  if (!isObj(p) || !isStr(p.color) || typeof p.closed !== "boolean" || !Array.isArray(p.points)) throw new ProjectError(t("Invalid path in {where}", { where }));
  for (const q of p.points) if (!isObj(q) || !isNum(q.x) || !isNum(q.y)) throw new ProjectError(t("Invalid point in {where}", { where }));
  if (p.fill !== undefined && !isStr(p.fill)) throw new ProjectError(t("Invalid fill colour in {where}", { where }));
  return p as unknown as ScenePath;
}

function checkObject(o: unknown, depth = 0): SceneObject {
  if (depth > 50) throw new ProjectError(t("Groups are nested too deeply"));
  if (!isObj(o) || !isStr(o.id) || !isStr(o.name) || !Array.isArray(o.paths) || !Array.isArray(o.mat) || o.mat.length !== 6 || !o.mat.every(isNum)) {
    throw new ProjectError(t("Invalid object"));
  }
  o.paths.forEach((p) => checkPath(p, t("object \"{name}\"", { name: String(o.name) })));
  if (o.image !== undefined) {
    const im = o.image;
    if (!isObj(im) || !isStr(im.src) || !im.src.startsWith("data:image/") || !isNum(im.w) || !isNum(im.h) || !(im.w > 0) || !(im.h > 0)) {
      throw new ProjectError(t("Invalid image in object \"{name}\"", { name: String(o.name) }));
    }
  }
  if (o.children !== undefined) {
    if (!Array.isArray(o.children)) throw new ProjectError(t("Invalid group \"{name}\"", { name: String(o.name) }));
    o.children.forEach((c) => checkObject(c, depth + 1));
  }
  return o as unknown as SceneObject;
}

function checkLayer(l: unknown): Layer {
  if (!isObj(l) || !isStr(l.color) || !isNum(l.speed) || !isNum(l.minPower) || !isNum(l.maxPower) || !isNum(l.passes) || typeof l.output !== "boolean") {
    throw new ProjectError(t("Invalid layer settings"));
  }
  // Values the layer fields could never produce (a hand-edited or foreign file) are brought into their ranges, so a
  // file can't plan a job at speed 0, with fractional passes or a fill with no spacing.
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const minPower = clamp(l.minPower, 0, 100);
  const out = { ...l, speed: clamp(l.speed, 0.1, 10_000), minPower, maxPower: clamp(l.maxPower, minPower, 100), passes: clamp(Math.round(l.passes), 1, 99) } as Record<string, unknown>;
  if (out.kerf !== undefined) out.kerf = isNum(out.kerf) ? clamp(out.kerf, 0, 2) : undefined;
  if (out.fill !== undefined) {
    const f = out.fill;
    out.fill = isObj(f) && isNum(f.interval) && isNum(f.angle) ? { ...f, interval: clamp(f.interval, 0.01, 50) } : undefined;
  }
  return out as unknown as Layer;
}

/** Give repeated object ids (at any group level) fresh ones: selection and editing go by id. */
function uniqueIds(objects: SceneObject[], seen = new Set<string>()): SceneObject[] {
  return objects.map((o) => {
    const id = seen.has(o.id) ? newId() : o.id;
    seen.add(id);
    return { ...o, id, ...(o.children ? { children: uniqueIds(o.children, seen) } : {}) };
  });
}

/** Parse and validate a project file. Throws an Error with a readable message. */
export function parseProject(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectError(t("Not a project file (not valid JSON)"));
  }
  if (!isObj(raw) || raw.format !== PROJECT_FORMAT) throw new ProjectError(t("Not a .laserproj project file"));
  if (!isNum(raw.version) || raw.version < 1) throw new ProjectError(t("Unknown project file version"));
  if (raw.version > PROJECT_VERSION) throw new ProjectError(t("This project was saved by a newer version of the app (format {v}); update the app to open it", { v: raw.version }));
  if (!isObj(raw.doc) || !Array.isArray(raw.doc.objects)) throw new ProjectError(t("The project has no drawing"));
  const objects = uniqueIds(raw.doc.objects.map((o) => checkObject(o)));
  const layers = Array.isArray(raw.doc.layers) ? raw.doc.layers.map(checkLayer) : [];
  const job = isObj(raw.job) ? raw.job : {};
  const machine = isObj(raw.machine) ? raw.machine : {};
  return {
    format: PROJECT_FORMAT,
    version: raw.version,
    app: isStr(raw.app) ? raw.app : "unknown",
    savedAt: isStr(raw.savedAt) ? raw.savedAt : "",
    machine: {
      driver: isStr(machine.driver) ? machine.driver : "ruida",
      model: isStr(machine.model) ? machine.model : null,
      profileName: isStr(machine.profileName) ? machine.profileName : "",
    },
    job: {
      startFrom: job.startFrom === "current" ? "current" : "absolute",
      innerFirst: job.innerFirst !== false,
      order: job.order === "layer" || job.order === "object" ? job.order : "auto",
    },
    doc: migrateDoc({ objects, layers }),
    materials: Array.isArray(raw.materials)
      ? raw.materials.filter((m): m is MaterialPreset => isObj(m) && isStr(m.id) && isStr(m.name) && isStr(m.machine) && validPreset(m as unknown as MaterialPreset))
      : [],
  };
}

const sameSettings = (a: MaterialPreset, b: MaterialPreset) =>
  a.speed === b.speed && a.minPower === b.minPower && a.maxPower === b.maxPower && a.passes === b.passes && (a.kerf ?? 0) === (b.kerf ?? 0);

/**
 * A file's materials against the local library: ones the library doesn't have, and ones it has (same id) with
 * different settings.
 */
export function compareMaterials(file: MaterialPreset[], local: MaterialPreset[]): { missing: MaterialPreset[]; differ: { file: MaterialPreset; local: MaterialPreset }[] } {
  const byId = new Map(local.map((m) => [m.id, m]));
  const missing: MaterialPreset[] = [];
  const differ: { file: MaterialPreset; local: MaterialPreset }[] = [];
  for (const f of file) {
    const l = byId.get(f.id);
    if (!l) missing.push(f);
    else if (!sameSettings(f, l)) differ.push({ file: f, local: l });
  }
  return { missing, differ };
}

/** Project name from a file name: "plate.laserproj" → "plate". */
export const projectName = (fileName: string) => fileName.replace(/\.laserproj$/i, "") || "Untitled";
