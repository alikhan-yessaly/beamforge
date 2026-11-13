import { describe, expect, it } from "vitest";
import { analyzeImage, autoSettings, traceVariants } from "../src/import/trace/analyze";
import { dilate, fillHoles, joinPolylines, skeletonPaths, thin } from "../src/import/trace/morph";
import { DEFAULT_TRACE, STICKER_COLOR, traceImage } from "../src/import/trace/pipeline";
import type { Rgba } from "../src/import/types";

function bitmap(w: number, h: number, fn: (x: number, y: number) => boolean): Uint8Array {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = fn(x, y) ? 1 : 0;
  return b;
}

function rgba(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Rgba {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const len = (p: { x: number; y: number }[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i]!.x, q.y - p[i]!.y), 0);

describe("centre lines", () => {
  it("thins a thick bar to one line along its middle", () => {
    const w = 60, h = 20;
    const bits = bitmap(w, h, (x, y) => x >= 5 && x < 55 && y >= 8 && y < 13);
    const lines = joinPolylines(skeletonPaths(thin(bits, w, h), w, h, 6));
    expect(lines).toHaveLength(1);
    const l = lines[0]!;
    expect(l.closed).toBe(false);
    for (const p of l.points) expect(Math.abs(p.y - 10.5)).toBeLessThanOrEqual(1);
    expect(len(l.points)).toBeGreaterThan(40);
  });

  it("joins the two arms of an L into one line", () => {
    const w = 50, h = 50;
    const bits = bitmap(w, h, (x, y) => (x >= 8 && x < 12 && y >= 5 && y < 42) || (y >= 38 && y < 42 && x >= 8 && x < 45));
    const lines = joinPolylines(skeletonPaths(thin(bits, w, h), w, h, 6));
    expect(lines).toHaveLength(1);
    expect(len(lines[0]!.points)).toBeGreaterThan(60);
  });

  it("gives a closed loop for a ring", () => {
    const w = 60, h = 60;
    const bits = bitmap(w, h, (x, y) => {
      const r = Math.hypot(x - 30, y - 30);
      return r >= 18 && r <= 22;
    });
    const lines = joinPolylines(skeletonPaths(thin(bits, w, h), w, h, 6));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closed).toBe(true);
    expect(len(lines[0]!.points)).toBeGreaterThan(2 * Math.PI * 18);
  });
});

describe("sticker outline helpers", () => {
  it("grows a shape and fills its holes", () => {
    const w = 40, h = 40;
    const ring = bitmap(w, h, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30 && !(x >= 14 && x < 26 && y >= 14 && y < 26));
    const grown = fillHoles(dilate(ring, w, h, 3), w, h);
    expect(grown[20 * w + 20]).toBe(1); // the hole is filled
    expect(grown[20 * w + 7]).toBe(1); // 3 px outside
    expect(grown[20 * w + 5]).toBe(0);
  });
});

describe("analyzeImage and automatic settings", () => {
  it("reads a thin black drawing on white as one-colour line art (centre lines)", () => {
    const img = rgba(200, 200, (x, y) => (Math.abs(y - 100) < 2 && x > 20 && x < 180) || (Math.abs(x - 100) < 2 && y > 20 && y < 180) ? BLACK : WHITE);
    const a = analyzeImage(img);
    expect(a.background).toBe("light");
    expect(a.colors).toBe(1);
    expect(a.photo).toBe(false);
    expect(a.strokePx).toBeGreaterThan(2);
    expect(a.strokePx).toBeLessThan(5);
    const s = autoSettings(a, 0.25); // ~1 mm strokes
    expect(s.mode).toBe("bw");
    expect(s.lines).toBe("centerline");
    expect(s.sticker).toBe(false);
  });

  it("doesn't count anti-aliased edge greys as colours", () => {
    // Soft-edged lines: a dark core fading to white over two pixels gives a band of greys.
    const img = rgba(240, 240, (x, y) => {
      const d = Math.min(Math.abs(y - 60), Math.abs(y - 120), Math.abs(y - 180), Math.abs(x - 120));
      const v = Math.max(0, Math.min(255, (d - 1) * 85));
      return [v, v, v, 255];
    });
    const a = analyzeImage(img);
    expect(a.colors).toBe(1);
    expect(autoSettings(a, 0.25).mode).toBe("bw");
  });

  it("picks colours and a cut outline for flat two-colour artwork", () => {
    const img = rgba(200, 120, (x, y) => (x > 20 && x < 90 && y > 20 && y < 100 ? [220, 30, 30, 255] : x > 110 && x < 180 && y > 20 && y < 100 ? [30, 30, 200, 255] : WHITE));
    const a = analyzeImage(img);
    expect(a.colors).toBe(2);
    const s = autoSettings(a, 0.5);
    expect(s.mode).toBe("color");
    expect(s.lines).toBe("outline");
    expect(s.sticker).toBe(true);
  });

  it("inverts light artwork on a dark backdrop", () => {
    const img = rgba(160, 100, (x, y) => (x > 30 && x < 130 && y > 30 && y < 70 ? WHITE : [20, 20, 30, 255]));
    const a = analyzeImage(img);
    expect(a.background).toBe("dark");
    expect(autoSettings(a, 0.5).invert).toBe(true);
  });

  it("uses transparency as the shape of a cut-out picture", () => {
    const img = rgba(100, 100, (x, y) => (Math.hypot(x - 50, y - 50) < 35 ? [250, 250, 250, 255] : [0, 0, 0, 0]));
    const a = analyzeImage(img);
    expect(a.background).toBe("transparent");
    expect(autoSettings(a, 0.5).source).toBe("alpha");
  });

  it("recognises a photo-like gradient and offers alternatives", () => {
    const img = rgba(128, 128, (x, y) => [x * 2, y * 2, (x + y) % 256, 255]);
    const a = analyzeImage(img);
    expect(a.photo).toBe(true);
    expect(autoSettings(a, 0.5).blur).toBeGreaterThan(0);
    const v = traceVariants(a, 0.5);
    expect(v[0]!.id).toBe("auto");
    expect(v.length).toBeGreaterThan(1);
    expect(new Set(v.map((x) => JSON.stringify(x.settings))).size).toBe(v.length);
  });
});

