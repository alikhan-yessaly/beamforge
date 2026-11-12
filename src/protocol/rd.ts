import { splitCommands } from "./chunk";
import { hasForbiddenParamWrite } from "./encode";
import { decodeInt35, encodeInt35 } from "./numbers";
import { KNOWN_MAGICS, unswizzle } from "./swizzle";

export interface BoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RdJob {
  magic: number;
  /** Unswizzled commands, in file order. */
  commands: Uint8Array[];
  /** Bounds in micrometers from E7 03 / E7 07, if present. */
  bbox: BoundingBox | null;
  layerCount: number;
  hasForbiddenWrite: boolean;
}

const EOF = 0xd7;

/** Candidate magics under which the stream ends with the End-of-File command, in preference order. */
export function detectRdMagic(raw: Uint8Array): number | null {
  const last = raw[raw.length - 1];
  if (last === undefined) return null;
  return KNOWN_MAGICS.find((m) => unswizzle(Uint8Array.of(last), m)[0] === EOF) ?? null;
}

export function parseRd(raw: Uint8Array, magic?: number): RdJob {
  const m = magic ?? detectRdMagic(raw);
  if (m === null) throw new Error("Cannot detect swizzle magic: no candidate makes the file end with D7");
  const commands = splitCommands(unswizzle(raw, m));
  if (commands.length === 0 || commands[commands.length - 1]![0] !== EOF) {
    throw new Error("File does not end with End-of-File (D7); wrong magic or truncated file");
  }

  let tl: [number, number] | null = null;
  let br: [number, number] | null = null;
  let layerCount = 0;
  for (const c of commands) {
    if (c[0] === 0xe7 && c[1] === 0x03 && c.length >= 12) tl = [decodeInt35(c, 2), decodeInt35(c, 7)];
    if (c[0] === 0xe7 && c[1] === 0x07 && c.length >= 12) br = [decodeInt35(c, 2), decodeInt35(c, 7)];
    if (c[0] === 0xca && c[1] === 0x22) layerCount = Math.max(layerCount, (c[2] ?? 0) + 1);
  }

  return {
    magic: m,
    commands,
    bbox: tl && br ? { x0: tl[0], y0: tl[1], x1: br[0], y1: br[1] } : null,
    layerCount,
    hasForbiddenWrite: hasForbiddenParamWrite(commands),
  };
}

/**
 * File checksum as LightBurn writes it (verified on three captured jobs): `E5 05 <int35>`, placed just before
 * the final `D7`. The value is the sum of every unswizzled byte of the file except the `E5 05` command itself
 * (the `D7` counts).
 */
export function rdChecksum(commands: Uint8Array[]): number {
  let sum = 0;
  for (const c of commands) {
    if (c[0] === 0xe5 && c[1] === 0x05) continue;
    for (const b of c) sum += b;
  }
  return sum;
}

export const checksumCommand = (sum: number) => Uint8Array.of(0xe5, 0x05, ...encodeInt35(sum));
