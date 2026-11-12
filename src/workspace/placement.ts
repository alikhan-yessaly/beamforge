import type { PointUm } from "../protocol/jobEncode";
import { designOrigin } from "../job/build";
import type { Toolpath } from "../job/plan";
import { fromUser, type Doc, type MachineProfile } from "../scene/model";

/** Project actual machine coordinates onto the drawing anchored at the head's captured start position. */
export function relativeHeadOnDrawing(head: PointUm, start: PointUm, designOrigin: PointUm): PointUm {
  return { x: designOrigin.x + head.x - start.x, y: designOrigin.y + head.y - start.y };
}

/** Rebase only the preview's first and last travel moves, preserving the encoded cut order. */
export function relativeToolpath(tp: Toolpath, doc: Doc, profile: MachineProfile): Toolpath {
  const origin = designOrigin(doc, profile);
  if (!origin) return tp;
  const start = fromUser(profile, { x: origin.x / 1000, y: origin.y / 1000 });
  const segments = [...tp.segments];
  if (segments[0] && !segments[0].cut) segments.shift();
  if (segments.at(-1) && !segments.at(-1)!.cut) segments.pop();
  const first = segments[0];
  const last = segments.at(-1);
  if (first && (first.x0 !== start.x || first.y0 !== start.y)) {
    segments.unshift({ x0: start.x, y0: start.y, x1: first.x0, y1: first.y0, cut: false, layer: -1 });
  }
  if (last && (last.x1 !== start.x || last.y1 !== start.y)) {
    segments.push({ x0: last.x1, y0: last.y1, x1: start.x, y1: start.y, cut: false, layer: -1 });
  }
  return { ...tp, start, segments };
}
