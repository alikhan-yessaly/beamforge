import { msg, t, tp } from "../i18n";
import { signal } from "@preact/signals";
import { Pause, Play, RefreshCw, Route, SquareDashed, Timer } from "lucide-preact";
import { StartFromBed, StartFromHead } from "../ui/customIcons";
import { IconButton } from "../ui/icons";
import { bedLoad, linkState, motion, refreshBedDimensions, runner } from "../app/connection";
import { frameJob } from "../controller/frame";
import { type JobProgress, inspectJob } from "../controller/jobRunner";
import { StoppedError } from "../controller/motion";
import { buildJob, designOrigin } from "../job/build";
import { activeLayers } from "../job/layers";
import { formatDuration } from "../job/estimate";
import { encodeJobCommands } from "../protocol/jobEncode";
import type { PointUm } from "../protocol/jobEncode";
import { doc, notify, prefs, profile } from "../scene/store";
import { jobEstimate, preview, togglePreview, toolpath } from "./job";
import { confirmStart } from "./StartDialog";

/** Latest job progress (null before the first run). */
export const runProgress = signal<JobProgress | null>(null);
/** Head position in machine µm while a job or frame runs, for the canvas marker. */
export const headUm = signal<{ x: number; y: number } | null>(null);
/** Captured relative placement during a frame/job, in machine µm. */
export const relativePlacement = signal<{ designOrigin: PointUm; start: PointUm } | null>(null);
export const framing = signal(false);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function prepareJob() {
  const pr = prefs.value;
  const built = buildJob(doc.value, profile.value, { mode: pr.startFrom, innerFirst: pr.innerFirst });
  return { commands: encodeJobCommands(built.input), mode: built.input.mode, designOrigin: built.designOrigin };
}

async function frame(): Promise<void> {
  const speed = profile.value.frameSpeed ?? 30;
  framing.value = true;
  try {
    const job = prepareJob();
    await frameJob(motion, inspectJob(job.commands), speed, (p) => (headUm.value = p), (start) => {
      relativePlacement.value = job.mode === "current" ? { start, designOrigin: job.designOrigin } : null;
    });
  } catch (e) {
    if (!(e instanceof StoppedError)) notify(t("Frame: {error}", { error: errText(e) }), "error");
  } finally {
    framing.value = false;
    headUm.value = null;
    relativePlacement.value = null;
  }
}

async function start(): Promise<void> {
  let job: ReturnType<typeof prepareJob>;
  try {
    job = prepareJob();
  } catch (e) {
    notify(errText(e), "error");
    return;
  }
  const hidden = activeLayers(doc.value).filter((l) => l.output && l.show === false).length;
  const bounds = inspectJob(job.commands);
  const offset = job.mode === "current" && (bounds.min.x > 0 || bounds.min.y > 0);
  const warnings = [
    ...(hidden ? [tp(["{n} dotted (hidden) output layer will also be cut.", "{n} dotted (hidden) output layers will also be cut."], hidden)] : []),
    ...(offset ? [t("The output is offset from the visible job reference; this placement is untested on a real controller. Frame and check first.")] : []),
    ...toolpath.value.warnings,
  ];
  const ok = await confirmStart({
    time: formatDuration(jobEstimate.value.total),
    layers: toolpath.value.layers.length,
    where: job.mode === "current" ? t("from the head's current position") : t("at its place on the bed"),
    warnings,
  });
  if (!ok) return;
  try {
    const end = await runner.run(job.commands, (p) => {
      if (job.mode === "current" && p.phase === "sending" && p.pos) {
        relativePlacement.value = { start: p.pos, designOrigin: job.designOrigin };
      }
      runProgress.value = p;
      headUm.value = p.pos;
    });
    notify(end === "done" ? t("Job finished") : t("Job stopped"), end === "done" ? "info" : "warn");
  } catch (e) {
    notify(t("Job: {error}", { error: errText(e) }), "error");
  } finally {
    headUm.value = null;
    relativePlacement.value = null;
  }
}

export function StartFromControl() {
  const busy = framing.value || (runProgress.value !== null && runner.active);
  const mode = prefs.value.startFrom;
  const set = (startFrom: "absolute" | "current") => (prefs.value = { ...prefs.value, startFrom });
  return (
    <div class="ws-segmented ws-start-from" role="group" aria-label={t("Start from")}>
      <IconButton icon={StartFromBed} label={t("Start from: the drawing's place on the bed (absolute)")} pressed={mode === "absolute"} disabled={busy} onClick={() => set("absolute")} />
      <IconButton
        icon={StartFromHead}
        label={`${t("Start from: the current head position (relative).")} ${designOrigin(doc.value, profile.value) ? t("The purple job reference (the shown drawing's corner nearest home) goes to the head, not necessarily to its drawn bed position; frame and check before starting.") : t("Show a layer to define the job reference.")}`}
        pressed={mode === "current"}
        disabled={busy}
        onClick={() => set("current")}
      />
    </div>
  );
}

