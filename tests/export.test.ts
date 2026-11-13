import { describe, expect, it } from "vitest";
import { parseDxf } from "../src/dxf/parse";
import { aciNearest, writeDxf } from "../src/export/dxf";
import { writePdf } from "../src/export/pdf";
import { writeSvg } from "../src/export/svg";
import type { ExportPath } from "../src/import/types";

const rect = (x: number, y: number, w: number, h: number, color: string, extra: Partial<ExportPath> = {}): ExportPath => ({
  points: [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ],
  closed: true,
  color,
  ...extra,
});

const sample: ExportPath[] = [
  rect(10, 20, 100, 50, "#ff0000"),
  {
    points: [
      { x: 20, y: 30.1234 },
      { x: 60, y: 45 },
      { x: 90.5, y: 25.25 },
    ],
    closed: false,
    color: "#12ab56",
  },
  rect(30, 30, 20, 10, "#ff0000"),
  { points: [{ x: 1, y: 1 }], closed: false, color: "#00ff00" },
];

describe("aciNearest", () => {
  it("maps the primaries", () => {
    expect(aciNearest("#ff0000")).toBe(1);
    expect(aciNearest("#0000ff")).toBe(5);
    expect(aciNearest("#ffffff")).toBe(7);
    expect(aciNearest("#000000")).toBe(7);
    expect(aciNearest("#00ff00")).toBe(3);
  });
});

describe("writeDxf", () => {
  it("round-trips through parseDxf with the y flip and origin shift", () => {
    const res = parseDxf(writeDxf(sample));
    expect(res.units).toBe("mm");
    const used = sample.filter((p) => p.points.length >= 2);
    expect(res.paths).toHaveLength(used.length);
    const minX = 10;
    const maxY = 70;
    used.forEach((src, i) => {
      const got = res.paths[i]!;
      expect(got.closed).toBe(src.closed);
      expect(got.color).toBe(src.color);
      expect(got.points).toHaveLength(src.points.length);
      src.points.forEach((p, k) => {
        expect(got.points[k]!.x).toBeCloseTo(p.x - minX, 3);
        expect(got.points[k]!.y).toBeCloseTo(maxY - p.y, 3);
      });
    });
    expect(Math.min(...res.paths.flatMap((p) => p.points.map((q) => q.x)))).toBeCloseTo(0, 6);
  });

  it("keeps bed coordinates with keepPosition", () => {
    const res = parseDxf(writeDxf(sample, { keepPosition: true }));
    expect(res.paths[0]!.points[0]!.x).toBeCloseTo(10, 3);
    expect(res.paths[0]!.points[0]!.y).toBeCloseTo(70 - 20, 3);
  });

  it("names layers per colour and writes both colour codes", () => {
    const dxf = writeDxf(sample);
    expect(dxf).toContain("L01_ff0000");
    expect(dxf).toContain("L02_12ab56");
    expect(dxf).not.toContain("L03");
    expect(dxf).toMatch(/\n420\n1223510\n/); // 0x12ab56
    expect(dxf).toMatch(/\n62\n1\n/);
    expect(dxf).not.toMatch(/e[+-]\d/);
  });

  it("handles an empty drawing", () => {
    expect(parseDxf(writeDxf([])).paths).toHaveLength(0);
  });
});

describe("writeSvg", () => {
  it("writes mm units, layers, strokes and shifted coordinates", () => {
    const svg = writeSvg(sample);
    expect(svg).toContain('width="100mm" height="50mm" viewBox="0 0 100 50"');
    expect(svg).toContain('<g id="layer-ff0000" inkscape:groupmode="layer"');
    expect(svg).toContain('<g id="layer-12ab56"');
    expect(svg).toContain('fill="none" stroke="#ff0000" stroke-width="0.1"');
    expect(svg).toContain('d="M0 0L100 0L100 50L0 50Z"');
    expect(svg).toContain("M10 10.123L50 25L80.5 5.25"); // 3 decimals, trimmed
    expect(svg).not.toContain("00ff00");
  });

  it("keeps the bed position and page size with keepPosition", () => {
    const svg = writeSvg(sample, { keepPosition: true, page: { w: 300, h: 200 } });
    expect(svg).toContain('viewBox="0 0 300 200"');
    expect(svg).toContain('d="M10 20L110 20L110 70L10 70Z"');
  });

  it("adds a margin", () => {
    const svg = writeSvg([rect(5, 5, 10, 10, "#000000")], { marginMm: 2 });
    expect(svg).toContain('viewBox="0 0 14 14"');
    expect(svg).toContain("M2 2L12 2L12 12L2 12Z");
  });

  it("fills fill layers as one even-odd compound path without stroke", () => {
    const svg = writeSvg([rect(0, 0, 20, 20, "#0000ff", { fillLayer: true }), rect(5, 5, 10, 10, "#0000ff", { fillLayer: true })]);
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).toContain('fill="#0000ff" fill-rule="evenodd" stroke="none"');
    expect(svg).toContain("Z" + "M"); // two subpaths in one d
  });

  it("puts the area fill before its outline", () => {
    const svg = writeSvg([rect(0, 0, 10, 10, "#ff0000", { fill: "#00ff00" })]);
    const fillAt = svg.indexOf('fill="#00ff00"');
    const strokeAt = svg.indexOf('stroke="#ff0000"');
    expect(fillAt).toBeGreaterThan(0);
    expect(strokeAt).toBeGreaterThan(fillAt);
  });
});

describe("writePdf", () => {
  const bytes = writePdf([rect(10, 10, 100, 50, "#ff0000"), rect(20, 20, 30, 10, "#0000ff", { fillLayer: true })], { title: "Test (1)" });
  const text = Buffer.from(bytes).toString("latin1");

  it("has header, trailer and EOF", () => {
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Producer (BeamForge)");
    expect(text).toContain("/Title (Test \\(1\\))");
  });

  it("has an xref table whose offsets point at object headers", () => {
    const start = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const m = /xref\n0 (\d+)\n([\s\S]*?)trailer/.exec(text.slice(start))!;
    const count = Number(m[1]);
    const rows = m[2]!.split("\n").filter(Boolean);
    expect(rows).toHaveLength(count);
    expect(Number(/\/Size (\d+)/.exec(text)![1])).toBe(count);
    for (let n = 1; n < count; n++) {
      const off = Number(rows[n]!.slice(0, 10));
      expect(text.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    }
  });

  it("measures a 100x50 mm drawing", () => {
    const t100 = Buffer.from(writePdf([rect(0, 0, 100, 50, "#000000")])).toString("latin1");
    const mb = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(t100)!;
    expect(Number(mb[1])).toBeCloseTo(283.465, 2);
    expect(Number(mb[2])).toBeCloseTo(141.732, 2);
  });

  it("uses stroke and fill operators and named layers", () => {
    expect(text).toContain("1 0 0 RG");
    expect(text).toContain("0 0 1 rg");
    expect(text).toContain("f*");
    expect(text).toContain("0.283 w");
    expect(text).toContain("/Type /OCG /Name (L01_ff0000)");
    expect(text).toContain("/Type /OCG /Name (L02_0000ff)");
    expect(text).toContain("BDC");
  });

  it("declares the stream length correctly", () => {
    const m = /\/Length (\d+) >>\nstream\n/.exec(text)!;
    const s = m.index + m[0].length;
    expect(text.slice(s + Number(m[1]), s + Number(m[1]) + 10)).toBe("\nendstream");
  });
});
