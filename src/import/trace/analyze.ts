// Automatic trace settings: look at a picture (background, real colours, photo or drawing, stroke width) and pick
// how to trace it, plus a few alternative versions to offer side by side. Pure; runs on a small copy of the picture.
import { msg } from "../../i18n";
import type { Rgba } from "../types";
import { otsu, toGray } from "./preprocess";
import { quantize } from "./quantize";
import type { TraceSettings } from "./pipeline";

export interface ImageAnalysis {
  /** transparent: the picture is cut out; light/dark: a plain backdrop; busy: no plain backdrop (a photo scene). */
  background: "transparent" | "light" | "dark" | "busy";
  /** The backdrop colour (median of the border), for plain backdrops. */
  bg: [number, number, number] | null;
  /** Distinct ink colours besides the backdrop (1 = one-colour artwork). */
  colors: number;
  /** Their colours, most used first. */
  palette: string[];
  /** Smooth shading with many tones (a photo or a painting) rather than flat artwork. */
  photo: boolean;
  /** Typical ink stroke width in px of the analysed picture (2 × area / perimeter). */
  strokePx: number;
  /** Share of the picture covered by ink, 0–1. */
  inkFraction: number;
  /** Automatic black & white threshold for the ink (after inversion on a dark backdrop). */
  level: number;
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function analyzeImage(img: Rgba): ImageAnalysis {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  // Border ring, 2 px deep.
  const ring: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) ring.push(y * w + x);
    }
  }
  let clear = 0;
  for (const i of ring) if (d[i * 4 + 3]! < 128) clear++;
  let background: ImageAnalysis["background"] = "busy";
  let bg: [number, number, number] | null = null;
  if (clear > ring.length * 0.5) background = "transparent";
  else {
    const ch = (k: number) => {
      const v = ring.filter((i) => d[i * 4 + 3]! >= 128).map((i) => d[i * 4 + k]!).sort((a, b) => a - b);
      return v[v.length >> 1] ?? 255;
    };
    const m: [number, number, number] = [ch(0), ch(1), ch(2)];
    let close = 0;
    for (const i of ring) {
      const p = i * 4;
      if (Math.hypot(d[p]! - m[0], d[p + 1]! - m[1], d[p + 2]! - m[2]) < 48) close++;
    }
    if (close >= ring.length * 0.75) {
      bg = m;
      background = lum(...m) >= 128 ? "light" : "dark";
    }
  }

  // Tones: 4-bit-per-channel histogram of opaque pixels. Flat artwork lands in a few bins (plus thin anti-aliasing);
  // photos spread over hundreds.
  const hist = new Uint32Array(4096);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (d[p + 3]! < 128) continue;
    opaque++;
    hist[((d[p]! >> 4) << 8) | ((d[p + 1]! >> 4) << 4) | (d[p + 2]! >> 4)]!++;
  }
  let bins = 0;
  for (let b = 0; b < 4096; b++) if (hist[b]! > opaque * 0.001) bins++;
  const photo = bins > 150;

  // Real colours: k-means without the backdrop, then clusters that are tiny or too alike are dropped.
  const q = quantize(img, 6, { ignoreWhite: background === "light" || background === "transparent", background: bg });
  const counts = new Array<number>(q.palette.length).fill(0);
  let fg = 0;
  for (let i = 0; i < n; i++) {
    const c = q.index[i]!;
    if (c !== 255) {
      counts[c]!++;
      fg++;
    }
  }
  const rgb = (hex: string) => [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
  type Cluster = { hex: string; c: [number, number, number]; n: number };
  const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  /** Distance from c to the segment a–b, and where along it (0 = a, 1 = b). */
  const toSegment = (c: readonly number[], a: readonly number[], b: readonly number[]) => {
    const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
    const len2 = ab[0]! ** 2 + ab[1]! ** 2 + ab[2]! ** 2 || 1;
    const u = Math.max(0, Math.min(1, ((c[0]! - a[0]!) * ab[0]! + (c[1]! - a[1]!) * ab[1]! + (c[2]! - a[2]!) * ab[2]!) / len2));
    return { d: dist(c, [a[0]! + u * ab[0]!, a[1]! + u * ab[1]!, a[2]! + u * ab[2]!]), u };
  };
  const cand: Cluster[] = [];
  q.palette.forEach((hex, i) => {
    if (counts[i]! / Math.max(1, fg) >= 0.03) cand.push({ hex, c: rgb(hex), n: counts[i]! });
  });
  // Anti-aliased edges make clusters of in-between colours: a blend of the backdrop and an ink, or of two inks.
  // Those belong to the ink they fade from, so they don't count as colours of their own.
  const paper = bg ?? [255, 255, 255];
  const kept: Cluster[] = [];
  for (const c of cand) {
    const blendOf = cand.find(
      (k) =>
        k !== c &&
        ((dist(k.c, paper) > dist(c.c, paper) && toSegment(c.c, paper, k.c).d < 30) ||
          cand.some((k2) => k2 !== c && k2 !== k && k.n >= c.n && k2.n >= c.n && toSegment(c.c, k.c, k2.c).d < 30 && Math.abs(toSegment(c.c, k.c, k2.c).u - 0.5) < 0.4 && dist(c.c, k.c) <= dist(c.c, k2.c))),
    );
    const near = kept.find((k) => dist(k.c, c.c) < 60);
    const into = near ?? (blendOf && kept.includes(blendOf) ? blendOf : null);
    if (into) into.n += c.n;
    else if (blendOf) blendOf.n += c.n;
    else kept.push(c);
  }
  kept.sort((a, b) => b.n - a.n);

  // Ink mask for stroke width: opaque pixels on a transparent picture, otherwise dark (or, on a dark backdrop, light)
  // pixels by Otsu's threshold.
  const gray = toGray(img);
  if (background === "dark") for (let i = 0; i < n; i++) gray[i] = 255 - gray[i]!;
  const level = otsu(gray);
  const ink = new Uint8Array(n);
  let area = 0;
  for (let i = 0; i < n; i++) {
    ink[i] = background === "transparent" ? (d[i * 4 + 3]! >= 128 ? 1 : 0) : gray[i]! <= level ? 1 : 0;
    area += ink[i]!;
  }
  let perim = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink[i]) continue;
      if (x === 0 || !ink[i - 1]) perim++;
      if (x === w - 1 || !ink[i + 1]) perim++;
      if (y === 0 || !ink[i - w]) perim++;
      if (y === h - 1 || !ink[i + w]) perim++;
    }
  }
  // 4-connected edge counting overstates a diagonal's perimeter by up to √2; the stroke estimate is a rough guide.
  const strokePx = perim ? (2 * area) / perim : 0;
  return { background, bg, colors: Math.max(1, kept.length), palette: kept.map((k) => k.hex), photo, strokePx, inkFraction: area / Math.max(1, n), level };
}

