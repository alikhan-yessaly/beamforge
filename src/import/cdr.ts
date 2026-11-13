// CorelDRAW (.cdr), best effort. The format is closed and its vector records are undocumented, so instead of
// guessing at them BeamForge takes the preview picture every CDR file carries and offers it for tracing:
//  - X4 and later: a ZIP archive with a thumbnail PNG/BMP (metadata/thumbnails/…, previews/…).
//  - older versions: a RIFF file whose DISP chunk is a Windows DIB (BMP without its file header).
// Exporting SVG or PDF from CorelDRAW keeps the real vectors; the import dialog says so.
import { msg } from "../i18n";
import { isZip, readZip } from "./zip";

export interface CdrPreview {
  image: Blob;
  /** Where the picture came from, for the dialog. */
  source: "thumbnail" | "disp";
}

const IMAGE = /\.(png|bmp|jpe?g)$/i;

export async function cdrPreview(bytes: Uint8Array): Promise<CdrPreview> {
  if (isZip(bytes)) {
    const entries = readZip(bytes).filter((e) => IMAGE.test(e.name));
    const pick = entries.find((e) => /thumbnail/i.test(e.name)) ?? entries.find((e) => /preview/i.test(e.name)) ?? entries[0];
    if (!pick) throw new Error(msg("This CorelDRAW file has no preview picture to trace."));
    const type = /\.png$/i.test(pick.name) ? "image/png" : /\.bmp$/i.test(pick.name) ? "image/bmp" : "image/jpeg";
    return { image: new Blob([new Uint8Array(await pick.read())], { type }), source: "thumbnail" };
  }
  const tag = (i: number) => String.fromCharCode(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, bytes[i + 3]!);
  if (bytes.length < 12 || tag(0) !== "RIFF" || !tag(8).startsWith("CDR")) throw new Error(msg("Not a CorelDRAW file."));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 12; i + 8 < bytes.length; i++) {
    if (bytes[i] !== 0x44 || tag(i) !== "DISP") continue; // "D"
    const size = dv.getUint32(i + 4, true);
    const payload = bytes.subarray(i + 8, Math.min(bytes.length, i + 8 + size));
    const bmp = dibToBmp(payload);
    if (bmp) return { image: new Blob([new Uint8Array(bmp)], { type: "image/bmp" }), source: "disp" };
  }
  throw new Error(msg("This CorelDRAW file has no preview picture to trace."));
}

/** Wrap a DIB (BITMAPINFOHEADER + palette + pixels), found within the first bytes of `data`, as a .bmp file. */
export function dibToBmp(data: Uint8Array): Uint8Array | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let off = 0; off <= 8 && off + 40 <= data.length; off += 4) {
    if (dv.getUint32(off, true) !== 40) continue;
    const bits = dv.getUint16(off + 14, true);
    if (![1, 4, 8, 16, 24, 32].includes(bits)) continue;
    const used = dv.getUint32(off + 32, true);
    const colors = bits <= 8 ? used || 1 << bits : 0;
    const dib = data.subarray(off);
    const out = new Uint8Array(14 + dib.length);
    const o = new DataView(out.buffer);
    out[0] = 0x42;
    out[1] = 0x4d; // "BM"
    o.setUint32(2, out.length, true);
    o.setUint32(10, 14 + 40 + colors * 4, true);
    out.set(dib, 14);
    return out;
  }
  return null;
}
