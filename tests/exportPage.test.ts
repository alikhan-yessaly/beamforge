import { describe, expect, it } from "vitest";
import { PAGE_SIZES, orientPage, pixelInfo, setJpegDpi, setPngDpi, smallestPage } from "../src/export/page";
import { writePdf } from "../src/export/pdf";
import { layoutExport } from "../src/export/svg";
import { readDpi } from "../src/import/raster";
import type { ExportPath } from "../src/import/types";

const box: ExportPath = { points: [{ x: 50, y: 60 }, { x: 150, y: 60 }, { x: 150, y: 110 }], closed: true, color: "#ff0000" };
const A4 = PAGE_SIZES.find((p) => p.id === "a4")!;

describe("pages", () => {
  it("orients the page", () => {
    expect(orientPage(A4, "auto", { w: 100, h: 50 })).toEqual({ w: 297, h: 210 });
    expect(orientPage(A4, "auto", { w: 50, h: 100 })).toEqual({ w: 210, h: 297 });
    expect(orientPage(A4, "portrait", { w: 100, h: 50 })).toEqual({ w: 210, h: 297 });
    expect(orientPage(A4, "landscape", { w: 10, h: 50 })).toEqual({ w: 297, h: 210 });
  });

  it("suggests the smallest A page that fits", () => {
    expect(smallestPage({ w: 100, h: 50 })!.id).toBe("a5");
    expect(smallestPage({ w: 250, h: 150 })!.id).toBe("a4");
    expect(smallestPage({ w: 300, h: 250 })!.id).toBe("a3");
    expect(smallestPage({ w: 2000, h: 2000 })).toBeNull();
  });

  it("centres the drawing on a page", () => {
    const lay = layoutExport([box], { page: { w: 297, h: 210 }, center: true });
    expect(lay).toEqual({ w: 297, h: 210, dx: (297 - 100) / 2 - 50, dy: (210 - 50) / 2 - 60 });
  });

  it("writes the page size into the PDF", () => {
    const pdf = new TextDecoder().decode(writePdf([box], { page: { w: 210, h: 297 }, center: true }));
    expect(pdf).toMatch(/\/MediaBox \[0 0 595\.27\d* 841\.89\d*\]/);
  });
});

describe("pixels", () => {
  it("pixel size and scale", () => {
    const i = pixelInfo({ w: 100, h: 50 }, 254);
    expect(i).toMatchObject({ w: 1000, h: 500, mp: 0.5, bytes: 2e6 });
    expect(i.pxPerMm).toBeCloseTo(10);
    expect(i.mmPerPx).toBeCloseTo(0.1);
  });

  it("stamps the resolution into PNG and JPEG files", () => {
    // Minimal PNG: signature, IHDR (13 bytes), IEND.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...new Array(13).fill(0), 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const stamped = setPngDpi(png, 300);
    expect(stamped.length).toBe(png.length + 21);
    expect(readDpi(stamped)).toBe(300);
    expect(readDpi(setPngDpi(stamped, 600))).toBe(600); // replaces, doesn't stack
    expect(setPngDpi(setPngDpi(stamped, 600), 600).length).toBe(stamped.length);

    const jpg = new Uint8Array(24);
    jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1]);
    expect(readDpi(setJpegDpi(jpg, 254))).toBe(254);
    expect(readDpi(jpg)).toBeNull(); // the original is untouched
  });
});
