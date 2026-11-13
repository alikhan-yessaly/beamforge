// Questions about which machine this is (src/scene/store.ts `machinePrompt`): the machine class of a new profile
// (one question, which also offers typical materials), several profiles matching the connected controller, or a
// controller that doesn't match the active profile.
import { t } from "../i18n";
import { useEffect, useRef, useState } from "preact/hooks";
import { linkState } from "../app/connection";
import { MACHINE_CLASSES, applyClass, classById } from "../machine/classes";
import { machinePrompt, machines, notify, profile, updateMachine } from "../scene/store";
import { presets, presetsFor, savePresets, seedPresets } from "./materials";

function ClassQuestion(props: { id: string; done: () => void }) {
  const m = machines.value.find((x) => x.id === props.id) ?? profile.value;
  const [cls, setCls] = useState(m.class ?? "mid");
  const [seed, setSeed] = useState(presetsFor(m).length === 0);
  const ok = () => {
    const c = classById(cls)!;
    const next = applyClass(m, c, linkState.value === "verified" && !!m.controller);
    updateMachine(next);
    if (seed && presetsFor(next).length === 0) savePresets([...presets.value, ...seedPresets(next, c)]);
    notify(t("“{name}” uses typical values for {class}. Tune it any time from the Machine tab.", { name: next.name, class: t(c.name) }));
    props.done();
  };
  return (
    <>
      <h3>{t("What kind of machine is “{name}”?", { name: m.name })}</h3>
      <p>{t("This sets typical speed-up, start speed and starting material settings. You can tune them to your machine later.")}</p>
      <div class="ws-col">
        {MACHINE_CLASSES.map((c) => (
          <label key={c.id} class="ws-check">
            <input type="radio" name="ws-class" checked={cls === c.id} onChange={() => setCls(c.id)} /> {t(c.name)}
          </label>
        ))}
      </div>
      <label class="ws-check">
        <input type="checkbox" checked={seed} onChange={(e) => setSeed(e.currentTarget.checked)} /> {t("Add typical material presets (plywood, acrylic, cardboard, leather)")}
      </label>
      <div class="ws-row ws-dialog-actions">
        <button type="button" onClick={props.done}>{t("Later")}</button>
        <button type="button" class="ws-primary-btn" autofocus onClick={ok}>{t("Use these values")}</button>
      </div>
    </>
  );
}

export function MachineDialog() {
  const q = machinePrompt.value;
  const ref = useRef<HTMLDialogElement>(null);
  const [pick, setPick] = useState("");
  useEffect(() => {
    if (q && !ref.current?.open) ref.current?.showModal();
    if (q?.kind === "choose") setPick(q.ids[0]!);
  }, [q]);
  if (!q) return null;
  const close = () => {
    ref.current?.close();
    machinePrompt.value = null;
  };
  const cancel = () => {
    close();
    if (q.kind === "choose") q.resolve(null);
    else if (q.kind === "mismatch") q.resolve(null);
    else q.resolve();
  };
  return (
    <dialog ref={ref} class="ws-dialog ws-machine-dialog" onCancel={(e) => (e.preventDefault(), cancel())}>
      {q.kind === "class" && (
        <ClassQuestion
          id={q.id}
          done={() => {
            close();
            q.resolve();
          }}
        />
      )}
      {q.kind === "choose" && (
        <>
          <h3>{t("Which machine is connected?")}</h3>
          <p>{t("Several machine profiles match this controller.")}</p>
          <select value={pick} onChange={(e) => setPick(e.currentTarget.value)}>
            {q.ids.map((id) => (
              <option key={id} value={id}>
                {machines.value.find((m) => m.id === id)?.name ?? id}
              </option>
            ))}
          </select>
          <div class="ws-row ws-dialog-actions">
            <button type="button" onClick={cancel}>{t("Keep the current profile")}</button>
            <button type="button" class="ws-primary-btn" onClick={() => (close(), q.resolve(pick))}>{t("Use this profile")}</button>
          </div>
        </>
      )}
      {q.kind === "mismatch" && (
        <>
          <h3>{t("A different machine?")}</h3>
          <p>{t("The connected controller doesn't match the machine profile “{name}” (card ID or bed size differ).", { name: profile.value.name })}</p>
          <div class="ws-row ws-dialog-actions">
            <button type="button" onClick={() => (close(), q.resolve("keep"))}>{t("It's the same machine")}</button>
            <button type="button" class="ws-primary-btn" onClick={() => (close(), q.resolve("new"))}>{t("New machine profile")}</button>
          </div>
        </>
      )}
    </dialog>
  );
}
