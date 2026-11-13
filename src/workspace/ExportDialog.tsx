// Export the drawing (the selection or everything) as SVG, DXF, PDF, PNG or JPEG, in bed millimetres, with a
// preview of the result.
import { msg, t } from "../i18n";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Box, apply, emptyBox, addPoint, isEmptyBox } from "../geom/geom";
import { writeDxf } from "../export/dxf";
import { DPI_PRESETS, MAX_PIXELS, type Orientation, PAGE_SIZES, orientPage, pixelInfo, setJpegDpi, setPngDpi, smallestPage } from "../export/page";
import { writePdf } from "../export/pdf";
import { fillRegions } from "../export/regions";
import { layoutExport, writeSvg } from "../export/svg";
import type { ExportPath } from "../import/types";
import { activeLayers } from "../job/layers";
import { project } from "../project/state";
import type { Doc, SceneObject } from "../scene/model";
import { imageFrame } from "../scene/ops";
import { doc, notify, profile, selection } from "../scene/store";

type Format = "svg" | "dxf" | "pdf" | "png" | "jpg";
const FORMATS: { v: Format; label: string }[] = [
  { v: "svg", label: "SVG" },
  { v: "dxf", label: "DXF" },
  { v: "pdf", label: "PDF" },
  { v: "png", label: "PNG" },
  { v: "jpg", label: "JPEG" },
];
const isRaster = (f: Format) => f === "png" || f === "jpg";

const DPI_NOTES: Record<string, string> = {
  screen: msg("screen"),
  "draft print": msg("draft print"),
  "0.1 mm per pixel, a typical laser line spacing": msg("0.1 mm per pixel, a typical laser line spacing"),
  print: msg("print"),
  "0.05 mm per pixel": msg("0.05 mm per pixel"),
  "fine print": msg("fine print"),
  "very fine": msg("very fine"),
};

const open = signal(false);
export const openExport = () => (open.value = true);

/** The objects in scope, and their paths in bed mm with layer info. Hidden layers are left out unless asked. */
export function exportPaths(d: Doc, objects: SceneObject[], includeHidden: boolean): ExportPath[] {
  const layers = new Map(activeLayers(d).map((l) => [l.color, l]));
  const shown = (c: string) => includeHidden || layers.get(c)?.show !== false;
  const out: ExportPath[] = [];
  for (const o of objects) {
    for (const p of o.paths) {
      if (!shown(p.color) || p.points.length < 2) continue;
      const fill = p.fill && shown(p.fill) ? p.fill : undefined;
      out.push({
        points: p.points.map((q) => apply(o.mat, q)),
        closed: p.closed,
        color: p.color,
        ...((layers.get(p.color)?.mode ?? "cut") !== "cut" ? { fillLayer: true } : {}),
        ...(fill ? { fill } : {}),
      });
    }
  }
  return out;
}

function boxOf(paths: ExportPath[], objects: SceneObject[], withImages: boolean): Box {
  const b = emptyBox();
  for (const p of paths) for (const q of p.points) addPoint(b, q);
  if (withImages) for (const o of objects) if (o.image) for (const q of imageFrame(o.image).points) addPoint(b, apply(o.mat, q));
  return b;
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("image"));
      im.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draw the export onto `ctx`, whose transform already maps bed mm to pixels at `k` px/mm: pictures, then engraved
 * areas filled solid, then outlines 0.1 mm (at least `minLinePx` px) wide.
 */
async function paint(ctx: Ctx, paths: ExportPath[], objects: SceneObject[], k: number, opts: { images: boolean; minLinePx: number }): Promise<void> {
  if (opts.images) {
    for (const o of objects) {
      if (!o.image) continue;
      const im = await loadImage(o.image.src);
      ctx.save();
      ctx.transform(...o.mat);
      ctx.drawImage(im, 0, 0, o.image.w, o.image.h);
      ctx.restore();
    }
  }
  const ring = (p: ExportPath) => {
    p.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    if (p.closed) ctx.closePath();
  };
  // Disjoint regions, so a shape filled in another colour inside a filled shape keeps its own colour.
  for (const r of fillRegions(paths)) {
    ctx.beginPath();
    for (const pts of r.rings) ring({ points: pts, closed: true, color: r.color });
    ctx.fillStyle = r.color;
    ctx.fill("evenodd");
  }
  ctx.lineWidth = Math.max(0.1, opts.minLinePx / k);
  ctx.lineJoin = "round";
  for (const p of paths) {
    if (p.fillLayer) continue;
    ctx.beginPath();
    ring(p);
    ctx.strokeStyle = p.color;
    ctx.stroke();
  }
}

