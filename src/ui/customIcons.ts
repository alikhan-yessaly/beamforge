// Icons Lucide doesn't have, drawn in its style (24×24 grid, 2px round strokes, no fill) so they mix freely.
import { createLucideIcon } from "lucide-preact";

/** A laser cutter: cabinet with the lid seam, the head hanging from the gantry, its beam and the bed. */
export const LaserCutter = createLucideIcon("laser-cutter", [
  ["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2", key: "body" }],
  ["path", { d: "M2 9h20", key: "gantry" }],
  ["path", { d: "M10 9v3h4V9", key: "head" }],
  ["path", { d: "M12 14v1.5", key: "beam" }],
  ["path", { d: "M6 17h12", key: "bed" }],
]);

/** Zoom to the bed: the slatted bed inside outward corner brackets. */
export const FitBed = createLucideIcon("fit-bed", [
  ["path", { d: "M3 7V5a2 2 0 0 1 2-2h2", key: "c1" }],
  ["path", { d: "M17 3h2a2 2 0 0 1 2 2v2", key: "c2" }],
  ["path", { d: "M21 17v2a2 2 0 0 1-2 2h-2", key: "c3" }],
  ["path", { d: "M7 21H5a2 2 0 0 1-2-2v-2", key: "c4" }],
  ["rect", { x: "6", y: "8", width: "12", height: "8", rx: "1", key: "bed" }],
  ["path", { d: "M10 8v8M14 8v8", key: "slats" }],
]);

/** Zoom to the selection: a dashed selection box with a handle, inside outward corner brackets. */
export const FitSelection = createLucideIcon("fit-selection", [
  ["path", { d: "M3 7V5a2 2 0 0 1 2-2h2", key: "c1" }],
  ["path", { d: "M17 3h2a2 2 0 0 1 2 2v2", key: "c2" }],
  ["path", { d: "M21 17v2a2 2 0 0 1-2 2h-2", key: "c3" }],
  ["path", { d: "M7 21H5a2 2 0 0 1-2-2v-2", key: "c4" }],
  ["rect", { x: "8", y: "8", width: "8", height: "8", "stroke-dasharray": "2 2", key: "sel" }],
]);

/** Start from the drawing's place on the bed: the bed, its origin corner, and the design fixed inside it. */
export const StartFromBed = createLucideIcon("start-from-bed", [
  ["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2", key: "bed" }],
  ["path", { d: "M17 4v3h5", key: "origin" }],
  ["rect", { x: "6", y: "11", width: "7", height: "5", rx: "0.5", key: "design" }],
]);

/** Start from the head: the laser nozzle with its tip on the design's corner. */
export const StartFromHead = createLucideIcon("start-from-head", [
  ["path", { d: "M5 2h6v3l-2 4H7L5 5z", key: "nozzle" }],
  ["path", { d: "M8 9v2", key: "beam" }],
  ["rect", { x: "8", y: "13", width: "13", height: "9", rx: "1", key: "design" }],
]);

/** Cut mode: the outline, with a direction tick showing the beam follows it. */
export const ModeCut = createLucideIcon("mode-cut", [
  ["rect", { x: "4", y: "4", width: "16", height: "16", rx: "2", key: "outline" }],
  ["path", { d: "m10 2 2 2-2 2", key: "dir" }],
]);

/** Fill mode: the inside hatched, no outline. */
export const ModeFill = createLucideIcon("mode-fill", [
  ["path", { d: "M4 9 9 4", key: "h1" }],
  ["path", { d: "M4 14 14 4", key: "h2" }],
  ["path", { d: "M4 20 20 4", key: "h3" }],
  ["path", { d: "M10 20 20 10", key: "h4" }],
  ["path", { d: "M15 20l5-5", key: "h5" }],
]);

/** Fill + outline: hatched inside, then the outline cut. */
export const ModeFillCut = createLucideIcon("mode-fill-cut", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", key: "outline" }],
  ["path", { d: "M7 12l5-5", key: "h1" }],
  ["path", { d: "M7 17 17 7", key: "h2" }],
  ["path", { d: "M12 17l5-5", key: "h3" }],
]);

/** Line fill pattern: parallel strokes. */
export const PatternLines = createLucideIcon("pattern-lines", [
  ["path", { d: "M4 6h16", key: "l1" }],
  ["path", { d: "M4 10h16", key: "l2" }],
  ["path", { d: "M4 14h16", key: "l3" }],
  ["path", { d: "M4 18h16", key: "l4" }],
]);

/** Cross-hatch fill pattern. */
export const PatternCross = createLucideIcon("pattern-cross", [
  ["path", { d: "M4 8h16M4 16h16", key: "h" }],
  ["path", { d: "M8 4v16M16 4v16", key: "v" }],
]);

/** Dot fill pattern. */
export const PatternDots = createLucideIcon("pattern-dots", [
  ["circle", { cx: "6", cy: "6", r: "1", key: "d1" }],
  ["circle", { cx: "12", cy: "6", r: "1", key: "d2" }],
  ["circle", { cx: "18", cy: "6", r: "1", key: "d3" }],
  ["circle", { cx: "6", cy: "12", r: "1", key: "d4" }],
  ["circle", { cx: "12", cy: "12", r: "1", key: "d5" }],
  ["circle", { cx: "18", cy: "12", r: "1", key: "d6" }],
  ["circle", { cx: "6", cy: "18", r: "1", key: "d7" }],
  ["circle", { cx: "12", cy: "18", r: "1", key: "d8" }],
  ["circle", { cx: "18", cy: "18", r: "1", key: "d9" }],
]);

