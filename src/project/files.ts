// Reading and writing project files. Uses the File System Access API where the browser has it (Chrome, Edge):
// Save writes back to the same file and recent files can be reopened. Elsewhere (Safari, Firefox, embedded
// previews) Open uses a file input and Save downloads a copy.
import { PROJECT_EXT } from "./format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handle = FileSystemFileHandle;

const picker = typeof window !== "undefined" && "showOpenFilePicker" in window && "showSaveFilePicker" in window;
export const canSaveInPlace = picker;

const TYPES = [{ description: "Laser project", accept: { "application/json": [PROJECT_EXT] } }];

export interface OpenedFile {
  name: string;
  text: string;
  handle: Handle | null;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Ask for a project file. Resolves null if the user cancels. */
export async function pickProjectFile(): Promise<OpenedFile | null> {
  if (picker) {
    try {
      const [handle] = (await (window as any).showOpenFilePicker({ types: TYPES, multiple: false })) as Handle[];
      const file = await handle!.getFile();
      return { name: file.name, text: await file.text(), handle: handle! };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: PROJECT_EXT });
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { name: file.name, text: await file.text(), handle: null } : null);
    };
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Read a file again from a handle (recent files), asking for permission if needed. */
export async function readHandle(handle: Handle): Promise<OpenedFile> {
  const h = handle as any;
  if ((await h.queryPermission?.({ mode: "readwrite" })) !== "granted" && (await h.requestPermission?.({ mode: "readwrite" })) !== "granted") {
    throw new Error("Permission to open the file was refused");
  }
  const file = await handle.getFile();
  return { name: file.name, text: await file.text(), handle };
}

/** Write to an existing handle (Save). */
export async function writeHandle(handle: Handle, text: string): Promise<void> {
  const h = handle as any;
  if ((await h.queryPermission?.({ mode: "readwrite" })) !== "granted" && (await h.requestPermission?.({ mode: "readwrite" })) !== "granted") {
    throw new Error("Permission to save the file was refused");
  }
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

/** Save As: pick a new file (or download a copy where that isn't possible). Resolves null if cancelled. */
export async function saveAsFile(suggestedName: string, text: string): Promise<{ name: string; handle: Handle | null } | null> {
  const name = suggestedName.endsWith(PROJECT_EXT) ? suggestedName : `${suggestedName}${PROJECT_EXT}`;
  if (picker) {
    try {
      const handle = (await (window as any).showSaveFilePicker({ suggestedName: name, types: TYPES })) as Handle;
      await writeHandle(handle, text);
      return { name: handle.name, handle };
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { name, handle: null };
}

// ---------- Recent files: handles kept in IndexedDB (they can't go in localStorage) ----------

export interface RecentFile {
  name: string;
  openedAt: number;
  handle: Handle;
}

const DB = "ruida-web";
const STORE = "recent-projects";
const MAX_RECENT = 8;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadRecent(): Promise<RecentFile[]> {
  if (!picker || typeof indexedDB === "undefined") return [];
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction(STORE).objectStore(STORE).get("list");
      req.onsuccess = () => resolve((req.result as RecentFile[] | undefined) ?? []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function rememberRecent(name: string, handle: Handle): Promise<RecentFile[]> {
  const list = await loadRecent();
  const others: RecentFile[] = [];
  for (const r of list) if (!(await r.handle.isSameEntry(handle))) others.push(r);
  const next = [{ name, handle, openedAt: Date.now() }, ...others].slice(0, MAX_RECENT);
  try {
    const d = await db();
    d.transaction(STORE, "readwrite").objectStore(STORE).put(next, "list");
  } catch {
    /* recent files are a convenience */
  }
  return next;
}

/** Remember which file the open project belongs to, so Save keeps working after a reload. */
export async function storeCurrentHandle(handle: Handle | null): Promise<void> {
  if (!picker || typeof indexedDB === "undefined") return;
  try {
    const d = await db();
    const store = d.transaction(STORE, "readwrite").objectStore(STORE);
    if (handle) store.put(handle, "current");
    else store.delete("current");
  } catch {
    /* convenience only */
  }
}

export async function loadCurrentHandle(): Promise<Handle | null> {
  if (!picker || typeof indexedDB === "undefined") return null;
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction(STORE).objectStore(STORE).get("current");
      req.onsuccess = () => resolve((req.result as Handle | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
