import { msg, t, tp } from "../i18n";
import { translate } from "../geom/geom";
import { appMode, enterPrepare } from "./mode";
import { signal } from "@preact/signals";
import type { SceneObject } from "../scene/model";
import { importDxf } from "../scene/importDxf";
import { parseSvg } from "../import/svg";
import { parseHpgl } from "../import/hpgl";
import { looksLikePdf, openPdf } from "../import/pdf";
import { cdrPreview } from "../import/cdr";
import { decodeImage } from "../import/raster";
import { type ImportOutcome, askRasterImport, askVectorImport } from "./ImportDialog";
import { openExport } from "./ExportDialog";
import { NEW_FILL_LAYER, updateLayer } from "../job/layers";
import type { Doc } from "../scene/model";
import {
  centerOnBed,
  duplicateSelected,
  pasteObjects,
  groupSelected,
  mirror,
  removeSelected,
  transformSelected,
  ungroupSelected,
  rotateAbout,
  boxCenter,
  selectionBox,
} from "../scene/ops";
import { commit, doc, notify, prefs, profile, redo, selBox, selection, undo } from "../scene/store";
import { togglePreview } from "./job";
import { isJogKey } from "./keyboardJog";
import { shortcutsOpen } from "./ShortcutSheet";
import { sketchKey } from "./sketch/controller";
import { session as sketchSession } from "./sketch/state";
import { openProject, saveProject, saveProjectAs } from "../project/state";
import { fitBed, fitBox, view } from "./view";
import { assignMode, visibleDocument } from "../job/layers";
import type { LayerMode } from "../scene/model";
import { fillTool, stopFillTool, toggleFillTool } from "./fillTool";

/** File types Import accepts (the file picker's filter). */
export const IMPORT_ACCEPT = ".dxf,.svg,.svgz,.pdf,.ai,.plt,.hpgl,.hgl,.cdr,.png,.jpg,.jpeg,.bmp,.gif,.webp,.avif,.heic,.heif";

const RASTER = /\.(png|jpe?g|bmp|gif|webp|avif|heic|heif)$/i;

/** Add what an import produced: objects (selected afterwards) and the fill layers it needs. */
function addImported(file: string, out: ImportOutcome): void {
  out.warnings.forEach((w) => notify(t("{file}: {message}", { file, message: t(w) }), "warn"));
  if (!out.objects.length) return;
  let next: Doc = { ...doc.value, objects: [...doc.value.objects, ...out.objects] };
  for (const color of out.fillLayers) {
    const stored = (next.layers ?? []).find((l) => l.color === color);
    if (!stored || (stored.mode ?? "cut") === "cut") next = updateLayer(next, color, stored ? { mode: "fill", fill: stored.fill ?? NEW_FILL_LAYER.fill } : NEW_FILL_LAYER);
  }
  commit(next);
  selection.value = new Set(out.objects.map((o) => o.id));
  const paths = out.objects.reduce((n, o) => n + o.paths.length, 0);
  notify(tp(["Imported {file} ({n} path)", "Imported {file} ({n} paths)"], paths, { file }));
}

async function importOne(f: File): Promise<void> {
  const name = f.name.replace(/\.[^.]+$/, "");
  const lower = f.name.toLowerCase();
  if (lower.endsWith(".dxf")) {
    const { object, warnings } = importDxf(await f.text(), name, profile.value);
    addImported(f.name, { objects: object ? [object] : [], fillLayers: [], warnings });
    return;
  }
  if (lower.endsWith(".eps") || lower.endsWith(".ps")) throw new Error(t("EPS/PostScript can't be read in the browser: save the drawing as PDF or SVG and import that."));
  if (lower.endsWith(".svg") || lower.endsWith(".svgz")) {
    let text: string;
    if (lower.endsWith(".svgz")) {
      const stream = f.stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else text = await f.text();
    const out = await askVectorImport(name, parseSvg(text));
    if (out) addImported(f.name, out);
    return;
  }
  if (/\.(plt|hpgl|hgl)$/.test(lower)) {
    const out = await askVectorImport(name, parseHpgl(await f.text()));
    if (out) addImported(f.name, out);
    return;
  }
  if (lower.endsWith(".pdf") || lower.endsWith(".ai")) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!looksLikePdf(bytes)) throw new Error(t("This Illustrator file has no PDF inside: in Illustrator, save it with “Create PDF Compatible File” on, or save as PDF or SVG."));
    const pdf = await openPdf(bytes);
    const out = await askVectorImport(name, await pdf.read(1), pdf);
    if (out) addImported(f.name, out);
    return;
  }
  if (lower.endsWith(".cdr")) {
    const preview = await cdrPreview(new Uint8Array(await f.arrayBuffer()));
    const img = await decodeImage(preview.image, f.name);
    const out = await askRasterImport(name, img, msg("CorelDRAW files are closed: this is the preview picture saved inside the file, traced. For exact vectors, export SVG or PDF from CorelDRAW."));
    if (out) addImported(f.name, out);
    return;
  }
  if (RASTER.test(lower) || f.type.startsWith("image/")) {
    const img = await decodeImage(f, f.name);
    const out = await askRasterImport(name, img);
    if (out) addImported(f.name, out);
    return;
  }
  throw new Error(t("This file type isn't supported. Import DXF, SVG, PDF, AI, PLT/HPGL, CDR, or a picture (PNG, JPEG, HEIC, BMP, GIF, WebP)."));
}

export async function importFiles(files: Iterable<File>): Promise<void> {
  for (const f of files) {
    try {
      await importOne(f);
    } catch (e) {
      notify(t("{file}: {message}", { file: f.name, message: t(e instanceof Error ? e.message : String(e)) }), "error");
    }
  }
}

const sel = () => selection.value;
export const clipboard = signal<readonly SceneObject[]>([]);
let pasteCount = 0;

