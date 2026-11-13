import { describe, expect, it } from "vitest";
import { NAMED_COLORS, parseColor, parseSvg } from "../src/import/svg";
import { flattenPathData } from "../src/import/svgPath";
import { decodeEntities, parseXml } from "../src/import/xml";
import { IDENTITY } from "../src/geom/geom";
import type { VecPath } from "../src/import/types";

/** An SVG whose user units are millimetres (100 x 100 mm page). */
const mm = (body: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100" ${attrs}>${body}</svg>`;
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const box = (ps: VecPath[]) => {
  const xs = ps.flatMap((p) => p.points.map((q) => q.x));
  const ys = ps.flatMap((p) => p.points.map((q) => q.y));
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

describe("xml parser", () => {
  it("handles prolog, comments, CDATA, DOCTYPE, entities and self-closing tags", () => {
    const root = parseXml(`<?xml version="1.0"?>
<!-- hi -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [ <!ENTITY ns "http://x"> <!ENTITY foo "bar"> ]>
<svg:svg a="&lt;&amp;&#65;&#x42;&quot;" b='&foo;'><sodipodi:namedview id="n"/><style><![CDATA[a > b {}]]></style><g/></svg:svg>`);
    expect(root.name).toBe("svg");
    expect(root.attrs.a).toBe('<&AB"');
    expect(root.attrs.b).toBe("bar");
    expect(root.children.map((c) => c.name)).toEqual(["sodipodi:namedview", "style", "g"]);
    expect(root.children[1]!.text).toBe("a > b {}");
    expect(decodeEntities("&unknown; &amp;")).toBe("&unknown; &");
  });

  it("throws without an element", () => {
    expect(() => parseXml("<!-- nothing -->")).toThrow();
  });
});

describe("parseSvg units and viewport", () => {
  it("mm document with matching viewBox", () => {
    const r = parseSvg(mm(`<rect x="10" y="5" width="20" height="10" fill="none" stroke="#f00"/>`));
    expect(r.pageMm).toEqual({ w: 100, h: 100 });
    expect(r.paths).toHaveLength(1);
    const p = r.paths[0]!;
    expect(p.closed).toBe(true);
    expect(p.stroke).toBe("#ff0000");
    expect(p.fill).toBeNull();
    expect(p.points).toEqual([
      { x: 10, y: 5 },
      { x: 30, y: 5 },
      { x: 30, y: 15 },
      { x: 10, y: 15 },
    ]);
  });

  it("px document without viewBox is 96 dpi", () => {
    const r = parseSvg(`<svg width="96" height="192"><rect width="96" height="96" fill="none" stroke="black"/></svg>`);
    close(r.pageMm!.w, 25.4);
    close(r.pageMm!.h, 50.8);
    close(box(r.paths).maxX, 25.4);
  });

  it("units cm, in, pt, pc", () => {
    expect(parseSvg(`<svg width="2cm" height="1in"/>`).pageMm).toEqual({ w: 20, h: 25.4 });
    const r = parseSvg(`<svg width="72pt" height="6pc"/>`).pageMm!;
    close(r.w, 25.4);
    close(r.h, 25.4);
  });

  it("uses the viewBox as px when there is no width/height", () => {
    const r = parseSvg(`<svg viewBox="0 0 96 48"><rect width="96" height="48" stroke="#000"/></svg>`);
    close(r.pageMm!.w, 25.4);
    close(r.pageMm!.h, 12.7);
    close(box(r.paths).maxX, 25.4);
  });

  it("scales a viewBox into the page and centres it (xMidYMid meet)", () => {
    const r = parseSvg(`<svg width="200mm" height="100mm" viewBox="0 0 100 100"><rect width="100" height="100" stroke="#000"/></svg>`);
    const b = box(r.paths);
    close(b.minX, 50);
    close(b.maxX, 150);
    close(b.minY, 0);
    close(b.maxY, 100);
  });

  it("honours viewBox origin, preserveAspectRatio none and one-sided sizes", () => {
    const a = parseSvg(`<svg width="100mm" height="100mm" viewBox="10 20 50 25" preserveAspectRatio="none"><rect x="10" y="20" width="50" height="25" stroke="#000"/></svg>`);
    expect(box(a.paths)).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: 100 });
    const b = parseSvg(`<svg width="50mm" viewBox="0 0 100 200"/>`);
    expect(b.pageMm).toEqual({ w: 50, h: 100 });
  });

  it("reports non-SVG input", () => {
    expect(parseSvg("<html/>").warnings).toHaveLength(1);
    expect(parseSvg("not xml").paths).toEqual([]);
  });
});

