import { msg, t, tp } from "../i18n";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  BookmarkCheck,
  BookmarkPlus,
  Check,
  CopyPlus,
  FileDown,
  FileUp,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Keyboard,
  PenTool,
  LocateFixed,
  Lock,
  LockOpen,
  Magnet,
  PaintBucket,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Ungroup,
  X,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { FitBed, FitSelection, ModeCut, ModeFill } from "../ui/customIcons";
import { fillTool, toggleFillTool } from "./fillTool";
import { ProjectButtons } from "./ProjectButtons";
import { newSketch } from "./sketch/state";
import { shortcutsOpen } from "./ShortcutSheet";
import { NumberInput } from "../ui/NumberInput";
import { IconButton, IconToggle } from "../ui/icons";
import { ASSUMED_MIN_FIRE_POWER, ASSUMED_START_SPEED, type Anchor, DEFAULT_PROFILE, type MachineProfile, type OriginCorner, fromUser, toUser, anchorPoint } from "../scene/model";
import { MACHINE_CLASSES, applyClass, classById } from "../machine/classes";
import { TUNE_EXT, parseTune, serializeTune } from "../machine/tuneFile";
import { presetOf, presets, savePresets } from "./materials";
import { type AlignMode, align, objectScale, selectionBox, setObjectScale, setSelectionBox } from "../scene/ops";
import { addMachine, canRedo, canUndo, commit, cursor, doc, machinePrompt, machines, messages, notify, prefs, profile, removeMachine, selBox, selectMachine, selection, updateMachine } from "../scene/store";
import { IMPORT_ACCEPT, actions, importFiles } from "./actions";
import { ExportDesign, ImportDesign } from "../ui/customIcons";
import { openExport } from "./ExportDialog";
import { PreviewBar } from "./LayersPanel";
import { formatUser } from "./render";
import { contextMenu } from "./ContextMenu";
import { bedLoad, link, linkState, refreshBedDimensions } from "../app/connection";
import { visibleDocument } from "../job/layers";
import { MACHINE_ORIGINS_KEY, type SavedMachineOrigin, parseMachineOrigins } from "../app/machineSettings";

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? "0" : n.toFixed(2).replace(/\.?0+$/, ""));

/** Labelled position/size field (NumberInput: ↑/↓ and the wheel step by 1 mm, Shift 10, Alt 0.1). */
function NumField(props: { label: string; value: number | null; onCommit: (v: number) => void; unit?: string; min?: number }) {
  return (
    <label class="ws-num">
      <span>{props.label}</span>
      <NumberInput value={props.value} label={props.label} min={props.min} disabled={props.value === null} onCommit={props.onCommit} onInvalid={(m) => notify(m, "error")} />
      {props.unit && <em>{props.unit}</em>}
    </label>
  );
}

