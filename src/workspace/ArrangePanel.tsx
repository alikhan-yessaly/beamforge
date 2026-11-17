// Arranging the selection on the bed: distribute with a set gap, a linear/grid pattern of copies, and automatic
// packing (src/scene/arrange.ts). Settings are remembered in prefs.arrange.
import { t, tp } from "../i18n";
import { AlignHorizontalSpaceAround, AlignHorizontalSpaceBetween, AlignVerticalSpaceAround, AlignVerticalSpaceBetween, Grid3x3, LayoutDashboard } from "lucide-preact";
import { computed } from "@preact/signals";
import { MAX_PATTERN_COPIES, areaFromBox, autoArrange, distribute, linearArray, userArea } from "../scene/arrange";
import { commit, doc, notify, prefs, profile, selBox, selection } from "../scene/store";
import { type Units, fromUnits, toUnits, unitDecimals } from "../scene/units";
import { IconButton } from "../ui/icons";
import { More } from "../ui/More";
import { NumberInput } from "../ui/NumberInput";

export interface ArrangePrefs {
  gap: number;
  cols: number;
  rows: number;
  gapX: number;
  gapY: number;
  nestGap: number;
  rotate: boolean;
  /** Pack into a rectangle (a scrap) instead of the whole bed; x, y from the home corner, in mm. */
  useArea: boolean;
  area: { x: number; y: number; w: number; h: number };
}
export const DEFAULT_ARRANGE: ArrangePrefs = { gap: 2, cols: 3, rows: 1, gapX: 2, gapY: 2, nestGap: 2, rotate: false, useArea: false, area: { x: 0, y: 0, w: 300, h: 200 } };

const arrangePrefs = (): ArrangePrefs => ({ ...DEFAULT_ARRANGE, ...prefs.value.arrange });
const setArrange = (patch: Partial<ArrangePrefs>) => (prefs.value = { ...prefs.value, arrange: { ...arrangePrefs(), ...patch } });

/** The scrap area to pack into (internal bed mm), drawn on the canvas while it is in use and something is selected. */
export const arrangeArea = computed(() => {
  const a = arrangePrefs();
  return a.useArea && selection.value.size ? userArea(profile.value, a.area) : null;
});

/** A compact length box: shows the chosen units, stores mm. */
function Len(props: { label: string; mm: number; min?: number; onCommit: (mm: number) => void }) {
  const u: Units = prefs.value.units ?? "mm";
  return (
    <label class="ws-num ws-num-sm" title={props.label}>
      <span>{props.label}</span>
      <NumberInput
        value={toUnits(props.mm, u)}
        maxDecimals={unitDecimals(u)}
        label={`${props.label} (${u})`}
        min={props.min === undefined ? undefined : toUnits(props.min, u)}
        onCommit={(v) => props.onCommit(fromUnits(v, u))}
        onInvalid={(m) => notify(m, "error")}
      />
      <em>{u}</em>
    </label>
  );
}

function Count(props: { label: string; value: number; onCommit: (n: number) => void }) {
  return (
    <label class="ws-num ws-num-sm" title={props.label}>
      <span>{props.label}</span>
      <NumberInput value={props.value} label={props.label} step={1} min={1} max={100} onCommit={(v) => props.onCommit(Math.round(v))} onInvalid={(m) => notify(m, "error")} />
    </label>
  );
}

/** Distribute buttons, for the Align section: a set gap along x or y, or even spacing. */
export function DistributeRow() {
  const a = arrangePrefs();
  const ids = selection.value;
  const few = ids.size < 2;
  const run = (axis: "x" | "y", gap: number | null) => commit(distribute(doc.value, ids, axis, gap));
  return (
    <div class="ws-row ws-distribute">
      <Len label={t("Gap")} mm={a.gap} onCommit={(gap) => setArrange({ gap })} />
      <IconButton icon={AlignHorizontalSpaceAround} label={t("Distribute left to right with this gap")} disabled={few} onClick={() => run("x", a.gap)} />
      <IconButton icon={AlignVerticalSpaceAround} label={t("Distribute top to bottom with this gap")} disabled={few} onClick={() => run("y", a.gap)} />
      <span class="ws-sep" />
      <IconButton icon={AlignHorizontalSpaceBetween} label={t("Space evenly left to right (the outer two stay)")} disabled={ids.size < 3} onClick={() => run("x", null)} />
      <IconButton icon={AlignVerticalSpaceBetween} label={t("Space evenly top to bottom (the outer two stay)")} disabled={ids.size < 3} onClick={() => run("y", null)} />
    </div>
  );
}

