// Keyboard shortcut sheet: press ? (or the keyboard icon in the status bar).
import { msg, t } from "../i18n";
import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";

export const shortcutsOpen = signal(false);

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const M = mac ? "⌘" : "Ctrl+";
const S = mac ? "⇧" : "Shift+";
const JOG = mac ? "⌃⌥ + ↑↓←→" : "Ctrl+Alt + ↑↓←→";

const GROUPS: [string, [string, string][]][] = [
  [msg("Project"), [[`${M}O`, msg("Open a project")], [`${M}S`, msg("Save")], [`${S}${M}S`, msg("Save As")], [`${M}E`, msg("Export the selection or everything")]]],
  [
    msg("Edit"),
    [
      [`${M}Z / ${S}${M}Z`, msg("Undo / redo")],
      [`${M}C · ${M}X · ${M}V`, msg("Copy · cut · paste")],
      [`${M}D`, msg("Duplicate")],
      [`${M}A`, msg("Select all")],
      ["⌫", msg("Delete")],
      ["F2", msg("Rename")],
      ["Esc", msg("Deselect")],
      [`${M}G / ${S}${M}G`, msg("Group / ungroup")],
      [msg("Arrows"), msg("Nudge 1 mm (Shift 10 mm, Alt 0.1 mm)")],
    ],
  ],
  [
    msg("Canvas"),
    [
      [msg("Drag"), msg("Move (Shift: one axis; Alt: no snap)")],
      [msg("Corner / edge handles"), msg("Scale (Shift: free aspect; Alt: from centre)")],
      [msg("Top handle"), msg("Rotate (Shift: 15° steps)")],
      [msg("Wheel / pinch"), msg("Zoom")],
      [msg("Space-drag, right-drag, two-finger scroll"), "Pan"],
      ["F · B", msg("Zoom to the selection (or the whole drawing) · zoom to bed")],
      ["P", msg("Toolpath preview")],
      [msg("Right-click"), msg("Object menu")],
    ],
  ],
  [msg("Number fields"), [[msg("↑ / ↓, wheel"), msg("Step (Shift ×10, Alt ÷10)")], ["Enter · Esc", msg("Apply · revert")], ["100/3, 20+5", msg("Arithmetic works")]]],
  [msg("Machine"), [[JOG, msg("Hold to jog (Shift: faster); needs “I'm at the machine”")], ["Esc", msg("Software STOP while connected (not an E-stop)")]]],
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
      <h3>{t("Keyboard shortcuts")}</h3>
      <div class="ws-shortcut-groups">
        {GROUPS.map(([title, rows]) => (
          <section key={title}>
            <h4>{t(title)}</h4>
            <dl>
              {rows.map(([k, what]) => (
                <Fragment key={k}>
                  <dt>
                    <kbd>{t(k)}</kbd>
                  </dt>
                  <dd>{t(what)}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}
