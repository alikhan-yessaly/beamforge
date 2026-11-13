// Help (status bar): the welcome guide, keyboard shortcuts, connection help, copying diagnostics, safety notes.
import { signal } from "@preact/signals";
import { CircleHelp, ClipboardCopy, Keyboard, PlugZap, ShieldAlert, Sparkles } from "lucide-preact";
import { useEffect, useRef } from "preact/hooks";
import { t } from "../i18n";
import { IconButton } from "../ui/icons";
import { shortcutsOpen } from "./ShortcutSheet";
import { welcomeOpen } from "./WelcomeDialog";
import { connHelpOpen } from "./ConnectionHelp";
import { copyDiagnostics } from "./diagnostics";

export const helpOpen = signal(false);

export function HelpMenu() {
  const open = helpOpen.value;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && (helpOpen.value = false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (helpOpen.value = false);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const run = (f: () => void) => () => {
    helpOpen.value = false;
    f();
  };
  const items = [
    { id: "welcome", icon: Sparkles, label: t("Welcome guide"), action: () => (welcomeOpen.value = true) },
    { id: "keys", icon: Keyboard, label: t("Keyboard shortcuts (?)"), action: () => (shortcutsOpen.value = true) },
    { id: "conn", icon: PlugZap, label: t("Connection help"), action: () => (connHelpOpen.value = true) },
    { id: "diag", icon: ClipboardCopy, label: t("Copy diagnostics"), action: () => void copyDiagnostics() },
  ];
  return (
    <div class="ws-help" ref={ref}>
      <IconButton icon={CircleHelp} label={t("Help")} pressed={open} onClick={() => (helpOpen.value = !open)} />
      {open && (
        <div class="ws-help-menu" role="menu" aria-label={t("Help")}>
          {items.map((i) => (
            <button key={i.id} type="button" role="menuitem" onClick={run(i.action)}>
              <i.icon size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>{i.label}</span>
            </button>
          ))}
          <a role="menuitem" href="https://github.com/alikhan-yessaly/beamforge#safety-and-limitations" target="_blank" rel="noopener noreferrer" onClick={() => (helpOpen.value = false)}>
            <ShieldAlert size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{t("Safety and limitations")}</span>
          </a>
        </div>
      )}
    </div>
  );
}