/** Offset (contour) fill pattern: concentric outlines. */
export const PatternOffset = createLucideIcon("pattern-offset", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "3", key: "r1" }],
  ["rect", { x: "7", y: "7", width: "10", height: "10", rx: "2", key: "r2" }],
  ["rect", { x: "11", y: "11", width: "2", height: "2", rx: "0.5", key: "r3" }],
]);

// ---------- Sketch tools ----------
export const SkLine = createLucideIcon("sk-line", [
  ["path", { d: "M5 19 19 5", key: "l" }],
  ["circle", { cx: "5", cy: "19", r: "2", key: "a" }],
  ["circle", { cx: "19", cy: "5", r: "2", key: "b" }],
]);
export const SkArc3 = createLucideIcon("sk-arc3", [
  ["path", { d: "M4 18A10 10 0 0 1 20 18", key: "arc" }],
  ["circle", { cx: "4", cy: "18", r: "1.6", key: "a" }],
  ["circle", { cx: "12", cy: "9", r: "1.6", key: "m" }],
  ["circle", { cx: "20", cy: "18", r: "1.6", key: "b" }],
]);
export const SkArcCenter = createLucideIcon("sk-arc-center", [
  ["path", { d: "M5 12a7 7 0 0 1 14 0", key: "arc" }],
  ["circle", { cx: "12", cy: "12", r: "1.6", key: "c" }],
  ["path", { d: "M12 12 19 12", key: "r", "stroke-dasharray": "2 2" }],
]);
export const SkArcTangent = createLucideIcon("sk-arc-tangent", [
  ["path", { d: "M3 18h8", key: "l" }],
  ["path", { d: "M11 18a6 6 0 0 0 6-6V5", key: "arc" }],
  ["circle", { cx: "11", cy: "18", r: "1.6", key: "j" }],
]);
export const SkConstruction = createLucideIcon("sk-construction", [["path", { d: "M4 20 20 4", key: "l", "stroke-dasharray": "3 3" }]]);
export const SkSlot = createLucideIcon("sk-slot", [["path", { d: "M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7z", key: "s" }]]);
export const SkFillet = createLucideIcon("sk-fillet", [["path", { d: "M5 20V11a6 6 0 0 1 6-6h9", key: "f" }]]);
export const SkChamfer = createLucideIcon("sk-chamfer", [["path", { d: "M5 20v-9l6-6h9", key: "c" }]]);
export const SkOffset = createLucideIcon("sk-offset", [
  ["path", { d: "M4 20V9a5 5 0 0 1 5-5h11", key: "a" }],
  ["path", { d: "M9 20v-9a2 2 0 0 1 2-2h9", key: "b", "stroke-dasharray": "2 2" }],
]);
export const SkCircularPattern = createLucideIcon("sk-circular-pattern", [
  ["circle", { cx: "12", cy: "4", r: "2", key: "a" }],
  ["circle", { cx: "20", cy: "12", r: "2", key: "b" }],
  ["circle", { cx: "12", cy: "20", r: "2", key: "c" }],
  ["circle", { cx: "4", cy: "12", r: "2", key: "d" }],
  ["circle", { cx: "12", cy: "12", r: "1", key: "o" }],
]);
// ---------- Constraints ----------
export const CnCoincident = createLucideIcon("cn-coincident", [
  ["circle", { cx: "9", cy: "12", r: "4", key: "a" }],
  ["circle", { cx: "15", cy: "12", r: "4", key: "b" }],
]);
export const CnHorizontal = createLucideIcon("cn-horizontal", [["path", { d: "M3 12h18M3 9v6M21 9v6", key: "h" }]]);
export const CnVertical = createLucideIcon("cn-vertical", [["path", { d: "M12 3v18M9 3h6M9 21h6", key: "v" }]]);
export const CnParallel = createLucideIcon("cn-parallel", [["path", { d: "M8 20 14 4M12 20l6-16", key: "p" }]]);
export const CnPerpendicular = createLucideIcon("cn-perpendicular", [["path", { d: "M4 20h16M12 20V4", key: "p" }]]);
export const CnTangent = createLucideIcon("cn-tangent", [
  ["circle", { cx: "12", cy: "13", r: "6", key: "c" }],
  ["path", { d: "M3 7h18", key: "t" }],
]);
export const CnMidpoint = createLucideIcon("cn-midpoint", [
  ["path", { d: "M3 17 21 7", key: "l" }],
  ["circle", { cx: "12", cy: "12", r: "2.4", key: "m" }],
]);
export const CnConcentric = createLucideIcon("cn-concentric", [
  ["circle", { cx: "12", cy: "12", r: "8", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "4", key: "b" }],
]);
export const CnSymmetric = createLucideIcon("cn-symmetric", [
  ["path", { d: "M12 3v18", key: "axis", "stroke-dasharray": "2 2" }],
  ["circle", { cx: "6", cy: "12", r: "2.2", key: "a" }],
  ["circle", { cx: "18", cy: "12", r: "2.2", key: "b" }],
]);
