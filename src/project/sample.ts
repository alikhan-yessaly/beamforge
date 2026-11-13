// The sample project for first-time users: a small tag with a cut outline and hole, and an engraved star.
// Built in code so it needs no file on the site and always fits the active bed.
import type { Vec } from "../geom/geom";
import { translate } from "../geom/geom";
import { DEFAULT_LAYER, type Doc, type MachineProfile, type ScenePath, newId } from "../scene/model";

/** Layer colours of the sample: red cuts, blue engraves (the palette's own colours). */
export const SAMPLE_CUT = "#ff0000";
export const SAMPLE_FILL = "#0000ff";

export const SAMPLE_W = 60;
export const SAMPLE_H = 30;

function roundedRect(w: number, h: number, r: number, steps = 6): Vec[] {
  const pts: Vec[] = [];
  const corners: [number, number, number][] = [
    [w - r, r, -90],
    [w - r, h - r, 0],
    [r, h - r, 90],
    [r, r, 180],
  ];
  for (const [cx, cy, start] of corners)
    for (let i = 0; i <= steps; i++) {
      const a = ((start + (90 * i) / steps) * Math.PI) / 180;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  return pts;
}

function circle(c: Vec, r: number, steps = 32): Vec[] {
  return Array.from({ length: steps }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

function star(c: Vec, outer: number, inner: number, points = 5): Vec[] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const a = -Math.PI / 2 + (Math.PI * i) / points;
    return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
  });
}

/**
 * The sample document, centred on the bed: one object "Sample tag" (60 × 30 mm). Red is cut slowly with high
 * power; blue is a filled star, engraved fast and light. Both are gentle starting values for plywood or cardboard.
 */
export function sampleDoc(profile: Pick<MachineProfile, "bedW" | "bedH">, name: string): Doc {
  const paths: ScenePath[] = [
    { color: SAMPLE_CUT, closed: true, points: roundedRect(SAMPLE_W, SAMPLE_H, 4) },
    { color: SAMPLE_CUT, closed: true, points: circle({ x: 7, y: SAMPLE_H / 2 }, 2.5) },
    { color: SAMPLE_FILL, closed: true, fill: SAMPLE_FILL, points: star({ x: 36, y: SAMPLE_H / 2 + 1 }, 10, 4.2) },
  ];
  return {
    objects: [{ id: newId(), name, paths, mat: translate((profile.bedW - SAMPLE_W) / 2, (profile.bedH - SAMPLE_H) / 2) }],
    layers: [
      { ...DEFAULT_LAYER, color: SAMPLE_FILL, mode: "fill", speed: 200, minPower: 15, maxPower: 15, overscan: "auto" },
      { ...DEFAULT_LAYER, color: SAMPLE_CUT, mode: "cut", speed: 15, minPower: 55, maxPower: 55 },
    ],
  };
}
