// Material library: the presets of the active machine profile, listed by material. Presets are applied from each
// layer card (Layers tab); here they are listed, created, edited and deleted. A machine with a class but no presets
// can start from the class's typical settings; the power/speed and kerf test cards (Tuning) refine them.
import { msg, t } from "../i18n";
import { Check, Gauge, Pencil, Plus, Repeat, Sparkles, Trash2, X } from "lucide-preact";
import { useState } from "preact/hooks";
import { activeLayers } from "../job/layers";
import { classById } from "../machine/classes";
import { newId } from "../scene/model";
import { doc, notify, prefs, profile } from "../scene/store";
import { IconButton } from "../ui/icons";
import { type MaterialPreset, OP_NAME, powerText, presets, presetsError, presetsFor, savePresets, seedPresets, validPreset } from "./materials";
import { PowerRamp, PowerRow } from "./PowerRow";
import { openTuning } from "./TuningDialog";

const FIELDS = [
  { key: "speed", icon: Gauge, label: msg("Speed"), unit: "mm/s" },
  { key: "passes", icon: Repeat, label: msg("Passes"), unit: "×" },
] as const;

const OPS = ["cut", "engrave", "score"] as const;

function Editor(props: { draft: MaterialPreset; onDone: () => void }) {
  const [d, setD] = useState(props.draft);
  const [linked, setLinked] = useState(props.draft.minPower === props.draft.maxPower);
  const advanced = prefs.value.advanced;
  const save = () => {
    const material = d.material?.trim() || undefined;
    const name = d.name.trim() || (material && d.op ? `${material} · ${t(OP_NAME[d.op])}` : "");
    const next = { ...d, name, material, minPower: Math.min(d.minPower, d.maxPower) };
    if (!validPreset(next)) return notify(t("Check the name and values: speed ≥ 0.1 mm/s, power 0–100 % (corner power at most power), passes 1–99."), "error");
    if (!savePresets([...presets.value.filter((p) => p.id !== next.id), next])) return notify(presetsError.value ?? t("Could not save the preset."), "error");
    props.onDone();
  };
  return (
    <li class="ws-preset editing">
      <input class="ws-preset-name" aria-label={t("Material")} placeholder={t("Material, e.g. 3 mm plywood")} value={d.material ?? ""} onInput={(e) => setD({ ...d, material: e.currentTarget.value })} />
      <div class="ws-preset-op">
        <select aria-label={t("Operation")} value={d.op ?? ""} onChange={(e) => setD({ ...d, op: (e.currentTarget.value || undefined) as MaterialPreset["op"] })}>
          <option value="">{t("Any operation")}</option>
          {OPS.map((op) => (
            <option key={op} value={op}>
              {t(OP_NAME[op])}
            </option>
          ))}
        </select>
        <input class="ws-grow" aria-label={t("Preset name")} placeholder={t("Name (optional)")} value={d.name} onInput={(e) => setD({ ...d, name: e.currentTarget.value })} />
      </div>
      <div class="ws-layer-fields">
        {FIELDS.map((f) => (
          <label class="ws-lf" key={f.key} title={t(f.label)}>
            <f.icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <input inputMode="decimal" aria-label={t(f.label)} value={d[f.key]} onInput={(e) => setD({ ...d, [f.key]: Number(e.currentTarget.value.replace(",", ".")) })} />
            <em>{f.unit}</em>
          </label>
        ))}
      </div>
      <PowerRow
        min={d.minPower}
        max={d.maxPower}
        speed={d.speed}
        linked={linked}
        onChange={(p) => {
          const link = p.linkPower ?? linked;
          const maxPower = p.maxPower ?? d.maxPower;
          setLinked(link);
          setD({ ...d, maxPower, minPower: link ? maxPower : (p.minPower ?? d.minPower) });
        }}
      />
      {advanced && d.op === "cut" && (
        <div class="ws-opts">
          <div class="ws-opt" title={t("Kerf: the width the beam removes; cut layers using this preset are compensated by it")}>
            <span class="ws-opt-label">{t("Kerf")}</span>
            <span class="ws-opt-num">
              <input inputMode="decimal" aria-label={t("Kerf (mm)")} value={d.kerf ?? 0} onInput={(e) => setD({ ...d, kerf: Number(e.currentTarget.value.replace(",", ".")) || undefined })} />
              <em>mm</em>
            </span>
          </div>
        </div>
      )}
      <div class="ws-row ws-actions">
        <PowerRamp min={d.minPower} max={d.maxPower} speed={d.speed} />
        <span class="ws-grow" />
        <IconButton icon={X} label={t("Cancel")} onClick={props.onDone} />
        <IconButton icon={Check} class="ws-primary" label={t("Save the preset")} onClick={save} />
      </div>
    </li>
  );
}

