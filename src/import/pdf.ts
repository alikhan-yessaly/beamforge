// PDF and Illustrator (.ai, which modern Illustrator saves as PDF) import through pdf.js, loaded on first use.
import type { Mat } from "../geom/geom";
import { type PdfOps, pdfOperatorsToPaths } from "./pdfOps";
import type { VectorImport } from "./types";

const PT_MM = 25.4 / 72;

/** True when the bytes start like a PDF (an .ai file saved with PDF compatibility does). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

export interface PdfDoc {
  pages: number;
  read(page: number): Promise<VectorImport>;
}

export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  // pdf.js takes ownership of the buffer it is given: pass a copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const ops = pdfjs.OPS as unknown as PdfOps;
  return {
    pages: doc.numPages,
    async read(n: number) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const list = await page.getOperatorList();
      return pdfOperatorsToPaths(list.fnArray, list.argsArray, ops, vp.transform as Mat, { w: vp.width * PT_MM, h: vp.height * PT_MM });
    },
  };
}
