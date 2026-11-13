// Machine tab: simple mode (head position, jog, Go to, machine profile) or developer mode (adds connection
// details, raw status, raw bytes and the traffic log). The jog/diagnostics DOM comes from
// src/ui/machinePanel.ts and index.html; elements marked .dev-only are hidden in simple mode.
import { t } from "../i18n";
import { SlidersHorizontal, Wrench } from "lucide-preact";
import { profile } from "../scene/store";
import { classById } from "../machine/classes";
import { openTuning, stepDone } from "./TuningDialog";
import { useEffect, useRef, useState } from "preact/hooks";
import { headPos, linkState, watchHeadPosition } from "../app/connection";
import { IconButton } from "../ui/icons";
import { ProfileSection } from "./Panels";
import { headUm } from "./RunPanel";

const ADVANCED_KEY = "ruida-web.machine-advanced.v1";
const loadAdvanced = () => {
  try {
    return localStorage.getItem(ADVANCED_KEY) === "1";
  } catch {
    return false;
  }
};

const mm = (um: number) => (um / 1000).toFixed(2);

function HeadPosition(props: { active: boolean }) {
  useEffect(() => (props.active ? watchHeadPosition() : undefined), [props.active]);
  const p = headUm.value ?? headPos.value;
  const verified = linkState.value === "verified";
  return (
    <section class="ws-panel">
      <h3>{t("Head position")}</h3>
      {verified && p ? (
        <div class="ws-headpos">
          <span>
            <em>X</em> {mm(p.x)}
          </span>
          <span>
            <em>Y</em> {mm(p.y)}
          </span>
          <small>{t("mm from home")}</small>
        </div>
      ) : (
        <p class="ws-hint">{verified ? t("Reading…") : t("Connect to the machine (plug icon, top right) to see the head position.")}</p>
      )}
    </section>
  );
}

/** Tuning progress for the active machine and the way into the wizard. */
function TuningSection() {
  const p = profile.value;
  const tn = p.tuning ?? {};
  const rows: [string, string | null, Parameters<typeof openTuning>[0]][] = [
    [t("Fill evenness"), stepDone("fill"), "fill"],
    [t("Scan offset"), stepDone("scan"), "scan"],
    [t("Power and speed"), stepDone("grid"), "grid"],
    [t("Kerf"), stepDone("kerf"), "kerf"],
  ];
  const cls = classById(p.class);
  return (
    <section class="ws-panel">
      <h3>{t("Tuning")}</h3>
      <p class="ws-hint">
        {cls ? t("Untuned values come from the class “{class}”.", { class: t(cls.name) }) : t("Untuned values are generic defaults.")}{" "}
        {t("Each test card takes about 5 minutes on scrap; all are optional.")}
      </p>
      <ul class="ws-tune-list">
        {rows.map(([name, done, step]) => (
          <li key={step}>
            <button type="button" class="ws-link-btn" onClick={() => openTuning(step)}>
              {name}
            </button>
            <small>{done ? `✓ ${done}` : t("not done")}</small>
          </li>
        ))}
      </ul>
      <div class="ws-row">
        <button type="button" onClick={() => openTuning(tn.fill ? (tn.scanOffset ? "grid" : "scan") : "fill")}>
          <SlidersHorizontal size={14} strokeWidth={1.75} aria-hidden="true" /> {t("Tune this machine…")}
        </button>
        {(tn.dismissed?.length ?? 0) > 0 && (
          <button type="button" class="ws-link-btn" onClick={() => (profile.value = { ...p, tuning: { ...tn, dismissed: [] } })}>
            {t("Show hidden suggestions again")}
          </button>
        )}
      </div>
    </section>
  );
}

export function MachineTab(props: { visible: boolean; content: HTMLElement | null }) {
  const [advanced, setAdvanced] = useState(loadAdvanced);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.content && host.current && props.content.parentElement !== host.current) host.current.append(props.content);
  }, [props.content]);
  const toggle = () => {
    const next = !advanced;
    setAdvanced(next);
    try {
      localStorage.setItem(ADVANCED_KEY, next ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  return (
    <div class={`ws-machine ${advanced ? "advanced" : "simple"}`} hidden={!props.visible}>
      <div class="ws-machine-head">
        <span>{advanced ? t("Developer mode") : t("Simple mode")}</span>
        <IconButton
          icon={Wrench}
          label={advanced ? t("Developer mode: on (connection details, raw status, raw bytes, traffic log)") : t("Developer mode: off")}
          pressed={advanced}
          onClick={toggle}
        />
      </div>
      <HeadPosition active={props.visible} />
      <div ref={host} />
      <ProfileSection advanced={advanced} />
      <TuningSection />
    </div>
  );
}
