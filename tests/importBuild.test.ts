import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildObject, colorDistance, conflicts, defaultChoices, isNearWhite, nearestPalette } from "../src/import/build";
import { cdrPreview, dibToBmp } from "../src/import/cdr";
import { type PdfOps, pdfOperatorsToPaths } from "../src/import/pdfOps";
import type { VecPath, VectorImport } from "../src/import/types";
import { isZip, readZip } from "../src/import/zip";
import { PALETTE } from "../src/job/layers";
import { DEFAULT_LAYER, DEFAULT_PROFILE, type Doc } from "../src/scene/model";

const sq = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];
const vp = (points: { x: number; y: number }[], stroke: string | null, fill: string | null, closed = true): VecPath => ({ points, closed, stroke, fill });
const empty = (): Doc => ({ objects: [], layers: [] });

describe("colour snapping", () => {
  it("palette colours map to themselves", () => {
    for (const c of PALETTE) expect(nearestPalette(c)).toBe(c);
  });
  it("avoids colours when asked", () => {
    expect(nearestPalette("#ff0000", new Set(["#ff0000"]))).not.toBe("#ff0000");
  });
  it("distance is symmetric and zero for equal colours", () => {
    expect(colorDistance("#123456", "#123456")).toBe(0);
    expect(colorDistance("#ff0000", "#00ff00")).toBeCloseTo(colorDistance("#00ff00", "#ff0000"));
  });
  it("near white", () => {
    expect(isNearWhite("#ffffff")).toBe(true);
    expect(isNearWhite("#fafafa")).toBe(true);
    expect(isNearWhite("#808080")).toBe(false);
  });
});

describe("defaultChoices", () => {
  it("lists strokes before fills, counts uses, and keeps fills off cut colours", () => {
    const vi: VectorImport = {
      paths: [vp(sq(0, 0, 10), "#ff0000", null), vp(sq(20, 0, 10), "#ff0000", null), vp(sq(40, 0, 10), null, "#fe0101")],
      warnings: [],
    };
    const ch = defaultChoices(vi, empty());
    expect(ch.map((c) => c.key)).toEqual(["s:#ff0000", "f:#fe0101"]);
    expect(ch[0]!.count).toBe(2);
    expect(ch[0]!.target).toBe("#ff0000");
    expect(ch[1]!.target).not.toBe("#ff0000"); // a layer either cuts or fills
  });
  it("skips near-white fills by default", () => {
    const ch = defaultChoices({ paths: [vp(sq(0, 0, 10), null, "#ffffff")], warnings: [] }, empty());
    expect(ch[0]!.target).toBeNull();
  });
  it("avoids existing cut layers for fills", () => {
    const doc: Doc = {
      objects: [{ id: "a", name: "a", mat: [1, 0, 0, 1, 0, 0], paths: [{ color: "#0000ff", closed: true, points: sq(0, 0, 5) }] }],
      layers: [{ ...DEFAULT_LAYER, color: "#0000ff" }],
    };
    const ch = defaultChoices({ paths: [vp(sq(0, 0, 10), null, "#0000ff")], warnings: [] }, doc);
    expect(ch[0]!.target).not.toBe("#0000ff");
  });
});

