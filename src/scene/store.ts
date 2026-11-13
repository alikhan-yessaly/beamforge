import type { JobOrder } from "../job/plan";
import { computed, effect, signal } from "@preact/signals";
import { selectionBox } from "./ops";
import { type Anchor, DEFAULT_PROFILE, type Doc, type MachineProfile } from "./model";
import { migrateDoc, visibleDocument } from "../job/layers";

const DOC_KEY = "ruida-web.doc.v1";
const PROFILE_KEY = "ruida-web.profile.v1";
const PREFS_KEY = "ruida-web.prefs.v1";
const HISTORY_LIMIT = 200;

function load<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? { ...fallback, ...JSON.parse(s) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* quota or private mode: autosave is best-effort */
  }
}

export interface Prefs {
  snapToGrid: boolean;
  gridStep: number;
  anchor: Anchor;
  lockAspect: boolean;
  /** Cut closed shapes that lie inside other shapes first, so parts don't drop before their holes are cut. */
  innerFirst: boolean;
  /** Job placement: where the design sits on the bed, or relative to the head when the job starts. */
  startFrom: "absolute" | "current";
  /** Job order: layer by layer, object by object, or whichever is quicker by the time estimate. */
  jobOrder: JobOrder;
}

export const doc = signal<Doc>(migrateDoc(load<Doc>(DOC_KEY, { objects: [], layers: [] })));
export const profile = signal<MachineProfile>(load(PROFILE_KEY, DEFAULT_PROFILE));
export const prefs = signal<Prefs>(load(PREFS_KEY, { snapToGrid: false, gridStep: 10, anchor: { fx: 0, fy: 0 }, lockAspect: true, innerFirst: true, startFrom: "absolute", jobOrder: "auto" }));
export const selection = signal<ReadonlySet<string>>(new Set());
export const messages = signal<{ id: number; text: string; kind: "info" | "warn" | "error" }[]>([]);
/** Cursor position in internal bed mm, or null when the pointer is outside the canvas. */
export const cursor = signal<{ x: number; y: number } | null>(null);

export const selBox = computed(() => selectionBox(doc.value, selection.value));

const undoStack: Doc[] = [];
const redoStack: Doc[] = [];
export const historyVersion = signal(0);

/** Replace the document as one undoable step. `before` overrides the state recorded for undo (used after live drags). */
export function commit(next: Doc, before: Doc = doc.value): void {
  if (next === before) return;
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  doc.value = next;
  pruneSelection();
  historyVersion.value++;
}

export function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(doc.value);
  doc.value = prev;
  pruneSelection();
  historyVersion.value++;
}

export function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(doc.value);
  doc.value = next;
  pruneSelection();
  historyVersion.value++;
}

export const canUndo = computed(() => (historyVersion.value, undoStack.length > 0));
export const canRedo = computed(() => (historyVersion.value, redoStack.length > 0));

function pruneSelection(): void {
  const ids = new Set(visibleDocument(doc.value).objects.map((o) => o.id));
  const kept = [...selection.value].filter((id) => ids.has(id));
  if (kept.length !== selection.value.size) selection.value = new Set(kept);
}

let msgId = 0;
export function notify(text: string, kind: "info" | "warn" | "error" = "info"): void {
  const id = ++msgId;
  messages.value = [...messages.value, { id, text, kind }];
  setTimeout(() => (messages.value = messages.value.filter((m) => m.id !== id)), kind === "error" ? 8000 : 5000);
}

// Autosave (debounced for the document; live drags write the signal many times per second).
let saveTimer: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  const d = doc.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(DOC_KEY, d), 500);
});
effect(() => save(PROFILE_KEY, profile.value));
effect(() => save(PREFS_KEY, prefs.value));

/** Start over with `next` (New / Open project): clears the selection and the undo history. */
export function resetDoc(next: Doc): void {
  undoStack.length = 0;
  redoStack.length = 0;
  doc.value = next;
  selection.value = new Set();
  historyVersion.value++;
}
