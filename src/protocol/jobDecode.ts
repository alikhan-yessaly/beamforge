// Decode a job's unswizzled commands back into layers and paths: the inverse of encodeJobCommands.
// Used by the golden tests (decode a LightBurn capture, re-encode, compare bytes) and by the simulator.
import type { PointUm, RdJobInput, RdLayer } from "./jobEncode";
import { decodeInt14, decodeInt35 } from "./numbers";

export function decodeJob(commands: Uint8Array[]): RdJobInput {
  let mode: RdJobInput["mode"] = "current";
  const table = new Map<number, { speed: number; min: number; max: number; color: string }>();
  const layers: RdLayer[] = [];
  let cur: RdLayer | null = null;
  let path: PointUm[] | null = null;
  let pos: PointUm = { x: 0, y: 0 };
  const pct = (v: number) => Math.round((v * 100 * 1000) / 0x3fff) / 1000;

  for (const c of commands) {
    const [a, b] = [c[0], c[1]];
    if (a === 0xe6 && b === 0x01) mode = "absolute";
    else if (a === 0xc9 && b === 0x04) {
      const t = table.get(c[2]!) ?? { speed: 0, min: 0, max: 0, color: "#000000" };
      table.set(c[2]!, { ...t, speed: decodeInt35(c, 3) / 1000 });
    } else if (a === 0xc6 && (b === 0x31 || b === 0x32)) {
      const t = table.get(c[2]!) ?? { speed: 0, min: 0, max: 0, color: "#000000" };
      table.set(c[2]!, { ...t, [b === 0x31 ? "min" : "max"]: pct(decodeInt14(c, 3) & 0x3fff) });
    } else if (a === 0xca && b === 0x06) {
      const t = table.get(c[2]!) ?? { speed: 0, min: 0, max: 0, color: "#000000" };
      const bgr = decodeInt35(c, 3);
      const rgb = ((bgr & 0xff) << 16) | (bgr & 0xff00) | ((bgr >> 16) & 0xff);
      table.set(c[2]!, { ...t, color: `#${rgb.toString(16).padStart(6, "0")}` });
    } else if (a === 0xca && b === 0x02) {
      const t = table.get(c[2]!);
      cur = { speed: t?.speed ?? 0, minPower: t?.min ?? 0, maxPower: t?.max ?? 0, color: t?.color ?? "#000000", paths: [] };
      layers.push(cur);
      path = null;
    } else if (a === 0x88) {
      pos = { x: decodeInt35(c, 1), y: decodeInt35(c, 6) };
      path = [pos];
      cur?.paths.push(path);
    } else if (a === 0xa8 || a === 0xa9 || a === 0xaa || a === 0xab) {
      if (a === 0xa8) pos = { x: decodeInt35(c, 1), y: decodeInt35(c, 6) };
      else if (a === 0xa9) pos = { x: pos.x + decodeInt14(c, 1), y: pos.y + decodeInt14(c, 3) };
      else if (a === 0xaa) pos = { x: pos.x + decodeInt14(c, 1), y: pos.y };
      else pos = { x: pos.x, y: pos.y + decodeInt14(c, 1) };
      if (!path) {
        path = [pos];
        cur?.paths.push(path);
      } else path.push(pos);
    }
  }
  return { mode, layers };
}
