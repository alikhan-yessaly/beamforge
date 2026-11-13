// A name that turns into a text field for renaming: Enter or leaving the field keeps it, Escape cancels.
import { useEffect, useRef } from "preact/hooks";
import { cleanName } from "../scene/names";

interface Props {
  value: string;
  /** Accessible name of the field, e.g. "Object name". */
  label: string;
  class?: string;
  onCommit: (name: string) => void;
  /** Called after commit or cancel. */
  onDone: () => void;
}

export function InlineNameField(p: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (keep: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const name = cleanName(ref.current?.value ?? "");
    if (keep && name && name !== p.value) p.onCommit(name);
    p.onDone();
  };
  return (
    <input
      ref={ref}
      class={`ws-name-field${p.class ? ` ${p.class}` : ""}`}
      aria-label={p.label}
      defaultValue={p.value}
      maxLength={120}
      spellcheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
    />
  );
}
