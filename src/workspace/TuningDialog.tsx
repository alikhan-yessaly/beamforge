// Tuning wizard: four test cards, each skippable. Machine steps (fill evenness, scan offset) run once per machine;
// material steps (power and speed, kerf) once per material. A step explains why it matters, adds its card to the
// drawing (placed like any object; Frame and Start as usual), and then reads the result: you click what you see on
// a drawing of the card. Results go into the machine profile or the material library.
import { msg, t, tp } from "../i18n";
import { signal } from "@preact/signals";
import { Check, CirclePlus, ScanLine, X } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { activeLayers, updateLayer } from "../job/layers";
import { scanOffsetAt } from "../machine/motion";
import { classById, seedsFor } from "../machine/classes";
import { commit, doc, notify, profile, selection } from "../scene/store";
import type { SceneObject } from "../scene/model";
import {
  type CardKind,
  type CardParams,
  FILL_ROWS,
  type FillCardParams,
  type GridCardParams,
  type KerfCardParams,
  type Patch,
  type ScanCardParams,
  accelFromStrip,
  fillParams,
  fixFromRow,
  gridParams,
  kerfParams,
  makeCard,
  scanParams,
} from "../tuning/cards";
import { cardColors, cardsIn, onlyCard, placeCard } from "../tuning/place";
import { type MaterialPreset, presets, presetsFor, savePresets } from "./materials";
import { kerfMeasured, presetOf, tunedMaterials } from "../machine/presets";
import { newId } from "../scene/model";
import { appMode, enterPrepare } from "./mode";

/** Which step is open, or null when the wizard is closed. */
export const tuningStep = signal<CardKind | null>(null);
export const openTuning = (step: CardKind = "fill") => (tuningStep.value = step);

const STEPS: { kind: CardKind; title: string; scope: string; why: string }[] = [
  {
    kind: "fill",
    title: msg("Fill evenness"),
    scope: msg("once per machine"),
    why: msg("Engraving burns deeper where the head speeds up and slows down: row ends, small letters. This card measures how fast your machine speeds up and which fix evens it out, so the checks before each job predict it correctly."),
  },
  {
    kind: "scan",
    title: msg("Scan offset"),
    scope: msg("once per machine"),
    why: msg("Rows engraved right to left land slightly off from rows engraved left to right, which makes vertical edges ragged. This card finds the shift that lines them up, at two speeds."),
  },
  {
    kind: "grid",
    title: msg("Power and speed"),
    scope: msg("once per material"),
    why: msg("Engraves a grid of speed × power and cuts squares at falling speed. You pick the engraving you like and the fastest cut that went through; they become the material's presets."),
  },
  {
    kind: "kerf",
    title: msg("Kerf"),
    scope: msg("once per material"),
    why: msg("Cuts holes of slightly different sizes and a peg. The hole the peg fits snugly tells how wide the beam cuts, so parts that must fit come out the right size (kerf compensation)."),
  },
];

const today = () => new Date().toISOString().slice(0, 10);

/** Drawing of a card with clickable patches. */
function CardView(props: { params: CardParams; picked: (p: Patch) => boolean; onPick: (p: Patch) => void; groups?: string[] }) {
  const card = makeCard(props.params);
  const pad = 2;
  const colorOf = new Map(card.layers.map((l) => [l.color, l.mode === "cut" ? "none" : l.color]));
  return (
    <svg class="ws-card" viewBox={`${-pad} ${-pad} ${card.w + 2 * pad + 14} ${card.h + 2 * pad + 3}`} role="img" aria-label={t("Drawing of the test card: click what you see on the engraved one")}>
      {card.paths.map((p, i) => (
        <polygon key={i} points={p.points.map((v) => `${v.x},${v.y}`).join(" ")} fill={colorOf.get(p.color) ?? "none"} fill-opacity={0.55} stroke={p.color} stroke-width={0.15} />
      ))}
      {card.patches
        .filter((p) => !props.groups || props.groups.includes(p.group))
        .map((p, i) => (
          <g key={`${p.group}-${i}`} class={`ws-card-patch${props.picked(p) ? " on" : ""}`} onClick={() => props.onPick(p)}>
            <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={0.6} />
            {p.label &&
              (p.group === "ramp" || p.group === "row" ? (
                <text x={p.x + p.w + 0.8} y={p.y + p.h / 2 + 0.9} font-size={2.4}>
                  {p.label}
                </text>
              ) : (
                <text x={p.x + p.w / 2} y={p.y + p.h + 2.4} font-size={2} text-anchor="middle">
                  {p.label}
                </text>
              ))}
          </g>
        ))}
    </svg>
  );
}

