// Export the drawing (the selection or everything) as SVG, DXF, PDF or PNG, in bed millimetres.
import { t } from "../i18n";
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Box, apply, emptyBox, addPoint, isEmptyBox } from "../geom/geom";
import { writeDxf } from "../export/dxf";
import { writePdf } from "../export/pdf";
import { writeSvg } from "../export/svg";
import type { ExportPath } from "../import/types";
import { activeLayers } from "../job/layers";
import { project } from "../project/state";
import type { Doc, SceneObject } from "../scene/model";
import { imageFrame } from "../scene/ops";
import { doc, notify, profile, selection } from "../scene/store";

type Format = "svg" | "dxf" | "pdf" | "png";
const FORMATS: { v: Format; label: string }[] = [
  { v: "svg", label: "SVG" },
  { v: "dxf", label: "DXF" },
  { v: "pdf", label: "PDF" },
  { v: "png", label: "PNG" },
];

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

/** Render to PNG at `dpi`: pictures, then engraved areas filled solid, then outlines 0.1 mm (≥ 1 px) wide. */
async function renderPng(paths: ExportPath[], objects: SceneObject[], box: Box, dpi: number, opts: { transparent: boolean; images: boolean }): Promise<Blob> {
  const k = dpi / 25.4;
  const w = Math.max(1, Math.ceil((box.maxX - box.minX) * k)), h = Math.max(1, Math.ceil((box.maxY - box.minY) * k));
  if (w * h > 120e6) throw new Error(t("The PNG would be {w} × {h} px, too large: lower the resolution.", { w, h }));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  if (!opts.transparent) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.setTransform(k, 0, 0, k, -box.minX * k, -box.minY * k);
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
  const fills = new Map<string, ExportPath[]>();
  for (const p of paths) {
    const f = p.fillLayer && p.closed ? p.color : p.fill && p.closed ? p.fill : null;
    if (f) fills.set(f, [...(fills.get(f) ?? []), p]);
  }
  for (const [color, list] of fills) {
    ctx.beginPath();
    list.forEach(ring);
    ctx.fillStyle = color;
    ctx.fill("evenodd");
  }
  ctx.lineWidth = Math.max(0.1, 1 / k);
  ctx.lineJoin = "round";
  for (const p of paths) {
    if (p.fillLayer) continue;
    ctx.beginPath();
    ring(p);
    ctx.strokeStyle = p.color;
    ctx.stroke();
  }
  return c.convertToBlob({ type: "image/png" });
}

function download(data: Blob, name: string): void {
  const url = URL.createObjectURL(data);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const isOpen = open.value;
  const hasSel = selection.value.size > 0;
  const [format, setFormat] = useState<Format>("svg");
  const [scope, setScope] = useState<"selection" | "all">("all");
  const [bedPos, setBedPos] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dpi, setDpi] = useState(300);
  const [transparent, setTransparent] = useState(false);
  const [images, setImages] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setScope(selection.value.size > 0 ? "selection" : "all");
    ref.current?.showModal();
  }, [isOpen]);
  if (!isOpen) return null;
  const close = () => {
    ref.current?.close();
    open.value = false;
  };
  const d = doc.value;
  const objects = scope === "selection" ? d.objects.filter((o) => selection.value.has(o.id)) : d.objects;
  const paths = exportPaths(d, objects, hidden);
  const withImages = format === "png" && images;
  const box = boxOf(paths, objects, withImages);
  const empty = isEmptyBox(box);
  const base = (scope === "selection" && objects.length === 1 ? objects[0]!.name : project.value.name || "drawing").replace(/[\\/:*?"<>|]+/g, "-");
  const p = profile.value;

  const go = async () => {
    setBusy(true);
    try {
      const page = bedPos ? { w: p.bedW, h: p.bedH } : undefined;
      let blob: Blob;
      if (format === "svg") blob = new Blob([writeSvg(paths, { keepPosition: bedPos, page })], { type: "image/svg+xml" });
      else if (format === "dxf") blob = new Blob([writeDxf(paths, { keepPosition: bedPos })], { type: "application/dxf" });
      else if (format === "pdf") blob = new Blob([new Uint8Array(writePdf(paths, { keepPosition: bedPos, page, title: base }))], { type: "application/pdf" });
      else blob = await renderPng(paths, objects, bedPos ? { minX: 0, minY: 0, maxX: p.bedW, maxY: p.bedH } : box, dpi, { transparent, images: withImages });
      download(blob, `${base}.${format}`);
      notify(t("Exported {file}", { file: `${base}.${format}` }));
      close();
    } catch (e) {
      notify(t("Export: {error}", { error: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

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
        {format === "png" && (
          <>
            <label>
              <span>{t("Resolution")}</span>
              <select value={dpi} onChange={(e) => setDpi(Number(e.currentTarget.value))}>
                {[96, 150, 300, 600, 1000].map((v) => (
                  <option key={v} value={v}>
                    {v} DPI
                  </option>
                ))}
              </select>
            </label>
            <label class="ws-check">
              <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.currentTarget.checked)} /> {t("Transparent background")}
            </label>
            <label class="ws-check">
              <input type="checkbox" checked={images} onChange={(e) => setImages(e.currentTarget.checked)} /> {t("Include pictures")}
            </label>
          </>
        )}
        <label class="ws-check">
          <input type="checkbox" checked={bedPos} onChange={(e) => setBedPos(e.currentTarget.checked)} /> {t("Keep the position on the bed (page = bed)")}
        </label>
        <label class="ws-check">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.currentTarget.checked)} /> {t("Include hidden layers")}
        </label>
      </div>
      <p class="ws-hint">
        {empty
          ? t("Nothing to export.")
          : t("{n} paths · {w} × {h} mm", { n: paths.length, w: (box.maxX - box.minX).toFixed(1), h: (box.maxY - box.minY).toFixed(1) })}
        {format !== "png" && objects.some((o) => o.image) ? ` · ${t("pictures are left out (PNG includes them)")}` : ""}
      </p>
      <div class="ws-row ws-dialog-actions">
        <button type="button" onClick={close}>
          {t("Cancel")}
        </button>
        <button type="button" class="ws-primary-btn" disabled={empty || busy} onClick={() => void go()}>
          {t("Export")}
        </button>
      </div>
    </dialog>
  );
}