describe("buildObject", () => {
  const vi: VectorImport = {
    paths: [vp(sq(10, 10, 20), "#ff0000", "#0000ff"), vp(sq(40, 10, 10), null, "#00a000"), vp([{ x: 10, y: 50 }, { x: 60, y: 50 }], "#000000", null, false)],
    warnings: ["w"],
  };
  const choices = () => defaultChoices(vi, empty());

  it("cuts strokes, engraves fills, and reports the fill layers (area fills under outlines too)", () => {
    const ch = choices();
    const b = buildObject(vi, ch, { fills: "engrave", name: "x" }, DEFAULT_PROFILE, empty());
    const o = b.object!;
    expect(o.paths).toHaveLength(3);
    const blueTarget = ch.find((c) => c.key === "f:#0000ff")!.target!;
    const greenTarget = ch.find((c) => c.key === "f:#00a000")!.target!;
    expect(o.paths[0]).toMatchObject({ color: "#ff0000", fill: blueTarget, closed: true });
    expect(o.paths[1]).toMatchObject({ color: greenTarget, closed: true });
    expect(o.paths[1]!.fill).toBeUndefined();
    expect(new Set(b.fillLayers)).toEqual(new Set([blueTarget, greenTarget]));
    expect(b.warnings).toContain("w");
  });

  it("normalises to the top-left, scales, and centres on the bed", () => {
    const b = buildObject(vi, choices(), { fills: "engrave", scale: 2, name: "x" }, DEFAULT_PROFILE, empty());
    const pts = b.object!.paths.flatMap((p) => p.points);
    expect(Math.min(...pts.map((p) => p.x))).toBe(0);
    expect(Math.min(...pts.map((p) => p.y))).toBe(0);
    expect(Math.max(...pts.map((p) => p.x))).toBe(100); // 50 mm wide × 2
    expect(b.object!.mat[4]).toBeCloseTo((DEFAULT_PROFILE.bedW - 100) / 2);
  });

  it("outlines or ignores fills when asked", () => {
    const out = buildObject(vi, choices(), { fills: "outline", name: "x" }, DEFAULT_PROFILE, empty());
    expect(out.fillLayers).toEqual([]);
    expect(out.object!.paths.every((p) => !p.fill)).toBe(true);
    const ign = buildObject(vi, choices(), { fills: "ignore", name: "x" }, DEFAULT_PROFILE, empty());
    expect(ign.object!.paths).toHaveLength(2);
  });

  it("a fill sent to a cut colour is cut, not filled", () => {
    const ch = choices().map((c) => (c.key === "f:#00a000" ? { ...c, target: "#ff0000" } : c));
    expect(conflicts(ch, "engrave", empty())).toEqual(new Set(["#ff0000"]));
    const b = buildObject(vi, ch, { fills: "engrave", name: "x" }, DEFAULT_PROFILE, empty());
    expect(b.fillLayers).not.toContain("#ff0000");
  });

  it("skipping every colour gives no object and a warning", () => {
    const ch = choices().map((c) => ({ ...c, target: null }));
    const b = buildObject(vi, ch, { fills: "engrave", name: "x" }, DEFAULT_PROFILE, empty());
    expect(b.object).toBeNull();
    expect(b.warnings.length).toBeGreaterThan(1);
  });
});

describe("pdfOperatorsToPaths", () => {
  const OPS: PdfOps = {
    save: 10, restore: 11, transform: 12, constructPath: 91, setStrokeRGBColor: 58, setFillRGBColor: 59, setLineWidth: 2,
    paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, showText: 44, showSpacedText: 45, nextLineShowText: 46,
    nextLineSetSpacingShowText: 47, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageMaskXObject: 83,
    stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
    closeEOFillStroke: 27, endPath: 28,
  };
  const PT = 25.4 / 72;
  // A 144 pt tall page; pdf.js's viewport flips y.
  const viewport = [1, 0, 0, -1, 0, 144] as const;
  const rect = (x: number, y: number, s: number) => new Float32Array([0, x, y, 1, x + s, y, 1, x + s, y + s, 1, x, y + s, 4]);

  it("reads a filled and stroked rectangle in mm with y down", () => {
    const r = pdfOperatorsToPaths(
      [OPS.setFillRGBColor, OPS.setStrokeRGBColor, OPS.constructPath],
      [["#00ff00"], ["#ff0000"], [OPS.fillStroke, [rect(0, 0, 72)], null]],
      OPS,
      [...viewport],
    );
    expect(r.paths).toHaveLength(1);
    const p = r.paths[0]!;
    expect(p).toMatchObject({ closed: true, stroke: "#ff0000", fill: "#00ff00" });
    expect(p.points).toHaveLength(4);
    const ys = p.points.map((q) => q.y);
    expect(Math.min(...ys)).toBeCloseTo(72 * PT);
    expect(Math.max(...ys)).toBeCloseTo(144 * PT);
    expect(Math.max(...p.points.map((q) => q.x))).toBeCloseTo(25.4);
  });

  it("applies transforms inside save/restore and flattens curves", () => {
    const curve = new Float32Array([0, 0, 0, 2, 0, 50, 50, 50, 50, 0]);
    const r = pdfOperatorsToPaths(
      [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath],
      [null, [2, 0, 0, 2, 0, 0], [OPS.stroke, [curve], null], null, [OPS.stroke, [rect(0, 0, 10)], null]],
      OPS,
      [1, 0, 0, 1, 0, 0],
    );
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0]!.points.length).toBeGreaterThan(4);
    expect(Math.max(...r.paths[0]!.points.map((q) => q.x))).toBeCloseTo(100 * PT, 3);
    expect(Math.max(...r.paths[1]!.points.map((q) => q.x))).toBeCloseTo(10 * PT, 3); // restored, unscaled
    expect(r.paths[0]!.fill).toBeNull();
  });

  it("warns about text and pictures, and drops endPath (clip) paths", () => {
    const r = pdfOperatorsToPaths([OPS.showText, OPS.paintImageXObject, OPS.constructPath], [null, null, [OPS.endPath, [rect(0, 0, 5)], null]], OPS, [1, 0, 0, 1, 0, 0]);
    expect(r.paths).toHaveLength(0);
    expect(r.warnings).toHaveLength(2);
  });
});

