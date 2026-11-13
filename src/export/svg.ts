// SVG writer: millimetre units (1 user unit = 1 mm), one Inkscape layer per colour.
import { pathsBox } from "../geom/geom";
import type { ExportPath } from "../import/types";

export interface ExportLayout {
  /** Page size, mm. */
  w: number;
  h: number;
  /** Added to a bed coordinate to get the page coordinate (still y down). */
  dx: number;
  dy: number;
}

/** Fixed-point with at most `digits` decimals, trimmed, never "-0" or exponent notation. */
export function fmtNum(n: number, digits = 3): string {
  const s = n.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/** Lower-case #rrggbb; anything unparsable becomes black. */
export function normHex(c: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return `#${(m ? m[1]! : "000000").toLowerCase()}`;
}

export function hexParts(c: string): [number, number, number] {
  const n = Number.parseInt(normHex(c).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface ExportLayer {
  color: string;
  name: string;
  paths: ExportPath[];
}

/** One layer per distinct colour in first-seen order; paths under 2 points are dropped. */
export function groupLayers(paths: ExportPath[]): ExportLayer[] {
  const map = new Map<string, ExportLayer>();
  for (const p of paths) {
    if (p.points.length < 2) continue;
    const color = normHex(p.color);
    let l = map.get(color);
    if (!l) {
      l = { color, name: `L${String(map.size + 1).padStart(2, "0")}_${color.slice(1)}`, paths: [] };
      map.set(color, l);
    }
    l.paths.push(p);
  }
  return [...map.values()];
}

/** Page size and offset. Without keepPosition the drawing's box moves to the page corner (plus margin). */
export function layoutExport(paths: ExportPath[], opts: { keepPosition?: boolean; page?: { w: number; h: number }; marginMm?: number }): ExportLayout {
  const used = paths.filter((p) => p.points.length >= 2);
  const has = used.length > 0;
  const b = pathsBox(used);
  const margin = opts.marginMm ?? 0;
  if (opts.keepPosition) {
    return { w: opts.page?.w ?? (has ? b.maxX : 0), h: opts.page?.h ?? (has ? b.maxY : 0), dx: 0, dy: 0 };
  }
  const bw = has ? b.maxX - b.minX : 0;
  const bh = has ? b.maxY - b.minY : 0;
  return {
    w: opts.page?.w ?? bw + 2 * margin,
    h: opts.page?.h ?? bh + 2 * margin,
    dx: (has ? -b.minX : 0) + margin,
    dy: (has ? -b.minY : 0) + margin,
  };
}

/** Compound path data: every path as its own M/L(/Z) subpath. */
function pathData(paths: ExportPath[], lay: ExportLayout): string {
  return paths
    .map((p) => {
      const pts = p.points.map((q, i) => `${i === 0 ? "M" : "L"}${fmtNum(q.x + lay.dx)} ${fmtNum(q.y + lay.dy)}`);
      return pts.join("") + (p.closed ? "Z" : "");
    })
    .join("");
}

/** Closed paths grouped by a colour, in first-seen order. */
function groupBy(paths: ExportPath[], key: (p: ExportPath) => string | undefined): Map<string, ExportPath[]> {
  const m = new Map<string, ExportPath[]>();
  for (const p of paths) {
    const k = key(p);
    if (k === undefined) continue;
    const list = m.get(k);
    if (list) list.push(p);
    else m.set(k, [p]);
  }
  return m;
}

/** Layer colours' paths split into area fills (drawn first), filled layer paths and stroked outlines. */
export function splitLayer(layer: ExportLayer): { areaFills: Map<string, ExportPath[]>; fillPaths: ExportPath[]; strokes: ExportPath[] } {
  const fillPaths = layer.paths.filter((p) => p.fillLayer);
  const strokes = layer.paths.filter((p) => !p.fillLayer);
  const areaFills = groupBy(strokes, (p) => (p.closed && p.fill ? normHex(p.fill) : undefined));
  return { areaFills, fillPaths, strokes };
}

export function writeSvg(paths: ExportPath[], opts: { keepPosition?: boolean; page?: { w: number; h: number }; marginMm?: number } = {}): string {
  const lay = layoutExport(paths, opts);
  const w = fmtNum(lay.w);
  const h = fmtNum(lay.h);
  const out: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
  ];
  for (const layer of groupLayers(paths)) {
    const { areaFills, fillPaths, strokes } = splitLayer(layer);
    out.push(`<g id="layer-${layer.color.slice(1)}" inkscape:groupmode="layer" inkscape:label="${layer.name}">`);
    // Area fills first so the outline stays visible on top of them.
    for (const [color, list] of areaFills) out.push(`<path d="${pathData(list, lay)}" fill="${color}" fill-rule="evenodd" stroke="none"/>`);
    if (fillPaths.length) out.push(`<path d="${pathData(fillPaths, lay)}" fill="${layer.color}" fill-rule="evenodd" stroke="none"/>`);
    for (const p of strokes) out.push(`<path d="${pathData([p], lay)}" fill="none" stroke="${layer.color}" stroke-width="0.1"/>`);
    out.push(`</g>`);
  }
  out.push(`</svg>`);
  return `${out.join("\n")}\n`;
}