/** Render the PNG or JPEG at `dpi`, with the resolution written into the file. */
async function renderRaster(format: "png" | "jpg", paths: ExportPath[], objects: SceneObject[], box: Box, dpi: number, opts: { transparent: boolean; images: boolean; quality: number }): Promise<Blob> {
  const info = pixelInfo({ w: box.maxX - box.minX, h: box.maxY - box.minY }, dpi);
  if (info.w * info.h > MAX_PIXELS) throw new Error(t("The picture would be {w} × {h} px, too large: lower the resolution.", { w: info.w, h: info.h }));
  const c = new OffscreenCanvas(info.w, info.h);
  const ctx = c.getContext("2d")!;
  if (format === "jpg" || !opts.transparent) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, info.w, info.h);
  }
  const k = info.pxPerMm;
  ctx.setTransform(k, 0, 0, k, -box.minX * k, -box.minY * k);
  await paint(ctx, paths, objects, k, { images: opts.images, minLinePx: 1 });
  const blob = await c.convertToBlob(format === "png" ? { type: "image/png" } : { type: "image/jpeg", quality: opts.quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const stamped = format === "png" ? setPngDpi(bytes, dpi) : setJpegDpi(bytes, dpi);
  return new Blob([new Uint8Array(stamped)], { type: blob.type });
}

function download(data: Blob, name: string): void {
  const url = URL.createObjectURL(data);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const mm = (v: number) => (Math.round(v * 10) / 10).toString();
const MiB = (bytes: number) => (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0);

/** What the dialog's settings produce: the area that becomes the file (bed mm) and how the paths sit in it. */
interface Plan {
  /** The page or picture area, in bed mm. */
  area: Box;
  /** For a page: its size and name. */
  page?: { w: number; h: number; name: string };
  /** The drawing doesn't fit on the chosen page. */
  overflow: boolean;
}

export function ExportDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const isOpen = open.value;
  const hasSel = selection.value.size > 0;
  const [format, setFormat] = useState<Format>("svg");
  const [scope, setScope] = useState<"selection" | "all">("all");
  const [bedPos, setBedPos] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dpi, setDpi] = useState(254);
  const [customDpi, setCustomDpi] = useState(false);
  const [transparent, setTransparent] = useState(false);
  const [images, setImages] = useState(true);
  const [quality, setQuality] = useState(90);
  const [pageId, setPageId] = useState<string>("fit");
  const [orientation, setOrientation] = useState<Orientation>("auto");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setScope(selection.value.size > 0 ? "selection" : "all");
    ref.current?.showModal();
  }, [isOpen]);

  const d = doc.value;
  const objects = !isOpen ? [] : scope === "selection" ? d.objects.filter((o) => selection.value.has(o.id)) : d.objects;
  const paths = isOpen ? exportPaths(d, objects, hidden) : [];
  const raster = isRaster(format);
  const withImages = raster && images;
  const box = boxOf(paths, objects, withImages);
  const empty = isEmptyBox(box);
  const p = profile.value;
  const drawing = empty ? { w: 0, h: 0 } : { w: box.maxX - box.minX, h: box.maxY - box.minY };
  const suggested = smallestPage(drawing);

  // The page (PDF) or picture area (others).
  const pdfPage = (): { w: number; h: number; name: string; keep: boolean } | null => {
    if (pageId === "bed") return { w: p.bedW, h: p.bedH, name: t("Bed"), keep: true };
    const size = PAGE_SIZES.find((s) => s.id === pageId);
    return size ? { ...orientPage(size, orientation, drawing), name: size.label, keep: false } : null;
  };
  const plan = (): Plan => {
    if (format === "pdf") {
      const pg = pdfPage();
      if (pg) {
        const lay = layoutExport(paths, pg.keep ? { keepPosition: true, page: pg } : { page: pg, center: true });
        const area = { minX: -lay.dx, minY: -lay.dy, maxX: -lay.dx + lay.w, maxY: -lay.dy + lay.h };
        const overflow = !empty && (box.minX < area.minX - 1e-6 || box.minY < area.minY - 1e-6 || box.maxX > area.maxX + 1e-6 || box.maxY > area.maxY + 1e-6);
        return { area, page: { w: lay.w, h: lay.h, name: pg.name }, overflow };
      }
    }
    if (bedPos && format !== "pdf") return { area: { minX: 0, minY: 0, maxX: p.bedW, maxY: p.bedH }, overflow: false };
    return { area: box, overflow: false };
  };
  const pl = plan();
  const areaMm = { w: pl.area.maxX - pl.area.minX, h: pl.area.maxY - pl.area.minY };
  const px = raster && !empty ? pixelInfo(areaMm, dpi) : null;
  const tooBig = !!px && px.w * px.h > MAX_PIXELS;

  // Preview: the page or picture area fitted into the canvas.
  useEffect(() => {
    if (!isOpen) return;
    let stale = false;
    const draw = async () => {
      const c = canvas.current;
      if (!c) return;
      if (!c.clientWidth) {
        requestAnimationFrame(() => !stale && void draw());
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      c.width = W * dpr;
      c.height = H * dpr;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#e9ebef";
      ctx.fillRect(0, 0, W, H);
      if (empty) return;
      const a = pl.area;
      const aw = Math.max(a.maxX - a.minX, 1e-6), ah = Math.max(a.maxY - a.minY, 1e-6);
      const k = Math.min((W - 24) / aw, (H - 24) / ah);
      const ox = (W - aw * k) / 2, oy = (H - ah * k) / 2;
      // The sheet: white, or a checkerboard where the PNG is transparent.
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,.25)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = "#fff";
      ctx.fillRect(ox, oy, aw * k, ah * k);
      ctx.restore();
      if (format === "png" && transparent) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, aw * k, ah * k);
        ctx.clip();
        ctx.fillStyle = "#d9dce2";
        for (let y = 0; y < ah * k; y += 8) for (let x = (y / 8) % 2 ? 8 : 0; x < aw * k; x += 16) ctx.fillRect(ox + x, oy + y, 8, 8);
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, aw * k, ah * k);
      ctx.clip();
      ctx.translate(ox, oy);
      ctx.scale(k, k);
      ctx.translate(-a.minX, -a.minY);
      if (stale) return;
      await paint(ctx, paths, objects, k, { images: withImages, minLinePx: 1 });
      ctx.restore();
      if (pl.overflow) {
        ctx.strokeStyle = "#d33";
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(ox + 0.5, oy + 0.5, aw * k - 1, ah * k - 1);
      }
    };
    void draw();
    return () => {
      stale = true;
    };
  });

  if (!isOpen) return null;
  const close = () => {
    ref.current?.close();
    open.value = false;
  };
  const base = (scope === "selection" && objects.length === 1 ? objects[0]!.name : project.value.name || "drawing").replace(/[\\/:*?"<>|]+/g, "-");

  const go = async () => {
    setBusy(true);
    try {
      const bedPage = { w: p.bedW, h: p.bedH };
      let blob: Blob;
      if (format === "svg") blob = new Blob([writeSvg(paths, { keepPosition: bedPos, page: bedPos ? bedPage : undefined })], { type: "image/svg+xml" });
      else if (format === "dxf") blob = new Blob([writeDxf(paths, { keepPosition: bedPos })], { type: "application/dxf" });
      else if (format === "pdf") {
        const pg = pdfPage();
        const opts = pg ? (pg.keep ? { keepPosition: true, page: pg } : { page: pg, center: true }) : {};
        blob = new Blob([new Uint8Array(writePdf(paths, { ...opts, title: base }))], { type: "application/pdf" });
      } else blob = await renderRaster(format, paths, objects, pl.area, dpi, { transparent, images: withImages, quality: quality / 100 });
      download(blob, `${base}.${format}`);
      notify(t("Exported {file}", { file: `${base}.${format}` }));
      close();
    } catch (e) {
      notify(t("Export: {error}", { error: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  const presetDpi = DPI_PRESETS.some((x) => x.dpi === dpi) && !customDpi;

  return (
    <dialog
      ref={ref}
      class="ws-dialog ws-export-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h3>{t("Export")}</h3>
      <div class="ws-export-body">
        <div>
          <canvas ref={canvas} class="ws-import-preview ws-export-preview" />
          <p class="ws-hint ws-export-facts">
            {empty ? (
              t("Nothing to export.")
            ) : (
              <>
                {t("{n} paths · drawing {w} × {h} mm", { n: paths.length, w: mm(drawing.w), h: mm(drawing.h) })}
                {pl.page && <br />}
                {pl.page && t("Page {name}: {w} × {h} mm", { name: pl.page.name, w: mm(pl.page.w), h: mm(pl.page.h) })}
                {px && <br />}
                {px &&
                  t("{w} × {h} px · {mp} MP · {ppmm} px/mm · 1 px = {mmpx} mm · {mem} MB to render", {
                    w: px.w,
                    h: px.h,
                    mp: px.mp.toFixed(px.mp < 10 ? 2 : 1),
                    ppmm: px.pxPerMm.toFixed(2),
                    mmpx: px.mmPerPx.toFixed(3),
                    mem: MiB(px.bytes),
                  })}
              </>
            )}
          </p>
          {pl.overflow && <p class="ws-plan-msg">{t("The drawing is larger than the page and isn't scaled: parts of it will be cut off. Pick a larger page or Fit to the drawing.")}</p>}
          {tooBig && <p class="ws-plan-msg">{t("Too many pixels (limit {n} MP): lower the resolution.", { n: MAX_PIXELS / 1e6 })}</p>}
          {!raster && objects.some((o) => o.image) && <p class="ws-hint">{t("Pictures are left out (PNG and JPEG include them).")}</p>}
        </div>
        <div class="ws-import-opts">
          <label>
            <span>{t("What")}</span>
            <select value={scope} onChange={(e) => setScope(e.currentTarget.value as "selection" | "all")}>
              <option value="selection" disabled={!hasSel}>
                {t("The selection")}
              </option>
              <option value="all">{t("Everything")}</option>
            </select>
          </label>
          <label>
            <span>{t("Format")}</span>
            <select value={format} onChange={(e) => setFormat(e.currentTarget.value as Format)}>
              {FORMATS.map((f) => (
                <option key={f.v} value={f.v}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {format === "pdf" && (
            <>
              <label>
                <span>{t("Page size")}</span>
                <select value={pageId} onChange={(e) => setPageId(e.currentTarget.value)}>
                  <option value="fit">{t("Fit to the drawing")}</option>
                  {PAGE_SIZES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} ({mm(s.w)} × {mm(s.h)} mm){suggested?.id === s.id ? ` · ${t("smallest that fits")}` : ""}
                    </option>
                  ))}
                  <option value="bed">{t("Bed size, keep the position on the bed")}</option>
                </select>
              </label>
              {PAGE_SIZES.some((s) => s.id === pageId) && (
                <label>
                  <span>{t("Orientation")}</span>
                  <select value={orientation} onChange={(e) => setOrientation(e.currentTarget.value as Orientation)}>
                    <option value="auto">{t("Automatic")}</option>
                    <option value="portrait">{t("Portrait")}</option>
                    <option value="landscape">{t("Landscape")}</option>
                  </select>
                </label>
              )}
              {pageId === "fit" && suggested && (
                <button type="button" class="ws-link-btn" onClick={() => setPageId(suggested.id)}>
                  {t("Use {page}, the smallest standard page it fits on", { page: suggested.label })}
                </button>
              )}
              {PAGE_SIZES.some((s) => s.id === pageId) && <p class="ws-hint">{t("The drawing is centred on the page at its real size.")}</p>}
            </>
          )}
          {raster && (
            <>
              <label>
                <span>{t("Resolution")}</span>
                <select
                  value={presetDpi ? String(dpi) : "custom"}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setCustomDpi(v === "custom");
                    if (v !== "custom") setDpi(Number(v));
                  }}
                >
                  {DPI_PRESETS.map((x) => (
                    <option key={x.dpi} value={x.dpi}>
                      {x.dpi} DPI · {(x.dpi / 25.4).toFixed(2)} px/mm · {t(DPI_NOTES[x.note] ?? x.note)}
                    </option>
                  ))}
                  <option value="custom">{t("Custom…")}</option>
                </select>
              </label>
              {!presetDpi && (
                <label>
                  <span>{t("Pixels per mm")}</span>
                  <span class="ws-row">
                    <input
                      type="number"
                      min={0.5}
                      max={80}
                      step={0.1}
                      value={Number((dpi / 25.4).toFixed(2))}
                      onChange={(e) => {
                        const v = Number(e.currentTarget.value);
                        if (v > 0) setDpi(Math.round(v * 25.4 * 100) / 100);
                      }}
                    />
                    <span>= {Math.round(dpi)} DPI</span>
                  </span>
                </label>
              )}
              {format === "png" && (
                <label class="ws-check">
                  <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.currentTarget.checked)} /> {t("Transparent background")}
                </label>
              )}
              {format === "jpg" && (
                <label>
                  <span>
                    {t("Quality")} <b>{quality}</b>
                  </span>
                  <input type="range" min={50} max={100} value={quality} onInput={(e) => setQuality(Number(e.currentTarget.value))} />
                </label>
              )}
              <label class="ws-check">
                <input type="checkbox" checked={images} onChange={(e) => setImages(e.currentTarget.checked)} /> {t("Include pictures")}
              </label>
              <p class="ws-hint">{t("The resolution is saved in the file, so other programs open it at the right size in mm.")}</p>
            </>
          )}
          {format !== "pdf" && (
            <label class="ws-check">
              <input type="checkbox" checked={bedPos} onChange={(e) => setBedPos(e.currentTarget.checked)} /> {t("Keep the position on the bed (page = bed)")}
            </label>
          )}
          <label class="ws-check">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.currentTarget.checked)} /> {t("Include hidden layers")}
          </label>
        </div>
      </div>
      <div class="ws-row ws-dialog-actions">
        <button type="button" onClick={close}>
          {t("Cancel")}
        </button>
        <button type="button" class="ws-primary-btn" disabled={empty || busy || tooBig} onClick={() => void go()}>
          {busy ? t("Exporting…") : t("Export")}
        </button>
      </div>
    </dialog>
  );
}