describe("shapes", () => {
  it("circle stays within the flatten tolerance", () => {
    const r = parseSvg(mm(`<circle cx="50" cy="50" r="40" fill="none" stroke="#000"/>`));
    const p = r.paths[0]!;
    expect(p.closed).toBe(true);
    for (const q of p.points) close(Math.hypot(q.x - 50, q.y - 50), 40, 0.015);
    for (let i = 0; i < p.points.length; i++) {
      const a = p.points[i]!;
      const b = p.points[(i + 1) % p.points.length]!;
      expect(40 - Math.hypot((a.x + b.x) / 2 - 50, (a.y + b.y) / 2 - 50)).toBeLessThanOrEqual(0.02 + 1e-6);
    }
    expect(p.points.length).toBeGreaterThan(30);
  });

  it("ellipse", () => {
    const b = box(parseSvg(mm(`<ellipse cx="50" cy="50" rx="30" ry="10" stroke="#000" fill="none"/>`)).paths);
    close(b.minX, 20);
    close(b.maxX, 80);
    close(b.minY, 40);
    close(b.maxY, 60);
  });

  it("line, polyline and polygon", () => {
    const r = parseSvg(mm(`<line x1="0" y1="0" x2="10" y2="10" stroke="#000"/><polyline points="0,0 10,0 10,10" fill="none" stroke="#111"/><polygon points="0 0 10 0 10 10" fill="none" stroke="#222"/>`));
    expect(r.paths.map((p) => [p.points.length, p.closed])).toEqual([[2, false], [3, false], [3, true]]);
    expect(r.paths[0]!.fill).toBeNull();
  });

  it("line without stroke draws nothing, an open polyline gets no fill", () => {
    const r = parseSvg(mm(`<line x1="0" y1="0" x2="10" y2="10"/><polyline points="0,0 10,0 10,10" stroke="#000"/>`));
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.closed).toBe(false);
    expect(r.paths[0]!.fill).toBeNull();
  });

  it("rect with rx/ry is rounded and stays in its box", () => {
    const r = parseSvg(mm(`<rect x="10" y="10" width="40" height="20" rx="5" fill="none" stroke="#000"/>`));
    const b = box(r.paths);
    expect(b).toEqual({ minX: 10, maxX: 50, minY: 10, maxY: 30 });
    expect(r.paths[0]!.points.length).toBeGreaterThan(8);
    // A corner is cut: the box corner is not on the path.
    expect(r.paths[0]!.points.some((p) => p.x === 10 && p.y === 10)).toBe(false);
    const clamped = parseSvg(mm(`<rect width="10" height="10" ry="50" stroke="#000"/>`));
    expect(box(clamped.paths)).toEqual({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
  });

  it("default fill is black and stroke none", () => {
    const p = parseSvg(mm(`<rect width="10" height="10"/>`)).paths[0]!;
    expect(p.fill).toBe("#000000");
    expect(p.stroke).toBeNull();
  });

  it("fill and stroke together on one closed path; open filled path is kept as an outline", () => {
    const p = parseSvg(mm(`<path d="M0 0H10V10Z" fill="#00f" stroke="#f00"/>`)).paths[0]!;
    expect([p.fill, p.stroke]).toEqual(["#0000ff", "#ff0000"]);
    const open = parseSvg(mm(`<path d="M0 0H10V10" fill="#00f"/>`)).paths[0]!;
    expect(open.closed).toBe(false);
    expect(open.fill).toBeNull();
    expect(open.stroke).toBe("#0000ff");
  });
});

describe("path data", () => {
  const flat = (d: string) => flattenPathData(d, IDENTITY, 0.01);

  it("absolute, relative, H/V, Z and implicit repeats", () => {
    expect(flat("M10 10 h20 v20 H10 z")[0]).toEqual({ points: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], closed: true });
    expect(flat("m10 10 20 0 0 20")[0]!.points).toEqual([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }]);
    expect(flat("M0 0 L1 1 2 2 3 3")[0]!.points).toHaveLength(4);
  });

  it("compact number syntax", () => {
    const pts = flat("M1.5.5L-1-2 1e-3,2E1")[0]!.points;
    expect(pts).toEqual([{ x: 1.5, y: 0.5 }, { x: -1, y: -2 }, { x: 0.001, y: 20 }]);
  });

  it("several subpaths and moveto after close", () => {
    const s = flat("M0 0 L10 0 L10 10 Z L5 5 M20 20 L30 30");
    expect(s).toHaveLength(3);
    expect(s[0]!.closed).toBe(true);
    expect(s[1]!.points[0]).toEqual({ x: 0, y: 0 }); // starts at the previous subpath's start
    expect(s[2]!.points[1]).toEqual({ x: 30, y: 30 });
  });

  it("cubic, smooth cubic, quadratic and smooth quadratic end where they say", () => {
    expect(flat("M0 0 C0 10 10 10 10 0")[0]!.points.at(-1)).toEqual({ x: 10, y: 0 });
    const s = flat("M0 0 c0 10 10 10 10 0 s10 -10 10 0")[0]!.points.at(-1)!;
    expect(s).toEqual({ x: 20, y: 0 });
    expect(flat("M0 0 Q5 10 10 0")[0]!.points.at(-1)).toEqual({ x: 10, y: 0 });
    expect(flat("M0 0 Q5 10 10 0 T20 0")[0]!.points.at(-1)).toEqual({ x: 20, y: 0 });
    // Smooth continuation mirrors the control point: the second half bulges the other way.
    const t = flat("M0 0 Q5 10 10 0 T20 0")[0]!.points;
    expect(Math.min(...t.map((p) => p.y))).toBeLessThan(-1);
    expect(Math.max(...t.map((p) => p.y))).toBeGreaterThan(1);
  });

  it("flattens a semicircle arc onto its circle", () => {
    const pts = flat("M0 0 a10 10 0 0 1 20 0")[0]!.points;
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    close(pts.at(-1)!.x, 20);
    close(pts.at(-1)!.y, 0);
    for (const p of pts) close(Math.hypot(p.x - 10, p.y), 10, 0.005);
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(-9.9); // sweep=1 bulges upward (y down)
  });

  it("arc flags and large-arc selection, with compact flags", () => {
    const small = flat("M0 0 A10 10 0 0 1 10 10")[0]!.points;
    const large = flat("M0 0 A10 10 0 1 1 10 10")[0]!.points;
    expect(Math.max(...large.map((p) => Math.hypot(p.x, p.y)))).toBeGreaterThan(Math.max(...small.map((p) => Math.hypot(p.x, p.y))));
    const compact = flat("M0 0a1 1 0 001 1")[0]!.points.at(-1)!;
    close(compact.x, 1);
    close(compact.y, 1);
  });

  it("scales up too-small arc radii and treats a zero radius as a line", () => {
    const pts = flat("M0 0 A1 1 0 0 1 20 0")[0]!.points;
    for (const p of pts) close(Math.hypot(p.x - 10, p.y), 10, 0.005);
    expect(flat("M0 0 A0 5 0 0 1 10 0")[0]!.points).toHaveLength(2);
  });

  it("stops at the first error but keeps what was read", () => {
    expect(flat("M0 0 L10 10 L oops L 20 20")[0]!.points).toHaveLength(2);
    expect(flat("L10 10")).toEqual([]);
  });

  it("respects the tolerance in output units after scaling", () => {
    // A 1-unit-radius circle scaled by 100 needs far more segments than unscaled.
    const small = flattenPathData("M1 0A1 1 0 1 1 -1 0A1 1 0 1 1 1 0Z", IDENTITY, 0.02)[0]!.points.length;
    const big = flattenPathData("M1 0A1 1 0 1 1 -1 0A1 1 0 1 1 1 0Z", [100, 0, 0, 100, 0, 0], 0.02)[0]!.points;
    expect(big.length).toBeGreaterThan(small * 3);
    for (let i = 0; i < big.length; i++) {
      const a = big[i]!;
      const b = big[(i + 1) % big.length]!;
      expect(100 - Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2)).toBeLessThanOrEqual(0.02 + 1e-6);
    }
  });
});

