// Interface language. English text stays in the code as the key: t("Save As…"); ru.ts and kk.ts map it to the
// translation. tests/i18n.test.ts scans the source and fails when a text has no translation or its {placeholders}
// differ, so new text can't go untranslated. Terms that are the same in every language (DXF, Ruida, USB…) are
// simply not wrapped.
import { signal } from "@preact/signals";
import { kk } from "./kk";
import { ru } from "./ru";

export type Lang = "en" | "kk" | "ru";
/** A translation: one string, or plural forms in the order Intl.PluralRules gives for that language. */
export type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;
export type Dictionary = Record<string, Entry>;

export const LANGS: { id: Lang; label: string; name: string }[] = [
  { id: "en", label: "EN", name: "English" },
  { id: "kk", label: "ҚАЗ", name: "Қазақша" },
  { id: "ru", label: "РУС", name: "Русский" },
];

const DICTS: Record<Exclude<Lang, "en">, Dictionary> = { kk, ru };
const KEY = "ruida-web.lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "kk" || v === "ru") return v;
  } catch {
    /* storage unavailable */
  }
  return "en";
}

export const lang = signal<Lang>(initial());

export function setLang(l: Lang): void {
  lang.value = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* storage unavailable */
  }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

const fill = (s: string, params?: Record<string, string | number>) =>
  params ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : s;

/** Translate `text` (English) and fill in {placeholders}. Reading it subscribes Preact views to the language. */
export function t(text: string, params?: Record<string, string | number>): string {
  const l = lang.value;
  if (l === "en") return fill(text, params);
  const e = DICTS[l][text];
  const s = typeof e === "string" ? e : e ? (e.other ?? Object.values(e)[0]) : undefined;
  return fill(s ?? text, params);
}

/**
 * Mark English text kept in a constant (e.g. a list of tools built once) so the translation test finds it;
 * translate it where it's shown, with t(text).
 */
export const msg = (text: string): string => text;

/**
 * Plural: English forms [one, other], keyed by the first. The translation gives the language's own forms
 * ({ one, few, many, other }). `{n}` is filled with the count.
 */
export function tp(forms: [string, string], n: number, params?: Record<string, string | number>): string {
  const l = lang.value;
  const all = { n, ...params };
  if (l === "en") return fill(n === 1 ? forms[0] : forms[1], all);
  const e = DICTS[l][forms[0]];
  if (!e) return fill(n === 1 ? forms[0] : forms[1], all);
  if (typeof e === "string") return fill(e, all);
  const rule = new Intl.PluralRules(l).select(n);
  return fill(e[rule] ?? e.other ?? e.many ?? forms[1], all);
}

const normalized = new Map<Lang, Map<string, Entry>>();
/** Dictionary entries keyed by whitespace-normalised text (page markup is matched that way). */
function byNorm(l: Exclude<Lang, "en">): Map<string, Entry> {
  let m = normalized.get(l);
  if (!m) normalized.set(l, (m = new Map(Object.entries(DICTS[l]).map(([k, v]) => [norm(k), v]))));
  return m;
}

/** The translation of an English text, if there is one (for text that lives in the page markup). */
export function lookup(text: string): string | undefined {
  const l = lang.value;
  if (l === "en") return undefined;
  const e = DICTS[l][text] ?? byNorm(l).get(norm(text));
  const s = typeof e === "string" ? e : e?.other;
  return s?.trim();
}

// ---------- Plain DOM (index.html and the machine panel) ----------

const originals = new WeakMap<Node, string>();
const originalAttrs = new WeakMap<Element, Record<string, string>>();
const ATTRS = ["title", "aria-label", "placeholder"] as const;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Translate the static text under `root` (and put English back). Safe to call again after a language change. */
export function localizeDom(root: Element): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const orig = originals.get(n) ?? n.nodeValue ?? "";
    const key = norm(orig);
    if (!key) continue;
    if (!originals.has(n)) originals.set(n, orig);
    const tr = lookup(key);
    const lead = orig.match(/^\s*/)![0];
    const trail = orig.match(/\s*$/)![0];
    n.nodeValue = tr ? `${lead}${tr}${trail}` : orig;
  }
  for (const el of [root, ...root.querySelectorAll("*")]) {
    let saved = originalAttrs.get(el);
    for (const a of ATTRS) {
      const v = saved?.[a] ?? el.getAttribute(a);
      if (!v) continue;
      if (!saved) originalAttrs.set(el, (saved = {}));
      saved[a] = v;
      el.setAttribute(a, lookup(norm(v)) ?? v);
    }
  }
}
