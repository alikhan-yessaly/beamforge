import { BookmarkPlus, Check, ChevronDown, ChevronUp, Download, Eye, EyeOff, Gauge, type LucideIcon, MoveVertical, Repeat, RotateCcw, RotateCw, Save, SwatchBook, Target, X, Zap, ZapOff } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { IconButton, IconToggle } from "../ui/icons";
import { buildRdFile } from "../job/build";
import { formatDuration } from "../job/estimate";
import { activeLayers, moveLayer, powerLinked, updateLayer } from "../job/layers";
import { type Layer, type LayerMode, newId } from "../scene/model";
import { DEFAULT_FILL, type FillPattern, type FillSettings } from "../job/fill";
import { ModeCut, ModeFill, ModeFillCut, PatternCross, PatternDots, PatternLines, PatternOffset } from "../ui/customIcons";
import { commit, doc, notify, prefs, profile } from "../scene/store";
import { jobEstimate, preview, toolpath, togglePreview } from "./job";
import { selectedLayer } from "./layerSelect";
import { NumberInput } from "../ui/NumberInput";
import { PowerRow } from "./PowerRow";
import { matchesPreset, presets, presetsError, presetSettings, presetsFor, savePresets, validPreset } from "./materials";

/** Small labelled number box: icon, field, unit. ↑/↓ and the wheel step it (see NumberInput). */
function Field(props: { icon: LucideIcon; label: string; unit: string; value: number; step?: number; min?: number; max?: number; onCommit: (v: number) => void }) {
  const Icon = props.icon;
  return (
    <label class="ws-lf" title={props.label}>
      <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      <NumberInput value={props.value} label={props.label} step={props.step} min={props.min} max={props.max} onCommit={props.onCommit} onInvalid={(m) => notify(m, "error")} />
      <em>{props.unit}</em>
    </label>
  );
}

/** Which preset a layer uses: pick one to fill in its settings; edited values are flagged and can be reverted. */
function MaterialRow(props: { layer: Layer; set: (patch: Partial<Omit<Layer, "color">>) => void }) {
  const l = props.layer;
  const machine = profile.value.name;
  const list = presetsFor(machine);
  const preset = list.find((p) => p.id === l.material);
  const edited = !!preset && !matchesPreset(l, preset);
  const [naming, setNaming] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const isNaming = naming !== null;
  useEffect(() => {
    if (isNaming) nameRef.current?.focus();
  }, [isNaming]);
  const settings = { speed: l.speed, minPower: l.minPower, maxPower: l.maxPower, passes: l.passes };
  const saveNew = () => {
    const p = { id: newId(), name: (naming ?? "").trim(), machine, ...settings };
    if (!validPreset(p)) return notify("Give the preset a name (settings must be valid).", "error");
    if (!savePresets([...presets.value, p])) return notify(presetsError.value ?? "Could not save the preset.", "error");
    props.set({ material: p.id });
    setNaming(null);
  };
  const updatePreset = () => {
    if (!preset || !window.confirm(`Update preset "${preset.name}" with this layer's settings?`)) return;
    if (!savePresets(presets.value.map((p) => (p.id === preset.id ? { ...p, ...settings } : p)))) notify("Could not save the preset.", "error");
  };
  const nameField = naming !== null && (
    <div class="ws-layer-material">
      <input
        class="ws-grow"
        placeholder="Preset name, e.g. 3 mm plywood cut"
        aria-label="New preset name"
        value={naming}
        ref={nameRef}
        onInput={(e) => setNaming(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") saveNew();
          if (e.key === "Escape") setNaming(null);
        }}
      />
      <IconButton icon={Check} label="Save the preset" onClick={saveNew} />
      <IconButton icon={X} label="Cancel" onClick={() => setNaming(null)} />
    </div>
  );
  if (list.length === 0) {
    // No presets for this machine yet: just offer to start the library from this layer.
    return (
      <>
        <div class="ws-layer-material">
          <SwatchBook size={14} strokeWidth={1.75} aria-hidden="true" />
          <small class="ws-grow">No material presets yet</small>
          <IconButton icon={BookmarkPlus} label="Save these settings as a material preset" pressed={naming !== null} onClick={() => setNaming(naming === null ? "" : null)} />
        </div>
        {nameField}
      </>
    );
  }
  return (
    <>
      <div class="ws-layer-material">
        <SwatchBook size={14} strokeWidth={1.75} aria-hidden="true" />
        <select
          aria-label="Material preset"
          title="Material preset: fills in speed, power and passes"
          value={preset?.id ?? ""}
          onChange={(e) => {
            const p = list.find((x) => x.id === e.currentTarget.value);
            props.set(p ? { ...presetSettings(p), material: p.id } : { material: undefined });
          }}
        >
          <option value="">Custom settings</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {edited && (
          <>
            <span class="ws-badge" title="These settings differ from the preset">edited</span>
            <IconButton icon={RotateCcw} label="Revert to the preset's settings" onClick={() => preset && props.set(presetSettings(preset))} />
            <IconButton icon={Save} label="Update the preset with these settings" onClick={updatePreset} />
          </>
        )}
        {!preset && <IconButton icon={BookmarkPlus} label="Save these settings as a new preset" pressed={naming !== null} onClick={() => setNaming(naming === null ? "" : null)} />}
      </div>
      {nameField}
    </>
  );
}