// ---------- ZIP and CorelDRAW previews ----------

function zip(files: { name: string; data: Uint8Array; deflate?: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(8, f.deflate ? 8 : 0, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, f.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, f.deflate ? 8 : 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, off, true);
    c.set(name, 46);
    parts.push(local, body);
    central.push(c);
    off += local.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, off, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A 2 × 2, 24-bit DIB (BITMAPINFOHEADER + pixels). */
function dib(): Uint8Array {
  const d = new Uint8Array(40 + 16);
  const v = new DataView(d.buffer);
  v.setUint32(0, 40, true);
  v.setInt32(4, 2, true);
  v.setInt32(8, 2, true);
  v.setUint16(12, 1, true);
  v.setUint16(14, 24, true);
  return d;
}

describe("zip and cdr", () => {
  it("reads stored and deflated entries", async () => {
    const text = new TextEncoder().encode("hello hello hello hello");
    const z = zip([{ name: "a.txt", data: text }, { name: "b/c.txt", data: text, deflate: true }]);
    expect(isZip(z)).toBe(true);
    const entries = readZip(z);
    expect(entries.map((x) => x.name)).toEqual(["a.txt", "b/c.txt"]);
    for (const x of entries) expect(new TextDecoder().decode(await x.read())).toBe("hello hello hello hello");
  });

  it("wraps a DIB as a BMP", () => {
    const bmp = dibToBmp(dib())!;
    expect(String.fromCharCode(bmp[0]!, bmp[1]!)).toBe("BM");
    const v = new DataView(bmp.buffer);
    expect(v.getUint32(2, true)).toBe(bmp.length);
    expect(v.getUint32(10, true)).toBe(54);
    expect(dibToBmp(new Uint8Array(50))).toBeNull();
  });

  it("takes the thumbnail from an X4+ CDR (ZIP)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const z = zip([{ name: "content/root.dat", data: new Uint8Array(8) }, { name: "metadata/thumbnails/thumbnail.png", data: png }]);
    const r = await cdrPreview(z);
    expect(r.source).toBe("thumbnail");
    expect(r.image.type).toBe("image/png");
    expect(new Uint8Array(await r.image.arrayBuffer())).toEqual(png);
  });

  it("takes the DISP picture from an old RIFF CDR", async () => {
    const d = dib();
    const f = new Uint8Array(12 + 8 + d.length);
    const v = new DataView(f.buffer);
    f.set(new TextEncoder().encode("RIFF"), 0);
    v.setUint32(4, f.length - 8, true);
    f.set(new TextEncoder().encode("CDR9DISP"), 8);
    v.setUint32(16, d.length, true);
    f.set(d, 20);
    const r = await cdrPreview(f);
    expect(r.source).toBe("disp");
    expect(r.image.type).toBe("image/bmp");
  });

  it("rejects files that aren't CorelDRAW", async () => {
    await expect(cdrPreview(new TextEncoder().encode("not a cdr file at all"))).rejects.toThrow();
  });
});