describe("transforms", () => {
  const rect = `<rect width="10" height="10" fill="none" stroke="#000"`;
  it("translate, scale", () => {
    const b = box(parseSvg(mm(`${rect} transform="translate(5 7) scale(2)"/>`)).paths);
    expect(b).toEqual({ minX: 5, maxX: 25, minY: 7, maxY: 27 });
  });

  it("rotate about a centre", () => {
    const b = box(parseSvg(mm(`<rect x="0" y="0" width="20" height="10" fill="none" stroke="#000" transform="rotate(90 10 10)"/>`)).paths);
    close(b.minX, 10);
    close(b.maxX, 20);
    close(b.minY, 10 - 10);
    close(b.maxY, 10 + 10);
    const r = parseSvg(mm(`<path d="M20 10h1" stroke="#000" transform="rotate(90,10,10)"/>`)).paths[0]!;
    close(r.points[0]!.x, 10);
    close(r.points[0]!.y, 20);
  });

  it("matrix, skewX, skewY and sequences", () => {
    const m = parseSvg(mm(`<path d="M1 1L2 2" stroke="#000" transform="matrix(1 0 0 1 10 20)"/>`)).paths[0]!;
    expect(m.points[0]).toEqual({ x: 11, y: 21 });
    const s = parseSvg(mm(`<path d="M0 10L0 10.5" stroke="#000" transform="skewX(45)"/>`)).paths[0]!;
    close(s.points[0]!.x, 10);
    const sy = parseSvg(mm(`<path d="M10 0L10.5 0" stroke="#000" transform="skewY(45)"/>`)).paths[0]!;
    close(sy.points[0]!.y, 10);
    // Order matters: translate then scale differs from scale then translate.
    const a = parseSvg(mm(`<path d="M1 1L2 2" stroke="#000" transform="translate(10 0) scale(2)"/>`)).paths[0]!;
    const b = parseSvg(mm(`<path d="M1 1L2 2" stroke="#000" transform="scale(2) translate(10 0)"/>`)).paths[0]!;
    expect(a.points[0]).toEqual({ x: 12, y: 2 });
    expect(b.points[0]).toEqual({ x: 22, y: 2 });
  });

  it("nested groups compose", () => {
    const r = parseSvg(mm(`<g transform="translate(10 10)"><g transform="scale(2)"><path d="M1 1L2 2" stroke="#000" transform="translate(1 0)"/></g></g>`)).paths[0]!;
    expect(r.points[0]).toEqual({ x: 14, y: 12 });
  });

  it("applies the transform before measuring curve flatness", () => {
    const r = parseSvg(mm(`<circle r="1" stroke="#000" fill="none" transform="translate(50 50) scale(30)"/>`)).paths[0]!;
    expect(r.points.length).toBeGreaterThan(40);
  });
});

