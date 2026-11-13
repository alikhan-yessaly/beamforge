// Pure document operations. Every function returns a new Doc; objects are replaced, never mutated.
import {
  type Box,
  type Mat,
  type Vec,
  emptyBox,
  isEmptyBox,
  mul,
  pathsBox,
  rotate,
  scale,
  translate,
  unionBox,
} from "../geom/geom";
import { type Anchor, type Doc, type MachineProfile, type SceneObject, anchorPoint, newId } from "./model";

const boxCache = new WeakMap<SceneObject, Box>();

/** World-space (bed mm) bounding box of an object; cached per object instance. */
/** An image's outline in local mm, for its box and hit testing. */
export const imageFrame = (im: { w: number; h: number }) => ({ closed: true, points: [{ x: 0, y: 0 }, { x: im.w, y: 0 }, { x: im.w, y: im.h }, { x: 0, y: im.h }] });

export function objectBox(o: SceneObject): Box {
  let b = boxCache.get(o);
  if (!b) {
    b = pathsBox(o.image ? [...o.paths, imageFrame(o.image)] : o.paths, o.mat);
    boxCache.set(o, b);
  }
  return b;
}

export function selectionBox(doc: Doc, ids: ReadonlySet<string>): Box | null {
  let b = emptyBox();
  for (const o of doc.objects) if (ids.has(o.id)) b = unionBox(b, objectBox(o));
  return isEmptyBox(b) ? null : b;
}

/** Pre-multiply world matrix m onto the selected objects. */
export function transformSelected(doc: Doc, ids: ReadonlySet<string>, m: Mat): Doc {
  // Nothing selected: the same doc, so commit() records no empty undo step and the job isn't replanned.
  if (!doc.objects.some((o) => ids.has(o.id))) return doc;
  return { ...doc, objects: doc.objects.map((o) => (ids.has(o.id) ? { ...o, mat: mul(m, o.mat) } : o)) };
}

/** Matrix that scales by (sx, sy) about point p. */
export function scaleAbout(p: Vec, sx: number, sy: number): Mat {
  return mul(translate(p.x, p.y), mul(scale(sx, sy), translate(-p.x, -p.y)));
}

export function rotateAbout(p: Vec, deg: number): Mat {
  return mul(translate(p.x, p.y), mul(rotate((deg * Math.PI) / 180), translate(-p.x, -p.y)));
}

export const boxCenter = (b: Box): Vec => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });

/**
 * Place the selection so that its anchor point lands on `pos` (internal coords) and its size becomes w × h.
 * Sizes <= 0 are ignored for that axis (lines have zero width or height).
 */
export function setSelectionBox(
  doc: Doc,
  ids: ReadonlySet<string>,
  profile: MachineProfile,
  anchor: Anchor,
  pos: Vec,
  w: number,
  h: number,
): Doc {
  const b = selectionBox(doc, ids);
  if (!b) return doc;
  const cw = b.maxX - b.minX;
  const ch = b.maxY - b.minY;
  const sx = cw > 1e-9 && w > 0 ? w / cw : 1;
  const sy = ch > 1e-9 && h > 0 ? h / ch : 1;
  const a = anchorPoint(profile, b, anchor);
  const m = mul(translate(pos.x - a.x, pos.y - a.y), scaleAbout(a, sx, sy));
  return transformSelected(doc, ids, m);
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * Align each selected object to the reference box (the bed, or the whole selection when several objects are selected).
 * Modes are in screen terms (left = smaller x on screen), independent of the origin corner.
 */
export function align(doc: Doc, ids: ReadonlySet<string>, mode: AlignMode, ref: Box): Doc {
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      if (!ids.has(o.id)) return o;
      const b = objectBox(o);
      let dx = 0;
      let dy = 0;
      if (mode === "left") dx = ref.minX - b.minX;
      if (mode === "right") dx = ref.maxX - b.maxX;
      if (mode === "hcenter") dx = (ref.minX + ref.maxX) / 2 - (b.minX + b.maxX) / 2;
      if (mode === "top") dy = ref.minY - b.minY;
      if (mode === "bottom") dy = ref.maxY - b.maxY;
      if (mode === "vcenter") dy = (ref.minY + ref.maxY) / 2 - (b.minY + b.maxY) / 2;
      return { ...o, mat: mul(translate(dx, dy), o.mat) };
    }),
  };
}

/** Move the selection as a group so its centre is at the bed centre. */
export function centerOnBed(doc: Doc, ids: ReadonlySet<string>, profile: MachineProfile): Doc {
  const b = selectionBox(doc, ids);
  if (!b) return doc;
  const c = boxCenter(b);
  return transformSelected(doc, ids, translate(profile.bedW / 2 - c.x, profile.bedH / 2 - c.y));
}

export function mirror(doc: Doc, ids: ReadonlySet<string>, axis: "h" | "v"): Doc {
  const b = selectionBox(doc, ids);
  if (!b) return doc;
  return transformSelected(doc, ids, scaleAbout(boxCenter(b), axis === "h" ? -1 : 1, axis === "v" ? -1 : 1));
}

