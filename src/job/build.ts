// Document → job: plan the toolpath, convert bed millimetres to machine micrometres, group into layers of paths
// for the .rd encoder.
import { t } from "../i18n";
import { type RdJobInput, type RdLayer, type PointUm, encodeJob } from "../protocol/jobEncode";
import { type Doc, type MachineProfile, toUser } from "../scene/model";
import { type Toolpath, planToolpath } from "./plan";
import { apply } from "../geom/geom";
import { visibleDocument } from "./layers";

export interface BuildOptions {
  /**
   * absolute: the design is cut where it sits on the bed.
   * current: the design is cut relative to the head's position when the job starts; the head marks the design's
   * corner nearest the machine origin (verified with LightBurn for an origin-corner job origin).
   */
  mode: "absolute" | "current";
  innerFirst: boolean;
}

export interface BuiltJob {
  input: RdJobInput;
  toolpath: Toolpath;
  /** Nearest-home corner of the visible paths, in machine µm before relative normalization. */
  designOrigin: PointUm;
}

/** Bed mm (internal, top-left, y down) → machine µm (from the home corner, into the bed). */
export function toMachineUm(p: MachineProfile, v: { x: number; y: number }): PointUm {
  const u = toUser(p, v);
  return { x: Math.round(u.x * 1000), y: Math.round(u.y * 1000) };
}

/** Nearest-home corner of visible drawable paths, independent of layer output. */
export function designOrigin(doc: Doc, profile: MachineProfile): PointUm | null {
  let x = Infinity;
  let y = Infinity;
  for (const obj of visibleDocument(doc).objects) {
    for (const path of obj.paths) {
      if (path.points.length < 2) continue;
      for (const pt of path.points) {
        const machine = toMachineUm(profile, apply(obj.mat, pt));
        x = Math.min(x, machine.x);
        y = Math.min(y, machine.y);
      }
    }
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function buildJob(doc: Doc, profile: MachineProfile, opts: BuildOptions): BuiltJob {
  const home = { x: profile.origin.endsWith("right") ? profile.bedW : 0, y: profile.origin.startsWith("bottom") ? profile.bedH : 0 };
  const tp = planToolpath(doc, { start: home, innerFirst: opts.innerFirst });
  if (tp.errors.length) throw new Error(tp.errors.join(" "));
  if (!tp.segments.some((s) => s.cut)) throw new Error(t("Nothing to cut: no layer with output on has any paths"));

  // Segments → per-layer paths. A cut that doesn't continue from the previous cut starts a new path.
  const layers: RdLayer[] = tp.layers.map((l) => ({ speed: l.speed, minPower: l.minPower, maxPower: l.maxPower, color: l.color, paths: [] }));
  let path: PointUm[] | null = null;
  let last: { li: number; x: number; y: number } | null = null;
  for (const s of tp.segments) {
    if (!s.cut) {
      path = null;
      continue;
    }
    const a = toMachineUm(profile, { x: s.x0, y: s.y0 });
    const b = toMachineUm(profile, { x: s.x1, y: s.y1 });
    if (!path || !last || last.li !== s.layer || last.x !== a.x || last.y !== a.y) {
      path = [a];
      layers[s.layer]!.paths.push(path);
    }
    path.push(b);
    last = { li: s.layer, x: b.x, y: b.y };
  }

  const all = layers.flatMap((l) => l.paths.flat());
  const bedX = Math.round(profile.bedW * 1000);
  const bedY = Math.round(profile.bedH * 1000);
  const outside = all.some((p) => p.x < 0 || p.y < 0 || p.x > bedX || p.y > bedY);
  if (opts.mode === "absolute" && outside) throw new Error(t("Part of the design is outside the bed; move it onto the bed first"));

  const origin = designOrigin(doc, profile);
  if (opts.mode === "current") {
    if (!origin) throw new Error(t("Show at least one layer with drawable paths to set the relative origin"));
    for (const l of layers) l.paths = l.paths.map((p) => p.map((v) => ({ x: v.x - origin.x, y: v.y - origin.y })));
    if (layers.some((l) => l.paths.some((p) => p.some((v) => v.x < 0 || v.y < 0)))) {
      throw new Error(t("A hidden output layer lies beyond the relative origin. Show it or turn off its output before framing, starting, or saving."));
    }
  }
  return { input: { mode: opts.mode, layers: layers.filter((l) => l.paths.length > 0) }, toolpath: tp, designOrigin: origin ?? { x: 0, y: 0 } };
}

/** The .rd file bytes for the document. */
export const buildRdFile = (doc: Doc, profile: MachineProfile, opts: BuildOptions, magic = 0x88) =>
  encodeJob(buildJob(doc, profile, opts).input, magic);