const PHASE: Record<string, string> = { checking: msg("checking"), sending: msg("sending"), running: msg("running"), paused: msg("paused"), done: msg("done"), stopped: msg("stopped"), failed: msg("failed") };

/** Why Frame/Start can't run right now, or null when they can. */
function blockReason(): { text: string; retry?: boolean } | null {
  if (linkState.value === "disconnected") return { text: t("Connect to the machine (plug icon, top right) to frame or start.") };
  if (linkState.value === "connected") return { text: t("Connected, but the Card ID hasn't been verified (check the controller model in the Machine tab, developer mode).") };
  if (bedLoad.value.state === "loading" || bedLoad.value.state === "idle") return { text: t("Reading the machine's bed size…") };
  if (bedLoad.value.state === "error") return { text: bedLoad.value.message, retry: true };
  if (toolpath.value.errors.length) return { text: toolpath.value.errors[0]! };
  if (jobEstimate.value.cutLength <= 0) return { text: t("Nothing to cut: import a drawing and turn on Output for a layer.") };
  return null;
}

export function RunPanel() {
  const p = runProgress.value;
  const busy = runner.active || framing.value;
  const block = blockReason();
  const est = jobEstimate.value;
  const pct = p && est.total > 0 ? Math.min(100, (p.elapsed / est.total) * 100) : 0;
  const live = p && runner.active;
  const why = block ? ` — ${t("not available: {reason}", { reason: block.text })}` : "";
  const fmtM = (um: number) => String(Math.round(um / 10) / 100);
  return (
    <section class="ws-run">
      <div class="ws-run-details" title={t("Estimated job time · cut {cut} m · travel {travel} m", { cut: fmtM(est.cutLength), travel: fmtM(est.travelLength) })}>
        <Timer size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{formatDuration(est.total)}</span>
        <IconButton icon={Route} label={t("Preview the toolpath (P)")} pressed={preview.value.on} disabled={toolpath.value.segments.length === 0} onClick={togglePreview} />
      </div>
      <div class="ws-run-controls">
        <IconButton
          icon={SquareDashed}
          label={`${t("Frame at {speed} mm/s: trace the job's outline with the laser off (smooth; can't be stopped from the app)", { speed: profile.value.frameSpeed ?? 30 })}${why}`}
          disabled={!!block || busy}
          onClick={() => void frame()}
        />
        <IconButton icon={Play} class="ws-start" label={`${t("Start the job (fires the laser; confirmation comes first)")}${why}`} disabled={!!block || busy} onClick={() => void start()} />
        {p?.phase === "paused" && live ? (
          <IconButton icon={Play} label={t("Resume")} onClick={() => void runner.resume().catch((e) => notify(errText(e), "error"))} />
        ) : (
          <IconButton icon={Pause} label={t("Pause")} disabled={!live || p?.phase !== "running"} onClick={() => void runner.pause().catch((e) => notify(errText(e), "error"))} />
        )}
      </div>
      <div class="ws-run-status">
        {framing.value ? (
          <small role="status">{t("Framing… it runs to the end; software STOP can't halt it.")}</small>
        ) : p && (live || p.phase === "failed") ? (
          <div class="ws-progress">
            <div class="ws-bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <small>
              {t(PHASE[p.phase] ?? p.phase)}
              {p.phase !== "checking" && p.phase !== "failed" ? ` · ${t("{elapsed} of ~{total}", { elapsed: formatDuration(p.elapsed), total: formatDuration(est.total) })}` : ""}
              {p.error ? ` · ${p.error}` : ""}
            </small>
          </div>
        ) : block ? (
          <small role={block.retry ? "alert" : undefined}>
            {block.text}
            {block.retry && <IconButton icon={RefreshCw} label={t("Retry the bed read")} onClick={() => void refreshBedDimensions()} />}
          </small>
        ) : p?.phase === "done" || p?.phase === "stopped" ? (
          <small>{p.phase === "done" ? t("Last job done after {time}.", { time: formatDuration(p.elapsed) }) : t("Last job stopped after {time}.", { time: formatDuration(p.elapsed) })}</small>
        ) : (
          <small>{t("Ready.")}</small>
        )}
      </div>
    </section>
  );
}
