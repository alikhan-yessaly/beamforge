import { t, tp } from "../i18n";
import { translate } from "../geom/geom";
import { appMode } from "./mode";
import { signal } from "@preact/signals";
import type { SceneObject } from "../scene/model";
import { importDxf } from "../scene/importDxf";
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

export async function importFiles(files: Iterable<File>): Promise<void> {
  for (const f of files) {
    if (!/\.dxf$/i.test(f.name)) {
      notify(t("{file}: only .dxf is supported for now", { file: f.name }), "warn");
      continue;
    }
    try {
      const { object, warnings } = importDxf(await f.text(), f.name.replace(/\.dxf$/i, ""), profile.value);
      warnings.forEach((w) => notify(`${f.name}: ${w}`, "warn"));
      if (!object) continue;
      commit({ ...doc.value, objects: [...doc.value.objects, object] });
      selection.value = new Set([object.id]);
      notify(`Imported ${f.name} (${object.paths.length} paths)`);
    } catch (e) {
      notify(`${f.name}: ${e instanceof Error ? e.message : String(e)}`, "error");
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
  zoomSelection: () => {
    const b = selBox.value;
    if (b) view.value = fitBox(b);
  },
};

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function handleKey(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey;
  // Project shortcuts work even while a field has focus.
  if (mod && !e.altKey && (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "o")) {
    e.preventDefault();
    if (e.key.toLowerCase() === "o") void openProject();
    else void (e.shiftKey ? saveProjectAs() : saveProject());
    return;
  }
  if (isJogKey(e)) return; // keyboard jog (keyboardJog.ts)
  if (isTyping(e.target)) return;
  // The Device view is read-only: only the shortcut sheet.
  if (appMode.value === "device") {
    if (e.key === "?") shortcutsOpen.value = true;
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
