import { ADDR_BED_X, ADDR_BED_Y, readMemory } from "../protocol/encode";
import type { RuidaLink } from "../controller/link";
import type { OriginCorner } from "../scene/model";

export async function readBedDimensions(link: RuidaLink, isCurrent: () => boolean = () => true): Promise<{ width: number; height: number }> {
  if (!link.verified) throw new Error("Verify the controller before reading bed dimensions");
  const read = async (addr: number) => {
    if (!isCurrent() || !link.verified) throw new Error("Controller connection changed during bed read");
    const reply = (await link.query(readMemory(addr), 1000, "bed dimensions")).find((r) => r.addr === addr);
    if (!isCurrent() || !link.verified) throw new Error("Controller connection changed during bed read");
    if (!reply) throw new Error(`No reply for bed ${addr === ADDR_BED_X ? "width" : "height"}`);
    if (!Number.isSafeInteger(reply.value) || reply.value <= 0 || reply.value === 0xf2390000) {
      throw new Error(`Invalid bed ${addr === ADDR_BED_X ? "width" : "height"} returned by controller`);
    }
    return reply.value / 1000;
  };
  return { width: await read(ADDR_BED_X), height: await read(ADDR_BED_Y) };
}

export interface SavedMachineOrigin {
  name: string;
  cardId: number;
  origin: OriginCorner;
}

export const MACHINE_ORIGINS_KEY = "ruida-web.machine-origins.v1";
const origins: OriginCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export function parseMachineOrigins(raw: string | null): SavedMachineOrigin[] {
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.name === "string" && entry.name.trim().length > 0 &&
      typeof entry.cardId === "number" && Number.isSafeInteger(entry.cardId) && entry.cardId >= 0 &&
      typeof entry.origin === "string" && origins.some((origin) => origin === entry.origin);
  })) throw new Error("Saved machine origins are invalid");
  return value as SavedMachineOrigin[];
}
