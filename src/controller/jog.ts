import { t } from "../i18n";
import { moveAbs, moveRel, rapidMoveRel, REL_MAX_UM, setSpeed } from "../protocol/encode";

/**
 * Jog command builder. "rapidRel" (D9 10 02 dx dy) is verified on hardware; 88/89 outside a job are not.
 * See docs/PROTOCOL.md.
 */
export type JogMode = "rapidRel" | "abs88" | "rel89";

export const JOG_MODES: { mode: JogMode; label: string }[] = [
  { mode: "rapidRel", label: "Rapid relative (D9 10 02), verified" },
  { mode: "rel89", label: "Move Relative (89), UNVERIFIED" },
  { mode: "abs88", label: "Move Absolute (88), UNVERIFIED" },
];

/** Refuse anything bigger than this per click. */
export const MAX_JOG_MM = 100;

export interface JogRequest {
  mode: JogMode;
  dxMm: number;
  dyMm: number;
  /** Current head position in micrometers; required for the absolute modes. */
  fromUm?: { x: number; y: number } | null;
  /** Prefix with a C9 02 speed command when set. */
  speedMmS?: number | null;
}

export interface JogCommand {
  bytes: Uint8Array;
  /** Absolute target, for the absolute modes. */
  targetUm?: { x: number; y: number };
}

export function buildJog(req: JogRequest): JogCommand {
  const { dxMm, dyMm } = req;
  if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) throw new Error(t("Step must be a number"));
  if (Math.abs(dxMm) > MAX_JOG_MM || Math.abs(dyMm) > MAX_JOG_MM) throw new Error(t("Step limited to {max} mm", { max: MAX_JOG_MM }));
  const parts: Uint8Array[] = [];
  if (req.speedMmS != null) {
    if (!(req.speedMmS > 0 && req.speedMmS <= 500)) throw new Error(t("Speed must be 0–{max} mm/s", { max: 500 }));
    parts.push(setSpeed(req.speedMmS));
  }
  const dx = Math.round(dxMm * 1000);
  const dy = Math.round(dyMm * 1000);
  let targetUm: { x: number; y: number } | undefined;

  if (req.mode === "rapidRel") {
    parts.push(rapidMoveRel(dx, dy));
  } else if (req.mode === "rel89") {
    // A 14-bit relative coordinate holds ±8.191 mm, so longer steps become several 89 moves.
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / REL_MAX_UM));
    let doneX = 0;
    let doneY = 0;
    for (let i = 1; i <= n; i++) {
      const x = Math.round((dx * i) / n) - doneX;
      const y = Math.round((dy * i) / n) - doneY;
      parts.push(moveRel(x, y));
      doneX += x;
      doneY += y;
    }
  } else {
    if (!req.fromUm) throw new Error(t("Absolute jog needs the current position: read the position first"));
    targetUm = { x: req.fromUm.x + dx, y: req.fromUm.y + dy };
    parts.push(moveAbs(targetUm.x, targetUm.y));
  }

  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return { bytes, targetUm };
}
