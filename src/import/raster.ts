// Decode pictures (PNG, JPEG, BMP, GIF, WebP, and iPhone HEIC/HEIF) in the browser, for tracing and for keeping
// the picture on the canvas. HEIC decodes natively in Safari; elsewhere a libheif build loads on first use.
import type { Rgba } from "./types";

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Pixels per inch from the file's metadata, when present (PNG pHYs, JPEG JFIF). */
  dpi: number | null;
}

const isHeic = (name: string, bytes: Uint8Array) =>
  /\.(heic|heif)$/i.test(name) || (bytes.length > 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp" && /hei|mif|msf/.test(String.fromCharCode(...bytes.subarray(8, 12))));

export async function decodeImage(blob: Blob, name: string): Promise<DecodedImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    if (!isHeic(name, bytes)) throw new Error(`Could not read the picture (${e instanceof Error ? e.message : String(e)}).`);
    const { heicTo } = await import("heic-to");
    bitmap = await heicTo({ blob, type: "bitmap" });
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, dpi: readDpi(bytes) };
}

/** The picture scaled to fit `maxSide` px (never enlarged), as RGBA pixels. */
export function pixels(img: DecodedImage, maxSide: number): Rgba {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img.bitmap, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

/** A data: URL of the picture for keeping in the project (JPEG unless it has transparency), at most `maxSide` px. */
export async function keepableUrl(img: DecodedImage, maxSide = 2400): Promise<string> {
  const rgba = pixels(img, maxSide);
  let alpha = false;
  for (let i = 3; i < rgba.data.length; i += 4) {
    if (rgba.data[i]! < 250) {
      alpha = true;
      break;
    }
  }
  const c = new OffscreenCanvas(rgba.width, rgba.height);
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0);
  const out = await c.convertToBlob(alpha ? { type: "image/png" } : { type: "image/jpeg", quality: 0.88 });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(out);
  });
}

/** DPI from PNG pHYs or JPEG JFIF density; null when absent or not in a physical unit. */
export function readDpi(b: Uint8Array): number | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) {
    for (let i = 8; i + 12 <= b.length; ) {
      const len = dv.getUint32(i);
      const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
      if (type === "pHYs" && len >= 9) {
        const ppm = dv.getUint32(i + 8);
        return b[i + 16] === 1 && ppm > 0 ? Math.round(ppm * 0.0254) : null;
      }
      if (type === "IDAT" || type === "IEND") break;
      i += 12 + len;
    }
    return null;
  }
  if (b.length > 20 && b[0] === 0xff && b[1] === 0xd8 && String.fromCharCode(...b.subarray(6, 10)) === "JFIF") {
    const unit = b[13], x = dv.getUint16(14);
    if (unit === 1 && x > 1) return x;
    if (unit === 2 && x > 1) return Math.round(x * 2.54);
  }
  return null;
}