function AnchorPicker() {
  const a = prefs.value.anchor;
  const vals = [0, 0.5, 1] as const;
  return (
    <div class="ws-anchor" title={t("Reference point for X/Y (relative to the machine origin corner)")}>
      {vals.map((fy) =>
        vals.map((fx) => (
          <button
            key={`${fx}${fy}`}
            class={a.fx === fx && a.fy === fy ? "on" : ""}
            aria-label={t("Selection anchor {y} {x}", { y: fy === 0 ? t("top") : fy === 0.5 ? t("middle") : t("bottom"), x: fx === 0 ? t("left") : fx === 0.5 ? t("center") : t("right") })}
            aria-pressed={a.fx === fx && a.fy === fy}
            onClick={() => (prefs.value = { ...prefs.value, anchor: { fx, fy } as Anchor })}
          />
        )),
      )}
    </div>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

const CORNER_NAME: Record<OriginCorner, string> = { "top-left": msg("Top left"), "top-right": msg("Top right"), "bottom-left": msg("Bottom left"), "bottom-right": msg("Bottom right") };

export function PropertiesPanel() {
  const b = selBox.value;
  const p = profile.value;
  const pr = prefs.value;
  const ids = selection.value;
  const hiddenColors = new Set((doc.value.layers ?? []).filter((l) => l.show === false).map((l) => l.color));
  const selectionHasHidden = doc.value.objects.some((o) => ids.has(o.id) && o.paths.some((path) => hiddenColors.has(path.color)));
  const user = b ? toUser(p, anchorPoint(p, b, pr.anchor)) : null;
  const w = b ? b.maxX - b.minX : null;
  const h = b ? b.maxY - b.minY : null;

  const place = (ux: number, uy: number, nw: number, nh: number) =>
    commit(setSelectionBox(doc.value, ids, p, pr.anchor, fromUser(p, { x: ux, y: uy }), nw, nh));
  const setW = (nw: number) => {
    if (!user || w === null || h === null) return;
    const k = w > 1e-9 ? nw / w : 1;
    place(user.x, user.y, nw, pr.lockAspect ? h * k : h);
  };
  const setH = (nh: number) => {
    if (!user || w === null || h === null) return;
    const k = h > 1e-9 ? nh / h : 1;
    place(user.x, user.y, pr.lockAspect ? w * k : w, nh);
  };
  const [rot, setRot] = useState(90);
  // Scale of a single object relative to its drawn size (sketches keep their own dimensions; this sits on top).
  const one = ids.size === 1 ? doc.value.objects.find((o) => ids.has(o.id)) : undefined;
  const sc = one ? objectScale(one) : null;
  const setScale = (axis: "x" | "y", pct: number) => {
    if (!one || !sc) return;
    const k = pct / 100 / (axis === "x" ? sc.sx : sc.sy);
    const sx = axis === "x" || pr.lockAspect ? sc.sx * k : sc.sx;
    const sy = axis === "y" || pr.lockAspect ? sc.sy * k : sc.sy;
    commit(setObjectScale(doc.value, one.id, sx, sy, p, pr.anchor));
  };

  const doAlign = (mode: AlignMode) => {
    const multi = ids.size > 1;
    const ref = multi ? selectionBox(doc.value, ids)! : { minX: 0, minY: 0, maxX: p.bedW, maxY: p.bedH };
    commit(align(doc.value, ids, mode, ref));
  };

  return (
    <section class="ws-panel">
      <h3>{t("Position & size")}</h3>
      {selectionHasHidden && <p class="ws-hint">{t("Selected objects include hidden paths; object edits affect those paths too.")}</p>}
      <div class="ws-grid2">
        <AnchorPicker />
        <div>
          <NumField label="X" unit="mm" value={user?.x ?? null} onCommit={(x) => user && w !== null && h !== null && place(x, user.y, w, h)} />
          <NumField label="Y" unit="mm" value={user?.y ?? null} onCommit={(y) => user && w !== null && h !== null && place(user.x, y, w, h)} />
          <NumField label="W" unit="mm" value={w} min={0.001} onCommit={setW} />
          <NumField label="H" unit="mm" value={h} min={0.001} onCommit={setH} />
        </div>
      </div>
      <div class="ws-scale">
        <IconToggle on={pr.lockAspect} onIcon={Lock} offIcon={LockOpen} label={t("Lock aspect ratio")} onChange={(lockAspect) => (prefs.value = { ...pr, lockAspect })} />
        <span title={t("Scale of the selected object relative to its drawn size")}>{t("Scale")}</span>
        <NumField label="X" unit="%" value={sc ? round(sc.sx * 100) : null} min={0.001} onCommit={(v) => setScale("x", v)} />
        <NumField label="Y" unit="%" value={sc ? round(sc.sy * 100) : null} min={0.001} onCommit={(v) => setScale("y", v)} />
      </div>

      <h3>{t("Rotate & mirror")}</h3>
      <div class="ws-row">
        <input class="ws-small" type="number" value={rot} onInput={(e) => setRot(Number(e.currentTarget.value))} />°
        <IconButton icon={RotateCcw} label={t("Rotate counter-clockwise")} disabled={!b} onClick={() => actions.rotate(-rot)} />
        <IconButton icon={RotateCw} label={t("Rotate clockwise")} disabled={!b} onClick={() => actions.rotate(rot)} />
        <IconButton icon={FlipHorizontal2} label={t("Mirror horizontally")} disabled={!b} onClick={() => actions.mirror("h")} />
        <IconButton icon={FlipVertical2} label={t("Mirror vertically")} disabled={!b} onClick={() => actions.mirror("v")} />
      </div>

      <h3>{ids.size > 1 ? t("Align (to selection)") : t("Align (to bed)")}</h3>
      <div class="ws-row">
        <IconButton icon={AlignStartVertical} label={t("Align left")} disabled={!b} onClick={() => doAlign("left")} />
        <IconButton icon={AlignCenterVertical} label={t("Align horizontal centres")} disabled={!b} onClick={() => doAlign("hcenter")} />
        <IconButton icon={AlignEndVertical} label={t("Align right")} disabled={!b} onClick={() => doAlign("right")} />
        <IconButton icon={AlignStartHorizontal} label={t("Align top")} disabled={!b} onClick={() => doAlign("top")} />
        <IconButton icon={AlignCenterHorizontal} label={t("Align vertical centres")} disabled={!b} onClick={() => doAlign("vcenter")} />
        <IconButton icon={AlignEndHorizontal} label={t("Align bottom")} disabled={!b} onClick={() => doAlign("bottom")} />
        <span class="ws-sep" />
        <IconButton icon={LocateFixed} label={t("Center on bed")} disabled={!b} onClick={actions.centerOnBed} />
        <IconButton icon={Group} label={t("Group (⌘G)")} disabled={ids.size < 2} onClick={actions.group} />
        <IconButton icon={Ungroup} label={t("Ungroup (⇧⌘G)")} disabled={!b} onClick={actions.ungroup} />
      </div>
    </section>
  );
}

export function ObjectsPanel() {
  const d = doc.value;
  const visibleIds = new Set(visibleDocument(d).objects.map((o) => o.id));
  const ids = selection.value;
  const [open, setOpen] = useState(d.objects.length <= 3);
  return (
    <details class="ws-panel ws-objects" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <h3>{t("Objects ({n})", { n: d.objects.length })}</h3>
      </summary>
      <ul class="ws-list">
        {d.objects.map((o) => (
          <li key={o.id}>
            <button
            type="button"
            disabled={!visibleIds.has(o.id)}
            title={!visibleIds.has(o.id) ? t("All colours in this object are shown as shadows") : undefined}
            class={ids.has(o.id) ? "on" : ""}
            aria-pressed={ids.has(o.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selection.value.has(o.id)) selection.value = new Set([o.id]);
              contextMenu.value = { x: e.clientX, y: e.clientY };
            }}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey) {
                const next = new Set(ids);
                if (next.has(o.id)) next.delete(o.id);
                else next.add(o.id);
                selection.value = next;
              } else selection.value = new Set([o.id]);
            }}
          >
            <span class="ws-swatches">
              {[...new Set(o.paths.map((p) => p.color))].slice(0, 6).map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            {o.name}
            <small>{o.paths.length}</small>
            </button>
          </li>
        ))}
        {d.objects.length === 0 && <li class="ws-empty">{t("Import a drawing or picture, or drop one on the canvas")}</li>}
      </ul>
    </details>
  );
}

