// The text "Copy diagnostics" puts on the clipboard: enough to tell what ran where, nothing from the drawing. Pure.

export interface DiagnosticsInput {
  build: { version: string; id: string; time: string };
  browser: { name: string; serial: boolean; mobile: boolean };
  userAgent: string;
  lang: string;
  connection: { kind: string; state: string; problem: string | null; message: string };
  machine: Record<string, unknown>;
  objects: number;
  layers: number;
  /** Recent warnings and errors, oldest first. */
  log: { time: string; kind: string; text: string }[];
}

/** Machine profile fields worth sharing (no names the owner typed). */
export const MACHINE_FIELDS = ["class", "controller", "bedW", "bedH", "origin", "travelSpeed", "frameSpeed", "accel", "startSpeed", "minFirePower", "tuning"] as const;

export function formatDiagnostics(d: DiagnosticsInput): string {
  const machine = MACHINE_FIELDS.filter((k) => d.machine[k] !== undefined)
    .map((k) => `${k}=${JSON.stringify(d.machine[k])}`)
    .join(" ");
  const lines = [
    "BeamForge diagnostics",
    `build: ${d.build.version} (${d.build.id}, ${d.build.time})`,
    `browser: ${d.browser.name}, web serial ${d.browser.serial ? "yes" : "no"}${d.browser.mobile ? ", mobile" : ""}`,
    `user agent: ${d.userAgent}`,
    `language: ${d.lang}`,
    `connection: ${d.connection.kind}, ${d.connection.state}${d.connection.problem ? `, problem ${d.connection.problem}` : ""}`,
    ...(d.connection.message ? [`last message: ${d.connection.message}`] : []),
    `machine: ${machine || "(defaults)"}`,
    `document: ${d.objects} objects, ${d.layers} layers`,
    "recent warnings and errors:",
    ...(d.log.length ? d.log.map((l) => `  ${l.time} ${l.kind}: ${l.text}`) : ["  (none)"]),
  ];
  return lines.join("\n");
}
