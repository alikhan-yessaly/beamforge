// Remembered first-job events (prepared, framed, started) and whether the checklist was hidden.
import { signal } from "@preact/signals";
import type { StepId } from "../app/firstJob";

const KEY = "ruida-web.firstjob.v1";

interface Stored {
  seen: StepId[];
  hidden: boolean;
}

function load(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && Array.isArray(v.seen)) return { seen: v.seen, hidden: !!v.hidden };
  } catch {
    /* fresh */
  }
  return { seen: [], hidden: false };
}

export const firstJob = signal<Stored>(load());

function save(next: Stored): void {
  firstJob.value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not remembered */
  }
}

export function markStep(id: StepId): void {
  const s = firstJob.peek();
  if (!s.seen.includes(id)) save({ ...s, seen: [...s.seen, id] });
}

export function hideChecklist(hidden = true): void {
  save({ ...firstJob.peek(), hidden });
}
