import { describe, expect, it } from "vitest";
import { writePdf } from "../src/export/pdf";
import { fillRegions } from "../src/export/regions";
import { writeSvg } from "../src/export/svg";
import { pointInPolygon } from "../src/geom/geom";
import type { ExportPath } from "../src/import/types";

const sq = (c: number, r: number, color: string, extra: Partial<ExportPath> = {}): ExportPath => ({
  points: [
    { x: c - r, y: c - r },
    { x: c + r, y: c - r },
    { x: c + r, y: c + r },
    { x: c - r, y: c + r },
  ],
  closed: true,
  color,
  ...extra,
});

const BLUE = "#0000ff", GREEN = "#00a000", RED = "#ff0000";

/** The colour a point ends up with: the regions are meant to be disjoint, so at most one may cover it. */
function colourAt(paths: ExportPath[], x: number, y: number): string | null {
  const hits = fillRegions(paths).filter((r) => r.rings.filter((ring) => pointInPolygon({ x, y }, ring)).length % 2 === 1);
  expect(hits.length, `regions overlapping at ${x},${y}`).toBeLessThanOrEqual(1);
  return hits[0]?.color ?? null;
}

describe("export fill regions", () => {
  it("a fill-layer shape inside a fill-layer shape of another colour keeps its colour", () => {
    const paths = [sq(50, 40, BLUE, { fillLayer: true }), sq(50, 10, GREEN, { fillLayer: true })];
    expect(colourAt(paths, 15, 15)).toBe(BLUE);
    expect(colourAt(paths, 50, 50)).toBe(GREEN);
    // Order in the file doesn't matter.
    expect(colourAt([...paths].reverse(), 50, 50)).toBe(GREEN);
  });

  it("same-colour nesting stays even-odd: hole, then island", () => {
    const paths = [sq(50, 40, BLUE, { fillLayer: true }), sq(50, 25, BLUE, { fillLayer: true }), sq(50, 10, BLUE, { fillLayer: true })];
    expect(colourAt(paths, 15, 15)).toBe(BLUE);
    expect(colourAt(paths, 30, 30)).toBeNull();
    expect(colourAt(paths, 50, 50)).toBe(BLUE);
  });

  it("three colours deep, across a cut outline in between", () => {
    const paths = [
      sq(50, 45, BLUE, { fillLayer: true }),
      sq(50, 30, RED), // cut only, no fill
      sq(50, 20, GREEN, { fillLayer: true }),
      sq(50, 8, BLUE, { fillLayer: true }),
    ];
    expect(colourAt(paths, 10, 10)).toBe(BLUE);
    expect(colourAt(paths, 25, 25)).toBe(BLUE); // inside the red outline: a fill layer fills over it
    expect(colourAt(paths, 35, 35)).toBe(GREEN);
    // Blue is even-odd: its inner square is a hole in blue, so green engraves through it (as on the machine).
    expect(colourAt(paths, 50, 50)).toBe(GREEN);
    // A third blue square makes an island again, inside green: blue there.
    expect(colourAt([...paths, sq(50, 4, BLUE, { fillLayer: true })], 50, 50)).toBe(BLUE);
  });

  it("area fills (Fill tool / imported fill under an outline) nest the same way", () => {
    const paths = [sq(50, 40, RED, { fill: BLUE }), sq(50, 25, RED, { fill: GREEN }), sq(50, 10, RED)];
    expect(colourAt(paths, 15, 15)).toBe(BLUE);
    expect(colourAt(paths, 30, 30)).toBe(GREEN);
    expect(colourAt(paths, 50, 50)).toBeNull(); // a closed path inside an area fill is a hole
    expect(fillRegions(paths).every((r) => r.layer === RED)).toBe(true);
  });

  it("an area fill on a fill-layer shape's inside", () => {
    const paths = [sq(50, 40, BLUE, { fillLayer: true }), sq(50, 15, RED, { fill: GREEN })];
    expect(colourAt(paths, 15, 15)).toBe(BLUE);
    expect(colourAt(paths, 50, 50)).toBe(GREEN);
  });

  it("SVG and PDF cut the inner shape out of the outer fill", () => {
    const paths = [sq(50, 40, BLUE, { fillLayer: true }), sq(50, 10, GREEN, { fillLayer: true })];
    const svg = writeSvg(paths);
    const blue = /<path d="([^"]+)" fill="#0000ff"/.exec(svg)![1]!;
    expect(blue.match(/M/g)).toHaveLength(2); // outline + hole
    expect(svg).toMatch(/fill="#00a000"/);
    const pdf = new TextDecoder().decode(writePdf(paths));
    const blueFill = pdf.split("\n").find((l, i, a) => a[i - 1]?.startsWith("0 0 1 rg"))!;
    expect(blueFill.match(/ m/g)).toHaveLength(2);
  });
});
