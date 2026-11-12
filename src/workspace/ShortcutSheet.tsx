// Keyboard shortcut sheet: press ? (or the keyboard icon in the status bar).
import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";

export const shortcutsOpen = signal(false);

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const M = mac ? "⌘" : "Ctrl+";
const S = mac ? "⇧" : "Shift+";
const JOG = mac ? "⌃⌥ + arrows" : "Ctrl+Alt + arrows";

const GROUPS: [string, [string, string][]][] = [
  ["Project", [[`${M}O`, "Open a project"], [`${M}S`, "Save"], [`${S}${M}S`, "Save As"]]],
  [
    "Edit",
    [
      [`${M}Z / ${S}${M}Z`, "Undo / redo"],
      [`${M}C · ${M}X · ${M}V`, "Copy · cut · paste"],
      [`${M}D`, "Duplicate"],
      [`${M}A`, "Select all"],
      ["⌫", "Delete"],
      ["Esc", "Deselect"],
      [`${M}G / ${S}${M}G`, "Group / ungroup"],
      ["Arrows", "Nudge 1 mm (Shift 10 mm, Alt 0.1 mm)"],
    ],
  ],
  [
    "Canvas",
    [
      ["Drag", "Move (Shift: one axis; Alt: no snap)"],
      ["Corner / edge handles", "Scale (Shift: free aspect; Alt: from centre)"],
      ["Top handle", "Rotate (Shift: 15° steps)"],
      ["Wheel / pinch", "Zoom"],
      ["Space-drag, right-drag, two-finger scroll", "Pan"],
      ["F · B", "Zoom to selection · zoom to bed"],
      ["P", "Toolpath preview"],
      ["Right-click", "Object menu"],
    ],
  ],
  ["Number fields", [["↑ / ↓, wheel", "Step (Shift ×10, Alt ÷10)"], ["Enter · Esc", "Apply · revert"], ["100/3, 20+5", "Arithmetic works"]]],
  ["Machine", [[JOG, "Hold to jog (Shift: faster); needs “I'm at the machine”"], ["Esc", "Software STOP while connected (not an E-stop)"]]],
];

export function ShortcutSheet() {
  const ref = useRef<HTMLDialogElement>(null);
  const open = shortcutsOpen.value;
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog ref={ref} class="ws-dialog ws-shortcuts" onClose={() => (shortcutsOpen.value = false)} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <h3>Keyboard shortcuts</h3>
      <div class="ws-shortcut-groups">
        {GROUPS.map(([title, rows]) => (
          <section key={title}>
            <h4>{title}</h4>
            <dl>
              {rows.map(([k, what]) => (
                <Fragment key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}