export function MaterialsPanel() {
  const [editing, setEditing] = useState<MaterialPreset | null>(null);
  const machine = profile.value;
  const list = presetsFor(machine);
  const cls = classById(machine.class);
  const layers = activeLayers(doc.value);
  const usedBy = (id: string) =>
    layers
      .map((l, i) => (l.material === id ? String(i + 1).padStart(2, "0") : null))
      .filter(Boolean)
      .join(", ");
  const blank = (): MaterialPreset => ({ id: newId(), name: "", machine: machine.name, machineId: machine.id, speed: 20, minPower: 20, maxPower: 20, passes: 1 });
  // Group by material (presets without one under their own name).
  const groups = new Map<string, MaterialPreset[]>();
  for (const p of list) groups.set(p.material ?? "", [...(groups.get(p.material ?? "") ?? []), p]);
  const row = (p: MaterialPreset) =>
    editing?.id === p.id ? (
      <Editor key={p.id} draft={editing} onDone={() => setEditing(null)} />
    ) : (
      <li key={p.id} class="ws-preset">
        <div class="ws-preset-text">
          <b class={p.material && p.op ? "ws-op" : undefined}>{p.material && p.op ? t(OP_NAME[p.op]) : p.name}</b>
          <small>
            {p.speed} mm/s · {powerText(p)} · {p.passes}×{p.kerf ? ` · ${t("kerf {mm} mm", { mm: p.kerf })}` : ""}
            {usedBy(p.id) ? ` · ${t("layer {n}", { n: usedBy(p.id) ?? "" })}` : ""}
          </small>
        </div>
        <IconButton icon={Pencil} label={t("Edit {name}", { name: p.name })} disabled={!!editing} onClick={() => setEditing({ ...p })} />
        <IconButton
          icon={Trash2}
          label={t("Delete {name}", { name: p.name })}
          disabled={!!editing}
          onClick={() => {
            if (window.confirm(t("Delete the preset \"{name}\"? Layers keep their current settings.", { name: p.name }))) savePresets(presets.value.filter((x) => x.id !== p.id));
          }}
        />
      </li>
    );
  return (
    <section class="ws-panel">
      <div class="ws-panel-head">
        <h3>{t("Material library")}</h3>
        <IconButton icon={Plus} label={t("New preset")} disabled={!!presetsError.value || !!editing} onClick={() => setEditing(blank())} />
      </div>
      {presetsError.value && <p class="warn" role="alert">{presetsError.value}</p>}
      <p class="ws-hint">{t("Presets for “{machine}”. Choose one on a layer in the Layers tab to fill in its settings. They are starting points: test each material on your machine.", { machine: machine.name })}</p>
      <ul class="ws-presets">
        {editing && !list.some((p) => p.id === editing.id) && <Editor draft={editing} onDone={() => setEditing(null)} />}
        {[...groups.entries()].map(([material, ps]) =>
          material ? (
            <li key={material} class="ws-preset-group">
              <h4>{material}</h4>
              <ul class="ws-presets">{ps.map(row)}</ul>
            </li>
          ) : (
            ps.map(row)
          ),
        )}
        {list.length === 0 && !editing && <li class="ws-empty">{t("No presets yet. Save one from a layer card, or add one with +.")}</li>}
      </ul>
      {list.length === 0 && cls && !editing && (
        <button
          type="button"
          onClick={() => {
            if (savePresets([...presets.value, ...seedPresets(machine, cls)])) notify(t("Added typical settings for {class}. Test them on scrap before real work.", { class: t(cls.name) }));
          }}
        >
          <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" /> {t("Add typical settings for this machine class")}
        </button>
      )}
      <button type="button" class="ws-link" onClick={() => openTuning("grid")}>
        {t("Find a material's settings with a test card…")}
      </button>
    </section>
  );
}
