import { describe, expect, it } from "vitest";
import { parseNumber, stepValue } from "../src/ui/NumberInput";

describe("NumberInput helpers", () => {
  it("parses numbers, decimal commas and simple arithmetic; rejects anything else", () => {
    expect(parseNumber("12.5")).toBe(12.5);
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("100/4")).toBe(25);
    expect(parseNumber("(2+3)*2")).toBe(10);
    expect(parseNumber("")).toBeNaN();
    expect(parseNumber("alert(1)")).toBeNaN();
    expect(parseNumber("1/0")).toBeNaN();
  });

  it("steps by 1, ×10 with Shift, ÷10 with Alt, clamped and without float noise", () => {
    expect(stepValue(20, 1, 1, {})).toBe(21);
    expect(stepValue(20, 1, -1, { shift: true })).toBe(10);
    expect(stepValue(0.2, 1, 1, { alt: true })).toBe(0.3);
    expect(stepValue(0.1, 0.05, -1, {}, 0.01)).toBe(0.05);
    expect(stepValue(99, 1, 1, { shift: true }, 0, 100)).toBe(100);
    expect(stepValue(0.5, 1, -1, {}, 0.1)).toBe(0.1);
  });
});
