// Jobs stored in the controller's memory: list them and save a job under a name without running it
// (LightBurn's "Send"; traced 2026-11-12, docs/PROTOCOL.md "Saving a job on the controller").
import { t } from "../i18n";
import { chunkCommands } from "../protocol/chunk";
import {
  ADDR_BED_X,
  ADDR_BED_Y,
  ADDR_FILE_COUNT,
  ADDR_MACHINE_STATUS,
  STATUS_MOVING,
  normalizeFileName,
  parseFileNameReply,
  readFileName,
  readMemory,
  storeJobHeader,
} from "../protocol/encode";
import { JOB_CHUNK_BYTES, STATUS_JOB_ACTIVE, inspectJob } from "./jobRunner";
import type { RuidaLink } from "./link";

async function read(link: RuidaLink, addr: number): Promise<number> {
  const r = (await link.query(readMemory(addr), 800, "files")).find((x) => x.addr === addr);
  if (!r) throw new Error(t("No reply reading 0x{addr}", { addr: addr.toString(16) }));
  return r.value;
}

/** Names of the stored jobs, in the controller's order (file 1 first). */
export async function listFiles(link: RuidaLink): Promise<string[]> {
  if (!link.verified) throw new Error(t("Not connected and verified"));
  const n = await read(link, ADDR_FILE_COUNT);
  if (n < 0 || n > 999) throw new Error(t("Unexpected file count {n}", { n }));
  const names: string[] = [];
  for (let i = 1; i <= n; i++) {
    const r = await link.exchange(readFileName(i), (c) => parseFileNameReply(c)?.index === i, 1000, `file ${i}`);
    const parsed = r && parseFileNameReply(r);
    if (!parsed) throw new Error(t("No reply for the name of file {i}", { i }));
    names.push(parsed.name);
  }
  return names;
}

export interface SaveResult {
  name: string;
  /** Stored-file count before and after; `after` is null when the controller didn't answer. */
  before: number;
  after: number | null;
}

/**
 * Store a job on the controller under `name` without running it: E8 02 + E7 01 <name> 00 in one write, then the
 * job stream exactly as for Start, in ~255-byte writes. Refuses a name already in use (how the controller
 * overwrites is not known) and a busy machine. Absolute jobs must fit the bed.
 */
export async function saveJobToController(
  link: RuidaLink,
  commands: Uint8Array[],
  name: string,
  onProgress: (sent: number, total: number) => void = () => {},
  opts: { chunkBytes?: number; settleMs?: number } = {},
): Promise<SaveResult> {
  if (!link.verified) throw new Error(t("Not connected and verified"));
  const n = normalizeFileName(name);
  if (n === null) throw new Error(t("Use 1–16 letters, digits, spaces, dots, dashes or underscores."));
  const bounds = inspectJob(commands);
  const status = await read(link, ADDR_MACHINE_STATUS);
  if (status & (STATUS_JOB_ACTIVE | STATUS_MOVING)) throw new Error(t("Machine is busy (status {status})", { status: `0x${status.toString(16)}` }));
  if (bounds.mode === "absolute") {
    const bed = { x: await read(link, ADDR_BED_X), y: await read(link, ADDR_BED_Y) };
    if (bounds.min.x < 0 || bounds.min.y < 0 || bounds.max.x > bed.x || bounds.max.y > bed.y) throw new Error(t("The job doesn't fit the machine's bed"));
  }
  const existing = await listFiles(link);
  if (existing.includes(n)) throw new Error(t("The controller already has a file named {name}. Pick another name, or delete it on the controller first.", { name: n }));
  const chunks = [storeJobHeader(n), ...chunkCommands(commands, opts.chunkBytes ?? JOB_CHUNK_BYTES)];
  for (let i = 0; i < chunks.length; i++) {
    await link.send(chunks[i]!, i === 0 ? `store as ${n}` : `store ${i}/${chunks.length - 1}`);
    onProgress(i, chunks.length - 1);
  }
  // LightBurn reads the count again ~250 ms after the last write.
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 300));
  let after: number | null = null;
  try {
    after = await read(link, ADDR_FILE_COUNT);
  } catch {
    after = null;
  }
  return { name: n, before: existing.length, after };
}
