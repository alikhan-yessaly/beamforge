import { msg, t, tp } from "../i18n";
import { BookmarkPlus, Check, ChevronDown, ChevronUp, Download, Eye, EyeOff, Gauge, type LucideIcon, MoveVertical, Repeat, RotateCcw, RotateCw, Save, SwatchBook, Target, X, Zap, ZapOff } from "lucide-preact";
import { appMode } from "./mode";
import { useEffect, useRef, useState } from "preact/hooks";
import { IconButton, IconToggle } from "../ui/icons";
import { buildRdFile } from "../job/build";
import { formatDuration } from "../job/estimate";
import { activeLayers, moveLayer, powerLinked, updateLayer } from "../job/layers";
import { type Layer, type LayerMode, type SweepMode, newId } from "../scene/model";
import { overscanLength, startSpeedOf, suggestCornerPower } from "../machine/motion";
import { uneven } from "../job/depth";
import { DEFAULT_FILL, type FillPattern, type FillSettings } from "../job/fill";
import { ModeCut, ModeFill, ModeFillCut, PatternCross, PatternDots, PatternLines, PatternOffset } from "../ui/customIcons";
import { commit, doc, notify, prefs, profile } from "../scene/store";
import { jobDepth, jobEstimate, preview, toolpath, togglePreview } from "./job";
import { selectedLayer } from "./layerSelect";
import { NumberInput } from "../ui/NumberInput";
import { PowerRamp, PowerRow } from "./PowerRow";
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
  const machine = profile.value;
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
    const p = { id: newId(), name: (naming ?? "").trim(), machine: machine.name, machineId: machine.id, ...settings, ...(l.mode === "fill" ? { op: "engrave" as const } : {}), ...((l.kerf ?? 0) > 0 ? { kerf: l.kerf } : {}) };
    if (!validPreset(p)) return notify(t("Give the preset a name (settings must be valid)."), "error");
    if (!savePresets([...presets.value, p])) return notify(presetsError.value ?? t("Could not save the preset."), "error");
    props.set({ material: p.id });
    setNaming(null);
  };
  const updatePreset = () => {
    if (!preset || !window.confirm(t("Update preset \"{name}\" with this layer's settings?", { name: preset.name }))) return;
    if (!savePresets(presets.value.map((p) => (p.id === preset.id ? { ...p, ...settings } : p)))) notify(t("Could not save the preset."), "error");
  };
  const nameField = naming !== null && (
    <div class="ws-layer-material">
      <input
        class="ws-grow"
        placeholder={t("Preset name, e.g. 3 mm plywood cut")}
        aria-label={t("New preset name")}
        value={naming}
        ref={nameRef}
        onInput={(e) => setNaming(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") saveNew();
          if (e.key === "Escape") setNaming(null);
        }}
      />
      <IconButton icon={Check} label={t("Save the preset")} onClick={saveNew} />
      <IconButton icon={X} label={t("Cancel")} onClick={() => setNaming(null)} />
    </div>
  );
  if (list.length === 0) {
    // No presets for this machine yet: just offer to start the library from this layer.
    return (
      <>
        <div class="ws-layer-material">
          <SwatchBook size={14} strokeWidth={1.75} aria-hidden="true" />
          <small class="ws-grow">{t("No material presets yet")}</small>
          <IconButton icon={BookmarkPlus} label={t("Save these settings as a material preset")} pressed={naming !== null} onClick={() => setNaming(naming === null ? "" : null)} />
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
          aria-label={t("Material preset")}
          title={t("Material preset: fills in speed, power and passes")}
          value={preset?.id ?? ""}
          onChange={(e) => {
            const p = list.find((x) => x.id === e.currentTarget.value);
            props.set(p ? { ...presetSettings(p), material: p.id } : { material: undefined });
          }}
        >
          <option value="">{t("Custom settings")}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {edited && (
          <>
            <span class="ws-badge" title={t("These settings differ from the preset")}>{t("edited")}</span>
            <IconButton icon={RotateCcw} label={t("Revert to the preset's settings")} onClick={() => preset && props.set(presetSettings(preset))} />
            <IconButton icon={Save} label={t("Update the preset with these settings")} onClick={updatePreset} />
          </>
        )}
        {!preset && <IconButton icon={BookmarkPlus} label={t("Save these settings as a new preset")} pressed={naming !== null} onClick={() => setNaming(naming === null ? "" : null)} />}
      </div>
      {nameField}
    </>
  );
}

