// Putting a test card into the drawing and reading tuning results back out: pure document operations.
import { t } from "../i18n";
import { type Vec, translate } from "../geom/geom";
import { objectBox } from "../scene/ops";
import { PALETTE, activeLayers, colorsInUse, updateLayer } from "../job/layers";
import { type Doc, type MachineProfile, newId } from "../scene/model";
import { type CardKind, type CardParams, colorsNeeded, makeCard } from "./cards";

/**
 * `n` palette colours no shape uses: first ones without stored settings, then ones whose settings are only kept
 * from shapes deleted earlier (e.g. an old test card). Throws when there aren't enough.
 */
export function freeColors(doc: Doc, n: number): string[] {
  const used = new Set(colorsInUse(doc));
  const stored = new Set((doc.layers ?? []).map((l) => l.color));
  const free = [...PALETTE.filter((c) => !used.has(c) && !stored.has(c)), ...PALETTE.filter((c) => !used.has(c) && stored.has(c))];
  if (free.length < n) throw new Error(t("The test card needs {n} free layer colours; the drawing leaves {free}. Remove unused colours or start a new drawing.", { n, free: free.length }));
  return free.slice(0, n);
}

/** Colours for a new card of `kind`. */
export const cardColors = (doc: Doc, kind: CardKind) => freeColors(doc, colorsNeeded(kind));

/** Margin from the bed edge, and gap kept from other objects, mm. */
const EDGE = 10;
const GAP = 3;
const STEP = 5;

/**
 * Top-left corner (internal bed mm) for a w × h card: the free spot nearest the machine's home corner that keeps
 * clear of every object in the drawing, scanning away from home in 5 mm steps. Null when the bed has no room.
 */
export function freeSpot(doc: Doc, w: number, h: number, profile: Pick<MachineProfile, "bedW" | "bedH" | "origin">): Vec | null {
  const boxes = doc.objects.map(objectBox).filter((b) => Number.isFinite(b.minX));
  const right = profile.origin.endsWith("right");
  const bottom = profile.origin.startsWith("bottom");
  const nx = Math.floor((profile.bedW - 2 * EDGE - w) / STEP);
  const ny = Math.floor((profile.bedH - 2 * EDGE - h) / STEP);
  if (nx < 0 || ny < 0) return null;
  const clear = (x: number, y: number) => boxes.every((b) => x + w + GAP <= b.minX || x - GAP >= b.maxX || y + h + GAP <= b.minY || y - GAP >= b.maxY);
  // Nearest home first: by distance from the home corner (in steps), rows before columns on ties.
  const spots: [number, number][] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) spots.push([i, j]);
  spots.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[1] - b[1]);
  for (const [i, j] of spots) {
    const x = right ? profile.bedW - EDGE - w - i * STEP : EDGE + i * STEP;
    const y = bottom ? profile.bedH - EDGE - h - j * STEP : EDGE + j * STEP;
    if (clear(x, y)) return { x, y };
  }
  return null;
}

/**
 * Add a card as one object at the free spot nearest the machine's home corner (or at the corner itself when the
 * bed is full: `overlaps`), with its layers set up. Returns the new document and the card object's id.
 */
export function placeCard(doc: Doc, params: CardParams, profile: MachineProfile): { doc: Doc; id: string; overlaps: boolean } {
  const card = makeCard(params);
  const right = profile.origin.endsWith("right");
  const bottom = profile.origin.startsWith("bottom");
  const spot = freeSpot(doc, card.w, card.h, profile);
  const x = spot?.x ?? (right ? profile.bedW - EDGE - card.w : EDGE);
  const y = spot?.y ?? (bottom ? profile.bedH - EDGE - card.h : EDGE);
  const id = newId();
  const names = { fill: t("Test card: fill evenness"), scan: t("Test card: scan offset"), grid: t("Test card: power and speed"), kerf: t("Test card: kerf") };
  let next: Doc = { ...doc, objects: [...doc.objects, { id, name: names[params.kind], paths: card.paths, mat: translate(x, y), card: params }] };
  for (const { color, ...settings } of card.layers) next = updateLayer(next, color, settings);
  return { doc: next, id, overlaps: !spot };
}

/** Card objects of a kind in the drawing, newest last. */
export const cardsIn = (doc: Doc, kind: CardKind) => doc.objects.filter((o) => o.card?.kind === kind);

/** Turn output off for every layer that isn't one of the card's, so only the card runs. */
export function onlyCard(doc: Doc, params: CardParams): Doc {
  const mine = new Set(params.colors);
  let next = doc;
  for (const l of activeLayers(doc)) if (!mine.has(l.color) && l.output) next = updateLayer(next, l.color, { output: false });
  return next;
}
