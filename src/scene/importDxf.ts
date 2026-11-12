import { parseDxf } from "../dxf/parse";
import { t } from "../i18n";
import { type Seg, type Vec, pathsBox, translate } from "../geom/geom";
import { type MachineProfile, type SceneObject, newId } from "./model";

export interface ImportResult {
  object: SceneObject | null;
  warnings: string[];
}

/**
 * Parse a DXF into one scene object (like LightBurn's grouped import): converts to mm, flips Y (DXF is Y-up),
 * normalises the local origin to the drawing's top-left and centres it on the bed.
 */
export function importDxf(text: string, name: string, profile: MachineProfile): ImportResult {
  const r = parseDxf(text);
  const k = r.unitScale;
  const paths = r.paths.map((p) => ({ color: p.color, closed: p.closed, points: p.points.map((v) => ({ x: v.x * k, y: -v.y * k })) }));
  if (paths.length === 0) return { object: null, warnings: [...r.warnings, t("No drawable entities found")] };
  const b = pathsBox(paths);
  // To local mm: scale, flip Y (DXF is Y-up), origin at the drawing's top-left. Lines and arcs go the same way.
  const f = (v: Vec): Vec => ({ x: v.x * k - b.minX, y: -v.y * k - b.minY });
  const seg = (s: Seg): Seg => (s.kind === "line" ? { kind: "line", a: f(s.a), b: f(s.b) } : s.kind === "arc" ? { kind: "arc", a: f(s.a), m: f(s.m), b: f(s.b) } : { kind: "circle", c: f(s.c), r: s.r * k });
  const local = paths.map((p, i) => {
    const segs = r.paths[i]!.segs;
    return { ...p, points: p.points.map((v) => ({ x: v.x - b.minX, y: v.y - b.minY })), segs: segs ? segs.map(seg) : null };
  });
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const warnings = [...r.warnings];
  if (w > profile.bedW || h > profile.bedH) warnings.push(t("Drawing is {w} × {h} mm, larger than the bed", { w: w.toFixed(1), h: h.toFixed(1) }));
  return {
    object: { id: newId(), name, paths: local, mat: translate((profile.bedW - w) / 2, (profile.bedH - h) / 2) },
    warnings,
  };
}