const MODES: { mode: LayerMode; icon: LucideIcon; label: string }[] = [
  { mode: "cut", icon: ModeCut, label: msg("Cut: follow the outlines") },
  { mode: "fill", icon: ModeFill, label: msg("Fill: engrave the inside of closed shapes and the areas filled with this colour") },
];
const PATTERNS: { pattern: FillPattern; icon: LucideIcon; label: string }[] = [
  { pattern: "lines", icon: PatternLines, label: msg("Lines") },
  { pattern: "cross", icon: PatternCross, label: msg("Cross-hatch") },
  { pattern: "dots", icon: PatternDots, label: msg("Dots") },
  { pattern: "offset", icon: PatternOffset, label: msg("Offset (contours stepping inward)") },
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
        <div class="ws-segmented" role="group" aria-label={t("Layer mode")}>
          {MODES.map((m) => (
            <IconButton key={m.mode} icon={m.icon} label={t(m.label)} pressed={mode === m.mode} onClick={() => props.set({ mode: m.mode })} />
          ))}
        </div>
        {mode !== "cut" && (
          <div class="ws-segmented" role="group" aria-label={t("Fill pattern")}>
            {PATTERNS.map((p) => (
              <IconButton key={p.pattern} icon={p.icon} label={t("Fill pattern: {name}", { name: t(p.label) })} pressed={fill.pattern === p.pattern} onClick={() => setFill({ pattern: p.pattern })} />
            ))}
          </div>
        )}
      </div>
      {mode !== "cut" && (
        <div class="ws-layer-fields">
          <Field
            icon={MoveVertical}
            label={fill.pattern === "dots" ? t("Dot spacing") : fill.pattern === "offset" ? t("Contour spacing") : t("Line spacing")}
            unit="mm"
            value={fill.interval}
            step={0.05}
            min={0.01}
            max={50}
            onCommit={(interval) => setFill({ interval })}
          />
          {fill.pattern !== "offset" && (
            <Field icon={RotateCw} label={t("Angle")} unit="°" value={fill.angle} step={15} onCommit={(angle) => setFill({ angle: ((angle % 180) + 180) % 180 })} />
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
      title={t("Layer {n} ({color}): {mode}. Click to edit.", { n: props.index + 1, color: l.color, mode: t(MODES.find((m) => m.mode === mode)?.label ?? MODES[0]!.label) })}
    >
      <i class="ws-swatch" style={{ background: l.color }} />
      <b>{String(props.index + 1).padStart(2, "0")}</b>
      <ModeIcon size={14} strokeWidth={1.75} aria-hidden="true" />
      <span class="ws-lrow-vals">
        {num2(l.speed)}
        <small>mm/s</small> {power}
        {l.passes > 1 && <small> ×{l.passes}</small>}
      </span>
      <IconToggle on={l.show !== false} onIcon={Eye} offIcon={EyeOff} label={t("Show (off = dotted shadow; shown paths set the current-head job reference)")} onChange={(show) => set({ show })} />
      <IconToggle on={l.output} onIcon={Zap} offIcon={ZapOff} label={t("Output (cut this layer)")} onChange={(output) => set({ output })} />
      <small class="ws-lrow-time" title={t("Estimated time for this layer")}>
        {props.seconds !== null ? formatDuration(props.seconds) : "—"}
      </small>
      <span class="ws-lrow-order">
        <IconButton icon={ChevronUp} label={t("Cut earlier")} disabled={props.index === 0} onClick={() => commit(moveLayer(doc.value, l.color, -1))} />
        <IconButton icon={ChevronDown} label={t("Cut later")} disabled={props.index === props.count - 1} onClick={() => commit(moveLayer(doc.value, l.color, 1))} />
      </span>
    </li>
  );
}

const SWEEPS: { mode: SweepMode; label: string; title: string }[] = [
  { mode: "quick", label: msg("Quickest"), title: msg("Areas that share rows are swept together when that's quicker. Can make some areas burn deeper than others.") },
  { mode: "together", label: msg("Together"), title: msg("Areas that share rows are swept together, row by row across the gaps: they burn alike, and share overscan.") },
  { mode: "separate", label: msg("Separately"), title: msg("Each area is swept on its own.") },
];

/** Fill layers: overscan and how areas are swept; advanced: overscan length and scan offset. */
function FillMotionRows(props: { layer: Layer; set: (patch: Partial<Omit<Layer, "color">>) => void }) {
  const l = props.layer;
  const p = profile.value;
  const adv = prefs.value.advanced;
  const ov = l.overscan ?? "off";
  const auto = overscanLength("auto", l.speed, p);
  const depth = (() => {
    const i = toolpath.value.layers.findIndex((x) => x.color === l.color);
    return i < 0 ? undefined : jobDepth.value.find((d) => d.layer === i);
  })();
  return (
    <div class="ws-opts">
      <div class="ws-opt">
        <span class="ws-opt-label" title={t("Laser off while the head speeds up and slows down at each row end, so edges burn as deep as the middle. Costs time.")}>{t("Overscan")}</span>
        <div class="ws-segmented ws-seg-sm" role="group" aria-label={t("Overscan")}>
          <button type="button" class={ov === "off" ? "on" : ""} aria-pressed={ov === "off"} onClick={() => props.set({ overscan: "off" })}>{t("Off")}</button>
          <button type="button" class={ov === "auto" ? "on" : ""} aria-pressed={ov === "auto"} title={t("{mm} mm at this speed, from the machine's acceleration", { mm: auto })} onClick={() => props.set({ overscan: "auto" })}>
            {t("Auto")}
          </button>
        </div>
        {adv && (
          <span class="ws-opt-num">
            <NumberInput value={typeof ov === "number" ? ov : null} label={t("Overscan length (mm)")} step={0.5} min={0} max={100} onCommit={(v) => props.set({ overscan: v })} />
            <em>mm</em>
          </span>
        )}
      </div>
      <div class="ws-opt">
        <span class="ws-opt-label">{t("Sweep")}</span>
        <select aria-label={t("Sweep")} value={l.sweep ?? "quick"} title={t(SWEEPS.find((s) => s.mode === (l.sweep ?? "quick"))!.title)} onChange={(e) => props.set({ sweep: e.currentTarget.value as SweepMode })}>
          {SWEEPS.map((s) => (
            <option key={s.mode} value={s.mode} title={t(s.title)}>
              {t(s.label)}
            </option>
          ))}
        </select>
      </div>
      {adv && (
        <div class="ws-opt" title={t("Scan offset for this layer instead of the machine profile's (mm)")}>
          <span class="ws-opt-label">{t("Scan offset")}</span>
          <span class="ws-opt-num">
            <NumberInput value={l.scanOffset ?? null} label={t("Scan offset (mm)")} step={0.05} min={-2} max={2} onCommit={(v) => props.set({ scanOffset: v })} />
            <em>mm</em>
          </span>
        </div>
      )}
      {depth && uneven(depth) && (
        <p class="ws-hint">{t("Predicted: {pct} % of this engraving burns deeper than the middle of long rows (edges up to {x}× the energy).", { pct: Math.round(depth.deepShare * 100), x: Math.round(depth.peak * 10) / 10 })}</p>
      )}
    </div>
  );
}

/** All settings of the selected layer. */
function LayerEditor(props: { layer: Layer; index: number }) {
  const l = props.layer;
  const set = (patch: Partial<Omit<Layer, "color">>) => commit(updateLayer(doc.value, l.color, patch));
  const p = profile.value;
  const mode = l.mode ?? "cut";
  return (
    <div class="ws-layer ws-layer-editor">
      <div class="ws-layer-head">
        <i class="ws-swatch" style={{ background: l.color }} title={l.color} />
        <b>{t("Layer {n}", { n: String(props.index + 1).padStart(2, "0") })}</b>
        <small>{l.color}</small>
        <PowerRamp min={l.minPower} max={l.maxPower} speed={l.speed} start={startSpeedOf(p)} />
      </div>
      <ModeRows layer={l} set={set} />
      <MaterialRow layer={l} set={set} />
      <div class="ws-layer-fields">
        <Field icon={Gauge} label={t("Speed")} unit="mm/s" value={l.speed} step={1} min={0.1} onCommit={(speed) => set({ speed })} />
        <Field icon={Repeat} label={t("Passes")} unit="×" value={l.passes} step={1} min={1} max={99} onCommit={(passes) => set({ passes })} />
      </div>
      <PowerRow min={l.minPower} max={l.maxPower} speed={l.speed} linked={powerLinked(l)} onChange={set} startSpeed={startSpeedOf(p)} suggest={mode !== "cut" ? suggestCornerPower(l.maxPower, l.speed, p) : undefined} />
      {mode !== "cut" && <FillMotionRows layer={l} set={set} />}
      {mode === "cut" && (prefs.value.advanced || (l.kerf ?? 0) > 0) && (
        <div class="ws-opts">
          <div class="ws-opt" title={t("Kerf compensation: outlines grow and holes shrink by half of this, so parts come out at their drawn size")}>
            <span class="ws-opt-label">{t("Kerf")}</span>
            <span class="ws-opt-num">
              <NumberInput value={l.kerf ?? 0} label={t("Kerf (mm)")} step={0.01} min={0} max={2} onCommit={(kerf) => set({ kerf })} />
              <em>mm</em>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Encode the document and download it as an .rd file (the same bytes a job send would stream). */
function saveRd(): void {
  const pr = prefs.value;
  try {
    const bytes = buildRdFile(doc.value, profile.value, { mode: pr.startFrom, innerFirst: pr.innerFirst, order: pr.jobOrder });
    const hidden = activeLayers(doc.value).filter((l) => l.output && l.show === false);
    if (hidden.length && !window.confirm(tp(["This file includes {n} dotted output layer. Dotted layers are still cut. Save it anyway?", "This file includes {n} dotted output layers. Dotted layers are still cut. Save it anyway?"], hidden.length))) return;
    const name = (doc.value.objects[0]?.name ?? "job").replace(/\.dxf$/i, "");
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${name}.rd` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(t("Saved {file} ({n} bytes)", { file: `${name}.rd`, n: bytes.length }));
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
      <h3>{t("Layers")}</h3>
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
      <ul class="ws-lrows" role="listbox" aria-label={t("Layers in cut order")}>
        {layers.map((l, i) => (
          <LayerRow key={l.color} layer={l} index={i} count={layers.length} seconds={secondsFor(l)} selected={l === sel} />
        ))}
        {layers.length === 0 && <li class="ws-empty">{t("Layers appear here, one per colour in the drawing")}</li>}
      </ul>
      {sel && <LayerEditor layer={sel} index={selIndex} />}
      {layers.length > 0 && (
        <div class="ws-row ws-layers-foot">
          <IconToggle on={pr.innerFirst} onIcon={Target} label={t("Cut inner shapes first (holes before the outline around them)")} onChange={(innerFirst) => (prefs.value = { ...pr, innerFirst })} />
          <span class="ws-grow" />
          <IconButton icon={Download} label={t("Export the job as a Ruida .rd file")} disabled={tp.segments.length === 0} onClick={saveRd} />
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
  const at = Math.min(pv.t, total);
  return (
    <span class="ws-scrub">
      <input
        type="range"
        min={0}
        max={total}
        step={total / 1000 || 1}
        value={at}
        onInput={(e) => (preview.value = { on: true, t: Number(e.currentTarget.value) })}
      />
      {formatDuration(at)} / {formatDuration(total)}
      {appMode.value === "prepare" && <IconButton icon={X} label={t("Close preview (P)")} onClick={togglePreview} />}
    </span>
  );
}
