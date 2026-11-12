import { signal } from "@preact/signals";
import type { Box, Vec } from "../geom/geom";
import type { MachineProfile } from "../scene/model";

/** screen = bed * zoom + (ox, oy), in CSS pixels. */
export interface View {
  zoom: number;
  ox: number;
  oy: number;
}

export const view = signal<View>({ zoom: 1, ox: 40, oy: 40 });
/** False until the user pans or zooms; until then the view keeps fitting the bed as the layout settles. */
export const viewTouched = signal(false);
export const canvasSize = signal<{ w: number; h: number }>({ w: 800, h: 600 });

export const toScreen = (v: View, p: Vec): Vec => ({ x: p.x * v.zoom + v.ox, y: p.y * v.zoom + v.oy });
export const toBed = (v: View, p: Vec): Vec => ({ x: (p.x - v.ox) / v.zoom, y: (p.y - v.oy) / v.zoom });

export function fitBox(b: Box, size = canvasSize.value, margin = 40): View {
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const zoom = Math.min(200, Math.max(1, size.w - 2 * margin) / w, Math.max(1, size.h - 2 * margin) / h);
  return { zoom, ox: (size.w - w * zoom) / 2 - b.minX * zoom, oy: (size.h - h * zoom) / 2 - b.minY * zoom };
}

export const fitBed = (p: MachineProfile) => (view.value = fitBox({ minX: 0, minY: 0, maxX: p.bedW, maxY: p.bedH }));

export function zoomAt(screen: Vec, factor: number): void {
  viewTouched.value = true;
  const v = view.value;
  const zoom = Math.min(200, Math.max(0.05, v.zoom * factor));
  const k = zoom / v.zoom;
  view.value = { zoom, ox: screen.x - (screen.x - v.ox) * k, oy: screen.y - (screen.y - v.oy) * k };
}
