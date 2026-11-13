// Power settings, shared by layer cards and the material library.
//
// How a Ruida uses them: at or below the controller's start speed (a machine setting, often 10 mm/s; corners
// and line ends) it fires at the corner power (`minPower`), rising linearly to the power (`maxPower`) at the
// layer speed. Linked = corner power follows power (constant power, the usual choice for cutting).
import { t } from "../i18n";
import { Flame, Link2, Unlink2 } from "lucide-preact";
import { NumberInput } from "../ui/NumberInput";
import { IconButton } from "../ui/icons";
import { ASSUMED_START_SPEED as START } from "../scene/model";


export interface PowerPatch {
  minPower?: number;
  maxPower?: number;
  linkPower?: boolean;
}

function PctInput(props: { value: number; label: string; disabled?: boolean; onCommit: (v: number) => void }) {
  return <NumberInput class="ws-pct" value={props.value} label={props.label} disabled={props.disabled} step={1} min={0} max={100} onCommit={props.onCommit} />;
}

/** Speed → power sketch: flat at corner power up to the start speed, then rising to power at the layer speed. */
export function PowerRamp(props: { min: number; max: number; speed: number; start?: number }) {
  const ASSUMED_START_SPEED = props.start ?? START;
  const w = 44;
  const h = 20;
  const y = (pct: number) => h - 2 - (Math.max(0, Math.min(100, pct)) / 100) * (h - 4);
  const xs = props.speed > ASSUMED_START_SPEED ? (ASSUMED_START_SPEED / props.speed) * (w - 4) + 2 : w - 2;
  const pts = `2,${y(props.min)} ${xs},${y(props.min)} ${w - 2},${y(props.speed > ASSUMED_START_SPEED ? props.max : props.min)}`;
  const note =
    props.speed > ASSUMED_START_SPEED
      ? t("Power vs speed: {min} % at corners (at or below the machine's start speed, often {start} mm/s), rising to {max} % at {speed} mm/s.", { min: props.min, start: ASSUMED_START_SPEED, max: props.max, speed: props.speed })
      : t("At {speed} mm/s (not above the machine's start speed, often {start} mm/s) the laser stays at the corner power, {min} %.", { speed: props.speed, start: ASSUMED_START_SPEED, min: props.min });
  return (
    <svg class="ws-ramp" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={note}>
      <title>{note}</title>
      <path d={`M2 ${h - 2}H${w - 2}M2 2V${h - 2}`} class="axis" />
      <polyline points={pts} class="line" />
    </svg>
  );
}

export function PowerRow(props: { min: number; max: number; speed: number; linked: boolean; onChange: (p: PowerPatch) => void; startSpeed?: number; suggest?: number }) {
  const sg = props.suggest;
  return (
    <>
    <div class="ws-layer-fields ws-power">
      <label class="ws-lf" title={t("Power at full speed (% of the tube's maximum)")}>
        <Flame size={14} strokeWidth={1.75} aria-hidden="true" />
        <PctInput value={props.max} label={t("Power at full speed (% of the tube's maximum)")} onCommit={(maxPower) => props.onChange({ maxPower })} />
        <em>%</em>
      </label>
      <div class="ws-lf ws-power-corner" title={t("Corner power: used at or below the machine's start speed (corners, line ends), rising to the power at full speed. Too high burns corners; too low may not fire there.")}>
        <IconButton
          icon={props.linked ? Link2 : Unlink2}
          label={props.linked ? t("Corner power follows power (constant power): on. Click to set a lower corner power.") : t("Corner power follows power: off. Click to link it to power.")}
          pressed={props.linked}
          onClick={() => props.onChange({ linkPower: !props.linked })}
        />
        <PctInput value={props.min} label={t("Corner power (%)")} disabled={props.linked} onCommit={(minPower) => props.onChange({ minPower, linkPower: false })} />
        <em>%</em>
      </div>
    </div>
    {sg !== undefined && sg < props.min - 0.05 && (
      <div class="ws-suggest">
        <small>{t("Suggested corner power: {p} % (even depth at row ends; the tube's lowest power allowing).", { p: sg })}</small>
        <button type="button" class="ws-link-btn" onClick={() => props.onChange({ minPower: sg, linkPower: false })}>
          {t("Use it")}
        </button>
      </div>
    )}
    </>
  );
}