const CORNERS: OriginCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Scan offsets as "speed: offset" pairs, e.g. "100: 0.1, 300: 0.25". */
const scanText = (t_: MachineProfile["scanOffsets"]) => (t_ ?? []).map((e) => `${e.speed}: ${e.offset}`).join(", ");
function parseScan(text: string): MachineProfile["scanOffsets"] | null {
  const out: { speed: number; offset: number }[] = [];
  for (const part of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return null;
    out.push({ speed: Number(m[1]), offset: Number(m[2]) });
  }
  return out;
}

function NumRow(props: { label: string; value: number | undefined; min?: number; max?: number; disabled?: boolean; onInput: (v: number) => void; title?: string }) {
  return (
    <label title={props.title}>
      {props.label} <input type="number" min={props.min} max={props.max} disabled={props.disabled} value={props.value ?? ""} onInput={(e) => props.onInput(Number(e.currentTarget.value))} />
    </label>
  );
}

/**
 * Machine profiles, inline in the Machine tab: pick the active machine, its class (typical defaults), bed and
 * origin; advanced mode adds the raw motion and firing values and tuning files; `advanced` (developer mode) adds
 * saved machine origins.
 */
export function ProfileSection(props: { advanced: boolean }) {
  const [draft, setDraft] = useState<MachineProfile>(profile.value);
  const [scan, setScan] = useState(scanText(profile.value.scanOffsets));
  const [saved, setSaved] = useState<SavedMachineOrigin[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [selectedMachine, setSelectedMachine] = useState("");
  const tuneRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try { setSaved(parseMachineOrigins(localStorage.getItem(MACHINE_ORIGINS_KEY))); }
    catch (e) { setStorageError(t("Cannot load saved machine origins: {error}", { error: e instanceof Error ? e.message : String(e) })); }
  }, []);
  const bed = bedLoad.value;
  const currentProfile = profile.value;
  // Another profile became active: start over from it. The same profile changed elsewhere (tuning, bed read):
  // take those changes but keep the fields typed here and not yet saved.
  const base = useRef(currentProfile);
  useEffect(() => {
    const old = base.current;
    base.current = currentProfile;
    if (old === currentProfile) return;
    if (old.id !== currentProfile.id) {
      setDraft(currentProfile);
      setScan(scanText(currentProfile.scanOffsets));
      return;
    }
    setDraft((d) => {
      const typed = (Object.keys(d) as (keyof MachineProfile)[]).filter((k) => d[k] !== old[k]);
      return { ...currentProfile, ...Object.fromEntries(typed.map((k) => [k, d[k]])) };
    });
    setScan((s) => (s === scanText(old.scanOffsets) ? scanText(currentProfile.scanOffsets) : s));
  }, [currentProfile]);
  const cardId = linkState.value === "verified" ? link.cardId : null;
  const adv = prefs.value.advanced;
  const list = machines.value;
  const cls = classById(draft.class);
  const saveDraft = () => {
    const scanOffsets = parseScan(scan);
    if (scanOffsets === null) return notify(t("Scan offsets: write speed: offset pairs separated by commas, e.g. 100: 0.1, 300: 0.25"), "error");
    const ok = draft.name.trim() && draft.bedW > 0 && draft.bedH > 0 && draft.travelSpeed > 0 && draft.accel > 0 && (draft.frameSpeed ?? 30) > 0 && (draft.frameSpeed ?? 30) <= 300 &&
      (draft.startSpeed ?? 10) >= 0 && (draft.minFirePower ?? 10) >= 0 && (draft.minFirePower ?? 10) <= 100;
    if (!ok) return notify(t("Machine profile values must be positive (frame speed at most 300 mm/s)."), "error");
    profile.value = { ...(cardId !== null ? { ...draft, bedW: profile.value.bedW, bedH: profile.value.bedH } : draft), name: draft.name.trim(), scanOffsets };
    notify(t("Machine profile saved."));
  };
  const exportTune = () => {
    const p = profile.value;
    const text = serializeTune(p, presets.value.filter((m) => presetOf(m, p)));
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${p.name.replace(/[\\/:*?"<>|]+/g, "-") || "machine"}${TUNE_EXT}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importTune = async (file: File) => {
    try {
      const f = parseTune(await file.text());
      const existing = list.find((m) => m.id && m.id === f.profile.id);
      if (existing && !window.confirm(t("Replace the tuning of \"{name}\" with the file's (saved {date})?", { name: existing.name, date: f.savedAt.slice(0, 10) }))) return;
      const m = existing ? f.profile : addMachine(f.profile, false);
      if (existing) updateMachine(m);
      // The file's materials replace this machine's library.
      const mats = f.materials.map((x) => ({ ...x, machine: m.name, machineId: m.id }));
      savePresets([...presets.value.filter((x) => !presetOf(x, m)), ...mats]);
      selectMachine(m.id!);
      notify(tp(["Loaded the tuning of \"{name}\" ({n} material).", "Loaded the tuning of \"{name}\" ({n} materials)."], mats.length, { name: m.name }));
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <section class="ws-panel ws-profile">
      <h3>{t("Machine profile")}</h3>
      <div class="ws-row">
        <select class="ws-grow" aria-label={t("Active machine profile")} value={currentProfile.id} onChange={(e) => selectMachine(e.currentTarget.value)}>
          {list.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.controller ? ` · card 0x${m.controller.cardId.toString(16)}` : ""}
            </option>
          ))}
        </select>
        <IconButton icon={Plus} label={t("New machine profile")} onClick={() => {
          const m = addMachine({ ...DEFAULT_PROFILE, name: t("Machine {n}", { n: list.length + 1 }) });
          machinePrompt.value = { kind: "class", id: m.id!, resolve: () => {} };
        }} />
        <IconButton icon={Trash2} label={t("Delete this machine profile")} disabled={list.length <= 1} onClick={() => {
          if (window.confirm(t("Delete the machine profile \"{name}\"? Its material presets stay in the library but won't be listed.", { name: currentProfile.name }))) removeMachine(currentProfile.id!);
        }} />
      </div>
      <label>{t("Name")}{" "}<input value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      </label>
      <label title={t("Typical motion values and starting materials for this kind of machine. Tuning replaces them with your machine's own.")}>
        {t("Machine class")}
        <select value={draft.class ?? ""} onChange={(e) => {
          const c = classById(e.currentTarget.value);
          if (c) setDraft(applyClass(draft, c, cardId !== null));
        }}>
          {!draft.class && <option value="">{t("Not chosen")}</option>}
          {MACHINE_CLASSES.map((c) => (
            <option key={c.id} value={c.id}>{t(c.name)}</option>
          ))}
        </select>
      </label>
      <div class="ws-pair">
        <label>
          {t("Bed width (mm)")} <input type="number" min={1} disabled={cardId !== null} value={draft.bedW} onInput={(e) => setDraft({ ...draft, bedW: Number(e.currentTarget.value) })} />
        </label>
        <label>
          {t("Bed height (mm)")} <input type="number" min={1} disabled={cardId !== null} value={draft.bedH} onInput={(e) => setDraft({ ...draft, bedH: Number(e.currentTarget.value) })} />
        </label>
      </div>
      {cardId !== null && <p class="ws-hint" role={bed.state === "error" ? "alert" : undefined}>{bed.message}
        {bed.state === "error" && <IconButton icon={RefreshCw} label={t("Retry the bed read")} onClick={() => void refreshBedDimensions()} />}
      </p>}
      <NumRow label={t("Frame speed (mm/s)")} min={1} max={300} value={draft.frameSpeed ?? 30} onInput={(frameSpeed) => setDraft({ ...draft, frameSpeed })} />
      <label>
        {t("Machine origin (home corner)")}
        <select value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.currentTarget.value as OriginCorner })}>
          {CORNERS.map((c) => (
            <option key={c} value={c}>
              {t(CORNER_NAME[c])}
            </option>
          ))}
        </select>
      </label>
      {adv ? (
        <>
          <div class="ws-pair">
          <NumRow label={t("Travel speed (mm/s)")} min={1} value={draft.travelSpeed} onInput={(travelSpeed) => setDraft({ ...draft, travelSpeed })} />
          <NumRow label={t("Acceleration (mm/s²)")} min={1} value={draft.accel} onInput={(accel) => setDraft({ ...draft, accel })} />
          </div>
          <div class="ws-pair">
          <NumRow label={t("Start speed (mm/s)")} min={0} value={draft.startSpeed ?? ASSUMED_START_SPEED} title={t("The controller's start speed: moves start and stop at it, and corner power applies at or below it.")} onInput={(startSpeed) => setDraft({ ...draft, startSpeed })} />
          <NumRow label={t("Lowest firing power (%)")} min={0} max={100} value={draft.minFirePower ?? ASSUMED_MIN_FIRE_POWER} title={t("The lowest power at which the tube still fires reliably; suggested corner powers never go below it.")} onInput={(minFirePower) => setDraft({ ...draft, minFirePower })} />
          </div>
          <label title={t("How far rows engraved right to left land from rows engraved left to right, per speed. Measured with the scan offset test card.")}>
            {t("Scan offsets (speed: mm)")} <input value={scan} placeholder="100: 0.1, 300: 0.25" onInput={(e) => setScan(e.currentTarget.value)} />
          </label>
          <p class="ws-hint">{t("The origin corner is where the head goes when it homes. Coordinates and rulers are measured from it. Travel speed and acceleration set the time estimate and the cut order (the quickest travel); the machine uses its own.")}</p>
        </>
      ) : (
        <p class="ws-hint">
          {cls ? t("Motion values: {class}{tuned}.", { class: t(cls.name), tuned: currentProfile.tuning?.fill ? t(", tuned {date}", { date: currentProfile.tuning.fill }) : "" }) : t("Choose the machine class for typical motion values.")}{" "}
          {t("Advanced mode (status bar) shows every value.")}
        </p>
      )}
      {props.advanced && <>
      <h3>{t("Saved machine origins")}</h3>
      <p class="ws-hint">{t("Card IDs identify controller types, not individual machines. Choose your machine by name and confirm its physical home corner; it is never detected automatically.")}</p>
      {storageError && <p class="warn" role="alert">{storageError}</p>}
      <label>{t("Saved machine")}<select value={selectedMachine} onChange={(e) => setSelectedMachine(e.currentTarget.value)}>
          <option value="">{t("Select a saved machine")}</option>
          {saved.map((m) => <option value={m.name} key={m.name}>{m.name} · {t(CORNER_NAME[m.origin])} · card 0x{m.cardId.toString(16)}</option>)}
        </select>
      </label>
      <div class="ws-row">
        <IconButton icon={BookmarkCheck} label={t("Use the saved origin")} disabled={!selectedMachine} onClick={() => {
          const entry = saved.find((m) => m.name === selectedMachine);
          if (!entry) return;
          if (cardId !== null && cardId !== entry.cardId) {
            notify(t("The saved machine's card ID does not match the connected controller."), "error");
            return;
          }
          setDraft({ ...draft, name: entry.name, origin: entry.origin });
        }} />
        <IconButton icon={BookmarkPlus} label={t("Remember this origin for the machine")} disabled={cardId === null || !!storageError || !draft.name.trim()} onClick={() => {
          if (cardId === null) return;
          const name = draft.name.trim();
          const existing = saved.find((m) => m.name === name);
          if (existing && !window.confirm(t("Replace saved origin for \"{name}\"?", { name }))) return;
          const next = [...saved.filter((m) => m.name !== name), { name, cardId, origin: draft.origin }];
          try {
            localStorage.setItem(MACHINE_ORIGINS_KEY, JSON.stringify(next));
            setSaved(next);
            setSelectedMachine(name);
            notify(t("Saved origin for {name}.", { name }));
          } catch (e) { setStorageError(t("Cannot save machine origin: {error}", { error: e instanceof Error ? e.message : String(e) })); }
        }} />
      </div>
      </>}
      <div class="ws-row ws-actions">
        {adv && (
          <>
            <IconButton icon={FileDown} label={t("Save this machine's tuning and materials as a .beamtune file")} onClick={exportTune} />
            <IconButton icon={FileUp} label={t("Load a .beamtune tuning file")} onClick={() => tuneRef.current?.click()} />
            <input ref={tuneRef} type="file" accept={`${TUNE_EXT},application/json`} hidden onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void importTune(f);
              e.currentTarget.value = "";
            }} />
          </>
        )}
        <span class="ws-grow" />
        <IconButton icon={Undo2} label={t("Discard changes")} onClick={() => { setDraft(profile.value); setScan(scanText(profile.value.scanOffsets)); }} />
        <IconButton icon={Check} class="ws-primary" label={t("Save the profile")} onClick={saveDraft} />
      </div>
    </section>
  );
}