describe("traceImage with the automatic options", () => {
  it("adds one sticker cut line around the design", () => {
    const img = rgba(100, 100, (x, y) => (x > 30 && x < 70 && y > 30 && y < 70 ? BLACK : WHITE));
    const r = traceImage(img, { ...DEFAULT_TRACE, sticker: true, stickerMarginMm: 2, mmPerPx: 0.5 });
    const cut = r.paths.filter((p) => p.stroke === STICKER_COLOR);
    expect(cut).toHaveLength(1);
    const xs = cut[0]!.points.map((p) => p.x);
    // The square spans 15.5–35 mm; the outline is about 2 mm outside it.
    expect(Math.min(...xs)).toBeLessThan(15);
    expect(Math.min(...xs)).toBeGreaterThan(12);
    expect(r.paths.some((p) => p.fill === "#000000")).toBe(true);
  });

  it("keeps two inks apart when the white backdrop is left out", () => {
    const img = rgba(200, 120, (x, y) => (x > 20 && x < 90 && y > 20 && y < 100 ? [220, 30, 30, 255] : x > 110 && x < 180 && y > 20 && y < 100 ? [20, 30, 70, 255] : WHITE));
    const r = traceImage(img, { ...DEFAULT_TRACE, mode: "color", colors: 2, mmPerPx: 0.5 });
    expect(new Set(r.paths.map((p) => p.fill)).size).toBe(2);
  });

  it("traces strokes as open centre lines", () => {
    const img = rgba(120, 60, (x, y) => (Math.abs(y - 30) < 2 && x > 10 && x < 110 ? BLACK : WHITE));
    const r = traceImage(img, { ...DEFAULT_TRACE, lines: "centerline", mmPerPx: 0.5 });
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0]!.closed).toBe(false);
    expect(r.paths[0]!.stroke).toBe("#000000");
    expect(r.paths[0]!.fill).toBeNull();
  });
});

describe("edge cases", () => {
  it("draws a wide sticker margin on a finely sampled picture without a giant mask", () => {
    const img = rgba(400, 400, (x, y) => (x > 100 && x < 300 && y > 100 && y < 300 ? BLACK : WHITE));
    // 0.005 mm per px with a 20 mm margin is 4000 px of margin.
    const r = traceImage(img, { ...DEFAULT_TRACE, sticker: true, stickerMarginMm: 20, mmPerPx: 0.005 });
    const cut = r.paths.filter((p) => p.stroke === STICKER_COLOR);
    expect(cut).toHaveLength(1);
    const xs = cut[0]!.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(0.5 - 18);
    expect(Math.min(...xs)).toBeGreaterThan(0.5 - 22);
  });

  it("traces blank, tiny and fully transparent pictures without errors", () => {
    for (const img of [rgba(1, 1, () => BLACK), rgba(1, 1, () => WHITE), rgba(20, 20, () => [0, 0, 0, 0]), rgba(1, 50, (x, y) => (y % 2 ? BLACK : WHITE))]) {
      const a = analyzeImage(img);
      for (const v of traceVariants(a, 0.5)) {
        const r = traceImage(img, { ...DEFAULT_TRACE, ...v.settings, background: a.bg, mmPerPx: 0.5 });
        for (const p of r.paths) for (const q of p.points) expect(Number.isFinite(q.x) && Number.isFinite(q.y)).toBe(true);
      }
    }
  });
});

describe("sticker outline size limits", () => {
  it("still outlines a design much smaller than the margin, but not a lone speck", () => {
    const small = rgba(200, 200, (x, y) => (x >= 95 && x < 105 && y >= 95 && y < 105 ? BLACK : WHITE));
    const r = traceImage(small, { ...DEFAULT_TRACE, sticker: true, stickerMarginMm: 20, mmPerPx: 0.25 });
    expect(r.paths.filter((p) => p.stroke === STICKER_COLOR)).toHaveLength(1);
    const speck = rgba(200, 200, (x, y) => (x === 100 && y === 100 ? BLACK : WHITE));
    const s = traceImage(speck, { ...DEFAULT_TRACE, sticker: true, stickerMarginMm: 5, mmPerPx: 0.25 });
    expect(s.paths.filter((p) => p.stroke === STICKER_COLOR)).toHaveLength(0);
  });
});