describe("style", () => {
  const fillOf = (svg: string) => parseSvg(mm(svg)).paths[0]!.fill;

  it("style attribute beats presentation attribute", () => {
    expect(fillOf(`<rect width="5" height="5" fill="red" style="fill: blue"/>`)).toBe("#0000ff");
  });

  it("stylesheet rules: type, class, id, lists, specificity and attribute interplay", () => {
    const css = `<style>/* c */ rect { fill: red } .a, circle { fill: #00ff00 } #x { fill: #123456 } g > rect { fill: pink }</style>`;
    const fills = parseSvg(mm(`${css}<rect width="5" height="5"/><rect class="a" width="5" height="5"/><rect class="a" id="x" width="5" height="5"/><circle r="2"/><rect class="a" fill="orange" width="5" height="5"/>`)).paths.map((p) => p.fill);
    expect(fills).toEqual(["#ff0000", "#00ff00", "#123456", "#00ff00", "#00ff00"]); // the stylesheet beats presentation attributes
    expect(fillOf(`<style>.a{fill:red}</style><rect class="a" style="fill:#0f0" width="5" height="5"/>`)).toBe("#00ff00");
  });

  it("inherits through groups and can be overridden", () => {
    const r = parseSvg(mm(`<g fill="none" stroke="#123456" stroke-width="2"><rect width="5" height="5"/><g stroke="green"><rect width="5" height="5"/></g></g>`));
    expect(r.paths.map((p) => [p.fill, p.stroke])).toEqual([[null, "#123456"], [null, "#008000"]]);
  });

  it("currentColor uses the color property", () => {
    const r = parseSvg(mm(`<g color="blue"><rect width="5" height="5" fill="currentColor"/></g><rect width="5" height="5" stroke="currentColor" fill="none"/>`));
    expect(r.paths[0]!.fill).toBe("#0000ff");
    expect(r.paths[1]!.stroke).toBe("#000000");
  });

  it("zero opacity or stroke width means none", () => {
    expect(parseSvg(mm(`<rect width="5" height="5" fill="red" fill-opacity="0"/>`)).paths).toHaveLength(0);
    expect(parseSvg(mm(`<rect width="5" height="5" fill="none" stroke="red" stroke-width="0"/>`)).paths).toHaveLength(0);
    expect(parseSvg(mm(`<rect width="5" height="5" fill="none" stroke="red" stroke-opacity="0"/>`)).paths).toHaveLength(0);
    expect(parseSvg(mm(`<rect width="5" height="5" fill="none" stroke="red" stroke-width="0.5"/>`)).paths).toHaveLength(1);
  });

  it("gradient fills use the first stop colour", () => {
    const svg = `<defs><linearGradient id="g"><stop offset="0" style="stop-color:#ff8800"/><stop offset="1" stop-color="blue"/></linearGradient><linearGradient id="h" xlink:href="#g"/></defs>`;
    expect(fillOf(`${svg}<rect width="5" height="5" fill="url(#g)"/>`)).toBe("#ff8800");
    expect(fillOf(`${svg}<rect width="5" height="5" fill="url(#h)"/>`)).toBe("#ff8800");
    expect(fillOf(`<rect width="5" height="5" fill="url(#missing)"/>`)).toBe("#000000");
  });

  it("skips hidden elements", () => {
    const r = parseSvg(mm(`<rect width="5" height="5" display="none"/><rect width="5" height="5" style="display:none"/><rect width="5" height="5" visibility="hidden"/><g style="display:none"><rect width="5" height="5"/></g><g visibility="hidden"><rect width="5" height="5" visibility="visible"/></g>`));
    expect(r.paths).toHaveLength(1);
  });
});

