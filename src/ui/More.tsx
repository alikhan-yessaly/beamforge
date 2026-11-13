// A long explanation folded under a one-line summary. Whether it is open is remembered per `id`.
import type { ComponentChildren } from "preact";
import { ChevronRight } from "lucide-preact";

const KEY = "ruida-web.more";

function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function save(id: string, open: boolean) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...load(), [id]: open }));
  } catch {
    // Storage blocked: the fold just isn't remembered.
  }
}

export function More(p: { id: string; summary: string; children: ComponentChildren }) {
  return (
    <details class="ws-more" open={load()[p.id] ?? false} onToggle={(e) => save(p.id, e.currentTarget.open)}>
      <summary>
        <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
        {p.summary}
      </summary>
      <div class="ws-more-body">{p.children}</div>
    </details>
  );
}
