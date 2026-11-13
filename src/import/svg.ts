// SVG importer: text -> paths in mm (y down, origin at the viewport's top-left), with stroke and fill colours.
// No DOM: uses the small parser in xml.ts. Clipping, masks, patterns, markers, text and images are not rendered.
import { msg } from "../i18n";
import { IDENTITY, type Mat, mul, rotate, scale, translate } from "../geom/geom";
import { flattenPathData, type Subpath } from "./svgPath";
import { FLATTEN_TOLERANCE_MM, type VecPath, type VectorImport } from "./types";
import { parseXml, type XmlNode } from "./xml";

const PX_TO_MM = 25.4 / 96;
const MAX_DEPTH = 200;

const NAMED_COLOR_DATA =
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,grey:808080,green:008000,greenyellow:adff2f,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32";

/** The 148 CSS named colours as "#rrggbb". */
export const NAMED_COLORS: Record<string, string> = Object.fromEntries(NAMED_COLOR_DATA.split(",").map((p) => [p.split(":")[0]!, "#" + p.split(":")[1]!]));

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
const rgbHex = (r: number, g: number, b: number) => "#" + hex2(r) + hex2(g) + hex2(b);

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t0: number) => {
    let x = t0;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [ch(hh + 1 / 3) * 255, ch(hh) * 255, ch(hh - 1 / 3) * 255];
}

/** CSS colour to "#rrggbb"; null for none/transparent/fully transparent; undefined when it is not a colour. */
export function parseColor(input: string): string | null | undefined {
  const s = input.trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return undefined;
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && h[3] === "0") return null;
      return "#" + h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
    }
    if (h.length === 6 || h.length === 8) {
      if (h.length === 8 && h.slice(6) === "00") return null;
      return "#" + h.slice(0, 6);
    }
    return undefined;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (fn) {
    const args = fn[2]!.split(/[\s,/]+/).filter(Boolean);
    if (args.length < 3) return undefined;
    const alphaArg = args[3];
    if (alphaArg !== undefined) {
      const al = alphaArg.endsWith("%") ? parseFloat(alphaArg) / 100 : parseFloat(alphaArg);
      if (!Number.isFinite(al)) return undefined;
      if (al <= 0) return null;
    }
    if (fn[1]!.startsWith("rgb")) {
      const c = args.slice(0, 3).map((a) => (a.endsWith("%") ? (parseFloat(a) * 255) / 100 : parseFloat(a)));
      if (c.some((v) => !Number.isFinite(v))) return undefined;
      return rgbHex(c[0]!, c[1]!, c[2]!);
    }
    const hue = parseFloat(args[0]!);
    const sat = parseFloat(args[1]!) / 100;
    const lig = parseFloat(args[2]!) / 100;
    if (![hue, sat, lig].every(Number.isFinite)) return undefined;
    const [r, g, b] = hslToRgb(hue, Math.max(0, Math.min(1, sat)), Math.max(0, Math.min(1, lig)));
    return rgbHex(r, g, b);
  }
  return NAMED_COLORS[s];
}

// ---------------------------------------------------------------- styles

type Style = Record<string, string>;
const INHERITED = ["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity", "color", "visibility"];
const PRESENTATION = new Set([...INHERITED, "display"]);

interface Rule {
  tag: string | null;
  classes: string[];
  id: string | null;
  spec: number;
  decl: Record<string, string>;
}

function parseDecls(text: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const part of text.split(";")) {
    const k = part.indexOf(":");
    if (k < 0) continue;
    const name = part.slice(0, k).trim().toLowerCase();
    const value = part.slice(k + 1).replace(/!important/i, "").trim();
    if (name && value) r[name] = value;
  }
  return r;
}

