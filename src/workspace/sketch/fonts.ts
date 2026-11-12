// Fonts for sketch text: a bundled default (Roboto, SIL OFL 1.1) and the computer's own fonts through Chrome's
// Local Font Access API. Parsed fonts are cached; the canvas redraws (fontsVersion) when one finishes loading.
import robotoUrl from "@fontsource/roboto/files/roboto-latin-400-normal.woff?url";
import { signal } from "@preact/signals";
import { type Font, parse } from "opentype.js";
import { pt } from "../../sketch/model";
import { registerTextOutlines } from "../../sketch/paths";
import { textEntityContours } from "../../sketch/text";

export const DEFAULT_FONT = "Roboto";
/** Bumped when a font finishes loading, so text redraws. */
export const fontsVersion = signal(0);

const fonts = new Map<string, Font | null>();
const loading = new Map<string, Promise<Font | null>>();

interface LocalFont {
  family: string;
  fullName: string;
  style: string;
  blob(): Promise<Blob>;
}
type QueryLocalFonts = () => Promise<LocalFont[]>;
const queryLocalFonts = (): QueryLocalFonts | undefined => (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;

/** The computer's font families (asks for permission the first time). Empty where the browser can't list them. */
export async function localFontFamilies(): Promise<string[]> {
  const q = queryLocalFonts();
  if (!q) return [];
  try {
    const all = await q();
    return [...new Set(all.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export const canListLocalFonts = () => !!queryLocalFonts();

async function fetchFont(name: string): Promise<ArrayBuffer | null> {
  if (name === DEFAULT_FONT) return (await fetch(robotoUrl)).arrayBuffer();
  const q = queryLocalFonts();
  if (!q) return null;
  const faces = (await q()).filter((f) => f.family === name);
  const face = faces.find((f) => /^(regular|normal|book|roman)$/i.test(f.style)) ?? faces[0];
  return face ? (await face.blob()).arrayBuffer() : null;
}

/** Load (once) and cache a font; null if it can't be read or parsed. */
export function loadFont(name: string): Promise<Font | null> {
  const got = loading.get(name);
  if (got) return got;
  const p = fetchFont(name)
    .then((buf) => (buf ? parse(buf) : null))
    .catch(() => null)
    .then((f) => {
      fonts.set(name, f);
      fontsVersion.value++;
      return f;
    });
  loading.set(name, p);
  return p;
}

/** The parsed font if it's ready (starts loading it otherwise). A font that failed falls back to the default. */
export function fontFor(name: string): Font | null | undefined {
  if (fonts.has(name)) return fonts.get(name) ?? (name === DEFAULT_FONT ? null : fontFor(DEFAULT_FONT));
  void loadFont(name);
  return undefined;
}

registerTextOutlines((s, e) => {
  const f = fontFor(e.font);
  if (f === undefined) return null;
  return f ? textEntityContours(f, e, pt(s, e.anchor)) : [];
});
void loadFont(DEFAULT_FONT);