describe("colours", () => {
  it("parses hex, rgb, hsl and names", () => {
    expect(parseColor("#f80")).toBe("#ff8800");
    expect(parseColor("#FF8800")).toBe("#ff8800");
    expect(parseColor("#ff880080")).toBe("#ff8800");
    expect(parseColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(parseColor("rgb(100%, 50%, 0%)")).toBe("#ff8000");
    expect(parseColor("rgba(0,0,255,0.5)")).toBe("#0000ff");
    expect(parseColor("rgb(0 255 0 / 50%)")).toBe("#00ff00");
    expect(parseColor("hsl(120, 100%, 50%)")).toBe("#00ff00");
    expect(parseColor("hsl(0,100%,25%)")).toBe("#800000");
    expect(parseColor("Orange")).toBe("#ffa500");
    expect(parseColor("rebeccapurple")).toBe("#663399");
  });

  it("transparent things are none, nonsense is undefined", () => {
    expect(parseColor("none")).toBeNull();
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("rgba(1,2,3,0)")).toBeNull();
    expect(parseColor("#ff000000")).toBeNull();
    expect(parseColor("nonsense")).toBeUndefined();
    expect(parseColor("#12")).toBeUndefined();
  });

  it("knows all 148 named colours", () => {
    expect(Object.keys(NAMED_COLORS)).toHaveLength(148);
    for (const v of Object.values(NAMED_COLORS)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("applies in documents", () => {
    const r = parseSvg(mm(`<rect width="5" height="5" fill="none" stroke="orange"/><rect width="5" height="5" fill="none" stroke="rgb(0,128,0)"/>`));
    expect(r.paths.map((p) => p.stroke)).toEqual(["#ffa500", "#008000"]);
  });
});

describe("use, defs, symbol, switch", () => {
  it("renders defs only through use, with x/y and both href spellings", () => {
    const r = parseSvg(mm(`<defs><rect id="r" width="10" height="10" fill="none" stroke="#000"/></defs><use href="#r" x="10" y="20"/><use xlink:href="#r" transform="translate(50 0)"/>`));
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0]!.points[0]).toEqual({ x: 10, y: 20 });
    expect(r.paths[1]!.points[0]).toEqual({ x: 50, y: 0 });
  });

  it("use inherits style from the use element", () => {
    const r = parseSvg(mm(`<defs><rect id="r" width="10" height="10"/></defs><use href="#r" fill="#00f"/>`));
    expect(r.paths[0]!.fill).toBe("#0000ff");
  });

  it("use of a group, nested uses, and cycles", () => {
    const r = parseSvg(mm(`<defs><g id="g"><path d="M0 0L1 0" stroke="#000"/></g><g id="loop"><use href="#loop"/><path d="M0 0L2 0" stroke="#000"/></g></defs><use href="#g" x="3"/><use href="#loop"/>`));
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0]!.points[0]).toEqual({ x: 3, y: 0 });
  });

  it("symbol with viewBox is fitted to the use size", () => {
    const r = parseSvg(mm(`<symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="#000"/></symbol><use href="#s" x="5" y="5" width="40" height="40"/>`));
    expect(box(r.paths)).toEqual({ minX: 5, maxX: 45, minY: 5, maxY: 45 });
  });

  it("nested svg with x/y/viewBox", () => {
    const r = parseSvg(mm(`<svg x="10" y="20" width="20" height="20" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="#000"/></svg>`));
    expect(box(r.paths)).toEqual({ minX: 10, maxX: 30, minY: 20, maxY: 40 });
  });

  it("a and switch", () => {
    const r = parseSvg(mm(`<a href="x"><rect width="5" height="5" stroke="#000" fill="none"/></a><switch><path d="M0 0L9 9" stroke="#111"/><path d="M0 0L5 5" stroke="#222"/></switch>`));
    expect(r.paths.map((p) => p.stroke)).toEqual(["#000000", "#111111"]);
  });
});

describe("warnings", () => {
  it("warns once about text", () => {
    const r = parseSvg(mm(`<text x="1" y="2">Hello</text><g><text>More<tspan>x</tspan></text></g>`));
    expect(r.paths).toEqual([]);
    expect(r.warnings).toEqual(["Text was skipped: convert text to paths (outlines) before importing."]);
  });

  it("warns about images and clipping, but not when absent", () => {
    const r = parseSvg(mm(`<defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs><image href="a.png" width="5" height="5"/><rect width="5" height="5" stroke="#000" fill="none" clip-path="url(#c)"/>`));
    expect(r.paths).toHaveLength(1);
    expect(r.warnings).toHaveLength(2);
    expect(parseSvg(mm(`<rect width="5" height="5"/>`)).warnings).toEqual([]);
  });

  it("ignores editor metadata and namespaced elements", () => {
    const r = parseSvg(mm(`<sodipodi:namedview id="n"><rect width="9" height="9"/></sodipodi:namedview><metadata><rect width="9" height="9"/></metadata><rect width="5" height="5"/>`, `xmlns:sodipodi="x"`));
    expect(r.paths).toHaveLength(1);
  });
});
