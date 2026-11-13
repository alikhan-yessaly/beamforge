// Length units shown in the interface. Everything is stored and sent in mm; inches are only for display and typing.

export type Units = "mm" | "in";

export const MM_PER_IN = 25.4;

export const toUnits = (mm: number, u: Units): number => (u === "in" ? mm / MM_PER_IN : mm);
export const fromUnits = (v: number, u: Units): number => (u === "in" ? v * MM_PER_IN : v);

/** Decimals worth showing: 0.01 mm, 0.001 in. */
export const unitDecimals = (u: Units): number => (u === "in" ? 3 : 2);

/** A length rounded for display, trailing zeros trimmed. */
export function formatLength(mm: number, u: Units, fixed = false): string {
  const v = toUnits(mm, u);
  return fixed ? v.toFixed(unitDecimals(u)) : String(Number(v.toFixed(unitDecimals(u))));
}

/** Snap steps offered for each unit, in mm. */
export const SNAP_STEPS: Record<Units, number[]> = {
  mm: [0.5, 1, 5, 10, 50],
  in: [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1].map((s) => s * MM_PER_IN),
};

/** A snap step's label in its unit ("1/8", "0.5"). */
export function stepLabel(mm: number, u: Units): string {
  if (u === "mm") return String(mm);
  const inch = mm / MM_PER_IN;
  for (const d of [1, 2, 4, 8, 16]) {
    const n = Math.round(inch * d);
    if (Math.abs(n / d - inch) < 1e-9) return d === 1 ? String(n) : `${n}/${d}`;
  }
  return formatLength(mm, u);
}

/** Grid spacing (in mm) for the zoom (px per mm): minor lines at least 7 px apart, majors at round numbers of the unit. */
export function gridSteps(zoom: number, u: Units = "mm"): { minor: number; major: number } {
  const k = u === "in" ? MM_PER_IN : 1;
  const ladder: [number, number][] = u === "in" ? [[1 / 8, 1], [1 / 4, 1], [1, 10], [5, 50], [10, 100]] : [[1, 10], [5, 50], [10, 100], [50, 500], [100, 1000]];
  for (const [minor, major] of ladder) if (minor * k * zoom >= 7) return { minor: minor * k, major: major * k };
  let minor = (u === "in" ? 50 : 500) * k;
  while (minor * zoom < 7) minor *= 10;
  return { minor, major: minor * 10 };
}
