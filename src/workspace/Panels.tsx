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
  Redo2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Trash2,
  Undo2,
  Ungroup,
  X,
} from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { FitBed, FitSelection, ModeCut, ModeFill } from "../ui/customIcons";
import { ProjectButtons } from "./ProjectButtons";
import { newSketch } from "./sketch/state";
import { shortcutsOpen } from "./ShortcutSheet";
import { NumberInput } from "../ui/NumberInput";
import { IconButton, IconToggle } from "../ui/icons";
import { type Anchor, type MachineProfile, type OriginCorner, fromUser, toUser, anchorPoint } from "../scene/model";
import { type AlignMode, align, selectionBox, setSelectionBox } from "../scene/ops";
import { canRedo, canUndo, commit, cursor, doc, messages, notify, prefs, profile, selBox, selection } from "../scene/store";
import { actions, importFiles } from "./actions";
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
    <div class="ws-anchor" title="Reference point for X/Y (relative to the machine origin corner)">
      {vals.map((fy) =>
        vals.map((fx) => (
          <button
            key={`${fx}${fy}`}
            class={a.fx === fx && a.fy === fy ? "on" : ""}
            aria-label={`Selection anchor ${fy === 0 ? "top" : fy === 0.5 ? "middle" : "bottom"} ${fx === 0 ? "left" : fx === 0.5 ? "center" : "right"}`}
            aria-pressed={a.fx === fx && a.fy === fy}
            onClick={() => (prefs.value = { ...prefs.value, anchor: { fx, fy } as Anchor })}
          />
        )),
      )}
    </div>
  );
}

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

  const doAlign = (mode: AlignMode) => {
    const multi = ids.size > 1;
    const ref = multi ? selectionBox(doc.value, ids)! : { minX: 0, minY: 0, maxX: p.bedW, maxY: p.bedH };
    commit(align(doc.value, ids, mode, ref));
  };

  return (
    <section class="ws-panel">
      <h3>Position &amp; size</h3>
      {selectionHasHidden && <p class="ws-hint">Selected objects include hidden paths; object edits affect those paths too.</p>}
      <div class="ws-grid2">
        <AnchorPicker />
        <div>
          <NumField label="X" unit="mm" value={user?.x ?? null} onCommit={(x) => user && w !== null && h !== null && place(x, user.y, w, h)} />
          <NumField label="Y" unit="mm" value={user?.y ?? null} onCommit={(y) => user && w !== null && h !== null && place(user.x, y, w, h)} />
          <NumField label="W" unit="mm" value={w} min={0.001} onCommit={setW} />
          <NumField label="H" unit="mm" value={h} min={0.001} onCommit={setH} />
        </div>
      </div>
      <div class="ws-row">
        <IconToggle on={pr.lockAspect} onIcon={Lock} offIcon={LockOpen} label="Lock aspect ratio" onChange={(lockAspect) => (prefs.value = { ...pr, lockAspect })} />
      </div>

      <h3>Rotate &amp; mirror</h3>
      <div class="ws-row">
        <input class="ws-small" type="number" value={rot} onInput={(e) => setRot(Number(e.currentTarget.value))} />°
        <IconButton icon={RotateCcw} label="Rotate counter-clockwise" disabled={!b} onClick={() => actions.rotate(-rot)} />
        <IconButton icon={RotateCw} label="Rotate clockwise" disabled={!b} onClick={() => actions.rotate(rot)} />
        <IconButton icon={FlipHorizontal2} label="Mirror horizontally" disabled={!b} onClick={() => actions.mirror("h")} />
        <IconButton icon={FlipVertical2} label="Mirror vertically" disabled={!b} onClick={() => actions.mirror("v")} />
      </div>

      <h3>Align {ids.size > 1 ? "(to selection)" : "(to bed)"}</h3>
      <div class="ws-row">
        <IconButton icon={AlignStartVertical} label="Align left" disabled={!b} onClick={() => doAlign("left")} />
        <IconButton icon={AlignCenterVertical} label="Align horizontal centres" disabled={!b} onClick={() => doAlign("hcenter")} />
        <IconButton icon={AlignEndVertical} label="Align right" disabled={!b} onClick={() => doAlign("right")} />
        <IconButton icon={AlignStartHorizontal} label="Align top" disabled={!b} onClick={() => doAlign("top")} />
        <IconButton icon={AlignCenterHorizontal} label="Align vertical centres" disabled={!b} onClick={() => doAlign("vcenter")} />
        <IconButton icon={AlignEndHorizontal} label="Align bottom" disabled={!b} onClick={() => doAlign("bottom")} />
        <span class="ws-sep" />
        <IconButton icon={LocateFixed} label="Center on bed" disabled={!b} onClick={actions.centerOnBed} />
        <IconButton icon={Group} label="Group (⌘G)" disabled={ids.size < 2} onClick={actions.group} />
        <IconButton icon={Ungroup} label="Ungroup (⇧⌘G)" disabled={!b} onClick={actions.ungroup} />
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
        <h3>Objects ({d.objects.length})</h3>
      </summary>
      <ul class="ws-list">
        {d.objects.map((o) => (
          <li key={o.id}>
            <button
            type="button"
            disabled={!visibleIds.has(o.id)}
            title={!visibleIds.has(o.id) ? "All colours in this object are shown as shadows" : undefined}
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
        {d.objects.length === 0 && <li class="ws-empty">Import a DXF or drop one on the canvas</li>}
      </ul>
    </details>
  );
}

const CORNERS: OriginCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Machine profile, inline in the Machine tab. `advanced` adds saved machine origins (developer mode). */
export function ProfileSection(props: { advanced: boolean }) {
  const [draft, setDraft] = useState<MachineProfile>(profile.value);
  const [saved, setSaved] = useState<SavedMachineOrigin[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [selectedMachine, setSelectedMachine] = useState("");
  useEffect(() => {
    try { setSaved(parseMachineOrigins(localStorage.getItem(MACHINE_ORIGINS_KEY))); }
    catch (e) { setStorageError(`Cannot load saved machine origins: ${e instanceof Error ? e.message : String(e)}`); }
  }, []);
  const bed = bedLoad.value;
  const currentProfile = profile.value;
  useEffect(() => {
    if (bed.state === "ready") setDraft((d) => ({ ...d, bedW: currentProfile.bedW, bedH: currentProfile.bedH }));
  }, [bed.state, currentProfile.bedW, currentProfile.bedH]);
  const cardId = linkState.value === "verified" ? link.cardId : null;
  return (
    <section class="ws-panel ws-profile">
      <h3>Machine profile</h3>
      <label>
        Name <input value={draft.name} onInput={(e) => setDraft({ ...draft, name: e.currentTarget.value })} />
      </label>
      <label>
        Bed width (mm) <input type="number" min={1} disabled={cardId !== null} value={draft.bedW} onInput={(e) => setDraft({ ...draft, bedW: Number(e.currentTarget.value) })} />
      </label>
      <label>
        Bed height (mm) <input type="number" min={1} disabled={cardId !== null} value={draft.bedH} onInput={(e) => setDraft({ ...draft, bedH: Number(e.currentTarget.value) })} />
      </label>
      {cardId !== null && <p class="ws-hint" role={bed.state === "error" ? "alert" : undefined}>{bed.message}
        {bed.state === "error" && <IconButton icon={RefreshCw} label="Retry the bed read" onClick={() => void refreshBedDimensions()} />}
      </p>}
      <label>
        Travel speed (mm/s) <input type="number" min={1} value={draft.travelSpeed} onInput={(e) => setDraft({ ...draft, travelSpeed: Number(e.currentTarget.value) })} />
      </label>
      <label>
        Frame speed (mm/s) <input type="number" min={1} max={300} value={draft.frameSpeed ?? 30} onInput={(e) => setDraft({ ...draft, frameSpeed: Number(e.currentTarget.value) })} />
      </label>
      <label>
        Acceleration (mm/s²) <input type="number" min={1} value={draft.accel} onInput={(e) => setDraft({ ...draft, accel: Number(e.currentTarget.value) })} />
      </label>
      <label>
        Machine origin (home corner)
        <select value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.currentTarget.value as OriginCorner })}>
          {CORNERS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <p class="ws-hint">The origin corner is where the head goes when it homes. Coordinates and rulers are measured from it. Travel speed and acceleration only affect the time estimate.</p>
      {props.advanced && <>
      <h3>Saved machine origins</h3>
      <p class="ws-hint">Card IDs identify controller types, not individual machines. Choose your machine by name and confirm its physical home corner; it is never detected automatically.</p>
      {storageError && <p class="warn" role="alert">{storageError}</p>}
      <label>Saved machine
        <select value={selectedMachine} onChange={(e) => setSelectedMachine(e.currentTarget.value)}>
          <option value="">Select a saved machine</option>
          {saved.map((m) => <option value={m.name} key={m.name}>{m.name} · {m.origin} · card 0x{m.cardId.toString(16)}</option>)}
        </select>
      </label>
      <div class="ws-row">
        <IconButton icon={BookmarkCheck} label="Use the saved origin" disabled={!selectedMachine} onClick={() => {
          const entry = saved.find((m) => m.name === selectedMachine);
          if (!entry) return;
          if (cardId !== null && cardId !== entry.cardId) {
            notify("The saved machine's card ID does not match the connected controller.", "error");
            return;
          }
          setDraft({ ...draft, name: entry.name, origin: entry.origin });
        }} />
        <IconButton icon={BookmarkPlus} label="Remember this origin for the machine" disabled={cardId === null || !!storageError || !draft.name.trim()} onClick={() => {
          if (cardId === null) return;
          const name = draft.name.trim();
          const existing = saved.find((m) => m.name === name);
          if (existing && !window.confirm(`Replace saved origin for "${name}"?`)) return;
          const next = [...saved.filter((m) => m.name !== name), { name, cardId, origin: draft.origin }];
          try {
            localStorage.setItem(MACHINE_ORIGINS_KEY, JSON.stringify(next));
            setSaved(next);
            setSelectedMachine(name);
            notify(`Saved origin for ${name}.`);
          } catch (e) { setStorageError(`Cannot save machine origin: ${e instanceof Error ? e.message : String(e)}`); }
        }} />
      </div>
      </>}
      <div class="ws-row">
        <IconButton
          icon={Check}
          label="Save the profile"
          onClick={() => {
            if (draft.bedW > 0 && draft.bedH > 0 && draft.travelSpeed > 0 && draft.accel > 0 && (draft.frameSpeed ?? 30) > 0 && (draft.frameSpeed ?? 30) <= 300) {
              profile.value = cardId !== null ? { ...draft, bedW: profile.value.bedW, bedH: profile.value.bedH } : draft;
              notify("Machine profile saved.");
            } else notify("Machine profile values must be positive (frame speed at most 300 mm/s).", "error");
          }}
        />
        <IconButton icon={Undo2} label="Discard changes" onClick={() => setDraft(profile.value)} />
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
      <IconButton icon={FileUp} label="Import DXF…" onClick={() => fileRef.current?.click()} />
      <IconButton icon={PenTool} label="New sketch: draw lines, arcs, circles with dimensions and constraints" onClick={() => void newSketch()} />
      <input
        ref={fileRef}
        type="file"
        accept=".dxf"
        multiple
        hidden
        onChange={(e) => {
          const files = e.currentTarget.files;
          if (files) void importFiles(Array.from(files));
          e.currentTarget.value = "";
        }}
      />
      <span class="ws-sep" />
      <IconButton icon={Undo2} label="Undo (⌘Z)" disabled={!canUndo.value} onClick={actions.undo} />
      <IconButton icon={Redo2} label="Redo (⇧⌘Z)" disabled={!canRedo.value} onClick={actions.redo} />
      <IconButton icon={CopyPlus} label="Duplicate (⌘D)" disabled={!has} onClick={actions.duplicate} />
      <IconButton icon={Trash2} label="Delete (⌫)" disabled={!has} onClick={actions.delete} />
      <span class="ws-sep" />
      <IconButton icon={ModeCut} label="Cut: move the selection to a cut layer" disabled={!has} onClick={() => actions.setMode("cut")} />
      <IconButton icon={ModeFill} label="Fill: move the selection's closed shapes to a fill (engrave) layer" disabled={!has} onClick={() => actions.setMode("fill")} />
      <span class="ws-sep" />
      <IconButton icon={FitBed} label="Zoom to bed (B)" onClick={actions.zoomBed} />
      <IconButton icon={FitSelection} label="Zoom to selection (F)" disabled={!has} onClick={actions.zoomSelection} />
      <span class="ws-sep" />
      <IconToggle on={pr.snapToGrid} onIcon={Magnet} label="Snap to grid (hold Alt while dragging to invert)" onChange={(snapToGrid) => (prefs.value = { ...pr, snapToGrid })} />
      <select value={pr.gridStep} onChange={(e) => (prefs.value = { ...pr, gridStep: Number(e.currentTarget.value) })} title="Snap step">
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
      <IconButton icon={Keyboard} label="Keyboard shortcuts (?)" onClick={() => (shortcutsOpen.value = true)} />
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
