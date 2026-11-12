// Palette strip under the canvas (as in LightBurn): click a colour to move the selection to that layer, creating
// it if needed. Without a selection, a click on a colour in use opens that layer in the editor.
import { activeLayers, assignColor, PALETTE } from "../job/layers";
import { commit, doc, notify, selection } from "../scene/store";
import { selectedLayer } from "./layerSelect";
import { session, setSketch } from "./sketch/state";

const MODE_NAME = { cut: "Cut", fill: "Fill", fillCut: "Fill + outline" } as const;

export function PaletteBar() {
  const layers = activeLayers(doc.value);
  const index = new Map(layers.map((l, i) => [l.color, i]));
  const hasSelection = selection.value.size > 0;
  const pick = (color: string) => {
    const ses = session.value;
    if (ses) {
      // Sketch mode: recolour the selected geometry (construction stays as it is).
      const ids = [...ses.selected].filter((id) => ses.sketch.entities.some((e) => e.id === id));
      if (!ids.length) {
        setSketch({ ...ses.sketch, color });
        notify("New geometry in this sketch will use that layer.");
        return;
      }
      setSketch({ ...ses.sketch, entities: ses.sketch.entities.map((e) => (ids.includes(e.id) ? { ...e, color } : e)) });
      return;
    }
    if (!selection.value.size) {
      if (index.has(color)) selectedLayer.value = color;
      else notify("Select shapes first, then click a colour to put them on that layer.");
      return;
    }
    const r = assignColor(doc.value, selection.value, color);
    if (!r) {
      notify("Nothing to move: the selection is already on that layer (fill layers take closed shapes only).");
      return;
    }
    commit(r.doc);
    selectedLayer.value = color;
  };
  return (
    <div class="ws-palette" role="toolbar" aria-label="Layer colours">
      {PALETTE.map((c) => {
        const at = index.get(c);
        const l = at !== undefined ? layers[at]! : null;
        const label = l
          ? `Layer ${String(at! + 1).padStart(2, "0")} · ${MODE_NAME[l.mode ?? "cut"]} · ${l.speed} mm/s · ${l.maxPower} %${hasSelection ? " — click to move the selection here" : " — click to edit"}`
          : `${c}: new layer${hasSelection ? " — click to move the selection here" : ""}`;
        return (
          <button
            key={c}
            type="button"
            class={`ws-pal${l ? " used" : ""}${selectedLayer.value === c && l ? " on" : ""}`}
            style={{ background: c }}
            title={label}
            aria-label={label}
            onClick={() => pick(c)}
          >
            {l && <span>{String(at! + 1).padStart(2, "0")}</span>}
          </button>
        );
      })}
    </div>
  );
}
