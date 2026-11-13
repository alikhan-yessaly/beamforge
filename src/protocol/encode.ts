import { encodeInt14, encodeInt35 } from "./numbers";

// All functions return UNSWIZZLED bytes.

// 14-bit addresses sent as two 7-bit bytes: 0x200 -> 04 00, 0x2FE -> 05 7E.
export const ADDR_MACHINE_STATUS = 0x200;
export const ADDR_CARD_ID = 0x2fe;
// UNVERIFIED: EduTech lists "DA 00 04 21" / "DA 00 04 31" as current X / Y position (micrometers).
// As 14-bit addresses these are 0x221 / 0x231 (wire bytes 04 21 / 04 31).
export const ADDR_POSITION_X = 0x221;
export const ADDR_POSITION_Y = 0x231;
/** Configured X/Y travel (bed size) in um. VERIFIED: 1,300,000 / 900,000 on a 1300x900 machine. */
export const ADDR_BED_X = 0x026;
export const ADDR_BED_Y = 0x036;
/** Machine status: 0 when idle; bit 0x01000000 set while moving (VERIFIED: 0x1020000 during rapid moves). */
export const STATUS_MOVING = 0x01000000;

/** 14-bit address from its two 7-bit wire bytes: (04, 21) -> 0x221. */
export const addrFromBytes = (hi: number, lo: number) => ((hi & 0x7f) << 7) | (lo & 0x7f);
/** Two 7-bit wire bytes of a 14-bit address, as "04 21". */
export const addrToHex = (addr: number) =>
  [(addr >> 7) & 0x7f, addr & 0x7f].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");

/** Read-only memory query (DA 00 hi lo). */
export function readMemory(addr: number): Uint8Array {
  return Uint8Array.of(0xda, 0x00, (addr >> 7) & 0x7f, addr & 0x7f);
}

export const queryCardId = () => readMemory(ADDR_CARD_ID);
export const queryStatus = () => readMemory(ADDR_MACHINE_STATUS);

export const startJob = () => Uint8Array.of(0xd8, 0x00);
export const stopJob = () => Uint8Array.of(0xd8, 0x01);

// ---------- Stored files (LightBurn "Send", traced 2026-11-12; docs/PROTOCOL.md "Saving a job on the controller") ----------

/** Number of jobs stored in the controller's memory (04 05). */
export const ADDR_FILE_COUNT = 0x205;
/** File names: printable ASCII, as LightBurn offers them (upper case). The controller's own limits are unknown. */
export const FILE_NAME_MAX = 16;
const FILE_NAME_RE = /^[A-Z0-9 _.-]+$/;

/** Normalise a name the way LightBurn does (upper case, trimmed); null if it can't be stored. */
export function normalizeFileName(name: string): string | null {
  const n = name.trim().toUpperCase();
  return n.length > 0 && n.length <= FILE_NAME_MAX && FILE_NAME_RE.test(n) ? n : null;
}

/** E8 01 <index>: ask for the name of stored file `index` (1-based, 14-bit). */
export const readFileName = (index: number) => Uint8Array.of(0xe8, 0x01, (index >> 7) & 0x7f, index & 0x7f);

/** Parse an E8 01 <index> <name> 00 reply. */
export function parseFileNameReply(c: Uint8Array): { index: number; name: string } | null {
  if (c[0] !== 0xe8 || c[1] !== 0x01 || c.length < 5 || c.at(-1) !== 0x00) return null;
  return { index: (c[2]! << 7) | c[3]!, name: String.fromCharCode(...c.subarray(4, c.length - 1)) };
}

/** E8 02, then E7 01 <name> 00: the job that follows is stored under `name` instead of run. One write, as LightBurn. */
export function storeJobHeader(name: string): Uint8Array {
  const n = normalizeFileName(name);
  if (n === null || n !== name) throw new Error(`Invalid file name: ${JSON.stringify(name)}`);
  return Uint8Array.of(0xe8, 0x02, 0xe7, 0x01, ...Array.from(n, (ch) => ch.charCodeAt(0)), 0x00);
}
export const pauseJob = () => Uint8Array.of(0xd8, 0x02);
export const resumeJob = () => Uint8Array.of(0xd8, 0x03);

export function moveAbs(xUm: number, yUm: number): Uint8Array {
  return Uint8Array.of(0x88, ...encodeInt35(xUm), ...encodeInt35(yUm));
}

/** Largest magnitude a 14-bit signed relative coordinate can hold (micrometers). */
export const REL_MAX_UM = 8191;

export function moveRel(dxUm: number, dyUm: number): Uint8Array {
  for (const v of [dxUm, dyUm]) {
    if (Math.abs(Math.trunc(v)) > REL_MAX_UM) throw new RangeError(`Relative move ${v} um exceeds ±${REL_MAX_UM} um`);
  }
  return Uint8Array.of(0x89, ...encodeInt14(dxUm), ...encodeInt14(dyUm));
}

