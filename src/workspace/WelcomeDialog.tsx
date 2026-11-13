// First visit: language, which kind of machine, and how to start (the sample, an empty bed, or the simulator).
// Shown once; Help in the status bar opens it again.
import { signal } from "@preact/signals";
import { FilePlus, Monitor, Sparkles } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { LANGS, lang, setLang, t } from "../i18n";
import { linkState } from "../app/connection";
import { MACHINE_CLASSES, applyClass, classById } from "../machine/classes";
import { doc, profile, updateMachine } from "../scene/store";
import { openSample } from "../project/state";
import { presets, presetsFor, savePresets, seedPresets } from "./materials";
import { useSimulator } from "./Notices";
import { appMode, enterPrepare } from "./mode";

const KEY = "ruida-web.welcome.v1";

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(KEY, new Date().toISOString());
  } catch {
    /* shows again next visit */
  }
}

/** A first visit: never welcomed, nothing drawn, no machine kind chosen. Returning users are marked seen quietly. */
function firstVisit(): boolean {
  if (seen()) return false;
  if (doc.peek().objects.length || profile.peek().class) {
    markSeen();
    return false;
  }
  return true;
}

export const welcomeOpen = signal(firstVisit());

export function WelcomeDialog() {
  const open = welcomeOpen.value;
  const ref = useRef<HTMLDialogElement>(null);
  const [cls, setCls] = useState(profile.value.class ?? "");
  const [seed, setSeed] = useState(true);
  useEffect(() => {
    if (open && !ref.current?.open) {
      setCls(profile.value.class ?? "");
      ref.current?.showModal();
    }
  }, [open]);
  if (!open) return null;

  const close = () => {
    ref.current?.close();
    welcomeOpen.value = false;
    markSeen();
  };
  /** Apply the machine kind (if one was picked and it changed), then leave. */
  const finish = (then?: () => boolean | void) => {
    const c = classById(cls);
    const m = profile.value;
    if (c && m.class !== c.id) {
      const next = applyClass(m, c, linkState.value === "verified" && !!m.controller);
      updateMachine(next);
      if (seed && presetsFor(next).length === 0) savePresets([...presets.value, ...seedPresets(next, c)]);
    }
    if (then) {
      if (appMode.value === "device") enterPrepare();
      if (then() === false) return;
    }
    close();
  };
  const sample = () => openSample();
  const simulator = () => {
    if (!openSample()) return false;
    useSimulator();
  };

  return (
    <dialog
      ref={ref}
      class="ws-dialog ws-welcome"
      aria-labelledby="ws-welcome-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="ws-welcome-title">{t("Welcome to BeamForge")}</h2>
      <p class="ws-hint">{t("Design, prepare and run jobs on a Ruida laser, right in the browser. Three quick choices to get going; everything can be changed later.")}</p>

      <h4>{t("1. Language")}</h4>
      <div class="ws-segmented ws-welcome-langs" role="group" aria-label={t("Interface language")}>
        {LANGS.map((l) => (
          <button key={l.id} type="button" class={lang.value === l.id ? "on" : ""} aria-pressed={lang.value === l.id} onClick={() => setLang(l.id)}>
            {l.name}
          </button>
        ))}
      </div>

      <h4>{t("2. Your machine")}</h4>
      <label class="ws-welcome-field">
        <span>{t("Kind of machine")}</span>
        <select value={cls} onChange={(e) => setCls(e.currentTarget.value)}>
          <option value="">{t("Not sure yet")}</option>
          {MACHINE_CLASSES.map((c) => (
            <option key={c.id} value={c.id}>
              {t(c.name)}
            </option>
          ))}
        </select>
      </label>
      {cls && (
        <label class="ws-check">
          <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.currentTarget.checked)} /> {t("Add typical material presets (plywood, acrylic, cardboard, leather)")}
        </label>
      )}
      <p class="ws-hint">{t("This sets typical speed-up, start speed and starting material settings. You can tune them to your machine later.")}</p>

      <h4>{t("3. How do you want to start?")}</h4>
      <div class="ws-welcome-starts">
        <button type="button" class="ws-welcome-start" onClick={() => finish(sample)}>
          <Sparkles size={20} strokeWidth={1.75} aria-hidden="true" />
          <b>{t("Open the sample")}</b>
          <small>{t("A small tag: cut outline and hole, engraved star. Look at its layers, then press Prepare job.")}</small>
        </button>
        <button type="button" class="ws-welcome-start" onClick={() => finish()}>
          <FilePlus size={20} strokeWidth={1.75} aria-hidden="true" />
          <b>{t("Start empty")}</b>
          <small>{t("Import a drawing (DXF, SVG, PDF, pictures) or start a sketch.")}</small>
        </button>
        <button type="button" class="ws-welcome-start" onClick={() => finish(simulator)}>
          <Monitor size={20} strokeWidth={1.75} aria-hidden="true" />
          <b>{t("Try the simulator")}</b>
          <small>{t("No laser needed: the sample, and a pretend machine that frames and runs it on screen.")}</small>
        </button>
      </div>
      <p class="ws-hint ws-welcome-foot">{t("The Help button (?) at the bottom right opens this again.")}</p>
    </dialog>
  );
}