const MODES: { mode: LayerMode; icon: LucideIcon; label: string }[] = [
  { mode: "cut", icon: ModeCut, label: "Cut: follow the outlines" },
  { mode: "fill", icon: ModeFill, label: "Fill: engrave the inside of closed shapes" },
  { mode: "fillCut", icon: ModeFillCut, label: "Fill, then cut the outlines" },
];
const PATTERNS: { pattern: FillPattern; icon: LucideIcon; label: string }[] = [
  { pattern: "lines", icon: PatternLines, label: "Lines" },
  { pattern: "cross", icon: PatternCross, label: "Cross-hatch" },
  { pattern: "dots", icon: PatternDots, label: "Dots" },
  { pattern: "offset", icon: PatternOffset, label: "Offset (contours stepping inward)" },
];

/** Cut / fill mode and, for fill modes, the pattern, spacing and angle. */
function ModeRows(props: { layer: Layer; set: (patch: Partial<Omit<Layer, "color">>) => void }) {
  const l = props.layer;
  const mode = l.mode ?? "cut";
  const fill = { ...DEFAULT_FILL, ...l.fill };
  const setFill = (patch: Partial<FillSettings>) => props.set({ fill: { ...fill, ...patch } });
  return (
    <>
      <div class="ws-mode">
        <div class="ws-segmented" role="group" aria-label="Layer mode">
          {MODES.map((m) => (
            <IconButton key={m.mode} icon={m.icon} label={m.label} pressed={mode === m.mode} onClick={() => props.set({ mode: m.mode })} />
          ))}
        </div>
        {mode !== "cut" && (
          <div class="ws-segmented" role="group" aria-label="Fill pattern">
            {PATTERNS.map((p) => (
              <IconButton key={p.pattern} icon={p.icon} label={`Fill pattern: ${p.label}`} pressed={fill.pattern === p.pattern} onClick={() => setFill({ pattern: p.pattern })} />
            ))}
          </div>
        )}
      </div>
      {mode !== "cut" && (
        <div class="ws-layer-fields">
          <Field
            icon={MoveVertical}
            label={fill.pattern === "dots" ? "Dot spacing" : fill.pattern === "offset" ? "Contour spacing" : "Line spacing"}
            unit="mm"
            value={fill.interval}
            step={0.05}
            min={0.01}
            max={50}
            onCommit={(interval) => setFill({ interval })}
          />
          {fill.pattern !== "offset" && (
            <Field icon={RotateCw} label="Angle" unit="°" value={fill.angle} step={15} onCommit={(angle) => setFill({ angle: ((angle % 180) + 180) % 180 })} />
          )}
        </div>
      )}
    </>
  );
}

const MODE_ICON: Record<LayerMode, LucideIcon> = { cut: ModeCut, fill: ModeFill, fillCut: ModeFillCut };
const num2 = (n: number) => String(Math.round(n * 100) / 100);

/** One compact row per layer: click to edit it below. */
function LayerRow(props: { layer: Layer; index: number; count: number; seconds: number | null; selected: boolean }) {
  const l = props.layer;
  const set = (patch: Partial<Omit<Layer, "color">>) => commit(updateLayer(doc.value, l.color, patch));
  const mode = l.mode ?? "cut";
  const ModeIcon = MODE_ICON[mode];
  const power = l.minPower === l.maxPower ? `${num2(l.maxPower)} %` : `${num2(l.maxPower)}/${num2(l.minPower)} %`;
  return (
    <li
      class={`ws-lrow${props.selected ? " on" : ""}${l.output ? "" : " off"}`}
      aria-selected={props.selected}
      onClick={() => (selectedLayer.value = l.color)}
      title={`Layer ${props.index + 1} (${l.color}): ${MODES.find((m) => m.mode === mode)!.label}. Click to edit.`}
    >
      <i class="ws-swatch" style={{ background: l.color }} />
      <b>{String(props.index + 1).padStart(2, "0")}</b>
      <ModeIcon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span class="ws-lrow-vals">
        {num2(l.speed)}
        <small>mm/s</small> {power}
        {l.passes > 1 && <small> ×{l.passes}</small>}
      </span>
      <IconToggle on={l.show !== false} onIcon={Eye} offIcon={EyeOff} label="Show (off = dotted shadow; shown paths set the current-head job reference)" onChange={(show) => set({ show })} />
      <IconToggle on={l.output} onIcon={Zap} offIcon={ZapOff} label="Output (cut this layer)" onChange={(output) => set({ output })} />
      <small class="ws-lrow-time" title="Estimated time for this layer">
        {props.seconds !== null ? formatDuration(props.seconds) : "—"}
      </small>
      <span class="ws-lrow-order">
        <IconButton icon={ChevronUp} label="Cut earlier" disabled={props.index === 0} onClick={() => commit(moveLayer(doc.value, l.color, -1))} />
        <IconButton icon={ChevronDown} label="Cut later" disabled={props.index === props.count - 1} onClick={() => commit(moveLayer(doc.value, l.color, 1))} />
      </span>
    </li>
  );
}

