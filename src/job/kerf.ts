// Kerf compensation for cut layers: the beam removes a strip about `kerf` wide centred on the path, so parts come
// out smaller and holes bigger by that much. Closed outlines grow by half the kerf and the holes inside them shrink
// by half (nesting depth decides which is which); open paths are left as they are.
import ClipperLib from "clipper-lib";
import { type Vec, pointInPolygon } from "../geom/geom";

const UM = 1000;

/** Offset closed rings by ±kerf/2: even nesting depth (outlines) outward, odd (holes) inward. */
export function kerfRings(rings: Vec[][], kerf: number): Vec[][][] {
  if (!(kerf > 0)) return rings.map((r) => [r]);
  const depth = rings.map((r, i) => rings.reduce((n, o, j) => (j !== i && o.length >= 3 && pointInPolygon(r[0]!, o) && !rings[i]!.every((p) => o.includes(p)) ? n + 1 : n), 0));
  return rings.map((r, i) => {
    if (r.length < 3) return [r];
    const co = new ClipperLib.ClipperOffset(2, 0.005 * UM);
    co.AddPaths([r.map((p) => ({ X: Math.round(p.x * UM), Y: Math.round(p.y * UM) }))], ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
    const out = new ClipperLib.Paths();
    co.Execute(out, ((depth[i]! % 2 === 0 ? 1 : -1) * kerf * UM) / 2);
    return out.filter((p) => p.length >= 3).map((p) => p.map((q) => ({ x: q.X / UM, y: q.Y / UM })));
  });
}
