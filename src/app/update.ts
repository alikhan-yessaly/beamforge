// Is the site serving a newer build than the one running? Pure.

export interface BuildInfo {
  version: string;
  id: string;
  time: string;
  notes: string;
}

export function parseBuild(v: unknown): BuildInfo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.time !== "string") return null;
  return { version: String(o.version ?? ""), id: o.id, time: o.time, notes: typeof o.notes === "string" ? o.notes : "" };
}

/** The served build, when it's a different build made after the running one. */
export function newerBuild(running: BuildInfo, served: BuildInfo | null): BuildInfo | null {
  if (!served || served.id === running.id) return null;
  return Date.parse(served.time) > Date.parse(running.time) ? served : null;
}