/** Speed and power for engraving cards: a fill layer of the drawing, an engrave preset, or the class's typical. */
function engraveDefaults(): { speed: number; power: number } {
  const cardColors = new Set(doc.value.objects.flatMap((o) => o.card?.colors ?? []));
  const fill = activeLayers(doc.value)
    .filter((l) => (l.mode ?? "cut") !== "cut" && l.output && !cardColors.has(l.color))
    .sort((a, b) => b.speed - a.speed)[0];
  if (fill) return { speed: fill.speed, power: fill.maxPower };
  const preset = presetsFor(profile.value).find((p) => p.op === "engrave");
  if (preset) return { speed: preset.speed, power: preset.maxPower };
  const seed = seedsFor(classById(profile.value.class) ?? classById("mid")!).find((s) => s.op === "engrave")!;
  return { speed: seed.speed, power: seed.power };
}

function cutDefaults(material: string): { speed: number; power: number; passes: number; preset?: string } {
  const preset = presetsFor(profile.value).find((p) => p.op === "cut" && (p.material ?? "") === material) ?? presetsFor(profile.value).find((p) => p.op === "cut");
  if (preset) return { speed: preset.speed, power: preset.maxPower, passes: preset.passes, preset: preset.id };
  const seed = seedsFor(classById(profile.value.class) ?? classById("mid")!).find((s) => s.op === "cut")!;
  return { speed: seed.speed, power: seed.power, passes: seed.passes };
}

/** Numeric field that keeps what is typed (so "12." or an empty field can be edited) and reports NaN until valid. */
function Num(props: { label: string; unit: string; value: number; invalid?: boolean; onInput: (v: number) => void }) {
  const [text, setText] = useState(String(props.value));
  return (
    <label class="ws-num-field">
      <span>{props.label}</span>
      <span class="ws-unit-input">
      <input
        inputMode="decimal"
        aria-invalid={props.invalid || undefined}
        value={text}
        onInput={(e) => {
          const s = e.currentTarget.value;
          setText(s);
          const v = s.trim() === "" ? NaN : Number(s.replace(",", "."));
          props.onInput(v);
        }}
      />
      <em>{props.unit}</em>
      </span>
    </label>
  );
}

/** Highest speed a test card may use, mm/s. */
const MAX_CARD_SPEED = 1000;

