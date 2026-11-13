// The open project: its name, file handle and what was last saved, so the app knows about unsaved changes.
// Autosave (localStorage, src/scene/store.ts) still keeps the working document across reloads.
import { t } from "../i18n";
import { computed, effect, signal } from "@preact/signals";
import { link } from "../app/connection";
import { outsideBed } from "../scene/ops";
import { type Doc } from "../scene/model";
import { doc, notify, prefs, profile, resetDoc } from "../scene/store";
import { type OpenedFile, type RecentFile, canSaveInPlace, loadCurrentHandle, loadRecent, storeCurrentHandle, pickProjectFile, readHandle, rememberRecent, saveAsFile, writeHandle } from "./files";
import { type ProjectJob, compareMaterials, parseProject, projectName, serializeProject } from "./format";
import { presetSettings, presets, savePresets } from "../workspace/materials";
import { updateLayer } from "../job/layers";
import { sampleDoc } from "./sample";

const KEY = "ruida-web.project.v1";

interface Saved {
  doc: Doc;
  job: ProjectJob;
}

interface ProjectState {
  name: string;
  handle: FileSystemFileHandle | null;
  /** What the file holds; null = never saved, or unknown after a reload with unsaved changes. */
  saved: Saved | null;
}

const jobNow = (): ProjectJob => ({ startFrom: prefs.value.startFrom, innerFirst: prefs.value.innerFirst, order: prefs.value.jobOrder });

const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") as { name: string; dirty: boolean; file?: string } | null;
  } catch {
    return null;
  }
})();

export const project = signal<ProjectState>({
  name: stored?.name ?? "Untitled",
  handle: null,
  // After a reload, the autosaved document counts as saved unless it had unsaved changes before.
  saved: stored && !stored.dirty ? { doc: doc.peek(), job: jobNow() } : null,
});

// Re-attach the project's file after a reload (the handle lives in IndexedDB; permission is asked on Save).
// Only after that may the stored handle be overwritten, or startup would erase it before reading it.
const restored = signal(false);
void loadCurrentHandle().then((h) => {
  const same = h && (stored?.file ? h.name === stored.file : projectName(h.name) === project.peek().name);
  if (h && same && !project.peek().handle) project.value = { ...project.peek(), handle: h };
  restored.value = true;
});
effect(() => {
  const h = project.value.handle;
  if (restored.value) void storeCurrentHandle(h);
});

export const recentFiles = signal<RecentFile[]>([]);
void loadRecent().then((r) => (recentFiles.value = r));

export const dirty = computed(() => {
  const s = project.value.saved;
  const empty = doc.value.objects.length === 0;
  if (!s) return !empty;
  const j = jobNow();
  return s.doc !== doc.value || s.job.startFrom !== j.startFrom || s.job.innerFirst !== j.innerFirst || (s.job.order ?? "auto") !== j.order;
});

effect(() => {
  document.title = `${dirty.value ? "• " : ""}${project.value.name} – BeamForge Beta`;
  try {
    localStorage.setItem(KEY, JSON.stringify({ name: project.value.name, dirty: dirty.value, file: project.value.handle?.name }));
  } catch {
    /* best effort */
  }
});

