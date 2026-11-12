import type { Box, Mat, Polyline, Seg, Vec } from "../geom/geom";
import type { FillSettings } from "../job/fill";
import type { Sketch } from "../sketch/model";

export interface ScenePath extends Polyline {
  /** CSS hex colour; becomes the layer key in M3. */
  color: string;
  /**
   * DXF imports: the path as lines and arcs (local mm, like `points`), or null for curves known only as points
   * (ellipses, splines). Used by "Edit as sketch". Absent on paths from elsewhere.
   */
  segs?: Seg[] | null;
  /**
   * Fill colour for the area this closed path encloses, minus the closed paths directly inside it (holes). Set with
   * the Fill tool; engraved by that colour's fill layer, independent of how the outline itself is cut.
   */
  fill?: string;
  /** Sketch objects: the entity ids forming this closed loop (sorted), so fills survive regenerating the paths. */
  src?: string[];
}

/**
 * One placed drawing. `paths` are in local millimetres (y down) and never change after import;
 * placement is entirely in `mat` (local → bed mm), so any number of moves/scales/rotations stays lossless.
 */
export interface SceneObject {
  id: string;
  name: string;
  paths: ScenePath[];
  mat: Mat;
  /** Original members in this group's local coordinates; absent on legacy flattened objects. */
  children?: SceneObject[];
  /** Editable sketch; `paths` are generated from it (src/sketch/paths.ts). Local coords = sketch coords. */
  sketch?: Sketch;
}

/** Cut settings for every path of one colour (LightBurn's "Cuts / Layers"). The array order in `Doc.layers` is the cut order. */
export interface Layer {
  color: string;
  /** mm/s */
  speed: number;
  /**
   * Power in % of the tube's full power. The Ruida scales power with speed along a cut: at or below its start
   * speed (a machine setting, often 10 mm/s; corners, line ends) it fires at `minPower`, rising linearly to
   * `maxPower` at the layer speed. The UI calls them corner power and power.
   */
  minPower: number;
  maxPower: number;
  passes: number;
  /** false = keep the shapes but don't cut them */
  output: boolean;
  /** false = show the colour as a non-interactive shadow; missing on older documents means shown. */
  show?: boolean;
  /** Id of the material preset the settings came from (they may have been edited since). */
  material?: string;
  /** Corner power follows power (constant power). Missing on older documents: linked if the two are equal. */
  linkPower?: boolean;
  /** cut = follow the outlines (default); fill = engrave the inside of closed shapes; fillCut = fill, then cut the outlines. */
  mode?: LayerMode;
  /** Fill pattern settings (fill modes); missing = DEFAULT_FILL. */
  fill?: FillSettings;
}

export type LayerMode = "cut" | "fill" | "fillCut";

export const DEFAULT_LAYER: Omit<Layer, "color"> = { speed: 20, minPower: 20, maxPower: 20, passes: 1, output: true, show: true, linkPower: true };

export interface Doc {
  objects: SceneObject[];
  /** Settings per colour, in cut order. May hold colours no path uses any more (their settings are kept). */
  layers: Layer[];
}

export type OriginCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface MachineProfile {
  name: string;
  /** Bed size in mm. */
  bedW: number;
  bedH: number;
  /** Where machine (0,0) is; numeric fields and rulers are shown relative to this corner. */
  origin: OriginCorner;
  /** Speed of moves with the laser off, mm/s (time estimate). */
  travelSpeed: number;
  /** Acceleration, mm/s² (time estimate). */
  accel: number;
  /** Speed for Frame, mm/s (default 30). */
  frameSpeed?: number;
}

export const DEFAULT_PROFILE: MachineProfile = {
  name: "Ruida laser",
  bedW: 600,
  bedH: 400,
  origin: "top-left",
  travelSpeed: 100,
  accel: 2000,
};

/** Anchor for numeric position/size: 0..1 fractions of the box, in *user* orientation (0,0 = near the origin corner). */
export interface Anchor {
  fx: 0 | 0.5 | 1;
  fy: 0 | 0.5 | 1;
}

const flipX = (p: MachineProfile) => p.origin.endsWith("right");
const flipY = (p: MachineProfile) => p.origin.startsWith("bottom");

/** Internal bed coords (top-left, y down) → user coords (relative to the machine origin corner, axes pointing into the bed). */
export function toUser(p: MachineProfile, v: Vec): Vec {
  return { x: flipX(p) ? p.bedW - v.x : v.x, y: flipY(p) ? p.bedH - v.y : v.y };
}
export const fromUser = toUser; // the mapping is its own inverse

/** A box's anchor point in internal coords, with the anchor given in user orientation. */
export function anchorPoint(p: MachineProfile, b: Box, a: Anchor): Vec {
  const fx = flipX(p) ? 1 - a.fx : a.fx;
  const fy = flipY(p) ? 1 - a.fy : a.fy;
  return { x: b.minX + (b.maxX - b.minX) * fx, y: b.minY + (b.maxY - b.minY) * fy };
}

export const newId = () => Math.random().toString(36).slice(2, 10);