/** All settings of the selected layer. */
function LayerEditor(props: { layer: Layer; index: number }) {
  const l = props.layer;
  const set = (patch: Partial<Omit<Layer, "color">>) => commit(updateLayer(doc.value, l.color, patch));
  return (
    <div class="ws-layer ws-layer-editor">
      <div class="ws-layer-head">
        <i class="ws-swatch" style={{ background: l.color }} title={l.color} />
        <b>Layer {String(props.index + 1).padStart(2, "0")}</b>
        <small>{l.color}</small>
      </div>
      <ModeRows layer={l} set={set} />
      <MaterialRow layer={l} set={set} />
      <div class="ws-layer-fields">
        <Field icon={Gauge} label="Speed" unit="mm/s" value={l.speed} step={1} min={0.1} onCommit={(speed) => set({ speed })} />
        <Field icon={Repeat} label="Passes" unit="×" value={l.passes} step={1} min={1} max={99} onCommit={(passes) => set({ passes })} />
      </div>
      <PowerRow min={l.minPower} max={l.maxPower} speed={l.speed} linked={powerLinked(l)} onChange={set} />
    </div>
  );
}

/** Encode the document and download it as an .rd file (the same bytes a job send would stream). */
function saveRd(): void {
  const pr = prefs.value;
  try {
    const bytes = buildRdFile(doc.value, profile.value, { mode: pr.startFrom, innerFirst: pr.innerFirst });
    const hidden = activeLayers(doc.value).filter((l) => l.output && l.show === false);
    if (hidden.length && !window.confirm(`This file includes ${hidden.length} dotted output layer(s). Dotted layers are still cut. Save it anyway?`)) return;
    const name = (doc.value.objects[0]?.name ?? "job").replace(/\.dxf$/i, "");
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name}.rd` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`Saved ${name}.rd (${bytes.length} bytes)`);
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), "error");
  }
}

export function LayersPanel() {
  const d = doc.value;
  const layers = activeLayers(d);
  const tp = toolpath.value;
  const est = jobEstimate.value;
  const pr = prefs.value;
  const selIndex = Math.max(0, layers.findIndex((l) => l.color === selectedLayer.value));
  const sel = layers[selIndex];
  // Per-layer time comes from the planned toolpath, whose layers are only the ones with output on.
  const secondsFor = (l: Layer) => {
    const i = tp.layers.findIndex((x) => x.color === l.color);
    return i >= 0 ? (est.layerTime[i] ?? 0) : null;
  };
  return (
    <section class="ws-panel">
      <h3>Layers</h3>
      {tp.errors.map((e) => (
        <p key={e} class="ws-plan-msg error" role="alert">
          {e}
        </p>
      ))}
      {tp.warnings.map((w) => (
        <p key={w} class="ws-plan-msg">
          {w}
        </p>
      ))}
      <ul class="ws-lrows" role="listbox" aria-label="Layers in cut order">
        {layers.map((l, i) => (
          <LayerRow key={l.color} layer={l} index={i} count={layers.length} seconds={secondsFor(l)} selected={l === sel} />
        ))}
        {layers.length === 0 && <li class="ws-empty">Layers appear here, one per colour in the drawing</li>}
      </ul>
      {sel && <LayerEditor layer={sel} index={selIndex} />}
      {layers.length > 0 && (
        <div class="ws-row ws-layers-foot">
          <IconToggle on={pr.innerFirst} onIcon={Target} label="Cut inner shapes first (holes before the outline around them)" onChange={(innerFirst) => (prefs.value = { ...pr, innerFirst })} />
          <span class="ws-grow" />
          <IconButton icon={Download} label="Export the job as a Ruida .rd file" disabled={tp.segments.length === 0} onClick={saveRd} />
        </div>
      )}
    </section>
  );
}

/** Scrubber shown in the status bar while the preview is on. */
export function PreviewBar() {
  const pv = preview.value;
  if (!pv.on) return null;
  const total = jobEstimate.value.total;
  const t = Math.min(pv.t, total);
  return (
    <span class="ws-scrub">
      <input
        type="range"
        min={0}
        max={total}
        step={total / 1000 || 1}
        value={t}
        onInput={(e) => (preview.value = { on: true, t: Number(e.currentTarget.value) })}
      />
      {formatDuration(t)} / {formatDuration(total)}
      <IconButton icon={X} label="Close preview (P)" onClick={togglePreview} />
    </span>
  );
}