/** Making a card: its few inputs and "Add to the drawing". */
function MakeCard(props: { kind: CardKind; onMade: () => void }) {
  const [eng, setEng] = useState(engraveDefaults);
  const materials = [...new Set(presetsFor(profile.value).map((p) => p.material).filter((m): m is string => !!m))];
  const [material, setMaterial] = useState(materials[0] ?? "");
  const speedOk = Number.isFinite(eng.speed) && eng.speed >= 1 && eng.speed <= MAX_CARD_SPEED;
  const powerOk = Number.isFinite(eng.power) && eng.power > 0 && eng.power <= 100;
  const needsEngrave = props.kind !== "kerf";
  const ok = !needsEngrave || (speedOk && powerOk);
  const add = () => {
    if (!ok) return;
    try {
      const colors = cardColors(doc.value, props.kind);
      const params: CardParams =
        props.kind === "fill"
          ? fillParams(profile.value, eng.speed, eng.power, colors)
          : props.kind === "scan"
            ? scanParams(eng.speed, eng.power, colors)
            : props.kind === "grid"
              ? gridParams(material.trim() || t("New material"), eng, cutDefaults(material), colors)
              : kerfParams(material.trim() || t("New material"), cutDefaults(material), colors);
      const r = placeCard(doc.value, params, profile.value);
      if (appMode.value !== "prepare") enterPrepare();
      commit(r.doc);
      selection.value = new Set([r.id]);
      if (r.overlaps) notify(t("No free room on the bed: the test card overlaps the drawing at the home corner. Move it onto scrap before you Frame."), "warn");
      else notify(t("Test card added near the home corner. Move it onto scrap, Frame, then Start."));
      props.onMade();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <div class="ws-tune-make">
      {(props.kind === "grid" || props.kind === "kerf") && (
        <label>
          {t("Material")}
          <input list="ws-tune-materials" value={material} placeholder={t("Material, e.g. 3 mm plywood")} onInput={(e) => setMaterial(e.currentTarget.value)} />
          <datalist id="ws-tune-materials">
            {materials.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      )}
      {props.kind !== "kerf" && (
        <div class="ws-pair">
          <Num label={t("Engrave speed")} unit="mm/s" value={eng.speed} invalid={!speedOk} onInput={(speed) => setEng((e) => ({ ...e, speed }))} />
          <Num label={t("Power")} unit="%" value={eng.power} invalid={!powerOk} onInput={(power) => setEng((e) => ({ ...e, power }))} />
        </div>
      )}
      {!ok && <p class="warn" role="alert">{t("Speed must be 1–{max} mm/s and power above 0 and at most 100 %.", { max: MAX_CARD_SPEED })}</p>}
      <button type="button" class="ws-primary-btn" disabled={!ok} onClick={add}>
        <CirclePlus size={14} strokeWidth={1.75} aria-hidden="true" /> {t("Add the test card to the drawing")}
      </button>
    </div>
  );
}

function FillResults(props: { params: FillCardParams; onSaved: () => void }) {
  const [strip, setStrip] = useState<number | "none" | "all" | null>(null);
  const [row, setRow] = useState<(typeof FILL_ROWS)[number] | null>(null);
  const accel = strip !== null ? accelFromStrip(props.params, strip) : null;
  const save = () => {
    if (accel === null || row === null) return;
    const p = profile.value;
    profile.value = { ...p, accel, tuning: { ...p.tuning, fill: today(), fillFix: fixFromRow(row) } };
    notify(t("Saved: acceleration {a} mm/s², best fix: {fix}.", { a: accel, fix: t(FIX_NAME[fixFromRow(row)]) }));
    props.onSaved();
  };
  return (
    <>
      <p>{t("1. Strips at the top: click the shortest strip whose middle is lighter than its ends.")}</p>
      <CardView params={props.params} groups={["ramp"]} picked={(p) => p.value === strip} onPick={(p) => setStrip(p.value as number)} />
      <div class="ws-row">
        <button type="button" class={strip === "none" ? "on" : ""} onClick={() => setStrip("none")}>{t("None has a lighter middle")}</button>
        <button type="button" class={strip === "all" ? "on" : ""} onClick={() => setStrip("all")}>{t("Even the shortest does")}</button>
      </div>
      <p>{t("2. Rows of squares (A, B, C): click the row where the small squares look most like the big ones.")}</p>
      <CardView params={props.params} groups={["row"]} picked={(p) => p.value === row} onPick={(p) => setRow(p.value as (typeof FILL_ROWS)[number])} />
      {accel !== null && <p class="ws-hint">{t("Acceleration: {a} mm/s² (was {old}).", { a: accel, old: profile.value.accel })}</p>}
      <button type="button" class="ws-primary-btn" disabled={accel === null || row === null} onClick={save}>
        <Check size={14} strokeWidth={2} aria-hidden="true" /> {t("Save to the machine profile")}
      </button>
    </>
  );
}

const FIX_NAME = { none: msg("none needed"), overscan: msg("overscan"), corner: msg("lower corner power") };

function ScanResults(props: { params: ScanCardParams; onSaved: () => void }) {
  const [picks, setPicks] = useState<Record<number, number>>({});
  const done = props.params.speeds.every((s) => s in picks);
  const save = () => {
    const p = profile.value;
    const table = props.params.speeds.map((speed) => ({ speed, offset: picks[speed]! }));
    profile.value = { ...p, scanOffsets: [...(p.scanOffsets ?? []).filter((e) => !props.params.speeds.includes(e.speed)), ...table].sort((a, b) => a.speed - b.speed), tuning: { ...p.tuning, scanOffset: today() } };
    notify(t("Saved scan offsets: {list}.", { list: table.map((e) => `${e.speed} mm/s → ${e.offset} mm`).join(", ") }));
    props.onSaved();
  };
  return (
    <>
      <p>{t("Each row is one speed. Click the sharpest patch in each row (bars with the cleanest edges).")}</p>
      <CardView
        params={props.params}
        picked={(p) => picks[Number(p.group.slice(6))] === p.value}
        onPick={(p) => setPicks({ ...picks, [Number(p.group.slice(6))]: p.value as number })}
      />
      <p class="ws-hint">{t("Rows: {speeds} mm/s, top to bottom.", { speeds: props.params.speeds.join(", ") })}</p>
      <button type="button" class="ws-primary-btn" disabled={!done} onClick={save}>
        <Check size={14} strokeWidth={2} aria-hidden="true" /> {t("Save to the machine profile")}
      </button>
    </>
  );
}

type GridRole = "engrave" | "light" | "cut" | "score";
const ROLE_NAME: Record<GridRole, string> = { engrave: msg("Engrave"), light: msg("Light engrave"), cut: msg("Cut through"), score: msg("Score") };
/** Preset name suffix per role. */
const ROLE_PRESET: Record<GridRole, string> = { engrave: msg("engrave"), light: msg("light engrave"), cut: msg("cut"), score: msg("score") };

/** Add or update this machine's preset `name` for `material`; returns the new list and the preset's id. */
function upsertPreset(list: MaterialPreset[], material: string, name: string, op: MaterialPreset["op"], s: Partial<MaterialPreset> & { speed: number; power: number }): { list: MaterialPreset[]; id: string } {
  const m = profile.value;
  const existing = list.find((p) => presetOf(p, m) && p.material === material && p.name === name);
  const { power, ...rest } = s;
  const next: MaterialPreset = { ...(existing ?? { id: newId(), machine: m.name, machineId: m.id, material, name, passes: 1 }), ...rest, op, minPower: power, maxPower: power, passes: s.passes ?? existing?.passes ?? 1 };
  return { list: [...list.filter((p) => p !== existing), next], id: next.id };
}

function GridResults(props: { params: GridCardParams; onSaved: () => void }) {
  const [role, setRole] = useState<GridRole>("engrave");
  const [picks, setPicks] = useState<Partial<Record<GridRole, Patch>>>({});
  const [material, setMaterial] = useState(props.params.material);
  const engraveRole = role === "engrave" || role === "light";
  const save = () => {
    const mat = material.trim();
    if (!mat) return notify(t("Name the material first."), "error");
    let list = presets.value;
    const name = (r: GridRole) => `${mat} · ${t(ROLE_PRESET[r])}`;
    for (const r of ["engrave", "light", "cut", "score"] as GridRole[]) {
      const p = picks[r];
      if (p) list = upsertPreset(list, mat, name(r), r === "light" ? "engrave" : r, { speed: p.speed!, power: p.power!, tuned: today() }).list;
    }
    if (!savePresets(list)) return notify(t("Could not save the preset."), "error");
    notify(t("Saved the presets for {material} in this machine's material library.", { material: mat }));
    props.onSaved();
  };
  return (
    <>
      <label>
        {t("Material")}
        <input value={material} onInput={(e) => setMaterial(e.currentTarget.value)} />
      </label>
      <div class="ws-segmented" role="group" aria-label={t("What to pick")}>
        {(["engrave", "light", "cut", "score"] as GridRole[]).map((r) => (
          <button key={r} type="button" class={role === r ? "on" : ""} aria-pressed={role === r} onClick={() => setRole(r)}>
            {t(ROLE_NAME[r])}
            {picks[r] ? " ✓" : ""}
          </button>
        ))}
      </div>
      <p>
        {engraveRole
          ? t("Click the engraved square you want (rows: power, columns: speed).")
          : role === "cut"
            ? t("Click the fastest square that fell out cleanly.")
            : t("Click a square whose line is marked but not cut through.")}
      </p>
      <CardView params={props.params} groups={[engraveRole ? "engrave" : "cut"]} picked={(p) => picks[role] === p} onPick={(p) => setPicks({ ...picks, [role]: p })} />
      {picks[role] && (
        <p class="ws-hint">
          {picks[role]!.speed} mm/s · {picks[role]!.power} %
        </p>
      )}
      <button type="button" class="ws-primary-btn" disabled={!Object.keys(picks).length} onClick={save}>
        <Check size={14} strokeWidth={2} aria-hidden="true" /> {t("Save to the material library")}
      </button>
    </>
  );
}

function KerfResults(props: { params: KerfCardParams; onSaved: () => void }) {
  const [k, setK] = useState<number | null>(null);
  const cuts = presetsFor(profile.value).filter((p) => p.op === "cut");
  const [target, setTarget] = useState(props.params.preset ?? cuts.find((p) => p.material === props.params.material)?.id ?? "");
  const save = () => {
    if (k === null) return;
    let list = presets.value;
    let id = target;
    if (target) list = list.map((p) => (p.id === target ? { ...p, kerf: k, kerfTuned: today() } : p));
    else ({ list, id } = upsertPreset(list, props.params.material, `${props.params.material} · ${t("cut")}`, "cut", { speed: props.params.speed, power: props.params.power, passes: props.params.passes, kerf: k, kerfTuned: today() }));
    if (!savePresets(list)) return notify(t("Could not save the preset."), "error");
    // Layers already using the preset get the kerf too.
    let d = doc.value;
    for (const l of activeLayers(d)) if (l.material === id) d = updateLayer(d, l.color, { kerf: k });
    if (d !== doc.value) commit(d);
    notify(t("Saved kerf {k} mm. Cut layers using this preset are compensated for it.", { k }));
    props.onSaved();
  };
  return (
    <>
      <p>{t("Push the square peg into each hole. Click the hole it fits snugly (not loose, not forced).")}</p>
      <CardView params={props.params} groups={["hole"]} picked={(p) => p.value === k} onPick={(p) => setK(p.value as number)} />
      <label>
        {t("Save the kerf to")}
        <select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="">{t("A new cut preset for {material}", { material: props.params.material })}</option>
          {cuts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {k !== null && <p class="ws-hint">{t("Kerf: {k} mm.", { k })}</p>}
      <button type="button" class="ws-primary-btn" disabled={k === null} onClick={save}>
        <Check size={14} strokeWidth={2} aria-hidden="true" /> {t("Save to the material library")}
      </button>
    </>
  );
}

/** What a tuning step has measured for the active machine (a date or a count), or null when not done. */
export function stepDone(kind: CardKind): string | null {
  const tn = profile.value.tuning;
  if (kind === "fill") return tn?.fill ?? null;
  if (kind === "scan") return tn?.scanOffset ?? null;
  const list = presetsFor(profile.value);
  if (kind === "kerf") return kerfMeasured(list) ? t("done for some materials") : null;
  const n = tunedMaterials(list).size;
  return n ? tp(["{n} material", "{n} materials"], n) : null;
}

export function TuningDialog() {
  const step = tuningStep.value;
  const ref = useRef<HTMLDialogElement>(null);
  const [made, setMade] = useState(0);
  useEffect(() => {
    if (step && !ref.current?.open) ref.current?.showModal();
  }, [step]);
  if (!step) return null;
  const close = () => {
    ref.current?.close();
    tuningStep.value = null;
  };
  const info = STEPS.find((s) => s.kind === step)!;
  void made;
  const card: SceneObject | undefined = cardsIn(doc.value, step).at(-1);
  const params = card?.card;
  const results = (() => {
    if (!params) return null;
    const saved = () => setMade((n) => n + 1);
    switch (params.kind) {
      case "fill":
        return <FillResults params={params} onSaved={saved} />;
      case "scan":
        return <ScanResults params={params} onSaved={saved} />;
      case "grid":
        return <GridResults params={params} onSaved={saved} />;
      case "kerf":
        return <KerfResults params={params} onSaved={saved} />;
    }
  })();
  const p = profile.value;
  return (
    <dialog ref={ref} class="ws-dialog ws-tuning" onCancel={(e) => (e.preventDefault(), close())}>
      <div class="ws-row">
        <h3 class="ws-grow">{t("Tune “{machine}”", { machine: p.name })}</h3>
        <button type="button" class="ib" title={t("Close")} aria-label={t("Close")} onClick={close}>
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <nav class="ws-tune-steps" aria-label={t("Tuning steps")}>
        {STEPS.map((s, i) => {
          const done = stepDone(s.kind);
          return (
            <button key={s.kind} type="button" class={s.kind === step ? "on" : ""} aria-current={s.kind === step} onClick={() => (tuningStep.value = s.kind)}>
              <span>
                {i + 1}. {t(s.title)}
              </span>
              <small>{done ? `✓ ${done}` : t(s.scope)}</small>
            </button>
          );
        })}
      </nav>
      <p>{t(info.why)}</p>
      {step === "scan" && <p class="ws-hint">{t("Current offset at 100 mm/s: {mm} mm.", { mm: scanOffsetAt(100, p.scanOffsets).toFixed(2) })}</p>}
      <h4>{t("1. Run the card")}</h4>
      <MakeCard kind={step} onMade={() => setMade((n) => n + 1)} />
      {params && (
        <p class="ws-hint">
          <ScanLine size={14} strokeWidth={1.75} aria-hidden="true" /> {t("Everything with output on runs with the card.")}{" "}
          <button type="button" class="ws-link-btn" onClick={() => commit(onlyCard(doc.value, params))}>
            {t("Turn off the other layers")}
          </button>
        </p>
      )}
      <h4>{t("2. Read the result")}</h4>
      {results ?? <p class="ws-hint">{t("Add the card and engrave it first; then its drawing appears here to click on.")}</p>}
    </dialog>
  );
}