/** Settings the automatic choice touches; the rest stay at the dialog's defaults. */
export type AutoSettings = Pick<TraceSettings, "mode" | "colors" | "invert" | "blur" | "turdSize" | "smoothMm" | "lines" | "sticker" | "source" | "threshold" | "ignoreWhite" | "result">;

export interface TraceVariant {
  id: string;
  /** English label (msg), shown with t(). */
  label: string;
  settings: AutoSettings;
}

/** Stroke widths up to this many mm are traced as centre lines (one pass) rather than outlines. */
export const CENTERLINE_MAX_MM = 1.5;

/** The automatic choice for a picture printed at `mmPerPx` mm per analysed pixel. */
export function autoSettings(a: ImageAnalysis, mmPerPx: number): AutoSettings {
  const color = a.colors >= 2 && !a.photo;
  const strokeMm = a.strokePx * mmPerPx;
  const lines = !a.photo && strokeMm > 0 && strokeMm <= CENTERLINE_MAX_MM && a.inkFraction < 0.3 ? "centerline" : "outline";
  const plain = a.background !== "busy" && !a.photo;
  return {
    mode: color ? "color" : "bw",
    colors: Math.max(2, Math.min(8, a.colors)),
    invert: a.background === "dark",
    blur: a.photo ? 1 : 0,
    turdSize: a.photo ? 16 : 4,
    smoothMm: a.photo ? 0.5 : 0.25,
    lines,
    // Sticker style: a cut outline around a subject on a plain backdrop. Line drawings are usually scored onto
    // something, so they start without one.
    sticker: plain && lines === "outline",
    source: a.background === "transparent" && !color ? "alpha" : "brightness",
    threshold: null,
    ignoreWhite: true,
    result: "engrave",
  };
}

const same = (a: AutoSettings, b: AutoSettings) => (Object.keys(a) as (keyof AutoSettings)[]).every((k) => a[k] === b[k]);

/** The automatic choice first, then up to three different takes on the same picture. */
export function traceVariants(a: ImageAnalysis, mmPerPx: number): TraceVariant[] {
  const auto = autoSettings(a, mmPerPx);
  const strokeMm = a.strokePx * mmPerPx;
  const list: TraceVariant[] = [{ id: "auto", label: msg("Auto"), settings: auto }];
  const add = (id: string, label: string, patch: Partial<AutoSettings>) => {
    const s = { ...auto, ...patch };
    if (list.length < 4 && !list.some((v) => same(v.settings, s))) list.push({ id, label, settings: s });
  };
  if (auto.lines === "centerline") add("outline", msg("Outlines"), { lines: "outline" });
  else if (!a.photo && strokeMm <= CENTERLINE_MAX_MM * 2) add("centerline", msg("Centre lines"), { lines: "centerline", sticker: false });
  if (auto.mode === "color") add("bw", msg("Black & white"), { mode: "bw", source: a.background === "transparent" ? "alpha" : "brightness" });
  else if (a.colors >= 2 || a.photo) add("color", msg("Colours"), { mode: "color", colors: Math.max(2, Math.min(4, a.colors)), source: "brightness" });
  if (a.background !== "busy" && auto.lines === "outline") add("sticker", auto.sticker ? msg("No cut outline") : msg("With cut outline"), { sticker: !auto.sticker });
  if (auto.mode === "bw" && auto.source === "brightness") {
    add("bold", msg("Bolder"), { threshold: Math.min(250, a.level + 35) });
    add("light", msg("Finer"), { threshold: Math.max(5, a.level - 35) });
  }
  return list;
}
