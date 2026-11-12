// Keyboard jog: hold Ctrl+Alt (⌃⌥ on a Mac) and an arrow to move the head; release to stop. Shift = 3× speed.
// Same hold-to-jog commands as the jog pad (key down / key up, stops at once). Needs a verified link and
// "I'm at the machine" ticked. (Ctrl+arrows alone switch desktops on macOS, so the second modifier is needed.)
import { t } from "../i18n";
import { atMachine, jogSpeed, link, motion } from "../app/connection";
import { JOG_KEY, type JogKey } from "../protocol/encode";
import { MAX_SPEED_MM_S } from "../controller/motion";
import { notify } from "../scene/store";

const KEYS: Record<string, JogKey> = { ArrowLeft: JOG_KEY.left, ArrowRight: JOG_KEY.right, ArrowUp: JOG_KEY.up, ArrowDown: JOG_KEY.down };

let held: string | null = null;

function release(): void {
  if (!held) return;
  held = null;
  void motion.jogRelease().catch(() => {});
}

/** True if the event is a keyboard-jog key (so other handlers ignore it). */
export const isJogKey = (e: KeyboardEvent) => e.ctrlKey && e.altKey && e.key in KEYS;

export function installKeyboardJog(): void {
  window.addEventListener("keydown", (e) => {
    if (!isJogKey(e)) return;
    e.preventDefault();
    if (e.repeat || held) return;
    if (!link.verified) return notify(t("Connect to the machine to jog."));
    if (!atMachine.value) return notify(t("Tick “I'm at the machine…” in the Machine tab to jog from the keyboard."), "warn");
    held = e.key;
    const speed = Math.min(MAX_SPEED_MM_S, jogSpeed.value * (e.shiftKey ? 3 : 1));
    void motion.jogPress(KEYS[e.key]!, speed).catch((err) => {
      held = null;
      notify(t("Jog: {error}", { error: err instanceof Error ? err.message : String(err) }), "error");
    });
  });
  window.addEventListener("keyup", (e) => {
    if (held && (e.key === held || e.key === "Control" || e.key === "Alt")) release();
  });
  window.addEventListener("blur", release);
}
