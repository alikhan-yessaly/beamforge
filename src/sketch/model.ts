// Sketch data: points, entities that reference them, and constraints. Sketch-local millimetres, y down (same
// orientation as the bed), origin at (0, 0). Pure data and pure helpers; solving lives in solver.ts.
import type { Vec } from "../geom/geom";

export interface SPoint {
  x: number;
  y: number;
  /** Pinned in place (the origin, or a Fix constraint). */
  fixed?: boolean;
}

interface EntityBase {
  id: string;
  /** Reference geometry: shown and constrainable, never cut. */
  construction?: boolean;
  /** Layer colour of the cut paths (defaults to the sketch's colour). */
  color?: string;
}

export interface LineEntity extends EntityBase {
  kind: "line";
  p1: string;
  p2: string;
}
export interface CircleEntity extends EntityBase {
  kind: "circle";
  c: string;
  r: number;
}
/** Arc from start to end, counter-clockwise in solver terms (increasing atan2 angle). */
export interface ArcEntity extends EntityBase {
  kind: "arc";
  c: string;
  r: number;
  start: string;
  end: string;
}
export interface PointEntity extends EntityBase {
  kind: "point";
  p: string;
}
/** Smooth curve through its points (Catmull-Rom). */
export interface SplineEntity extends EntityBase {
  kind: "spline";
  pts: string[];
  closed: boolean;
}
/** Text as outlines; the anchor is the baseline start, so it can be dimensioned and constrained. */
export interface TextEntity extends EntityBase {
  kind: "text";
  anchor: string;
  text: string;
  /** Cap height in mm. */
  size: number;
  /** Degrees, counter-clockwise on screen. */
  angle: number;
  font: string;
}
/** Imported geometry that can't be edited point by point (e.g. DXF ellipses): moves with its anchor. */
export interface RefEntity extends EntityBase {
  kind: "ref";
  anchor: string;
  /** Polyline relative to the anchor. */
  points: Vec[];
  closed: boolean;
}

export type Entity = LineEntity | CircleEntity | ArcEntity | PointEntity | SplineEntity | TextEntity | RefEntity;

export type ConstraintType =
  | "coincident"
  | "pointOnLine"
  | "pointOnCircle"
  | "horizontal"
  | "vertical"
  | "horizontalPts"
  | "verticalPts"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "equal"
  | "midpoint"
  | "concentric"
  | "symmetric"
  | "fix"
  // dimensions (have a value):
  | "distance"
  | "distanceX"
  | "distanceY"
  | "pointLineDistance"
  | "radius"
  | "diameter"
  | "angle";

export interface Constraint {
  id: string;
  type: ConstraintType;
  /** Point or entity ids, in the order the type expects (see solver.ts). */
  refs: string[];
  /** Dimension value: mm, or degrees for angle. */
  value?: number;
  /** Where the dimension label sits, relative to its anchor (sketch mm). */
  offset?: Vec;
  /** Not drawn (e.g. the extra distances that keep an offset rigid). */
  hidden?: boolean;
  /** A hidden dimension that follows this visible dimension's value (and is deleted with it). */
  link?: string;
}

export interface Sketch {
  points: Record<string, SPoint>;
  entities: Entity[];
  constraints: Constraint[];
  /** Default layer colour for new entities. */
  color: string;
  /** Counter for new ids. */
  next: number;
  /** Filled regions: the closed loop (sorted entity ids) and the fill colour. */
  fills?: { loop: string[]; color: string }[];
}

export const ORIGIN = "o";
export const DIMENSION_TYPES: ReadonlySet<ConstraintType> = new Set(["distance", "distanceX", "distanceY", "pointLineDistance", "radius", "diameter", "angle"]);
export const isDimension = (c: Constraint) => DIMENSION_TYPES.has(c.type);

export function emptySketch(color = "#000000"): Sketch {
  return { points: { [ORIGIN]: { x: 0, y: 0, fixed: true } }, entities: [], constraints: [], color, next: 1 };
}

