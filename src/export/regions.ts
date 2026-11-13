// Filled areas for export, as regions that don't overlap, so a shape filled in another colour inside a filled
// shape shows its own colour whatever order the colours are drawn in. Pure.
//
// Two kinds of fill, as the planner engraves them:
//  - a closed path on a fill layer: even-odd with the other paths of its colour (same-colour paths inside are holes,
//    islands inside those fill again);
//  - an area fill (`ExportPath.fill`, the Fill tool or an imported fill under an outline): the path minus the
//    closed paths directly inside it.
// On top of that, each region leaves out the filled regions inside it, so nested colours never stack.
import type { Vec } from "../geom/geom";
import type { ExportPath } from "../import/types";
import { containment } from "../job/regions";
import type { ScenePath } from "../scene/model";

export interface FillRegion {
  /** Fill colour. */
  color: string;
  /** The layer colour the region is exported with (the path's own colour). */
  layer: string;
  /** Even-odd rings: the outline, then its holes. */
  rings: Vec[][];
}

const normHex = (c: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return `#${(m ? m[1]! : "000000").toLowerCase()}`;
};

/** A layer's regions as one even-odd ring list per fill colour (the regions are disjoint, so they combine). */
export function layerFills(regions: readonly FillRegion[], layer: string): Map<string, Vec[][]> {
  const m = new Map<string, Vec[][]>();
  for (const r of regions) {
    if (r.layer !== layer) continue;
    const list = m.get(r.color);
    if (list) list.push(...r.rings);
    else m.set(r.color, [...r.rings]);
  }
  return m;
}

export function fillRegions(paths: readonly ExportPath[]): FillRegion[] {
  const list = paths as unknown as ScenePath[];
  const parent = containment(list);
  const closed = (i: number) => paths[i]!.closed && paths[i]!.points.length >= 3;
  // The fill colour each closed path starts, and whether it is a region or a same-colour hole.
  const fillOf = paths.map((p, i) => (!closed(i) ? null : p.fillLayer ? normHex(p.color) : p.fill ? normHex(p.fill) : null));
  const isLayerFill = paths.map((p, i) => closed(i) && !!p.fillLayer);
  const sameDepth = (i: number): number => {
    let n = 0;
    for (let j = parent[i]!; j >= 0; j = parent[j]!) if (isLayerFill[j] && normHex(paths[j]!.color) === fillOf[i]) n++;
    return n;
  };
  // Regions start a fill. A same-colour hole (odd depth in its colour's even-odd group) only stops its own colour:
  // it is a boundary when the nearest boundary around it is a region of that colour; inside another colour's region
  // it changes nothing (that colour fills through it, as the machine does). Ancestors are settled first.
  const region = paths.map((_, i) => fillOf[i] !== null && (!isLayerFill[i] || sameDepth(i) % 2 === 0));
  const boundary = region.slice();
  const boundaryParent = (i: number): number => {
    for (let j = parent[i]!; j >= 0; j = parent[j]!) if (boundary[j]) return j;
    return -1;
  };
  const depth = (i: number) => {
    let n = 0;
    for (let j = parent[i]!; j >= 0; j = parent[j]!) n++;
    return n;
  };
  const holes = paths.map((_, i) => i).filter((i) => fillOf[i] !== null && !region[i]);
  for (const h of holes.sort((a, b) => depth(a) - depth(b))) {
    const a = boundaryParent(h);
    boundary[h] = a >= 0 && region[a]! && fillOf[a] === fillOf[h];
  }
  const out: FillRegion[] = [];
  paths.forEach((p, i) => {
    if (!region[i]) return;
    const rings = [p.points];
    paths.forEach((q, j) => {
      if (j === i || !closed(j)) return;
      // Fills and same-colour holes directly inside; for area fills, also every closed path directly inside.
      if ((boundary[j] && boundaryParent(j) === i) || (!isLayerFill[i] && parent[j] === i)) rings.push(q.points);
    });
    out.push({ color: fillOf[i]!, layer: normHex(p.color), rings });
  });
  return out;
}
