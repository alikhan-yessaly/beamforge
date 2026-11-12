// One number field for the whole app: type and press Enter (or leave the field) to commit, Esc to revert,
// ↑/↓ to step (Shift ×10, Alt ÷10) and the mouse wheel to step while the field has focus. Steps commit at once,
// so whatever depends on the value (estimate, preview) updates live. Simple arithmetic is allowed: "100/3", "20+5".
import { useEffect, useRef, useState } from "preact/hooks";

export interface NumberInputProps {
  value: number | null;
  onCommit: (v: number) => void;
  /** Accessible name and tooltip. */
  label: string;
  step?: number;
  min?: number;
  max?: number;
  /** Decimals shown when not editing (default: up to 2, trailing zeros trimmed). */
  decimals?: number;
  disabled?: boolean;
  class?: string;
  /** Called with an error message when the typed text isn't a number in range. */
  onInvalid?: (message: string) => void;
  /** Initial typed text, used when a keyboard shortcut opens the input. */
  initialText?: string;
  /** Confirm the displayed value on Enter even if it wasn't edited. */
  commitOnEnter?: boolean;
  /** Whether leaving the field commits typed text (default: true). */
  commitOnBlur?: boolean;
}

/** Parse a number or a simple arithmetic expression (digits, + - * / ( ) . and spaces). */
export function parseNumber(text: string): number {
  const t = text.trim().replace(",", ".");
  if (!t || !/^[\d+\-*/(). ]+$/.test(t)) return Number.NaN;
  try {
    const v = Number(Function(`"use strict"; return (${t});`)());
    return Number.isFinite(v) ? v : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

export function stepValue(v: number, step: number, dir: 1 | -1, mods: { shift?: boolean; alt?: boolean }, min?: number, max?: number): number {
  const k = mods.shift ? 10 : mods.alt ? 0.1 : 1;
  const raw = v + dir * step * k;
  // Avoid 0.30000000000000004-style results.
  const rounded = Math.round(raw * 1e6) / 1e6;
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, rounded));
}

const show = (v: number | null, decimals?: number) => {
  if (v === null) return "";
  if (decimals !== undefined) return v.toFixed(decimals);
  return String(Math.round(v * 100) / 100);
};

export function NumberInput(p: NumberInputProps) {
  const [text, setText] = useState<string | null>(p.initialText ?? null);
  const ref = useRef<HTMLInputElement>(null);
  const latest = useRef(p);
  latest.current = p;
  // Value sent by the last step, until the new value comes back through props (key repeat can outrun renders).
  const pending = useRef<number | null>(null);
  useEffect(() => {
    pending.current = null;
  }, [p.value]);

  const current = () => {
    const t = text === null ? Number.NaN : parseNumber(text);
    return Number.isFinite(t) ? t : (p.value ?? 0);
  };
  const commit = (v: number) => {
    const q = latest.current;
    if (q.min !== undefined && v < q.min) return q.onInvalid?.(`${q.label} must be at least ${q.min}.`);
    if (q.max !== undefined && v > q.max) return q.onInvalid?.(`${q.label} must be at most ${q.max}.`);
    q.onCommit(v);
  };
  const done = (confirm = false) => {
    if (text === null && !confirm) return;
    const v = text === null ? p.value : parseNumber(text);
    setText(null);
    if (v !== null && Number.isFinite(v)) commit(v);
    else p.onInvalid?.(`${p.label}: “${text}” is not a number.`);
  };
  const step = (dir: 1 | -1, mods: { shift?: boolean; alt?: boolean }) => {
    const q = latest.current;
    const v = stepValue(pending.current ?? current(), q.step ?? 1, dir, mods, q.min, q.max);
    pending.current = v;
    setText(null);
    q.onCommit(v);
  };

  // Wheel stepping needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (document.activeElement !== el || el.disabled) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1, { shift: e.shiftKey, alt: e.altKey });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  return (
    <input
      ref={ref}
      class={p.class}
      inputMode="decimal"
      aria-label={p.label}
      title={p.label}
      disabled={p.disabled}
      value={text ?? show(p.value, p.decimals)}
      onInput={(e) => setText(e.currentTarget.value)}
      onBlur={() => {
        if (p.commitOnBlur !== false) done();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(p.commitOnEnter);
        else if (e.key === "Escape") setText(null);
        else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          step(e.key === "ArrowUp" ? 1 : -1, { shift: e.shiftKey, alt: e.altKey });
        }
      }}
    />
  );
}