/** Small immutable builder: each call returns a new sketch plus the new id. */
export function newId(s: Sketch, prefix: string): { s: Sketch; id: string } {
  return { s: { ...s, next: s.next + 1 }, id: `${prefix}${s.next}` };
}

export function addPoint(s: Sketch, p: Vec, fixed = false): { s: Sketch; id: string } {
  const r = newId(s, "p");
  return { s: { ...r.s, points: { ...r.s.points, [r.id]: { x: p.x, y: p.y, ...(fixed ? { fixed } : {}) } } }, id: r.id };
}

/** An entity without its id (distributes over the union, so each kind keeps its own fields). */
export type NewEntity = Entity extends infer T ? (T extends Entity ? Omit<T, "id"> : never) : never;

export function addEntity(s: Sketch, e: NewEntity): { s: Sketch; id: string } {
  const r = newId(s, "e");
  return { s: { ...r.s, entities: [...r.s.entities, { ...e, id: r.id } as unknown as Entity] }, id: r.id };
}

export function addConstraint(s: Sketch, c: Omit<Constraint, "id">): { s: Sketch; id: string } {
  const r = newId(s, "c");
  return { s: { ...r.s, constraints: [...r.s.constraints, { ...c, id: r.id }] }, id: r.id };
}

export const pt = (s: Sketch, id: string): Vec => {
  const p = s.points[id];
  if (!p) throw new Error(`Missing sketch point ${id}`);
  return { x: p.x, y: p.y };
};

/** Point ids an entity uses. */
export function entityPoints(e: Entity): string[] {
  switch (e.kind) {
    case "line":
      return [e.p1, e.p2];
    case "circle":
      return [e.c];
    case "arc":
      return [e.c, e.start, e.end];
    case "point":
      return [e.p];
    case "spline":
      return e.pts;
    case "text":
    case "ref":
      return [e.anchor];
  }
}

/** Ids of points and entities a constraint refers to. */
export const constraintRefs = (c: Constraint) => c.refs;

/** Delete entities (and constraints and orphaned points that depended on them). */
export function deleteItems(s: Sketch, ids: ReadonlySet<string>): Sketch {
  const entities = s.entities.filter((e) => !ids.has(e.id));
  const used = new Set<string>([ORIGIN]);
  for (const e of entities) for (const p of entityPoints(e)) used.add(p);
  const points: Record<string, SPoint> = {};
  for (const [id, p] of Object.entries(s.points)) if (used.has(id) && !ids.has(id)) points[id] = p;
  const alive = new Set([...Object.keys(points), ...entities.map((e) => e.id)]);
  let constraints = s.constraints.filter((c) => !ids.has(c.id) && c.refs.every((r) => alive.has(r)));
  const kept = new Set(constraints.map((c) => c.id));
  constraints = constraints.filter((c) => !c.link || kept.has(c.link));
  return { ...s, points, entities, constraints };
}

/** Arc angles (radians, atan2 in sketch coords) from its points. */
export function arcAngles(s: Sketch, a: ArcEntity): { a0: number; a1: number } {
  const c = pt(s, a.c);
  const p0 = pt(s, a.start);
  const p1 = pt(s, a.end);
  let a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  let a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  if (a1 <= a0) a1 += 2 * Math.PI;
  return { a0, a1 };
}

/** Find the entity, or undefined. */
export const entity = (s: Sketch, id: string) => s.entities.find((e) => e.id === id);

/** Bounding box of all points (for fitting the view). */
export function sketchBox(s: Sketch): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const e of s.entities) {
    for (const id of entityPoints(e)) {
      const p = s.points[id];
      if (!p) continue;
      const r = e.kind === "circle" || (e.kind === "arc" && id === e.c) ? e.r : 0;
      b.minX = Math.min(b.minX, p.x - r);
      b.minY = Math.min(b.minY, p.y - r);
      b.maxX = Math.max(b.maxX, p.x + r);
      b.maxY = Math.max(b.maxY, p.y + r);
    }
  }
  return b;
}