/**
 * Rapid move XY: D9 10 <options> <x> <y>.
 * VERIFIED on hardware (2026-11-11, docs/PROTOCOL.md): with options 0x02 the coordinates are a
 * RELATIVE offset in um, not a target, and STOP (D8 01) does not interrupt the move.
 * Other option values are untested.
 */
export function rapidMoveXY(options: number, xUm: number, yUm: number): Uint8Array {
  return Uint8Array.of(0xd9, 0x10, options & 0x7f, ...encodeInt35(xUm), ...encodeInt35(yUm));
}

export const RAPID_OPT_RELATIVE = 0x02;

/** Rapid relative move by (dx, dy) um. VERIFIED: +X/+Y move away from the home corner. */
export function rapidMoveRel(dxUm: number, dyUm: number): Uint8Array {
  return rapidMoveXY(RAPID_OPT_RELATIVE, dxUm, dyUm);
}

export const RAPID_OPT_ABSOLUTE = 0x00;

/** Rapid move to an absolute machine position (um). VERIFIED: what LightBurn sends for Move-to, Home and Frame. */
export function rapidMoveAbs(xUm: number, yUm: number): Uint8Array {
  return rapidMoveXY(RAPID_OPT_ABSOLUTE, xUm, yUm);
}

/**
 * Preamble LightBurn sends before every jog/move: speed, then min power 0 on lasers 1 and 2.
 * Captured from LightBurn 2.2.01 over USB (docs/PROTOCOL.md "LightBurn capture").
 */
export function motionPreamble(mmPerS: number): Uint8Array {
  return Uint8Array.of(...setSpeed(mmPerS), 0xc6, 0x01, 0x00, 0x00, 0xc6, 0x21, 0x00, 0x00);
}

/**
 * A frame exactly as LightBurn 2.2.01 sends it (captured, docs/PROTOCOL.md): speed 0 (= the controller's own
 * travel speed) and all powers 0, a rapid to the first corner, then the four sides at `mmPerS`, then speed 0 again
 * and a rapid back to `back`. All D9 10 00 absolute rapids, sent in ONE write and queued by the controller, so the
 * motion is smooth. WARNING: a running D9 10 move cannot be interrupted over USB (verified); software STOP does
 * not halt a frame. Corners in LightBurn's order: min, (min.x, max.y), max, (max.x, min.y), min.
 */
export function frameCommands(min: { x: number; y: number }, max: { x: number; y: number }, mmPerS: number, back: { x: number; y: number }): Uint8Array {
  const zeroPower = [0xc6, 0x01, 0, 0, 0xc6, 0x02, 0, 0, 0xc6, 0x21, 0, 0, 0xc6, 0x22, 0, 0];
  const corners = [min, { x: min.x, y: max.y }, max, { x: max.x, y: min.y }, min];
  return Uint8Array.of(
    ...setSpeed(0),
    ...zeroPower,
    ...rapidMoveAbs(min.x, min.y),
    ...setSpeed(mmPerS),
    ...corners.slice(1).flatMap((c) => [...rapidMoveAbs(c.x, c.y)]),
    ...setSpeed(0),
    ...rapidMoveAbs(back.x, back.y),
  );
}

/**
 * Keypad emulation, as LightBurn's Continuous Jog sends it: D9 D8 2k (key down), D9 D8 3k (key up).
 * Keys are screen arrows: 0 = left, 1 = right, 2 = up, 3 = down. VERIFIED: motion runs at the last C9 02 speed
 * while the key is down and stops immediately (0 mm coast) on key up. A key-up does NOT stop a D9 10 move.
 */
export const JOG_KEY = { left: 0, right: 1, up: 2, down: 3 } as const;
export type JogKey = (typeof JOG_KEY)[keyof typeof JOG_KEY];
export const jogKeyDown = (k: JogKey) => Uint8Array.of(0xd9, 0xd8, 0x20 + k);
export const jogKeyUp = (k: JogKey) => Uint8Array.of(0xd9, 0xd8, 0x30 + k);

/** Laser-1 speed: C9 02 <speed in um/s as Abscoord>. Used inside .rd jobs; UNVERIFIED as a standalone USB command. */
export function setSpeed(mmPerS: number): Uint8Array {
  return Uint8Array.of(0xc9, 0x02, ...encodeInt35(Math.round(mmPerS * 1000)));
}

/** True if the unswizzled stream contains a DA 01 (memory write) outside the allowed address range. */
export function hasForbiddenParamWrite(commands: Uint8Array[]): boolean {
  return commands.some((c) => c[0] === 0xda && c[1] === 0x01 && !isDocumentTimeAddr(c[2] ?? 0, c[3] ?? 0));
}

// Addresses written by RDWorks/LightBurn job trailers (docs/PROTOCOL.md): 06 20 and the document-time range.
function isDocumentTimeAddr(hi: number, lo: number): boolean {
  return (hi === 0x06 && lo === 0x20) || (hi === 0x07 && lo >= 0x10 && lo <= 0x74);
}
