// Power settings, shared by layer cards and the material library.
//
// How a Ruida uses them: at or below the controller's start speed (a machine setting, often 10 mm/s; corners
// and line ends) it fires at the corner power (`minPower`), rising linearly to the power (`maxPower`) at the
// layer speed. Linked = corner power follows power (constant power, the usual choice for cutting).
import { Flame, Link2, Unlink2 } from "lucide-preact";
import { NumberInput } from "../ui/NumberInput";
import { IconButton } from "../ui/icons";

/** Typical Ruida start speed; the real value is a machine setting we can't read yet. */
export const ASSUMED_START_SPEED = 10;

export interface PowerPatch {
  minPower?: number;
  maxPower?: number;
  linkPower?: boolean;
}

function PctInput(props: { value: number; label: string; disabled?: boolean; onCommit: (v: number) => void }) {
  return <NumberInput class="ws-pct" value={props.value} label={props.label} disabled={props.disabled} step={1} min={0} max={100} onCommit={props.onCommit} />;
}

/** Speed → power sketch: flat at corner power up to the start speed, then rising to power at the layer speed. */
export function PowerRamp(props: { min: number; max: number; speed: number }) {
  const w = 44;
  const h = 20;
  const y = (pct: number) => h - 2 - (Math.max(0, Math.min(100, pct)) / 100) * (h - 4);
  const xs = props.speed > ASSUMED_START_SPEED ? (ASSUMED_START_SPEED / props.speed) * (w - 4) + 2 : w - 2;
  const pts = `2,${y(props.min)} ${xs},${y(props.min)} ${w - 2},${y(props.speed > ASSUMED_START_SPEED ? props.max : props.min)}`;
  const note =
    props.speed > ASSUMED_START_SPEED
      ? `Power vs speed: ${props.min} % at corners (at or below the machine's start speed, often ${ASSUMED_START_SPEED} mm/s), rising to ${props.max} % at ${props.speed} mm/s.`
      : `At ${props.speed} mm/s (not above the machine's start speed, often ${ASSUMED_START_SPEED} mm/s) the laser stays at the corner power, ${props.min} %.`;
  return (
    <svg class="ws-ramp" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={note}>
      <title>{note}</title>
      <path d={`M2 ${h - 2}H${w - 2}M2 2V${h - 2}`} class="axis" />
      <polyline points={pts} class="line" />
    </svg>
  );
}

export function PowerRow(props: { min: number; max: number; speed: number; linked: boolean; onChange: (p: PowerPatch) => void }) {
  return (
    <div class="ws-power">
      <Flame size={14} strokeWidth={1.75} aria-hidden="true" />
      <PctInput value={props.max} label="Power at full speed (% of the tube's maximum)" onCommit={(maxPower) => props.onChange({ maxPower })} />
      <em>%</em>
      <span class="ws-power-corner" title="Corner power: used at or below the machine's start speed (corners, line ends), rising to the power at full speed. Too high burns corners; too low may not fire there.">
        corners
        <PctInput
          value={props.min}
          label="Corner power (%)"
          disabled={props.linked}
          onCommit={(minPower) => props.onChange({ minPower, linkPower: false })}
        />
        <em>%</em>
      </span>
      <IconButton
        icon={props.linked ? Link2 : Unlink2}
        label={props.linked ? "Corner power follows power (constant power): on. Click to set a lower corner power." : "Corner power follows power: off. Click to link it to power."}
        pressed={props.linked}
        onClick={() => props.onChange({ linkPower: !props.linked })}
      />
      <PowerRamp min={props.min} max={props.max} speed={props.speed} />
    </div>
  );
}
