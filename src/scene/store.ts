import type { Units } from "./units";
import { t } from "../i18n";
import type { JobOrder } from "../job/plan";
import { computed, effect, signal } from "@preact/signals";
import { selectionBox } from "./ops";
import { type Anchor, DEFAULT_PROFILE, type Doc, type MachineProfile, newId } from "./model";
import { migrateDoc, visibleDocument } from "../job/layers";

const DOC_KEY = "ruida-web.doc.v1";
const PROFILE_KEY = "ruida-web.profile.v1";
const MACHINES_KEY = "ruida-web.machines.v1";
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
function save(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    /* quota or private mode: autosave is best-effort */
    return false;
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
  /** Advanced mode: every raw machine and tuning value is shown and editable, plus tuning files. */
  advanced: boolean;
  /** Units for lengths shown and typed in the interface (default mm). Files and the machine always use mm. */
  units?: Units;
}

export const doc = signal<Doc>(migrateDoc(load<Doc>(DOC_KEY, { objects: [], layers: [] })));
// ---------- Machine profiles ----------
// Every machine the browser knows, by id; `profile` is the active one (what planning, jogging and the estimate
// use). Older browsers had a single profile under PROFILE_KEY: it becomes the first entry of the list.

function loadMachines(): { active: string; list: MachineProfile[] } {
  try {
    const raw = localStorage.getItem(MACHINES_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { active?: unknown; list?: unknown };
      const list = Array.isArray(v.list) ? (v.list as MachineProfile[]).filter((p) => p && typeof p.id === "string" && typeof p.name === "string").map((p) => ({ ...DEFAULT_PROFILE, ...p })) : [];
      if (list.length) return { active: list.some((p) => p.id === v.active) ? (v.active as string) : list[0]!.id!, list };
    }
  } catch {
    /* fall through to the single profile */
  }
  const one = { ...load(PROFILE_KEY, DEFAULT_PROFILE) };
  one.id ??= newId();
  return { active: one.id, list: [one] };
}
const initialMachines = loadMachines();

/** All machine profiles. */
export const machines = signal<MachineProfile[]>(initialMachines.list);
/** The active machine profile. Writing it updates its entry in `machines`. */
export const profile = signal<MachineProfile>(initialMachines.list.find((p) => p.id === initialMachines.active)!);

/** Make another profile active. */
export function selectMachine(id: string): void {
  const p = machines.value.find((m) => m.id === id);
  if (p && p.id !== profile.value.id) profile.value = p;
}

/** Add a profile (made active when `activate`). */
export function addMachine(p: MachineProfile, activate = true): MachineProfile {
  const m = { ...p, id: p.id && !machines.value.some((x) => x.id === p.id) ? p.id : newId() };
  machines.value = [...machines.value, m];
  if (activate) profile.value = m;
  return m;
}

/** Replace a stored profile by id (the active one through `profile`). */
export function updateMachine(p: MachineProfile): void {
  if (p.id === profile.value.id) profile.value = p;
  else machines.value = machines.value.map((m) => (m.id === p.id ? p : m));
}

/** Delete a profile; the last one can't be deleted. */
export function removeMachine(id: string): void {
  if (machines.value.length <= 1) return;
  machines.value = machines.value.filter((m) => m.id !== id);
  if (profile.value.id === id) profile.value = machines.value[0]!;
}

/**
 * A question the app needs answered about which machine is connected: pick among several matching profiles, the
 * connected controller doesn't match the active profile, or the machine class of a profile that has none.
 */
export type MachinePrompt =
  | { kind: "choose"; ids: string[]; resolve: (id: string | null) => void }
  | { kind: "mismatch"; resolve: (choice: "keep" | "new" | null) => void }
  | { kind: "class"; id: string; resolve: () => void };
export const machinePrompt = signal<MachinePrompt | null>(null);

/** `tuning.dismissed` entry: the owner chose "Later" for the machine-class question; don't ask on every connect. */
export const CLASS_QUESTION = "class";

/** Don't ask the machine-class question again for this profile (it can still be chosen in the Machine tab). */
export function postponeClassQuestion(id: string): void {
  const m = machines.value.find((x) => x.id === id);
  if (!m || m.class || m.tuning?.dismissed?.includes(CLASS_QUESTION)) return;
  updateMachine({ ...m, tuning: { ...m.tuning, dismissed: [...(m.tuning?.dismissed ?? []), CLASS_QUESTION] } });
}

const sameBed = (c: NonNullable<MachineProfile["controller"]>, w: number, h: number) => Math.abs(c.bedW - w) < 1 && Math.abs(c.bedH - h) < 1;

/**
 * The controller reported its card ID and bed: pick the profile it belongs to (asking when that's unclear), record
 * the controller on it, and ask for the machine class if the profile has none. Resolves when settled.
 */
export async function identifyController(cardId: number, bedW: number, bedH: number): Promise<void> {
  const controller = { cardId, bedW, bedH };
  const matches = machines.value.filter((m) => m.controller && m.controller.cardId === cardId && sameBed(m.controller, bedW, bedH));
  const active = profile.value;
  if (!matches.some((m) => m.id === active.id)) {
    if (matches.length === 1) {
      profile.value = matches[0]!;
      notify(t("Switched to the machine profile \"{name}\": it matches the connected controller.", { name: matches[0]!.name }));
    } else if (matches.length > 1) {
      const id = await new Promise<string | null>((resolve) => (machinePrompt.value = { kind: "choose", ids: matches.map((m) => m.id!), resolve }));
      if (id) selectMachine(id);
    } else if (active.controller) {
      const choice = await new Promise<"keep" | "new" | null>((resolve) => (machinePrompt.value = { kind: "mismatch", resolve }));
      if (choice === "new") addMachine({ ...DEFAULT_PROFILE, name: t("Machine {n}", { n: machines.value.length + 1 }) });
    }
  }
  profile.value = { ...profile.value, controller, bedW, bedH };
  if (!profile.value.class && !profile.value.tuning?.dismissed?.includes(CLASS_QUESTION)) await new Promise<void>((resolve) => (machinePrompt.value = { kind: "class", id: profile.value.id!, resolve }));
}
export const prefs = signal<Prefs>(load(PREFS_KEY, { snapToGrid: false, gridStep: 10, anchor: { fx: 0, fy: 0 }, lockAspect: true, innerFirst: true, startFrom: "absolute", jobOrder: "auto", advanced: false }));
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
let saveWarned = false;
function saveDoc(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (save(DOC_KEY, doc.peek())) saveWarned = false;
  else if (!saveWarned) {
    // Usually the browser's storage is full (big pictures): say so once instead of silently losing work.
    saveWarned = true;
    notify(t("The design is too big to keep in the browser between visits. Save it as a project file."), "warn");
  }
}
effect(() => {
  void doc.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDoc, 500);
});
// Closing the tab within the debounce would lose the last change.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => saveTimer !== undefined && saveDoc());
effect(() => {
  const p = profile.value;
  const list = machines.peek();
  machines.value = list.some((m) => m.id === p.id) ? list.map((m) => (m.id === p.id ? p : m)) : [...list, p];
});
effect(() => void save(MACHINES_KEY, { active: profile.value.id, list: machines.value }));
effect(() => void save(PROFILE_KEY, profile.value));
effect(() => void save(PREFS_KEY, prefs.value));

/** Start over with `next` (New / Open project): clears the selection and the undo history. */
export function resetDoc(next: Doc): void {
  undoStack.length = 0;
  redoStack.length = 0;
  doc.value = next;
  selection.value = new Set();
  historyVersion.value++;
}
