// ASCII DXF writer (AutoCAD 2000 layout, LWPOLYLINE entities) for LightBurn, Inkscape, LibreCAD and our own reader.
import { aciToHex } from "../dxf/aci";
import { pathsBox } from "../geom/geom";
import type { ExportPath } from "../import/types";

type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? Number.parseInt(m[1]!, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Standard AutoCAD palette, built once. 7 is white/black and handled separately in aciNearest.
const PALETTE: { aci: number; rgb: Rgb }[] = [];
for (let i = 1; i <= 255; i++) if (i !== 7) PALETTE.push({ aci: i, rgb: hexRgb(aciToHex(i)) });

/** Nearest AutoCAD Color Index (1-255) for a #rrggbb colour; pure black and white give 7 (the "white/black" index). */
export function aciNearest(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  if ((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255)) return 7;
  let best = 7;
  let bestD = Infinity;
  for (const p of PALETTE) {
    const d = (p.rgb[0] - r) ** 2 + (p.rgb[1] - g) ** 2 + (p.rgb[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p.aci;
    }
  }
  return best;
}

/** Fixed-point, trimmed, never "-0" or exponent notation. */
function fmt(n: number): string {
  const s = n.toFixed(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

const normColor = (c: string): string => {
  const [r, g, b] = hexRgb(c);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};
const trueColor = (c: string): number => Number.parseInt(normColor(c).slice(1), 16);

/** Write paths as a DXF in mm. DXF is Y-up, so y is flipped against the drawing's top edge. */
export function writeDxf(paths: ExportPath[], opts: { keepPosition?: boolean } = {}): string {
  const used = paths.filter((p) => p.points.length >= 2);
  const box = pathsBox(used);
  const has = used.length > 0;
  const ox = has && !opts.keepPosition ? box.minX : 0;
  const height = has ? box.maxY - (opts.keepPosition ? 0 : box.minY) : 0;
  const oy = has && !opts.keepPosition ? box.minY : 0;

  const layers = new Map<string, string>(); // colour -> layer name, first-seen order
  for (const p of used) {
    const c = normColor(p.color);
    if (!layers.has(c)) layers.set(c, `L${String(layers.size + 1).padStart(2, "0")}_${c.slice(1)}`);
  }

  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));
  let handle = 0x10;
  const h = () => (handle++).toString(16).toUpperCase();

  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$ACADVER");
  g(1, "AC1015");
  g(9, "$INSUNITS");
  g(70, 4);
  g(9, "$MEASUREMENT");
  g(70, 1);
  g(9, "$EXTMIN");
  g(10, 0);
  g(20, 0);
  g(30, 0);
  g(9, "$EXTMAX");
  g(10, fmt(has ? box.maxX - ox : 0));
  g(20, fmt(height));
  g(30, 0);
  g(0, "ENDSEC");

  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LTYPE");
  g(5, h());
  g(100, "AcDbSymbolTable");
  g(70, 1);
  g(0, "LTYPE");
  g(5, h());
  g(100, "AcDbSymbolTableRecord");
  g(100, "AcDbLinetypeTableRecord");
  g(2, "CONTINUOUS");
  g(70, 0);
  g(3, "Solid line");
  g(72, 65);
  g(73, 0);
  g(40, 0);
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "LAYER");
  g(5, h());
  g(100, "AcDbSymbolTable");
  g(70, layers.size);
  for (const [c, name] of layers) {
    g(0, "LAYER");
    g(5, h());
    g(100, "AcDbSymbolTableRecord");
    g(100, "AcDbLayerTableRecord");
    g(2, name);
    g(70, 0);
    g(62, aciNearest(c));
    g(420, trueColor(c));
    g(6, "CONTINUOUS");
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");

  g(0, "SECTION");
  g(2, "ENTITIES");
  for (const p of used) {
    const c = normColor(p.color);
    g(0, "LWPOLYLINE");
    g(5, h());
    g(100, "AcDbEntity");
    g(8, layers.get(c)!);
    g(62, aciNearest(c));
    g(420, trueColor(c));
    g(100, "AcDbPolyline");
    g(90, p.points.length);
    g(70, p.closed ? 1 : 0);
    for (const pt of p.points) {
      g(10, fmt(pt.x - ox));
      g(20, fmt(height - (pt.y - oy)));
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return `${out.join("\n")}\n`;
}