/** Simple selectors only: type, .class, #id, compounds of those, comma lists. Anything else is ignored. */
function parseStylesheet(css: string, rules: Rule[]): void {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") depth--;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (head.startsWith("@")) continue;
    const decl = parseDecls(body);
    for (const sel of head.split(",")) {
      const m = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(sel.trim());
      if (!m || (!m[1] && !m[2])) continue;
      const tag = m[1] && m[1] !== "*" ? m[1] : null;
      const classes: string[] = [];
      let id: string | null = null;
      for (const p of (m[2] ?? "").matchAll(/([.#])([\w-]+)/g)) {
        if (p[1] === ".") classes.push(p[2]!);
        else id = p[2]!;
      }
      rules.push({ tag, classes, id, spec: (tag ? 1 : 0) + classes.length * 10 + (id ? 100 : 0), decl });
    }
  }
}

function matches(rule: Rule, node: XmlNode): boolean {
  if (rule.tag && rule.tag !== node.name) return false;
  if (rule.id && node.attrs.id !== rule.id) return false;
  if (rule.classes.length) {
    const have = (node.attrs.class ?? "").split(/\s+/);
    if (!rule.classes.every((c) => have.includes(c))) return false;
  }
  return true;
}

// ---------------------------------------------------------------- document state

interface Doc {
  ids: Map<string, XmlNode>;
  rules: Rule[];
  warnings: string[];
  paths: VecPath[];
}

const warn = (doc: Doc, msg: string) => {
  if (!doc.warnings.includes(msg)) doc.warnings.push(msg);
};

interface Ctx {
  m: Mat;
  style: Style;
  /** Viewport size in user units, the base for percentage lengths. */
  vw: number;
  vh: number;
  /** ids of <use> targets being expanded, to stop cycles. */
  stack: string[];
}

function computeStyle(node: XmlNode, parent: Style, doc: Doc): Style {
  const s: Style = {};
  for (const k of INHERITED) if (parent[k] !== undefined) s[k] = parent[k]!;
  const set = (name: string, value: string) => {
    if (!PRESENTATION.has(name)) return;
    if (value.trim() === "inherit") {
      if (INHERITED.includes(name) && parent[name] !== undefined) s[name] = parent[name]!;
      return;
    }
    s[name] = value.trim();
  };
  for (const k of PRESENTATION) {
    const v = node.attrs[k];
    if (v !== undefined) set(k, v);
  }
  const hit = doc.rules.filter((r) => matches(r, node)).sort((a, b) => a.spec - b.spec); // stable: later rules win ties
  for (const r of hit) for (const [k, v] of Object.entries(r.decl)) set(k, v);
  if (node.attrs.style) for (const [k, v] of Object.entries(parseDecls(node.attrs.style))) set(k, v);
  return s;
}

function gradientColor(node: XmlNode, doc: Doc, depth = 0): string {
  const stop = node.children.find((c) => c.name === "stop");
  if (stop) {
    const raw = stop.attrs["stop-color"] ?? parseDecls(stop.attrs.style ?? "")["stop-color"];
    const c = raw !== undefined ? parseColor(raw) : undefined;
    return c ?? "#000000";
  }
  const href = node.attrs.href ?? node.attrs["xlink:href"];
  const next = href && depth < 10 ? doc.ids.get(href.replace(/^#/, "")) : undefined;
  return next && (next.name === "linearGradient" || next.name === "radialGradient") ? gradientColor(next, doc, depth + 1) : "#000000";
}

/** Resolve a fill/stroke value to a hex colour or null (none). `fallback` applies when the value is missing or invalid. */
function resolvePaint(raw: string | undefined, style: Style, fallback: string | null, doc: Doc): string | null {
  if (raw === undefined) return fallback;
  const v = raw.trim();
  if (v.toLowerCase() === "none") return null;
  if (/^url\(/i.test(v)) {
    const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/i.exec(v);
    const target = m ? doc.ids.get(m[1]!) : undefined;
    if (target && (target.name === "linearGradient" || target.name === "radialGradient")) return gradientColor(target, doc);
    const alt = m?.[2] ? parseColor(m[2]) : undefined;
    return alt === undefined ? "#000000" : alt;
  }
  if (v.toLowerCase() === "currentcolor") {
    const c = style.color !== undefined ? parseColor(style.color) : undefined;
    return c === undefined ? "#000000" : c;
  }
  const c = parseColor(v);
  return c === undefined ? fallback : c;
}

const transparent = (v: string | undefined) => {
  if (v === undefined) return false;
  const n = v.trim().endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  return Number.isFinite(n) && n <= 0;
};

// ---------------------------------------------------------------- lengths and transforms

const UNIT_PX: Record<string, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16, q: 96 / 101.6, em: 16, rem: 16, ex: 8 };

/** Length in px (user units); percentages are taken of `base`. Null if missing or invalid. */
function parseLength(s: string | undefined, base: number): number | null {
  if (s === undefined) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  if (unit === "") return v;
  if (unit === "%") return (v * base) / 100;
  const f = UNIT_PX[unit];
  return f === undefined ? null : v * f;
}

const numbers = (s: string): number[] => (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(parseFloat);

function parseTransform(s: string | undefined): Mat {
  if (!s) return IDENTITY;
  let m: Mat = IDENTITY;
  for (const t of s.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = numbers(t[2]!);
    let n: Mat | null = null;
    switch (t[1]) {
      case "matrix":
        if (a.length >= 6) n = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!];
        break;
      case "translate":
        if (a.length >= 1) n = translate(a[0]!, a[1] ?? 0);
        break;
      case "scale":
        if (a.length >= 1) n = scale(a[0]!, a[1] ?? a[0]!);
        break;
      case "rotate":
        if (a.length >= 1) {
          const r = rotate((a[0]! * Math.PI) / 180);
          n = a.length >= 3 ? mul(translate(a[1]!, a[2]!), mul(r, translate(-a[1]!, -a[2]!))) : r;
        }
        break;
      case "skewX":
        if (a.length >= 1) n = [1, 0, Math.tan((a[0]! * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        if (a.length >= 1) n = [1, Math.tan((a[0]! * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (n) m = mul(m, n);
  }
  return m;
}

function parseViewBox(s: string | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!s) return null;
  const a = numbers(s);
  if (a.length < 4 || a[2]! <= 0 || a[3]! <= 0) return null;
  return { x: a[0]!, y: a[1]!, w: a[2]!, h: a[3]! };
}

/** Matrix that fits a viewBox into the box (x, y, w, h) following preserveAspectRatio. */
function viewBoxMatrix(vb: ReturnType<typeof parseViewBox>, par: string | undefined, x: number, y: number, w: number, h: number): Mat {
  if (!vb) return translate(x, y);
  const tokens = (par ?? "").trim().split(/\s+/).filter((p) => p !== "defer");
  const align = tokens[0] || "xMidYMid";
  const slice = tokens[1] === "slice";
  const sx = w / vb.w;
  const sy = h / vb.h;
  if (align === "none") return mul(translate(x, y), mul(scale(sx, sy), translate(-vb.x, -vb.y)));
  const s = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const ax = align.includes("xMin") ? 0 : align.includes("xMax") ? 1 : 0.5;
  const ay = align.includes("YMin") ? 0 : align.includes("YMax") ? 1 : 0.5;
  return mul(translate(x + (w - vb.w * s) * ax, y + (h - vb.h * s) * ay), mul(scale(s), translate(-vb.x, -vb.y)));
}

// ---------------------------------------------------------------- drawing

const f = (v: number) => String(v);

/** Path data for a basic shape, or null if it draws nothing. `fillable` is false for plain lines. */
function shapeData(node: XmlNode, ctx: Ctx): { d: string; fillable: boolean } | null {
  const a = node.attrs;
  const L = (k: string, base: number) => parseLength(a[k], base) ?? 0;
  switch (node.name) {
    case "path":
      return a.d ? { d: a.d, fillable: true } : null;
    case "rect": {
      const x = L("x", ctx.vw);
      const y = L("y", ctx.vh);
      const w = L("width", ctx.vw);
      const h = L("height", ctx.vh);
      if (!(w > 0 && h > 0)) return null;
      let rx = parseLength(a.rx, ctx.vw);
      let ry = parseLength(a.ry, ctx.vh);
      if (rx === null && ry !== null) rx = ry;
      if (ry === null && rx !== null) ry = rx;
      rx = Math.min(Math.max(rx ?? 0, 0), w / 2);
      ry = Math.min(Math.max(ry ?? 0, 0), h / 2);
      if (rx === 0 || ry === 0) return { d: `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`, fillable: true };
      return {
        d: `M${f(x + rx)} ${f(y)}H${f(x + w - rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}V${f(y + h - ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}H${f(x + rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}V${f(y + ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}Z`,
        fillable: true,
      };
    }
    case "circle":
    case "ellipse": {
      const cx = L("cx", ctx.vw);
      const cy = L("cy", ctx.vh);
      let rx: number;
      let ry: number;
      if (node.name === "circle") rx = ry = L("r", Math.hypot(ctx.vw, ctx.vh) / Math.SQRT2);
      else {
        rx = L("rx", ctx.vw);
        ry = L("ry", ctx.vh);
      }
      if (!(rx > 0 && ry > 0)) return null;
      return { d: `M${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 1 ${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 1 ${f(cx + rx)} ${f(cy)}Z`, fillable: true };
    }
    case "line":
      return { d: `M${f(L("x1", ctx.vw))} ${f(L("y1", ctx.vh))}L${f(L("x2", ctx.vw))} ${f(L("y2", ctx.vh))}`, fillable: false };
    case "polyline":
    case "polygon": {
      const n = numbers(a.points ?? "");
      if (n.length < 4) return null;
      let d = `M${f(n[0]!)} ${f(n[1]!)}`;
      for (let i = 2; i + 1 < n.length; i += 2) d += `L${f(n[i]!)} ${f(n[i + 1]!)}`;
      return { d: node.name === "polygon" ? d + "Z" : d, fillable: true };
    }
  }
  return null;
}

function emit(subs: Subpath[], style: Style, fillable: boolean, doc: Doc): void {
  if (style.visibility === "hidden" || style.visibility === "collapse") return;
  let fill = fillable ? resolvePaint(style.fill, style, "#000000", doc) : null;
  if (transparent(style["fill-opacity"])) fill = null;
  let stroke = resolvePaint(style.stroke, style, null, doc);
  if (transparent(style["stroke-opacity"])) stroke = null;
  if (style["stroke-width"] !== undefined) {
    const w = parseLength(style["stroke-width"], 1);
    if (w !== null && w <= 0) stroke = null;
  }
  for (const sub of subs) {
    const areaFill = sub.closed ? fill : null;
    let s = stroke;
    // An open filled path with no stroke would vanish; keep its geometry, outlined in the fill colour.
    if (!areaFill && !s && !sub.closed && fill) s = fill;
    if (!areaFill && !s) continue;
    doc.paths.push({ points: sub.points, closed: sub.closed, stroke: s, fill: areaFill });
  }
}

const SKIP = new Set(["defs", "symbol", "clipPath", "mask", "marker", "pattern", "style", "title", "desc", "metadata", "linearGradient", "radialGradient", "filter", "script", "stop", "view", "cursor", "font", "font-face"]);
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

function walk(node: XmlNode, ctx: Ctx, doc: Doc, depth: number): void {
  const name = node.name;
  if (depth > MAX_DEPTH || name.includes(":") || SKIP.has(name)) return;
  if (name === "text" || name === "tspan" || name === "textPath") {
    warn(doc, msg("Text was skipped: convert text to paths (outlines) before importing."));
    return;
  }
  if (name === "image") {
    warn(doc, msg("An embedded image was skipped: only vector paths are imported."));
    return;
  }
  if (name === "foreignObject") {
    warn(doc, msg("Embedded HTML (foreignObject) was skipped."));
    return;
  }
  const style = computeStyle(node, ctx.style, doc);
  if (style.display === "none") return;
  const m = mul(ctx.m, parseTransform(node.attrs.transform));
  const sub: Ctx = { ...ctx, m, style };

  if (SHAPES.has(name)) {
    const sh = shapeData(node, ctx);
    if (!sh) return;
    emit(flattenPathData(sh.d, m, FLATTEN_TOLERANCE_MM), style, sh.fillable, doc);
  } else if (name === "g" || name === "a") {
    for (const c of node.children) walk(c, sub, doc, depth + 1);
  } else if (name === "switch") {
    const first = node.children.find((c) => !c.name.includes(":"));
    if (first) walk(first, sub, doc, depth + 1);
  } else if (name === "svg") {
    const x = parseLength(node.attrs.x, ctx.vw) ?? 0;
    const y = parseLength(node.attrs.y, ctx.vh) ?? 0;
    const w = parseLength(node.attrs.width, ctx.vw) ?? ctx.vw;
    const h = parseLength(node.attrs.height, ctx.vh) ?? ctx.vh;
    enterViewport(node, sub, doc, depth, x, y, w, h);
  } else if (name === "use") {
    const href = node.attrs.href ?? node.attrs["xlink:href"];
    const id = href?.startsWith("#") ? href.slice(1) : undefined;
    const target = id ? doc.ids.get(id) : undefined;
    if (!id || !target || ctx.stack.includes(id) || ctx.stack.length > 20) return;
    const x = parseLength(node.attrs.x, ctx.vw) ?? 0;
    const y = parseLength(node.attrs.y, ctx.vh) ?? 0;
    const u: Ctx = { ...sub, m: mul(m, translate(x, y)), stack: [...ctx.stack, id] };
    if (target.name === "symbol" || target.name === "svg") {
      const w = parseLength(node.attrs.width, ctx.vw) ?? parseLength(target.attrs.width, ctx.vw) ?? ctx.vw;
      const h = parseLength(node.attrs.height, ctx.vh) ?? parseLength(target.attrs.height, ctx.vh) ?? ctx.vh;
      const tStyle = computeStyle(target, style, doc);
      if (tStyle.display === "none") return;
      enterViewport(target, { ...u, m: mul(u.m, target.name === "svg" ? parseTransform(target.attrs.transform) : IDENTITY), style: tStyle }, doc, depth, 0, 0, w, h);
    } else {
      walk(target, u, doc, depth + 1);
    }
  }
}

/** Draw the children of an <svg> or <symbol> whose viewport is the box (x, y, w, h) in the current user space. */
function enterViewport(node: XmlNode, ctx: Ctx, doc: Doc, depth: number, x: number, y: number, w: number, h: number): void {
  const vb = parseViewBox(node.attrs.viewBox);
  const m = mul(ctx.m, viewBoxMatrix(vb, node.attrs.preserveAspectRatio, x, y, w, h));
  const inner: Ctx = { ...ctx, m, vw: vb ? vb.w : w, vh: vb ? vb.h : h };
  for (const c of node.children) walk(c, inner, doc, depth + 1);
}

/** Parse SVG text into paths in mm. Never throws: problems become warnings. */
export function parseSvg(text: string): VectorImport {
  const doc: Doc = { ids: new Map(), rules: [], warnings: [], paths: [] };
  let root: XmlNode;
  try {
    root = parseXml(text);
  } catch {
    return { paths: [], warnings: [msg("The file is not valid SVG (could not read it as XML).")] };
  }
  if (root.name !== "svg") return { paths: [], warnings: [msg("The file is not an SVG document.")] };

  let masks = false;
  const scan = (n: XmlNode) => {
    if (n.attrs.id !== undefined && !doc.ids.has(n.attrs.id)) doc.ids.set(n.attrs.id, n);
    if (n.name === "style" && (!n.attrs.type || n.attrs.type === "text/css")) parseStylesheet(n.text, doc.rules);
    if (n.name === "clipPath" || n.name === "mask" || n.name === "pattern" || n.name === "marker") masks = true;
    for (const c of n.children) scan(c);
  };
  scan(root);
  if (masks) warn(doc, msg("Clipping paths, masks, patterns and markers are not supported and were ignored."));

  const vb = parseViewBox(root.attrs.viewBox);
  let wPx = parseLength(root.attrs.width, vb ? vb.w : 0);
  let hPx = parseLength(root.attrs.height, vb ? vb.h : 0);
  if (wPx !== null && !(wPx > 0)) wPx = null;
  if (hPx !== null && !(hPx > 0)) hPx = null;
  if (vb) {
    if (wPx === null && hPx === null) {
      wPx = vb.w;
      hPx = vb.h;
    } else if (wPx === null) wPx = (hPx! * vb.w) / vb.h;
    else if (hPx === null) hPx = (wPx * vb.h) / vb.w;
  } else {
    wPx ??= 300;
    hPx ??= 150;
  }
  const w = wPx!;
  const h = hPx!;

  const style = computeStyle(root, {}, doc);
  if (style.display !== "none") {
    const base: Ctx = { m: mul(scale(PX_TO_MM), parseTransform(root.attrs.transform)), style, vw: w, vh: h, stack: [] };
    enterViewport(root, base, doc, 0, 0, 0, w, h);
  }
  return { paths: doc.paths, warnings: doc.warnings, pageMm: { w: w * PX_TO_MM, h: h * PX_TO_MM } };
}