export function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const pr = prefs.value;
  const has = selection.value.size > 0;
  return (
    <div class="ws-toolbar">
      <ProjectButtons />
      <IconButton icon={ImportDesign} label={t("Import… DXF, SVG, PDF, AI, PLT, CDR or a picture (PNG, JPEG, HEIC…)")} onClick={() => fileRef.current?.click()} />
      <IconButton icon={ExportDesign} label={t("Export… the selection or everything as SVG, DXF, PDF or PNG (⌘E)")} disabled={doc.value.objects.length === 0} onClick={openExport} />
      <IconButton icon={PenTool} label={t("New sketch: draw lines, arcs, circles with dimensions and constraints")} onClick={() => void newSketch()} />
      <input
        ref={fileRef}
        type="file"
        accept={IMPORT_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files) void importFiles(Array.from(files));
          e.currentTarget.value = "";
        }}
      />
      <span class="ws-sep" />
      <IconButton icon={Undo2} label={t("Undo (⌘Z)")} disabled={!canUndo.value} onClick={actions.undo} />
      <IconButton icon={Redo2} label={t("Redo (⇧⌘Z)")} disabled={!canRedo.value} onClick={actions.redo} />
      <IconButton icon={CopyPlus} label={t("Duplicate (⌘D)")} disabled={!has} onClick={actions.duplicate} />
      <IconButton icon={Trash2} label={t("Delete (⌫)")} disabled={!has} onClick={actions.delete} />
      <span class="ws-sep" />
      <IconButton icon={ModeCut} label={t("Cut: move the selection to a cut layer")} disabled={!has} onClick={() => actions.setMode("cut")} />
      <IconButton icon={ModeFill} label={t("Fill: move the selection's closed shapes to a fill (engrave) layer")} disabled={!has} onClick={() => actions.setMode("fill")} />
      <IconToggle on={!!fillTool.value} onIcon={PaintBucket} label={t("Fill tool (I): click inside shapes to engrave them in the colour picked below; click again to clear")} onChange={toggleFillTool} />
      <span class="ws-sep" />
      <IconButton icon={FitBed} label={t("Zoom to bed (B)")} onClick={actions.zoomBed} />
      <IconButton icon={FitSelection} label={t("Zoom to selection (F)")} disabled={!has} onClick={actions.zoomSelection} />
      <span class="ws-sep" />
      <IconToggle on={pr.snapToGrid} onIcon={Magnet} label={t("Snap to grid (hold Alt while dragging to invert)")} onChange={(snapToGrid) => (prefs.value = { ...pr, snapToGrid })} />
      <select value={pr.gridStep} onChange={(e) => (prefs.value = { ...pr, gridStep: Number(e.currentTarget.value) })} title={t("Snap step")}>
        {[0.5, 1, 5, 10, 50].map((s) => (
          <option key={s} value={s}>
            {s} mm
          </option>
        ))}
      </select>
    </div>
  );
}

export function StatusBar() {
  const c = cursor.value;
  const b = selBox.value;
  const p = profile.value;
  return (
    <div class="ws-status">
      <span>{c ? formatUser(p, c) : " "}</span>
      <span>
        {b ? `Selection ${fmt(b.maxX - b.minX)} × ${fmt(b.maxY - b.minY)} mm` : ""}
      </span>
      <span class="ws-grow" />
      <PreviewBar />
      <IconToggle on={prefs.value.advanced} onIcon={SlidersHorizontal} label={t("Advanced mode: every machine and tuning value, overscan length, kerf, tuning files")} onChange={(advanced) => (prefs.value = { ...prefs.value, advanced })} />
      <IconButton icon={Keyboard} label={t("Keyboard shortcuts (?)")} onClick={() => (shortcutsOpen.value = true)} />
    </div>
  );
}

export function Toasts() {
  return (
    <div class="ws-toasts">
      {messages.value.map((m) => (
        <div key={m.id} class={`ws-toast ${m.kind}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}
