// Machine tab: simple mode (head position, jog, Go to, machine profile) or developer mode (adds connection
// details, raw status, raw bytes and the traffic log). The jog/diagnostics DOM comes from
// src/ui/machinePanel.ts and index.html; elements marked .dev-only are hidden in simple mode.
import { t } from "../i18n";
import { Wrench } from "lucide-preact";
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
    </div>
  );
}
