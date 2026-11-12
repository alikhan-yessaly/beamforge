// Material library: the presets for the current machine profile. Presets are applied from each layer card
// (Layers tab); here they are listed, created, edited and deleted.
import { msg, t } from "../i18n";
import { Check, Gauge, Pencil, Plus, Repeat, Trash2, X } from "lucide-preact";
import { useState } from "preact/hooks";
import { activeLayers } from "../job/layers";
import { newId } from "../scene/model";
import { doc, notify, profile } from "../scene/store";
import { IconButton } from "../ui/icons";
import { type MaterialPreset, powerText, presets, presetsError, presetsFor, savePresets, validPreset } from "./materials";
import { PowerRow } from "./PowerRow";

const FIELDS = [
  { key: "speed", icon: Gauge, label: msg("Speed"), unit: "mm/s" },
  { key: "passes", icon: Repeat, label: msg("Passes"), unit: "×" },
] as const;

function Editor(props: { draft: MaterialPreset; onDone: () => void }) {
  const [d, setD] = useState(props.draft);
  const [linked, setLinked] = useState(props.draft.minPower === props.draft.maxPower);
  const save = () => {
    const next = { ...d, name: d.name.trim(), minPower: Math.min(d.minPower, d.maxPower) };
    if (!validPreset(next)) return notify(t("Check the name and values: speed ≥ 0.1 mm/s, power 0–100 % (corner power at most power), passes 1–99."), "error");
    if (!savePresets([...presets.value.filter((p) => p.id !== next.id), next])) return notify(presetsError.value ?? t("Could not save the preset."), "error");
    props.onDone();
  };
  return (
    <li class="ws-preset editing">
      <input class="ws-preset-name" aria-label={t("Preset name")} placeholder={t("Name, e.g. 3 mm plywood cut")} value={d.name} onInput={(e) => setD({ ...d, name: e.currentTarget.value })} />
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
      <div class="ws-row">
        <IconButton icon={Check} class="ws-primary" label={t("Save the preset")} onClick={save} />
        <IconButton icon={X} label={t("Cancel")} onClick={props.onDone} />
      </div>
    </li>
  );
}

export function MaterialsPanel() {
  const [editing, setEditing] = useState<MaterialPreset | null>(null);
  const machine = profile.value.name;
  const list = presetsFor(machine);
  const layers = activeLayers(doc.value);
  const usedBy = (id: string) =>
    layers
      .map((l, i) => (l.material === id ? String(i + 1).padStart(2, "0") : null))
      .filter(Boolean)
      .join(", ");
  const blank = (): MaterialPreset => ({ id: newId(), name: "", machine, speed: 20, minPower: 20, maxPower: 20, passes: 1 });
  return (
    <section class="ws-panel">
      <div class="ws-panel-head">
        <h3>{t("Material library")}</h3>
        <IconButton icon={Plus} label={t("New preset")} disabled={!!presetsError.value || !!editing} onClick={() => setEditing(blank())} />
      </div>
      {presetsError.value && <p class="warn" role="alert">{presetsError.value}</p>}
      <p class="ws-hint">
        Presets for “{machine}”. Choose one on a layer in the Layers tab to fill in its settings. They are starting points: test each material on your machine.
      </p>
      <ul class="ws-presets">
        {editing && !list.some((p) => p.id === editing.id) && <Editor draft={editing} onDone={() => setEditing(null)} />}
        {list.map((p) =>
          editing?.id === p.id ? (
            <Editor key={p.id} draft={editing} onDone={() => setEditing(null)} />
          ) : (
            <li key={p.id} class="ws-preset">
              <div class="ws-preset-text">
                <b>{p.name}</b>
                <small>
                  {p.speed} mm/s · {powerText(p)} · {p.passes}×{usedBy(p.id) ? ` · ${t("layer {n}", { n: usedBy(p.id) ?? "" })}` : ""}
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
          ),
        )}
        {list.length === 0 && !editing && <li class="ws-empty">{t("No presets yet. Save one from a layer card, or add one with +.")}</li>}
      </ul>
    </section>
  );
}
