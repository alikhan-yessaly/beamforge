// Default object names ("Sketch 3") and cleaning up names people type.
import type { SceneObject } from "./model";

/** Every object name in the document, group members included. */
export function allNames(objects: readonly SceneObject[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly SceneObject[]) => {
    for (const o of list) {
      out.push(o.name);
      if (o.children) walk(o.children);
    }
  };
  walk(objects);
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The next numbered name for `template` (which holds "{n}", e.g. "Sketch {n}"): one more than the highest number
 * already used, so a deleted "Sketch 2" isn't handed out again. Starts at 1.
 */
export function nextNumberedName(names: readonly string[], template: string): string {
  const [before, after = ""] = template.split("{n}");
  const re = new RegExp(`^${escape(before!.trim())}\\s*(\\d+)\\s*${escape(after.trim())}$`, "i");
  let max = 0;
  for (const name of names) {
    const m = re.exec(name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return template.replace("{n}", String(max + 1));
}

/** A typed name, trimmed and with runs of whitespace collapsed; null when nothing is left. */
export function cleanName(text: string, maxLength = 120): string | null {
  const s = text.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return s ? s : null;
}
