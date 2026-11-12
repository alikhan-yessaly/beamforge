// `.laserproj` project files: the drawing, layers and job options in machine-neutral units (mm, mm/s, %), plus a
// separate, informational `machine` entry, so a future driver for another laser can open the same file.
import type { Doc, Layer, SceneObject, ScenePath } from "../scene/model";

export const PROJECT_EXT = ".laserproj";
export const PROJECT_FORMAT = "laserproj";
export const PROJECT_VERSION = 1;

export interface ProjectJob {
  startFrom: "absolute" | "current";
  innerFirst: boolean;
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
}

export function serializeProject(doc: Doc, job: ProjectJob, machine: ProjectMachine, now = new Date()): string {
  const file: ProjectFile = { format: PROJECT_FORMAT, version: PROJECT_VERSION, app: "ruida-web", savedAt: now.toISOString(), machine, job, doc };
  return JSON.stringify(file, null, 1);
}

class ProjectError extends Error {}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkPath(p: unknown, where: string): ScenePath {
  if (!isObj(p) || !isStr(p.color) || typeof p.closed !== "boolean" || !Array.isArray(p.points)) throw new ProjectError(`Invalid path in ${where}`);
  for (const q of p.points) if (!isObj(q) || !isNum(q.x) || !isNum(q.y)) throw new ProjectError(`Invalid point in ${where}`);
  return p as unknown as ScenePath;
}

function checkObject(o: unknown, depth = 0): SceneObject {
  if (depth > 50) throw new ProjectError("Groups are nested too deeply");
  if (!isObj(o) || !isStr(o.id) || !isStr(o.name) || !Array.isArray(o.paths) || !Array.isArray(o.mat) || o.mat.length !== 6 || !o.mat.every(isNum)) {
    throw new ProjectError("Invalid object");
  }
  o.paths.forEach((p) => checkPath(p, `object "${o.name}"`));
  if (o.children !== undefined) {
    if (!Array.isArray(o.children)) throw new ProjectError(`Invalid group "${o.name}"`);
    o.children.forEach((c) => checkObject(c, depth + 1));
  }
  return o as unknown as SceneObject;
}

function checkLayer(l: unknown): Layer {
  if (!isObj(l) || !isStr(l.color) || !isNum(l.speed) || !isNum(l.minPower) || !isNum(l.maxPower) || !isNum(l.passes) || typeof l.output !== "boolean") {
    throw new ProjectError("Invalid layer settings");
  }
  return l as unknown as Layer;
}

/** Parse and validate a project file. Throws an Error with a readable message. */
export function parseProject(text: string): ProjectFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectError("Not a project file (not valid JSON)");
  }
  if (!isObj(raw) || raw.format !== PROJECT_FORMAT) throw new ProjectError("Not a .laserproj project file");
  if (!isNum(raw.version) || raw.version < 1) throw new ProjectError("Unknown project file version");
  if (raw.version > PROJECT_VERSION) throw new ProjectError(`This project was saved by a newer version of the app (format ${raw.version}); update the app to open it`);
  if (!isObj(raw.doc) || !Array.isArray(raw.doc.objects)) throw new ProjectError("The project has no drawing");
  const objects = raw.doc.objects.map((o) => checkObject(o));
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
    },
    doc: { objects, layers },
  };
}

/** Project name from a file name: "plate.laserproj" → "plate". */
export const projectName = (fileName: string) => fileName.replace(/\.laserproj$/i, "") || "Untitled";
