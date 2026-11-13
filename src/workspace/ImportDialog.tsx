// The import dialog: vector files (SVG, PDF/AI, HPGL) choose how colours become layers and how filled shapes
// are used; pictures (PNG, JPEG, HEIC, CDR previews, …) choose how they are traced, with a live preview, and
// whether the picture itself is kept on the canvas.
import { msg, t, tp } from "../i18n";
import { signal } from "@preact/signals";
import { Image as ImageIcon, TriangleAlert } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type ColorChoice, type FillsAs, buildObject, conflicts, defaultChoices, keptSize } from "../import/build";
import type { PdfDoc } from "../import/pdf";
import { type DecodedImage, keepableUrl, pixels } from "../import/raster";
import { DEFAULT_TRACE, type TraceResult, type TraceSettings } from "../import/trace/pipeline";
import type { Rgba, VectorImport } from "../import/types";
import { PALETTE } from "../job/layers";
import { type Doc, type MachineProfile, type SceneObject, newId } from "../scene/model";
import { translate } from "../geom/geom";
import { doc, profile } from "../scene/store";

/** What the dialog hands back: objects to add (pictures first, so traces draw on top) and colours to make fill layers. */
export interface ImportOutcome {
  objects: SceneObject[];
  fillLayers: string[];
  warnings: string[];
}

type Request =
  | { kind: "vector"; name: string; vi: VectorImport; pdf?: PdfDoc; resolve: (r: ImportOutcome | null) => void }
  | { kind: "raster"; name: string; img: DecodedImage; note?: string; resolve: (r: ImportOutcome | null) => void };

const request = signal<Request | null>(null);

export function askVectorImport(name: string, vi: VectorImport, pdf?: PdfDoc): Promise<ImportOutcome | null> {
  return new Promise((resolve) => (request.value = { kind: "vector", name, vi, pdf, resolve }));
}
export function askRasterImport(name: string, img: DecodedImage, note?: string): Promise<ImportOutcome | null> {
  return new Promise((resolve) => (request.value = { kind: "raster", name, img, note, resolve }));
}

const FILLS: { v: FillsAs; label: string }[] = [
  { v: "engrave", label: msg("Engrave them (fill layers)") },
  { v: "outline", label: msg("Cut their outlines") },
  { v: "ignore", label: msg("Leave them out") },
];

export function ImportDialog() {
  const r = request.value;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (r) ref.current?.showModal();
  }, [r]);
  if (!r) return null;
  const finish = (out: ImportOutcome | null) => {
    ref.current?.close();
    request.value = null;
    r.resolve(out);
  };
  return (
    <dialog
      ref={ref}
      class="ws-dialog ws-import-dialog"
      onCancel={(e) => {
        e.preventDefault();
        finish(null);
      }}
    >
      {r.kind === "vector" ? <VectorBody key={r.name} req={r} finish={finish} /> : <RasterBody key={r.name} req={r} finish={finish} />}
    </dialog>
  );
}

// ---------- Shared pieces ----------

