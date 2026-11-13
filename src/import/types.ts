// Shared shapes for the importers (SVG, PDF, HPGL, …), the image tracer and the exporters.
// All geometry here is in millimetres, x right, y down (the workspace convention, src/geom/geom.ts).
import type { Vec } from "../geom/geom";

/** One path read from a vector file, curves already flattened to points. */
export interface VecPath {
  points: Vec[];
  closed: boolean;
  /** CSS hex colour (#rrggbb, lower case) the path is stroked with in the source, or null if not stroked. */
  stroke: string | null;
  /** CSS hex colour the closed area is filled with in the source, or null if not filled. */
  fill: string | null;
}

/** Result of parsing a vector file. Coordinates are mm, y down, in the file's own frame (top-left of its page). */
export interface VectorImport {
  paths: VecPath[];
  /** Human-readable problems (skipped text, unsupported elements, …); already in English, wrap with t() upstream. */
  warnings: string[];
  /** Page or canvas size in mm when the format has one (SVG viewport, PDF page). */
  pageMm?: { w: number; h: number };
}

/** An RGBA bitmap, as from ImageData (row-major, 4 bytes per pixel). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A path for export: bed millimetres (y down), with its layer colour and optional area fill colour. */
export interface ExportPath {
  points: Vec[];
  closed: boolean;
  /** Layer colour of the outline (#rrggbb). */
  color: string;
  /** True when this colour's layer is a fill layer: the closed area is engraved rather than the outline cut. */
  fillLayer?: boolean;
  /** Area fill colour set with the Fill tool (#rrggbb), if any. */
  fill?: string;
}

/** Curve flattening tolerance used by all importers: max distance between a curve and its chord, mm. */
export const FLATTEN_TOLERANCE_MM = 0.02;