export const actions = {
  undo,
  redo,
  /** Move the selection to a fill layer (closed shapes) or a cut layer, creating the layer if needed. */
  setMode: (mode: LayerMode) => {
    const r = assignMode(doc.value, sel(), mode);
    if (!r) {
      notify(mode === "cut" ? t("The selection is already on a cut layer.") : t("Nothing to fill: select closed shapes that aren't already on a fill layer."));
      return;
    }
    commit(r.doc);
    const created = mode === "cut" ? t("Moved to a new cut layer ({color}); set its speed and power in Layers.", { color: r.color }) : t("Moved to a new fill layer ({color}); set its speed and power in Layers.", { color: r.color });
    notify(r.created ? created : mode === "cut" ? t("Moved to the cut layer {color}.", { color: r.color }) : t("Moved to the fill layer {color}.", { color: r.color }));
  },
  delete: () => commit(removeSelected(doc.value, sel())),
  copy: () => {
    const objects = doc.value.objects.filter((o) => sel().has(o.id));
    if (!objects.length) return;
    clipboard.value = objects;
    pasteCount = 0;
    notify(tp(["Copied {n} object within this workspace.", "Copied {n} objects within this workspace."], objects.length));
  },
  cut: () => {
    if (!sel().size) return;
    actions.copy();
    commit(removeSelected(doc.value, sel()));
  },
  paste: () => {
    if (!clipboard.value.length) return;
    const offset = ++pasteCount * 5;
    const r = pasteObjects(doc.value, clipboard.value, offset, offset);
    commit(r.doc);
    selection.value = r.ids;
  },
  duplicate: () => {
    const r = duplicateSelected(doc.value, sel());
    commit(r.doc);
    selection.value = r.ids;
  },
  group: () => {
    const r = groupSelected(doc.value, sel());
    commit(r.doc);
    selection.value = r.ids;
  },
  ungroup: () => {
    const r = ungroupSelected(doc.value, sel());
    commit(r.doc);
    selection.value = r.ids;
  },
  selectAll: () => (selection.value = new Set(visibleDocument(doc.value).objects.map((o) => o.id))),
  deselect: () => (selection.value = new Set()),
  nudge: (dx: number, dy: number) => commit(transformSelected(doc.value, sel(), translate(dx, dy))),
  rotate: (deg: number) => {
    const b = selBox.value;
    if (b) commit(transformSelected(doc.value, sel(), rotateAbout(boxCenter(b), deg)));
  },
  mirror: (axis: "h" | "v") => commit(mirror(doc.value, sel(), axis)),
  centerOnBed: () => commit(centerOnBed(doc.value, sel(), profile.value)),
  zoomBed: () => fitBed(profile.value),
  /** Zoom to the selection, or to the whole drawing when nothing is selected. */
  zoomSelection: () => {
    const b = selBox.value ?? selectionBox(doc.value, new Set(doc.value.objects.map((o) => o.id)));
    if (b) view.value = fitBox(b);
  },
};

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function handleKey(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey;
  // Project shortcuts work even while a field has focus.
  if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e" && !sketchSession.value) {
    e.preventDefault();
    if (doc.value.objects.length) openExport();
    return;
  }
  if (mod && !e.altKey && (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "o")) {
    e.preventDefault();
    if (e.key.toLowerCase() === "o") {
      // Opening replaces the design: leave the read-only Device view first (refused while the machine works).
      if (appMode.value === "device") enterPrepare();
      if (appMode.value === "prepare") void openProject();
    }
    else void (e.shiftKey ? saveProjectAs() : saveProject());
    return;
  }
  if (isJogKey(e)) return; // keyboard jog (keyboardJog.ts)
  if (isTyping(e.target)) return;
  // The Device view is read-only: only the view shortcuts.
  if (appMode.value === "device") {
    const k = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey || e.altKey;
    if (e.key === "?") shortcutsOpen.value = true;
    else if (!mod && k === "b") actions.zoomBed();
    else if (!mod && k === "f") actions.zoomSelection();
    else if (!mod && k === "p") togglePreview();
    else return;
    e.preventDefault();
    return;
  }
  // Sketch mode owns the keyboard (its own undo/redo, tools, delete).
  if (sketchSession.value) {
    if (sketchKey(e)) e.preventDefault();
    else if (e.key === "?") shortcutsOpen.value = true;
    return;
  }
  const k = e.key.toLowerCase();
  const step = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
  let handled = true;
  if (mod && k === "z" && !e.shiftKey) actions.undo();
  else if (mod && ((k === "z" && e.shiftKey) || k === "y")) actions.redo();
  else if (mod && k === "d") actions.duplicate();
  else if (mod && k === "c") actions.copy();
  else if (mod && k === "x") actions.cut();
  else if (mod && k === "v") actions.paste();
  else if (mod && k === "a") actions.selectAll();
  else if (mod && k === "g" && e.shiftKey) actions.ungroup();
  else if (mod && k === "g") actions.group();
  else if (k === "delete" || k === "backspace") actions.delete();
  else if (k === "escape") {
    if (fillTool.value) stopFillTool();
    else actions.deselect();
  } else if (!mod && k === "i") toggleFillTool();
  else if (k === "arrowleft") actions.nudge(-step, 0);
  else if (k === "arrowright") actions.nudge(step, 0);
  else if (k === "arrowup") actions.nudge(0, -step);
  else if (k === "arrowdown") actions.nudge(0, step);
  else if (!mod && k === "f") actions.zoomSelection();
  else if (!mod && k === "b") actions.zoomBed();
  else if (!mod && k === "p") togglePreview();
  else if (e.key === "?") shortcutsOpen.value = true;
  else handled = false;
  if (handled) e.preventDefault();
}
