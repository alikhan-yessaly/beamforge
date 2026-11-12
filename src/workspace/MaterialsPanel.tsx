// Material library: the presets for the current machine profile. Presets are applied from each layer card
// (Layers tab); here they are listed, created, edited and deleted.
import { Check, Gauge, Pencil, Plus, Repeat, Trash2, X } from "lucide-preact";
import { useState } from "preact/hooks";
import { activeLayers } from "../job/layers";
import { newId } from "../scene/model";
import { doc, notify, profile } from "../scene/store";
import { IconButton } from "../ui/icons";
import { type MaterialPreset, powerText, presets, presetsError, presetsFor, savePresets, validPreset } from "./materials";
import { PowerRow } from "./PowerRow";

const FIELDS = [
  { key: "speed", icon: Gauge, label: "Speed", unit: "mm/s" },
  { key: "passes", icon: Repeat, label: "Passes", unit: "×" },
] as const;

function Editor(props: { draft: MaterialPreset; onDone: () => void }) {
  const [d, setD] = useState(props.draft);
  const [linked, setLinked] = useState(props.draft.minPower === props.draft.maxPower);
  const save = () => {
    const next = { ...d, name: d.name.trim(), minPower: Math.min(d.minPower, d.maxPower) };
    if (!validPreset(next)) return notify("Check the name and values: speed ≥ 0.1 mm/s, power 0–100 % (corner power at most power), passes 1–99.", "error");
    if (!savePresets([...presets.value.filter((p) => p.id !== next.id), next])) return notify(presetsError.value ?? "Could not save the preset.", "error");
    props.onDone();
  };
  return (
    <li class="ws-preset editing">
      <input class="ws-preset-name" aria-label="Preset name" placeholder="Name, e.g. 3 mm plywood cut" value={d.name} onInput={(e) => setD({ ...d, name: e.currentTarget.value })} />
      <div class="ws-layer-fields">
        {FIELDS.map((f) => (
          <label class="ws-lf" key={f.key} title={f.label}>
            <f.icon size={14} strokeWidth={1.75} aria-hidden="true" />
            <input inputMode="decimal" aria-label={f.label} value={d[f.key]} onInput={(e) => setD({ ...d, [f.key]: Number(e.currentTarget.value.replace(",", ".")) })} />
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
        <IconButton icon={Check} class="ws-primary" label="Save the preset" onClick={save} />
        <IconButton icon={X} label="Cancel" onClick={props.onDone} />
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
        <h3>Material library</h3>
        <IconButton icon={Plus} label="New preset" disabled={!!presetsError.value || !!editing} onClick={() => setEditing(blank())} />
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
                  {p.speed} mm/s · {powerText(p)} · {p.passes}×{usedBy(p.id) ? ` · layer ${usedBy(p.id)}` : ""}
                </small>
              </div>
              <IconButton icon={Pencil} label={`Edit ${p.name}`} disabled={!!editing} onClick={() => setEditing({ ...p })} />
              <IconButton
                icon={Trash2}
                label={`Delete ${p.name}`}
                disabled={!!editing}
                onClick={() => {
                  if (window.confirm(`Delete the preset "${p.name}"? Layers keep their current settings.`)) savePresets(presets.value.filter((x) => x.id !== p.id));
                }}
              />
            </li>
          ),
        )}
        {list.length === 0 && !editing && <li class="ws-empty">No presets yet. Save one from a layer card, or add one with +.</li>}
      </ul>
    </section>
  );
}
