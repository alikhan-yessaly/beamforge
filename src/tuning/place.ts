// Putting a test card into the drawing and reading tuning results back out: pure document operations.
import { t } from "../i18n";
import { translate } from "../geom/geom";
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

/**
 * Add a card as one object, 10 mm from the machine's home corner, with its layers set up. Returns the new
 * document and the card object's id.
 */
export function placeCard(doc: Doc, params: CardParams, profile: MachineProfile): { doc: Doc; id: string } {
  const card = makeCard(params);
  const right = profile.origin.endsWith("right");
  const bottom = profile.origin.startsWith("bottom");
  const x = right ? profile.bedW - 10 - card.w : 10;
  const y = bottom ? profile.bedH - 10 - card.h : 10;
  const id = newId();
  const names = { fill: t("Test card: fill evenness"), scan: t("Test card: scan offset"), grid: t("Test card: power and speed"), kerf: t("Test card: kerf") };
  let next: Doc = { ...doc, objects: [...doc.objects, { id, name: names[params.kind], paths: card.paths, mat: translate(x, y), card: params }] };
  for (const { color, ...settings } of card.layers) next = updateLayer(next, color, settings);
  return { doc: next, id };
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