function ColorTable({ choices, onChange, clash }: { choices: ColorChoice[]; onChange: (key: string, target: string | null) => void; clash: Set<string> }) {
  if (!choices.length) return null;
  return (
    <table class="ws-import-colors">
      <thead>
        <tr>
          <th>{t("In the file")}</th>
          <th>{t("Paths")}</th>
          <th>{t("Layer colour")}</th>
        </tr>
      </thead>
      <tbody>
        {choices.map((c) => (
          <tr key={c.key}>
            <td>
              <i class="ws-swatch" style={{ background: c.source }} /> {c.kind === "stroke" ? t("outline") : t("fill")} <code>{c.source}</code>
            </td>
            <td>{c.count}</td>
            <td>
              <i class="ws-swatch" style={{ background: c.target ?? "transparent", opacity: c.target ? 1 : 0.3 }} />
              <select
                value={c.target ?? ""}
                aria-label={t("Layer colour for {color}", { color: c.source })}
                onChange={(e) => onChange(c.key, e.currentTarget.value || null)}
              >
                <option value="">{t("Skip")}</option>
                {PALETTE.map((p, i) => (
                  <option key={p} value={p} style={{ color: p }}>
                    ■ {String(i + 1).padStart(2, "0")} {p}
                  </option>
                ))}
              </select>
              {c.target && clash.has(c.target) && c.kind === "fill" && (
                <small class="ws-hint" title={t("This colour also cuts, so these filled shapes will be cut as outlines.")}> ⚠</small>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Warnings({ list }: { list: string[] }) {
  return (
    <>
      {list.map((w) => (
        <p key={w} class="ws-plan-msg">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> {t(w)}
        </p>
      ))}
    </>
  );
}

/** Draw paths (mm) into a canvas, fitted, in their chosen layer colours. */
function drawPreview(c: HTMLCanvasElement | null, vi: VectorImport | null, target: (key: string) => string | null, fills: FillsAs, under?: { img: ImageBitmap; w: number; h: number } | null) {
  if (!c) return;
  if (!c.clientWidth) {
    // The dialog isn't laid out yet on first render: draw on the next frame.
    requestAnimationFrame(() => c.isConnected && c.clientWidth && drawPreview(c, vi, target, fills, under));
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  const size = under ? { w: under.w, h: under.h } : vi ? (vi.pageMm && vi.paths.length === 0 ? vi.pageMm : keptSize(vi)) : { w: 1, h: 1 };
  let minX = 0, minY = 0;
  if (vi && !under) {
    minX = Infinity;
    minY = Infinity;
    for (const p of vi.paths) for (const q of p.points) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
    }
    if (!Number.isFinite(minX)) minX = minY = 0;
  }
  const k = Math.min((W - 16) / Math.max(size.w, 1e-6), (H - 16) / Math.max(size.h, 1e-6));
  const ox = (W - size.w * k) / 2, oy = (H - size.h * k) / 2;
  if (under) {
    ctx.globalAlpha = 0.35;
    ctx.drawImage(under.img, ox, oy, size.w * k, size.h * k);
    ctx.globalAlpha = 1;
  }
  if (!vi) return;
  for (const p of vi.paths) {
    if (p.points.length < 2) continue;
    ctx.beginPath();
    p.points.forEach((q, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ox + (q.x - minX) * k, oy + (q.y - minY) * k));
    if (p.closed) ctx.closePath();
    const f = p.fill && p.closed && fills === "engrave" ? target(`f:${p.fill}`) : null;
    if (f) {
      ctx.fillStyle = f;
      ctx.globalAlpha = 0.35;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
    }
    const s = p.stroke ? target(`s:${p.stroke}`) : p.fill && fills !== "ignore" ? target(`f:${p.fill}`) : null;
    ctx.strokeStyle = s ?? "#cbd5e1";
    ctx.lineWidth = s ? 1 : 0.5;
    ctx.stroke();
  }
}

// ---------- Vector files ----------

function VectorBody({ req, finish }: { req: Extract<Request, { kind: "vector" }>; finish: (o: ImportOutcome | null) => void }) {
  const [vi, setVi] = useState(req.vi);
  const [page, setPage] = useState(1);
  const [fills, setFills] = useState<FillsAs>("engrave");
  const [scalePct, setScalePct] = useState(100);
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const canvas = useRef<HTMLCanvasElement>(null);
  const d = doc.value;
  const choices = useMemo(() => defaultChoices(vi, d).map((c) => (c.key in overrides ? { ...c, target: overrides[c.key]! } : c)), [vi, overrides]);
  const target = (key: string) => choices.find((c) => c.key === key)?.target ?? null;
  const clash = conflicts(choices, fills, d);
  const size = keptSize(vi);
  useEffect(() => drawPreview(canvas.current, vi, target, fills), [vi, choices, fills]);
  const pick = async (n: number) => {
    if (!req.pdf) return;
    setPage(n);
    setVi(await req.pdf.read(n));
  };
  const accept = () => {
    const b = buildObject(vi, choices, { fills, scale: scalePct / 100, name: req.name }, profile.value, d);
    finish({ objects: b.object ? [b.object] : [], fillLayers: b.fillLayers, warnings: b.object ? [] : b.warnings });
  };
  return (
    <>
      <h3>{t("Import {file}", { file: req.name })}</h3>
      <canvas ref={canvas} class="ws-import-preview" />
      <div class="ws-import-opts">
        {req.pdf && req.pdf.pages > 1 && (
          <label>
            <span>{t("Page")}</span>
            <select value={page} onChange={(e) => void pick(Number(e.currentTarget.value))}>
              {Array.from({ length: req.pdf.pages }, (_, i) => (
                <option key={i} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>{t("Scale")}</span>
          <span class="ws-row">
            <input type="number" min={1} max={10000} step={1} value={scalePct} onChange={(e) => setScalePct(Math.max(1, Number(e.currentTarget.value) || 100))} /> %
            <small>
              {t("{w} × {h} mm", { w: ((size.w * scalePct) / 100).toFixed(1), h: ((size.h * scalePct) / 100).toFixed(1) })}
            </small>
          </span>
        </label>
        <label>
          <span>{t("Filled shapes")}</span>
          <select value={fills} onChange={(e) => setFills(e.currentTarget.value as FillsAs)}>
            {FILLS.map((f) => (
              <option key={f.v} value={f.v}>
                {t(f.label)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ColorTable choices={choices} clash={clash} onChange={(key, v) => setOverrides({ ...overrides, [key]: v })} />
      <p class="ws-hint">{t("Each colour snaps to the nearest layer colour. Change it, or skip it, before importing.")}</p>
      <Warnings list={vi.warnings} />
      <div class="ws-row ws-dialog-actions">
        <button type="button" onClick={() => finish(null)}>
          {t("Cancel")}
        </button>
        <button type="button" class="ws-primary-btn" disabled={!vi.paths.length} onClick={accept}>
          {t("Import")}
        </button>
      </div>
    </>
  );
}

// ---------- Pictures ----------

const DETAIL = [600, 1000, 1600, 2400];

let worker: Worker | null = null;
let jobId = 0;
function traceInWorker(img: Rgba, settings: TraceSettings): Promise<TraceResult> {
  worker ??= new Worker(new URL("../import/trace/worker.ts", import.meta.url), { type: "module" });
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    const w = worker!;
    const on = (e: MessageEvent<{ id: number; result?: TraceResult; error?: string }>) => {
      if (e.data.id !== id) return;
      w.removeEventListener("message", on);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result!);
    };
    w.addEventListener("message", on);
    w.postMessage({ id, img, settings });
  });
}

/** Default printed width: the file's DPI if it has one, else 100 mm; never wider than 80 % of the bed. */
function defaultWidth(img: DecodedImage, p: MachineProfile): number {
  const w = img.dpi ? (img.width / img.dpi) * 25.4 : 100;
  const fit = Math.min((p.bedW * 0.8) / w, (p.bedH * 0.8) / ((w * img.height) / img.width), 1);
  return Math.round(w * fit * 10) / 10;
}

function RasterBody({ req, finish }: { req: Extract<Request, { kind: "raster" }>; finish: (o: ImportOutcome | null) => void }) {
  const img = req.img;
  const [s, setS] = useState({ ...DEFAULT_TRACE });
  const [detail, setDetail] = useState(1000);
  const [widthMm, setWidthMm] = useState(() => defaultWidth(img, profile.value));
  const [doTrace, setDoTrace] = useState(true);
  const [keep, setKeep] = useState(true);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const canvas = useRef<HTMLCanvasElement>(null);
  const rgba = useMemo(() => pixels(img, detail), [img, detail]);
  const heightMm = (widthMm * img.height) / img.width;
  const set = (patch: Partial<typeof s>) => setS({ ...s, ...patch });

  useEffect(() => {
    if (!doTrace) return;
    setBusy(true);
    let live = true;
    const timer = setTimeout(() => {
      traceInWorker(rgba, { ...s, mmPerPx: widthMm / rgba.width })
        .then((r) => live && (setResult(r), setError(null)))
        .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => live && setBusy(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [rgba, s, widthMm, doTrace]);

  const d = doc.value;
  const vi = doTrace ? result : null;
  const choices = useMemo(() => (vi ? defaultChoices(vi, d).map((c) => (c.key in overrides ? { ...c, target: overrides[c.key]! } : c)) : []), [vi, overrides]);
  const target = (key: string) => choices.find((c) => c.key === key)?.target ?? null;
  const fills: FillsAs = "engrave";
  useEffect(() => drawPreview(canvas.current, vi, target, fills, { img: img.bitmap, w: widthMm, h: heightMm }), [vi, choices, widthMm]);

  const accept = async () => {
    const p = profile.value;
    const at = translate((p.bedW - widthMm) / 2, (p.bedH - heightMm) / 2);
    const objects: SceneObject[] = [];
    if (keep) objects.push({ id: newId(), name: t("{name} (picture)", { name: req.name }), paths: [], image: { src: await keepableUrl(img), w: widthMm, h: heightMm }, mat: at });
    let fillLayers: string[] = [];
    if (vi) {
      // Trace coordinates are already in the picture's frame (mm from its top-left): place them over the picture.
      const framed: VectorImport = { ...vi, paths: [...vi.paths] };
      const b = buildObject(framed, choices, { fills, name: req.name }, p, d);
      if (b.object) {
        const minX = Math.min(...vi.paths.flatMap((q) => q.points.map((v) => v.x)));
        const minY = Math.min(...vi.paths.flatMap((q) => q.points.map((v) => v.y)));
        objects.push({ ...b.object, mat: translate(at[4] + minX, at[5] + minY) });
        fillLayers = b.fillLayers;
      }
    }
    finish({ objects, fillLayers, warnings: [] });
  };

  const bw = s.mode === "bw";
  const nothing = !keep && !(doTrace && result?.paths.length);
  return (
    <>
      <h3>{t("Import {file}", { file: req.name })}</h3>
      {req.note && (
        <p class="ws-plan-msg">
          <ImageIcon size={14} strokeWidth={1.75} aria-hidden="true" /> {t(req.note)}
        </p>
      )}
      <div class="ws-import-raster">
        <div>
          <canvas ref={canvas} class="ws-import-preview" />
          <small class="ws-hint">
            {img.width} × {img.height} px · {busy ? t("Tracing…") : vi ? tp(["{n} shape", "{n} shapes"], vi.paths.length) : ""}
            {error ? ` · ${error}` : ""}
          </small>
        </div>
        <div class="ws-import-opts">
          <label class="ws-check">
            <input type="checkbox" checked={doTrace} onChange={(e) => setDoTrace(e.currentTarget.checked)} /> {t("Trace into vector shapes")}
          </label>
          <fieldset disabled={!doTrace}>
            <div class="ws-segmented" role="group" aria-label={t("Trace mode")}>
              <button type="button" class={bw ? "active" : ""} aria-pressed={bw} onClick={() => set({ mode: "bw" })}>
                {t("Black & white")}
              </button>
              <button type="button" class={!bw ? "active" : ""} aria-pressed={!bw} onClick={() => set({ mode: "color" })}>
                {t("Colours")}
              </button>
            </div>
            {bw ? (
              <>
                <label>
                  <span>
                    {t("Threshold")} {s.threshold ?? result?.level ?? ""}
                    <span class="ws-check">
                      <input type="checkbox" checked={s.threshold === null} onChange={(e) => set({ threshold: e.currentTarget.checked ? null : (result?.level ?? 128) })} /> {t("auto")}
                    </span>
                  </span>
                  <input type="range" min={1} max={254} value={s.threshold ?? result?.level ?? 128} onInput={(e) => set({ threshold: Number(e.currentTarget.value) })} />
                </label>
                <Slider label={t("Brightness")} min={-100} max={100} value={s.brightness} on={(v) => set({ brightness: v })} />
                <Slider label={t("Contrast")} min={-100} max={100} value={s.contrast} on={(v) => set({ contrast: v })} />
                <Slider label={t("Blur")} min={0} max={8} value={s.blur} on={(v) => set({ blur: v })} />
                <label class="ws-check">
                  <input type="checkbox" checked={s.invert} onChange={(e) => set({ invert: e.currentTarget.checked })} /> {t("Invert")}
                </label>
              </>
            ) : (
              <>
                <Slider label={t("Colours")} min={2} max={8} value={s.colors} on={(v) => set({ colors: v })} />
                <label class="ws-check">
                  <input type="checkbox" checked={s.ignoreWhite} onChange={(e) => set({ ignoreWhite: e.currentTarget.checked })} /> {t("Leave out the white background")}
                </label>
              </>
            )}
            <Slider label={t("Despeckle")} min={0} max={100} value={s.turdSize} on={(v) => set({ turdSize: v })} />
            <Slider label={t("Smooth corners")} min={0} max={133} value={Math.round(s.smoothness * 100)} on={(v) => set({ smoothness: v / 100 })} />
            <label>
              <span>{t("Detail")}</span>
              <select value={detail} onChange={(e) => setDetail(Number(e.currentTarget.value))}>
                {DETAIL.map((px) => (
                  <option key={px} value={px}>
                    {t("{n} px", { n: px })}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("Traced shapes")}</span>
              <select value={s.result} onChange={(e) => set({ result: e.currentTarget.value as "engrave" | "cut" })}>
                <option value="engrave">{t("Engrave the areas (fill)")}</option>
                <option value="cut">{t("Cut the outlines")}</option>
              </select>
            </label>
          </fieldset>
          <label class="ws-check">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.currentTarget.checked)} /> {t("Keep the picture on the canvas")}
          </label>
          <small class="ws-hint">{t("The picture is a reference: photo engraving isn't supported yet, so it isn't sent to the machine.")}</small>
          <label>
            <span>{t("Width")}</span>
            <span class="ws-row">
              <input type="number" min={1} max={5000} step={0.1} value={widthMm} onChange={(e) => setWidthMm(Math.max(1, Number(e.currentTarget.value) || widthMm))} /> mm
              <small>× {heightMm.toFixed(1)} mm</small>
            </span>
          </label>
        </div>
      </div>
      {doTrace && <ColorTable choices={choices} clash={new Set()} onChange={(key, v) => setOverrides({ ...overrides, [key]: v })} />}
      {doTrace && result && <Warnings list={result.warnings} />}
      <div class="ws-row ws-dialog-actions">
        <button type="button" onClick={() => finish(null)}>
          {t("Cancel")}
        </button>
        <button type="button" class="ws-primary-btn" disabled={nothing || (doTrace && busy)} onClick={() => void accept()}>
          {t("Import")}
        </button>
      </div>
    </>
  );
}

function Slider({ label, min, max, value, on }: { label: string; min: number; max: number; value: number; on: (v: number) => void }) {
  return (
    <label>
      <span>
        {label} <b>{value}</b>
      </span>
      <input type="range" min={min} max={max} value={value} onInput={(e) => on(Number(e.currentTarget.value))} />
    </label>
  );
}

/** Used by tests and the flow: whether an import produced anything. */
export const outcomeEmpty = (o: ImportOutcome) => o.objects.length === 0;
export type { Doc };
