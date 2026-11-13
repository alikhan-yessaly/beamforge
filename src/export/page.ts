// Page sizes for PDF export, and the pixel facts shown for PNG/JPEG export. Pure.

export interface PageSize {
  id: string;
  label: string;
  /** Portrait size, mm. */
  w: number;
  h: number;
}

export const PAGE_SIZES: PageSize[] = [
  { id: "a5", label: "A5", w: 148, h: 210 },
  { id: "a4", label: "A4", w: 210, h: 297 },
  { id: "a3", label: "A3", w: 297, h: 420 },
  { id: "a2", label: "A2", w: 420, h: 594 },
  { id: "a1", label: "A1", w: 594, h: 841 },
  { id: "letter", label: "Letter", w: 215.9, h: 279.4 },
  { id: "legal", label: "Legal", w: 215.9, h: 355.6 },
  { id: "tabloid", label: "Tabloid", w: 279.4, h: 431.8 },
];

export type Orientation = "auto" | "portrait" | "landscape";

/** The page in mm for a size and orientation; "auto" turns the page the way the drawing is wider. */
export function orientPage(size: { w: number; h: number }, orientation: Orientation, drawing: { w: number; h: number }): { w: number; h: number } {
  const landscape = orientation === "landscape" || (orientation === "auto" && drawing.w > drawing.h);
  const short = Math.min(size.w, size.h), long = Math.max(size.w, size.h);
  return landscape ? { w: long, h: short } : { w: short, h: long };
}

/** The smallest standard page (in either orientation) the drawing fits on with `margin` mm all round, or null. */
export function smallestPage(drawing: { w: number; h: number }, margin = 10): PageSize | null {
  const fits = (p: PageSize) => {
    const o = orientPage(p, "auto", drawing);
    return drawing.w + 2 * margin <= o.w + 1e-9 && drawing.h + 2 * margin <= o.h + 1e-9;
  };
  return PAGE_SIZES.filter((p) => p.id.startsWith("a")).find(fits) ?? null;
}

// ---------- Pixels ----------

export const MM_PER_INCH = 25.4;

/** Suggested resolutions, with what each is good for (English, translated by the caller). */
export const DPI_PRESETS: { dpi: number; note: string }[] = [
  { dpi: 96, note: "screen" },
  { dpi: 150, note: "draft print" },
  { dpi: 254, note: "0.1 mm per pixel, a typical laser line spacing" },
  { dpi: 300, note: "print" },
  { dpi: 508, note: "0.05 mm per pixel" },
  { dpi: 600, note: "fine print" },
  { dpi: 1000, note: "very fine" },
];

export interface PixelInfo {
  w: number;
  h: number;
  /** Megapixels. */
  mp: number;
  pxPerMm: number;
  mmPerPx: number;
  /** Uncompressed RGBA size in bytes (memory needed to render it). */
  bytes: number;
}

export function pixelInfo(sizeMm: { w: number; h: number }, dpi: number): PixelInfo {
  const pxPerMm = dpi / MM_PER_INCH;
  const w = Math.max(1, Math.ceil(sizeMm.w * pxPerMm)), h = Math.max(1, Math.ceil(sizeMm.h * pxPerMm));
  return { w, h, mp: (w * h) / 1e6, pxPerMm, mmPerPx: 1 / pxPerMm, bytes: w * h * 4 };
}

/** Largest picture the export will render (pixels). */
export const MAX_PIXELS = 120e6;

// ---------- Resolution stamps, so other programs (and BeamForge's import) read the right physical size ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG with a pHYs chunk (pixels per metre) right after IHDR, replacing any existing one. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  if (png.length < 33 || png[0] !== 0x89 || png[1] !== 0x50) return png;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const c = new DataView(chunk.buffer);
  c.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  c.setUint32(8, ppm);
  c.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  c.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Copy chunks, dropping any old pHYs, inserting ours after IHDR.
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  for (let i = 8; i + 12 <= png.length; ) {
    const len = dv.getUint32(i);
    const end = i + 12 + len;
    const type = String.fromCharCode(png[i + 4]!, png[i + 5]!, png[i + 6]!, png[i + 7]!);
    if (type !== "pHYs") parts.push(png.subarray(i, end));
    if (type === "IHDR") parts.push(chunk);
    i = end;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A JPEG whose JFIF header says `dpi` (the header is patched in place on a copy; files without JFIF are unchanged). */
export function setJpegDpi(jpg: Uint8Array, dpi: number): Uint8Array {
  if (jpg.length < 20 || jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[2] !== 0xff || jpg[3] !== 0xe0) return jpg;
  if (String.fromCharCode(jpg[6]!, jpg[7]!, jpg[8]!, jpg[9]!) !== "JFIF") return jpg;
  const out = jpg.slice();
  const dv = new DataView(out.buffer);
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  out[13] = 1; // dots per inch
  dv.setUint16(14, d);
  dv.setUint16(16, d);
  return out;
}