/** Give the project a new name. Save keeps writing to its file; Save As suggests the new name. */
export function renameProject(name: string): void {
  project.value = { ...project.value, name };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ask before throwing away unsaved work. */
function okToDiscard(action: string): boolean {
  return !dirty.value || window.confirm(t("\"{name}\" has unsaved changes. {action} anyway and lose them?", { name: project.value.name, action }));
}

export function newProject(): void {
  if (!okToDiscard(t("Start a new project"))) return;
  resetDoc({ objects: [], layers: [] });
  project.value = { name: "Untitled", handle: null, saved: null };
}

/** Open the built-in sample (a tag to cut, with an engraved star) as a new, unsaved project. */
export function openSample(): boolean {
  if (!okToDiscard(t("Open the sample"))) return false;
  const name = t("Sample tag");
  resetDoc(sampleDoc(profile.value, name));
  project.value = { name, handle: null, saved: null };
  return true;
}

function load(f: OpenedFile): void {
  const p = parseProject(f.text);
  resetDoc(p.doc);
  prefs.value = { ...prefs.value, startFrom: p.job.startFrom, innerFirst: p.job.innerFirst, jobOrder: p.job.order ?? "auto" };
  project.value = { name: projectName(f.name), handle: f.handle, saved: { doc: doc.value, job: jobNow() } };
  if (f.handle) void rememberRecent(f.name, f.handle).then((r) => (recentFiles.value = r));
  reconcileMaterials(p.materials ?? []);
  const notes: string[] = [];
  if (p.machine.profileName && p.machine.profileName !== profile.value.name) notes.push(t("it was set up for \"{machine}\"", { machine: p.machine.profileName }));
  if (outsideBed(p.doc, profile.value)) notes.push(t("part of the drawing is outside this machine's bed"));
  notify(notes.length ? t("Opened {name}: {notes}.", { name: projectName(f.name), notes: notes.join("; ") }) : t("Opened {name}.", { name: projectName(f.name) }), notes.length ? "warn" : "info");
}

/**
 * The file's materials against this browser's library. Different settings: ask whether the layers switch to the
 * local library or keep the file's. Missing: offer to add them to the active machine's library.
 */
function reconcileMaterials(file: Parameters<typeof compareMaterials>[0]): void {
  const { missing, differ } = compareMaterials(file, presets.value);
  if (differ.length && window.confirm(t("This file's settings for {list} differ from this machine's material library. OK: use this machine's library. Cancel: keep the file's settings.", { list: differ.map((d) => d.local.name).join(", ") }))) {
    let d = doc.value;
    for (const { local } of differ) for (const l of d.layers ?? []) if (l.material === local.id) d = updateLayer(d, l.color, presetSettings(local));
    if (d !== doc.value) resetDoc(d);
  }
  if (missing.length && window.confirm(t("Add {n} material presets from this file to the library of \"{machine}\"?", { n: missing.length, machine: profile.value.name }))) {
    const p = profile.value;
    savePresets([...presets.value, ...missing.map((m) => ({ ...m, machine: p.name, machineId: p.id }))]);
  }
}

export async function openProject(): Promise<void> {
  if (!okToDiscard(t("Open another project"))) return;
  try {
    const f = await pickProjectFile();
    if (f) load(f);
  } catch (e) {
    notify(t("Could not open the project: {error}", { error: errText(e) }), "error");
  }
}

/** Open a project file that was dropped or pasted (no file handle: Save asks where). */
export async function openProjectFile(f: File): Promise<void> {
  if (!okToDiscard(t("Open another project"))) return;
  try {
    load({ name: f.name, text: await f.text(), handle: null });
  } catch (e) {
    notify(t("Could not open the project: {error}", { error: errText(e) }), "error");
  }
}

export async function openRecent(r: RecentFile): Promise<void> {
  if (!okToDiscard(t("Open another project"))) return;
  try {
    load(await readHandle(r.handle));
  } catch (e) {
    notify(t("Could not open {file}: {error}", { file: r.name, error: errText(e) }), "error");
  }
}

function text(): string {
  const model = link.cardId !== null ? `card 0x${link.cardId.toString(16)}` : null;
  return serializeProject(doc.value, jobNow(), { driver: "ruida", model, profileName: profile.value.name }, new Date(), presets.value);
}

/** Save to the project's file. Without a file (never saved, or a browser that can't write files) this is Save As. */
export async function saveProject(): Promise<void> {
  const h = project.value.handle;
  if (!h) return saveProjectAs();
  try {
    const saved = { doc: doc.value, job: jobNow() };
    await writeHandle(h, text());
    project.value = { ...project.value, saved };
    notify(t("Saved {name}.", { name: project.value.name }));
  } catch (e) {
    notify(t("Could not save: {error}", { error: errText(e) }), "error");
  }
}

export async function saveProjectAs(): Promise<void> {
  try {
    const saved = { doc: doc.value, job: jobNow() };
    const r = await saveAsFile(project.value.name, text());
    if (!r) return;
    project.value = { name: projectName(r.name), handle: r.handle, saved };
    if (r.handle) void rememberRecent(r.name, r.handle).then((list) => (recentFiles.value = list));
    notify(canSaveInPlace ? t("Saved as {file}.", { file: r.name }) : t("Downloaded {file}. This browser can't write to files, so each Save As downloads a new copy.", { file: r.name }));
  } catch (e) {
    notify(t("Could not save: {error}", { error: errText(e) }), "error");
  }
}