/** Linear / grid pattern of the selection on the bed, and automatic arrangement. */
export function ArrangeSections() {
  const a = arrangePrefs();
  const ids = selection.value;
  const none = ids.size === 0;
  const total = a.cols * a.rows;
  const makePattern = () => {
    const r = linearArray(doc.value, ids, a.cols, a.rows, a.gapX, a.gapY);
    if ("error" in r) return notify(r.error === "count" ? t("Too many copies: at most {n}.", { n: MAX_PATTERN_COPIES }) : t("Select something first."), "error");
    commit(r.doc);
    selection.value = r.ids;
  };
  const arrange = () => {
    const r = autoArrange(doc.value, ids, profile.value, { gap: a.nestGap, rotate: a.rotate, ...(a.useArea ? { area: userArea(profile.value, a.area) } : {}) });
    commit(r.doc);
    if (r.left)
      notify(
        a.useArea
          ? tp(["{n} object didn't fit in the area and stayed where it was.", "{n} objects didn't fit in the area and stayed where they were."], r.left)
          : tp(["{n} object didn't fit on the bed and stayed where it was.", "{n} objects didn't fit on the bed and stayed where they were."], r.left),
        "warn",
      );
  };
  return (
    <>
      <More id="linearPattern" summary={t("Linear pattern")}>
        <div class="ws-row ws-arrange">
          <Count label={t("Columns")} value={a.cols} onCommit={(cols) => setArrange({ cols })} />
          <Count label={t("Rows")} value={a.rows} onCommit={(rows) => setArrange({ rows })} />
          <Len label={t("Gap X")} mm={a.gapX} onCommit={(gapX) => setArrange({ gapX })} />
          <Len label={t("Gap Y")} mm={a.gapY} onCommit={(gapY) => setArrange({ gapY })} />
        </div>
        <div class="ws-row">
          <button type="button" class="ws-arrange-btn" disabled={none || total < 2} onClick={makePattern} title={t("Copies of the selection in a grid, gaps measured between their boxes")}>
            <Grid3x3 size={14} strokeWidth={1.75} aria-hidden="true" /> {tp(["Make {n} copy", "Make {n} copies"], Math.max(0, total - 1))}
          </button>
        </div>
      </More>
      <More id="autoArrange" summary={t("Auto arrange on the bed")}>
        <div class="ws-row ws-arrange">
          <Len label={t("Min gap")} mm={a.nestGap} min={0} onCommit={(nestGap) => setArrange({ nestGap })} />
          <label class="ws-check" title={t("Turn each object to its tightest box, and a further 90° where that packs better")}>
            <input type="checkbox" checked={a.rotate} onChange={(e) => setArrange({ rotate: e.currentTarget.checked })} /> {t("Rotate for best fit")}
          </label>
        </div>
        <label class="ws-check" title={t("Pack into a rectangle, such as a scrap of material, instead of the whole bed")}>
          <input type="checkbox" checked={a.useArea} onChange={(e) => setArrange({ useArea: e.currentTarget.checked })} /> {t("Only inside an area (scrap)")}
        </label>
        {a.useArea && (
          <>
            <div class="ws-row ws-arrange">
              <Len label="X" mm={a.area.x} min={0} onCommit={(x) => setArrange({ area: { ...a.area, x } })} />
              <Len label="Y" mm={a.area.y} min={0} onCommit={(y) => setArrange({ area: { ...a.area, y } })} />
              <Len label={t("W")} mm={a.area.w} min={1} onCommit={(w) => setArrange({ area: { ...a.area, w } })} />
              <Len label={t("H")} mm={a.area.h} min={1} onCommit={(h) => setArrange({ area: { ...a.area, h } })} />
            </div>
            <div class="ws-row">
              <button type="button" class="ws-arrange-btn" disabled={!selBox.value} onClick={() => selBox.value && setArrange({ area: areaFromBox(profile.value, selBox.value) })} title={t("Set the area to the selection's box: draw or select a rectangle the size of the scrap, use it here, then select the parts")}>
                {t("Area from selection")}
              </button>
            </div>
            <p class="ws-hint">{t("X and Y are the area's corner nearest the home corner, measured from home. The area shows as an orange dashed box.")}</p>
          </>
        )}
        <div class="ws-row">
          <button type="button" class="ws-arrange-btn" disabled={none} onClick={arrange} title={t("Pack the selection from the machine's home corner, keeping the gap between boxes and from the bed edge")}>
            <LayoutDashboard size={14} strokeWidth={1.75} aria-hidden="true" /> {t("Arrange selection")}
          </button>
        </div>
        <p class="ws-hint">{t("Packs by bounding boxes, starting at the home corner (of the area, when one is set). Undo puts everything back.")}</p>
      </More>
    </>
  );
}