export function removeSelected(doc: Doc, ids: ReadonlySet<string>): Doc {
  if (!doc.objects.some((o) => ids.has(o.id))) return doc;
  return { ...doc, objects: doc.objects.filter((o) => !ids.has(o.id)) };
}

/** Duplicate the selection, offset by (dx, dy); returns the new doc and the ids of the copies. */
export function duplicateSelected(doc: Doc, ids: ReadonlySet<string>, dx = 5, dy = 5): { doc: Doc; ids: Set<string> } {
  return pasteObjects(doc, doc.objects.filter((o) => ids.has(o.id)), dx, dy);
}

function cloneObject(o: SceneObject): SceneObject {
  return { ...o, id: newId(), children: o.children?.map(cloneObject) };
}

/** Paste a snapshot with new IDs at every group level. */
export function pasteObjects(doc: Doc, objects: readonly SceneObject[], dx = 5, dy = 5): { doc: Doc; ids: Set<string> } {
  if (!objects.length) return { doc, ids: new Set() };
  const copies = objects.map((o) => ({ ...cloneObject(o), name: `${o.name} copy`, mat: mul(translate(dx, dy), o.mat) }));
  return { doc: { ...doc, objects: [...doc.objects, ...copies] }, ids: new Set(copies.map((c) => c.id)) };
}

/** Combine selected objects while retaining their hierarchy and baked paths for rendering and jobs. */
export function groupSelected(doc: Doc, ids: ReadonlySet<string>): { doc: Doc; ids: Set<string> } {
  // Pictures stay separate objects: a group is drawn from its baked paths, which a picture doesn't have.
  const sel = doc.objects.filter((o) => ids.has(o.id) && !o.image);
  if (sel.length < 2) return { doc, ids: new Set(ids) };
  ids = new Set(sel.map((o) => o.id));
  const paths = sel.flatMap((o) => bake(o));
  const g: SceneObject = { id: newId(), name: "Group", paths, mat: [1, 0, 0, 1, 0, 0], children: sel };
  const at = doc.objects.findIndex((o) => ids.has(o.id));
  const rest = doc.objects.filter((o) => !ids.has(o.id));
  rest.splice(at, 0, g);
  return { doc: { ...doc, objects: rest }, ids: new Set([g.id]) };
}

/** Restore group members one level at a time; legacy flattened objects still split into paths. */
export function ungroupSelected(doc: Doc, ids: ReadonlySet<string>): { doc: Doc; ids: Set<string> } {
  const out: SceneObject[] = [];
  const newIds = new Set<string>();
  for (const o of doc.objects) {
    if (!ids.has(o.id) || (!o.children?.length && o.paths.length < 2)) {
      out.push(o);
      if (ids.has(o.id)) newIds.add(o.id);
      continue;
    }
    if (o.children?.length) {
      for (const child of o.children) {
        const c = { ...child, mat: mul(o.mat, child.mat) };
        out.push(c);
        newIds.add(c.id);
      }
      continue;
    }
    o.paths.forEach((p, i) => {
      const c: SceneObject = { id: newId(), name: `${o.name} #${i + 1}`, paths: [p], mat: o.mat };
      out.push(c);
      newIds.add(c.id);
    });
  }
  return { doc: { ...doc, objects: out }, ids: newIds };
}

function bake(o: SceneObject) {
  return o.paths.map((p) => ({
    ...p,
    points: p.points.map((pt) => ({ x: o.mat[0] * pt.x + o.mat[2] * pt.y + o.mat[4], y: o.mat[1] * pt.x + o.mat[3] * pt.y + o.mat[5] })),
  }));
}

/** True if any part of the selection lies outside the bed. */
export function outsideBed(doc: Doc, profile: MachineProfile): boolean {
  return doc.objects.some((o) => {
    const b = objectBox(o);
    return b.minX < -1e-6 || b.minY < -1e-6 || b.maxX > profile.bedW + 1e-6 || b.maxY > profile.bedH + 1e-6;
  });
}

/** An object's own scale (1 = drawn size): the lengths of its matrix's axes (mirroring and rotation aside). */
export function objectScale(o: SceneObject): { sx: number; sy: number } {
  return { sx: Math.hypot(o.mat[0], o.mat[1]), sy: Math.hypot(o.mat[2], o.mat[3]) };
}

/**
 * Set one object's scale (1 = drawn size) along its own axes, keeping rotation and mirroring, with the selection
 * anchor point staying where it is.
 */
export function setObjectScale(doc: Doc, id: string, sx: number, sy: number, profile: MachineProfile, anchor: Anchor): Doc {
  const o = doc.objects.find((x) => x.id === id);
  if (!o || sx <= 0 || sy <= 0) return doc;
  const cur = objectScale(o);
  if (cur.sx < 1e-12 || cur.sy < 1e-12) return doc;
  const before = anchorPoint(profile, objectBox(o), anchor);
  const scaled: SceneObject = { ...o, mat: mul(o.mat, scale(sx / cur.sx, sy / cur.sy)) };
  const after = anchorPoint(profile, objectBox(scaled), anchor);
  const moved: SceneObject = { ...scaled, mat: mul(translate(before.x - after.x, before.y - after.y), scaled.mat) };
  return { ...doc, objects: doc.objects.map((x) => (x.id === id ? moved : x)) };
}
