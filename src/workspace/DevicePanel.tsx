// Prepare / Device mode UI: the mode switch, the Prepare-mode job bar, and the Device sidebar (job summary and
// Save to machine).
import { msg, t, tp } from "../i18n";
import { computed, signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ArrowRight, ChevronDown, ChevronUp, HardDriveDownload, PencilRuler, RefreshCw, Route, Timer, Trash2, TriangleAlert } from "lucide-preact";
import { linkState, link } from "../app/connection";
import { deleteFileOnController, listFiles, saveJobToController } from "../controller/files";
import { formatDuration } from "../job/estimate";
import { activeLayers, moveLayer } from "../job/layers";
import type { JobOrder } from "../job/plan";
import { FILE_NAME_MAX, normalizeFileName } from "../protocol/encode";
import { project } from "../project/state";
import { commit, doc, notify, prefs } from "../scene/store";
import { IconButton } from "../ui/icons";
import { jobEstimate, preview, togglePreview, toolpath } from "./job";
import { appMode, enterDevice, enterPrepare, machineBusy, prepareProblem, savingToMachine } from "./mode";
import { buildJobCommands, StartFromControl } from "./RunPanel";
import { session as sketchSession } from "./sketch/state";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ModeSwitch() {
  const mode = appMode.value;
  const busy = machineBusy();
  return (
    <div class="ws-appmode" role="tablist" aria-label={t("Workspace mode")}>
      <button type="button" role="tab" aria-selected={mode === "prepare"} class={mode === "prepare" ? "active" : ""} disabled={busy && mode !== "prepare"} onClick={enterPrepare} title={t("Edit the design: import, sketch, layers")}>
        <PencilRuler size={15} strokeWidth={1.75} aria-hidden="true" /> {t("Prepare")}
      </button>
      <button type="button" role="tab" aria-selected={mode === "device"} class={mode === "device" ? "active" : ""} disabled={!!sketchSession.value} onClick={enterDevice} title={t("Preview the planned job, then frame, start or save it on the machine")}>
        <HardDriveDownload size={15} strokeWidth={1.75} aria-hidden="true" /> {t("Device")}
      </button>
    </div>
  );
}

/** Job bar in Prepare mode: the estimate, the preview, and the step to the Device view. */
export function PrepareBar() {
  const est = jobEstimate.value;
  const problem = prepareProblem();
  return (
    <section class="ws-run">
      <div class="ws-run-details">
        <Timer size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{formatDuration(est.total)}</span>
        <IconButton icon={Route} label={t("Preview the toolpath (P)")} pressed={preview.value.on} disabled={toolpath.value.segments.length === 0} onClick={togglePreview} />
      </div>
      <div class="ws-run-status">{problem ? <small>{problem}</small> : <small>{t("Ready to prepare.")}</small>}</div>
      <button type="button" class="ws-prepare" disabled={!!problem} onClick={enterDevice} title={t("Plan the job and switch to the Device view")}>
        {t("Prepare job")} <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
      </button>
    </section>
  );
}

const MODE_NAME: Record<string, string> = { cut: msg("Cut"), fill: msg("Fill"), fillCut: msg("Fill + outline") };

const jobBox = computed(() => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of toolpath.value.segments) {
    if (!s.cut) continue;
    minX = Math.min(minX, s.x0, s.x1);
    minY = Math.min(minY, s.y0, s.y1);
    maxX = Math.max(maxX, s.x0, s.x1);
    maxY = Math.max(maxY, s.y0, s.y1);
  }
  return minX <= maxX ? { w: maxX - minX, h: maxY - minY } : null;
});

/** Swap a layer with its neighbour in the job (output-off layers in between are stepped over). */
function moveJobLayer(color: string, dir: -1 | 1): void {
  const job = toolpath.value.layers;
  const other = job[job.findIndex((l) => l.color === color) + dir]?.color;
  if (!other) return;
  let d = doc.value;
  for (let k = 0; k < 256; k++) {
    d = moveLayer(d, color, dir);
    const a = activeLayers(d);
    const [ia, ib] = [a.findIndex((l) => l.color === color), a.findIndex((l) => l.color === other)];
    if (dir < 0 ? ia < ib : ia > ib) break;
  }
  commit(d);
}

