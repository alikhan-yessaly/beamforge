import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kk } from "../src/i18n/kk";
import { ru } from "../src/i18n/ru";
import { type Dictionary, lang, t, tp } from "../src/i18n";

/** Every English text the interface translates: t("…") / tp(["…", "…"]) in src, and the text in index.html. */
export function interfaceTexts(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const unescape = (s: string) => JSON.parse(`"${s}"`) as string;
  for (const f of walk("src").filter((f) => /\.tsx?$/.test(f) && !f.startsWith(join("src", "i18n")))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/\b(?:t|msg)\(\s*"((?:[^"\\]|\\.)*)"/g)) out.add(unescape(m[1]!));
    for (const m of src.matchAll(/\btp\(\s*\[\s*"((?:[^"\\]|\\.)*)"/g)) out.add(unescape(m[1]!));
  }
  const html = readFileSync("index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<head>[\s\S]*?<\/head>/, "");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const m of html.matchAll(/>([^<>]+)</g)) {
    const s = norm(m[1]!.replace(/&amp;/g, "&"));
    if (/[A-Za-z]{2}/.test(s)) out.add(s);
  }
  for (const m of html.matchAll(/\b(?:title|aria-label|placeholder)="([^"]+)"/g)) out.add(norm(m[1]!));
  return out;
}

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const forms = (e: Dictionary[string]) => (typeof e === "string" ? [e] : Object.values(e));

describe("translations", () => {
  const texts = interfaceTexts();
  for (const [name, dict] of [["Kazakh", kk], ["Russian", ru]] as const) {
    it(`${name} covers every interface text, with the same placeholders`, () => {
      const missing = [...texts].filter((s) => !(s in dict));
      expect(missing, `missing ${name} translations`).toEqual([]);
      const wrong = Object.entries(dict).filter(([k, v]) => forms(v).some((f) => holes(f) !== holes(k)));
      expect(wrong.map(([k]) => k), `${name} placeholders differ`).toEqual([]);
    });
  }

  it("translates, fills placeholders and picks plural forms", () => {
    lang.value = "ru";
    expect(tp(["{n} degree of freedom", "{n} degrees of freedom"], 3)).toMatch(/3/);
    lang.value = "en";
    expect(t("Layer {n}", { n: 2 })).toBe("Layer 2");
    expect(tp(["{n} degree of freedom", "{n} degrees of freedom"], 1)).toBe("1 degree of freedom");
  });
});
