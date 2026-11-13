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
  /**
   * An imported picture shown on the canvas, covering local (0,0)–(w,h) mm. Not sent to the machine: raster
   * engraving (Ruida scan mode) isn't supported yet, so it serves as a reference for tracing and placement.
   */
  image?: SceneImage;
  /** A tuning test card (src/tuning/cards.ts): its parameters, so the results view can redraw it. */
  card?: import("../tuning/cards").CardParams;
}

export interface SceneImage {
  /** data: URL (PNG or JPEG). */
  src: string;
  /** Size in local mm. */
  w: number;
  h: number;
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
  /**
   * Fill layers: laser-off run-up before and after each engraved row, so the laser fires only at full speed and
   * edges burn as deep as the middle. "auto" = the profile's speed-up distance; a number = mm. Missing = off.
   */
  overscan?: Overscan;
  /** Fill layers: areas that share rows are swept together, each on its own, or whichever is quicker (default). */
  sweep?: SweepMode;
  /** Cut layers: kerf compensation width in mm (closed outlines grow by half of it, holes shrink). Missing = 0. */
  kerf?: number;
  /** Fill layers, advanced: scan offset in mm used instead of the machine profile's (bidirectional row lag). */
  scanOffset?: number;
}

export type Overscan = "off" | "auto" | number;
export type SweepMode = "quick" | "together" | "separate";

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
  /** Stable id (profiles are matched by it; the name can change). Missing on profiles saved before machine lists. */
  id?: string;
  /** Machine class the defaults came from (src/machine/classes.ts); missing = not chosen yet. */
  class?: string;
  /**
   * Controller start speed, mm/s: the head starts and stops at this speed, and corner power applies at or below it.
   * Missing = ASSUMED_START_SPEED.
   */
  startSpeed?: number;
  /** Lowest power (%) at which the tube fires reliably; suggested corner powers never go below it. Missing = 10. */
  minFirePower?: number;
  /**
   * Scan offset per speed (mm): how far a row engraved right-to-left lands from one engraved left-to-right. Fill
   * burns are shifted back by half of it along their direction. Interpolated by speed; empty or missing = none.
   */
  scanOffsets?: { speed: number; offset: number }[];
  /** What the controller reported when this profile was last used, so connecting picks this profile again. */
  controller?: { cardId: number; bedW: number; bedH: number };
  /** Tuning results and progress (src/tuning/). */
  tuning?: MachineTuning;
}

export interface MachineTuning {
  /** ISO date of the last fill-evenness test, when acceleration and start speed were measured. */
  fill?: string;
  /** Which fix evened out the fill test best: overscan, a lower corner power, or none needed. */
  fillFix?: "overscan" | "corner" | "none";
  /** ISO date of the last scan-offset test. */
  scanOffset?: string;
  /** Suggestions the owner chose not to see again for this machine (ids from src/job/checks.ts). */
  dismissed?: string[];
}

/** Typical Ruida start speed, used when the profile has none. */
export const ASSUMED_START_SPEED = 10;
/** Typical lowest reliable power of a CO2 tube, %. */
export const ASSUMED_MIN_FIRE_POWER = 10;

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
