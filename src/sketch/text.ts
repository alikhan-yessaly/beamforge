// Text as outlines (pure, given a parsed font): glyph contours flattened to closed polylines in sketch mm.
import type { Font, PathCommand } from "opentype.js";
import type { Vec } from "../geom/geom";
import type { TextEntity } from "./model";

/** Cap height in font units (falls back to 70 % of the em). */
export function capHeight(font: Font): number {
  const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
  return os2?.sCapHeight || font.unitsPerEm * 0.7;
}

/**
 * Outlines of `text` with its baseline start at `anchor`, cap height `size` mm, turned `angle` degrees
 * counter-clockwise on screen (sketch y points down). Each contour is closed (first point repeated).
 */
export function textContours(font: Font, text: string, anchor: Vec, size: number, angle: number): Vec[][] {
  if (!text || size <= 0) return [];
  const fontSize = (size * font.unitsPerEm) / capHeight(font);
  const cmds = font.getPath(text, 0, 0, fontSize).commands;
  const a = (angle * Math.PI) / 180;
  const [co, si] = [Math.cos(a), Math.sin(a)];
  // Screen counter-clockwise with y down.
  const place = (x: number, y: number): Vec => ({ x: anchor.x + x * co + y * si, y: anchor.y - x * si + y * co });
  const tol = Math.max(0.01, size / 200);
  const out: Vec[][] = [];
  let cur: Vec[] = [];
  let last = { x: 0, y: 0 };
  const close = () => {
    if (cur.length >= 3) {
      const f = cur[0]!;
      const l = cur[cur.length - 1]!;
      if (Math.hypot(f.x - l.x, f.y - l.y) > 1e-9) cur.push({ ...f });
      out.push(cur);
    }
    cur = [];
  };
  const steps = (len: number) => Math.max(2, Math.min(32, Math.ceil(Math.sqrt(len / tol))));
  for (const c of cmds as PathCommand[]) {
    switch (c.type) {
      case "M":
        close();
        last = { x: c.x, y: c.y };
        cur.push(place(c.x, c.y));
        break;
      case "L":
        last = { x: c.x, y: c.y };
        cur.push(place(c.x, c.y));
        break;
      case "Q": {
        const n = steps(Math.hypot(c.x1 - last.x, c.y1 - last.y) + Math.hypot(c.x - c.x1, c.y - c.y1));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          cur.push(place(u * u * last.x + 2 * u * t * c.x1 + t * t * c.x, u * u * last.y + 2 * u * t * c.y1 + t * t * c.y));
        }
        last = { x: c.x, y: c.y };
        break;
      }
      case "C": {
        const n = steps(Math.hypot(c.x1 - last.x, c.y1 - last.y) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
          cur.push(place(b[0] * last.x + b[1] * c.x1 + b[2] * c.x2 + b[3] * c.x, b[0] * last.y + b[1] * c.y1 + b[2] * c.y2 + b[3] * c.y));
        }
        last = { x: c.x, y: c.y };
        break;
      }
      case "Z":
        close();
        break;
    }
  }
  close();
  return out;
}

/** Outlines for a text entity whose anchor is at `anchor`. */
export const textEntityContours = (font: Font, e: TextEntity, anchor: Vec) => textContours(font, e.text, anchor, e.size, e.angle);
