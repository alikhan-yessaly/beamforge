// The open project: its name, file handle and what was last saved, so the app knows about unsaved changes.
// Autosave (localStorage, src/scene/store.ts) still keeps the working document across reloads.
import { computed, effect, signal } from "@preact/signals";
import { link } from "../app/connection";
import { outsideBed } from "../scene/ops";
import { type Doc } from "../scene/model";
import { doc, notify, prefs, profile, resetDoc } from "../scene/store";
import { type OpenedFile, type RecentFile, canSaveInPlace, loadCurrentHandle, loadRecent, storeCurrentHandle, pickProjectFile, readHandle, rememberRecent, saveAsFile, writeHandle } from "./files";
import { type ProjectJob, parseProject, projectName, serializeProject } from "./format";

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

const jobNow = (): ProjectJob => ({ startFrom: prefs.value.startFrom, innerFirst: prefs.value.innerFirst });

const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") as { name: string; dirty: boolean } | null;
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
  if (h && projectName(h.name) === project.peek().name && !project.peek().handle) project.value = { ...project.peek(), handle: h };
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
  return s.doc !== doc.value || s.job.startFrom !== j.startFrom || s.job.innerFirst !== j.innerFirst;
});

effect(() => {
  document.title = `${dirty.value ? "• " : ""}${project.value.name} – BeamForge Beta`;
  try {
    localStorage.setItem(KEY, JSON.stringify({ name: project.value.name, dirty: dirty.value }));
  } catch {
    /* best effort */
  }
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ask before throwing away unsaved work. */
function okToDiscard(action: string): boolean {
  return !dirty.value || window.confirm(`"${project.value.name}" has unsaved changes. ${action} anyway and lose them?`);
}

export function newProject(): void {
  if (!okToDiscard("Start a new project")) return;
  resetDoc({ objects: [], layers: [] });
  project.value = { name: "Untitled", handle: null, saved: null };
}

function load(f: OpenedFile): void {
  const p = parseProject(f.text);
  resetDoc(p.doc);
  prefs.value = { ...prefs.value, startFrom: p.job.startFrom, innerFirst: p.job.innerFirst };
  project.value = { name: projectName(f.name), handle: f.handle, saved: { doc: doc.value, job: jobNow() } };
  if (f.handle) void rememberRecent(f.name, f.handle).then((r) => (recentFiles.value = r));
  const notes: string[] = [];
  if (p.machine.profileName && p.machine.profileName !== profile.value.name) notes.push(`it was set up for "${p.machine.profileName}"`);
  if (outsideBed(p.doc, profile.value)) notes.push("part of the drawing is outside this machine's bed");
  notify(`Opened ${projectName(f.name)}${notes.length ? `: ${notes.join("; ")}` : ""}.`, notes.length ? "warn" : "info");
}

export async function openProject(): Promise<void> {
  if (!okToDiscard("Open another project")) return;
  try {
    const f = await pickProjectFile();
    if (f) load(f);
  } catch (e) {
    notify(`Could not open the project: ${errText(e)}`, "error");
  }
}

export async function openRecent(r: RecentFile): Promise<void> {
  if (!okToDiscard("Open another project")) return;
  try {
    load(await readHandle(r.handle));
  } catch (e) {
    notify(`Could not open ${r.name}: ${errText(e)}`, "error");
  }
}

function text(): string {
  const model = link.cardId !== null ? `card 0x${link.cardId.toString(16)}` : null;
  return serializeProject(doc.value, jobNow(), { driver: "ruida", model, profileName: profile.value.name });
}

/** Save to the project's file. Without a file (never saved, or a browser that can't write files) this is Save As. */
export async function saveProject(): Promise<void> {
  const h = project.value.handle;
  if (!h) return saveProjectAs();
  try {
    const saved = { doc: doc.value, job: jobNow() };
    await writeHandle(h, text());
    project.value = { ...project.value, saved };
    notify(`Saved ${project.value.name}.`);
  } catch (e) {
    notify(`Could not save: ${errText(e)}`, "error");
  }
}

export async function saveProjectAs(): Promise<void> {
  try {
    const saved = { doc: doc.value, job: jobNow() };
    const r = await saveAsFile(project.value.name, text());
    if (!r) return;
    project.value = { name: projectName(r.name), handle: r.handle, saved };
    if (r.handle) void rememberRecent(r.name, r.handle).then((list) => (recentFiles.value = list));
    notify(canSaveInPlace ? `Saved as ${r.name}.` : `Downloaded ${r.name}. This browser can't write to files, so each Save As downloads a new copy.`);
  } catch (e) {
    notify(`Could not save: ${errText(e)}`, "error");
  }
}