const ORDER_NAME: [JobOrder, string][] = [
  ["auto", msg("Fastest")],
  ["object", msg("Object by object")],
  ["layer", msg("Layer by layer")],
];

function JobSummary() {
  const tp_ = toolpath.value;
  const est = jobEstimate.value;
  const box = jobBox.value;
  const m = (mm: number) => (mm / 1000).toFixed(2);
  const pr = prefs.value;
  const busy = machineBusy();
  return (
    <section class="ws-panel ws-job-summary">
      <h3>{t("Job")}</h3>
      <p class="ws-job-name">{project.value.name}</p>
      <dl class="ws-job-facts">
        <dt>{t("Time")}</dt>
        <dd>~{formatDuration(est.total)}</dd>
        {box && (
          <>
            <dt>{t("Size")}</dt>
            <dd>{box.w.toFixed(1)} × {box.h.toFixed(1)} mm</dd>
          </>
        )}
        <dt>{t("Cut")}</dt>
        <dd>{m(est.cutLength)} m</dd>
        <dt>{t("Travel")}</dt>
        <dd>{m(est.travelLength)} m</dd>
      </dl>
      <div class="ws-row">
        <span>{t("Start from")}</span>
        <StartFromControl />
      </div>
      <div class="ws-row">
        <span>{t("Order")}</span>
        <select value={pr.jobOrder} disabled={busy} title={t("Fastest picks whichever finishes sooner by the time estimate. Either way, fills run before the cuts around them.")} onChange={(e) => (prefs.value = { ...pr, jobOrder: e.currentTarget.value as JobOrder })}>
          {ORDER_NAME.map(([v, label]) => (
            <option key={v} value={v}>
              {pr.jobOrder === "auto" && v === "auto" ? `${t(label)}: ${(tp_.order === "object" ? t("object by object") : t("layer by layer"))}` : t(label)}
            </option>
          ))}
        </select>
      </div>
      <h3>{tp(["{n} layer", "{n} layers"], tp_.layers.length)}</h3>
      <table class="ws-job-layers">
        <tbody>
          {tp_.layers.map((l, i) => (
            <tr key={l.color}>
              <td>
                <i class="ws-swatch" style={{ background: l.color }} />
              </td>
              <td>{t(MODE_NAME[l.mode ?? "cut"] ?? "Cut")}</td>
              <td>{l.speed} mm/s</td>
              <td>{l.minPower === l.maxPower ? `${l.maxPower} %` : `${l.minPower}–${l.maxPower} %`}</td>
              <td>×{l.passes}</td>
              <td>{formatDuration(est.layerTime[i] ?? 0)}</td>
              <td class="ws-job-move">
                <IconButton icon={ChevronUp} label={t("Cut earlier")} disabled={busy || i === 0} onClick={() => moveJobLayer(l.color, -1)} />
                <IconButton icon={ChevronDown} label={t("Cut later")} disabled={busy || i === tp_.layers.length - 1} onClick={() => moveJobLayer(l.color, 1)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tp_.warnings.map((w) => (
        <p key={w} class="ws-plan-msg">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> {w}
        </p>
      ))}
    </section>
  );
}

const machineFiles = signal<{ names: string[]; error?: string } | null>(null);
const saveProgress = signal<string | null>(null);

async function refreshFiles(): Promise<void> {
  try {
    machineFiles.value = { names: await listFiles(link) };
  } catch (e) {
    machineFiles.value = { names: [], error: errText(e) };
  }
}

async function save(name: string): Promise<void> {
  const n = normalizeFileName(name);
  if (!n) return;
  savingToMachine.value = true;
  saveProgress.value = t("Checking…");
  try {
    const r = await saveJobToController(link, buildJobCommands().commands, n, (i, total) => (saveProgress.value = t("Sending {i}/{total}…", { i, total })));
    if (r.after === r.before + 1) notify(t("Saved on the machine as {name}.", { name: r.name }));
    else notify(t("Sent as {name}, but the machine's file count didn't go up ({before} → {after}). Check the file list on the controller.", { name: r.name, before: r.before, after: r.after ?? "?" }), "warn");
  } catch (e) {
    notify(t("Save to machine: {error}", { error: errText(e) }), "error");
  } finally {
    savingToMachine.value = false;
    saveProgress.value = null;
    void refreshFiles();
  }
}

async function remove(index: number, name: string): Promise<void> {
  if (!window.confirm(t("Delete {name} from the machine's memory? This can't be undone.", { name }))) return;
  savingToMachine.value = true;
  try {
    const r = await deleteFileOnController(link, index, name);
    if (r.after === r.before - 1) notify(t("Deleted {name} from the machine.", { name }));
    else notify(t("Sent the delete for {name}, but the machine's file count didn't go down ({before} → {after}).", { name, before: r.before, after: r.after ?? "?" }), "warn");
  } catch (e) {
    notify(t("Delete on the machine: {error}", { error: errText(e) }), "error");
  } finally {
    savingToMachine.value = false;
    void refreshFiles();
  }
}

const fileName = signal<string | null>(null);

function SaveToMachine() {
  const verified = linkState.value === "verified";
  useEffect(() => {
    if (verified) void refreshFiles();
    else machineFiles.value = null;
  }, [verified]);
  const name = fileName.value ?? (project.value.name.toUpperCase().replace(/[^A-Z0-9 _.-]+/g, "-").slice(0, FILE_NAME_MAX) || "JOB");
  const n = normalizeFileName(name);
  const files = machineFiles.value;
  const taken = n !== null && !!files?.names.includes(n);
  const busy = machineBusy();
  const why = !verified ? t("Connect to the machine first.") : !n ? t("Use 1–16 letters, digits, spaces, dots, dashes or underscores.") : taken ? t("The machine already has a file with this name.") : prepareProblem();
  return (
    <section class="ws-panel ws-save-machine">
      <h3>{t("Save to machine")}</h3>
      <p class="ws-hint">{t("Stores the job in the controller's memory without running it; start it later from the machine's panel.")}</p>
      <label class="ws-col">
        <span>{t("File name")}</span>
        <input value={name} maxLength={FILE_NAME_MAX} spellcheck={false} onInput={(e) => (fileName.value = e.currentTarget.value.toUpperCase())} />
      </label>
      <div class="ws-row">
        <button type="button" disabled={!!why || busy} onClick={() => void save(name)} title={why ?? t("Send the job to the machine's memory")}>
          <HardDriveDownload size={14} strokeWidth={1.75} aria-hidden="true" /> {t("Save to machine")}
        </button>
        {saveProgress.value && <small role="status">{saveProgress.value}</small>}
      </div>
      {why && verified && <small class="ws-hint">{why}</small>}
      {verified && (
        <div class="ws-machine-files">
          <div class="ws-row">
            <span>{t("Files on the machine")}</span>
            <IconButton icon={RefreshCw} label={t("Read the machine's file list")} disabled={busy} onClick={() => void refreshFiles()} />
          </div>
          {files?.error ? (
            <small class="ws-hint">{files.error}</small>
          ) : files ? (
            files.names.length ? (
              <ol>
                {files.names.map((f, i) => (
                  <li key={`${i}-${f}`} class={f === n ? "ws-taken" : ""}>
                    <span>{f}</span>
                    <IconButton icon={Trash2} label={t("Delete {name} from the machine", { name: f })} disabled={busy} onClick={() => void remove(i + 1, f)} />
                  </li>
                ))}
              </ol>
            ) : (
              <small class="ws-hint">{t("No files.")}</small>
            )
          ) : (
            <small class="ws-hint">{t("Not read yet.")}</small>
          )}
        </div>
      )}
    </section>
  );
}

/** Device sidebar: what will run, and saving it on the machine. */
export function DevicePanel() {
  return (
    <div class="ws-device">
      <JobSummary />
      <SaveToMachine />
    </div>
  );
}
