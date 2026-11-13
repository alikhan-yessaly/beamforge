import { msg, t } from "../i18n";
import { ClipboardList, Layers, PanelRightClose, PanelRightOpen, SwatchBook } from "lucide-preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { selection } from "../scene/store";
import { linkState, runner } from "../app/connection";
import "../ui/app.css";
import { LaserCutter } from "../ui/customIcons";
import { IconButton } from "../ui/icons";
import { handleKey } from "./actions";
import { installKeyboardJog } from "./keyboardJog";
import { Canvas } from "./Canvas";
import { LayersPanel } from "./LayersPanel";
import { framing, runProgress, RunPanel } from "./RunPanel";
import { ObjectsPanel, PropertiesPanel, StatusBar, Toasts, Toolbar } from "./Panels";
import { MachineTab } from "./MachineTab";
import { PaletteBar } from "./PaletteBar";
import { MaterialsPanel } from "./MaterialsPanel";
import { ConnectButton } from "./ConnectButton";
import { LangSwitch } from "./LangSwitch";
import { ContextMenu } from "./ContextMenu";
import { StartDialog } from "./StartDialog";
import { SketchToolbar } from "./sketch/SketchToolbar";
import { session as sketchSession } from "./sketch/state";
import { ShortcutSheet } from "./ShortcutSheet";
import { DevicePanel, ModeSwitch, PrepareBar } from "./DevicePanel";
import { appMode } from "./mode";

type Tab = "layers" | "materials" | "machine" | "job";
const TABS: { name: Tab; icon: typeof Layers; label: string; device: boolean }[] = [
  { name: "layers", icon: Layers, label: msg("Layers and objects"), device: false },
  { name: "materials", icon: SwatchBook, label: msg("Material library"), device: false },
  { name: "job", icon: ClipboardList, label: msg("Job: summary and Save to machine"), device: true },
  { name: "machine", icon: LaserCutter, label: msg("Machine: position, jog and profile"), device: true },
];

function App() {
  const [tab, setTab] = useState<Tab>("layers");
  const device = appMode.value === "device";
  useEffect(() => setTab((current) => (device ? (current === "machine" ? current : "job") : current === "job" ? "layers" : current)), [device]);
  const [sidebar, setSidebar] = useState(true);
  const stop = useRef<HTMLDivElement>(null);
  const [machineContent] = useState(() => document.getElementById("machine-content"));
  const sketching = sketchSession.value !== null;
  const connected = linkState.value !== "disconnected";
  void runProgress.value;
  const running = runner.active || framing.value;
  useEffect(() => {
    const stopBar = document.getElementById("software-stop");
    if (!machineContent || !stopBar) throw new Error("Machine controls failed to initialize");
    stop.current!.append(stopBar);
  }, []);
  return (
    <div class="ws">
      {import.meta.env.PROD && (
        <div class="ws-beta">
          <strong>BeamForge Beta</strong> · {t("Tested on one RDC644XS controller. Features and other controllers are not fully verified.")}
          {" "}<a href="https://github.com/alikhan-yessaly/beamforge#safety-and-limitations" target="_blank" rel="noopener noreferrer">{t("Safety and limitations")}</a>
        </div>
      )}
      <div class={`ws-top${sketching && connected && !running ? " ws-sketch-stop-space" : ""}`}>
        {!sketching && <ModeSwitch />}
        {sketching ? <SketchToolbar /> : device ? <span class="ws-device-title">{t("Device: a read-only preview of the prepared job")}</span> : <Toolbar />}
        {!sketching && <LangSwitch />}
        {!sketching && <ConnectButton />}
      </div>
      <div class="ws-body">
        <Canvas />
        <aside class={`ws-side${sidebar ? "" : " collapsed"}`} id="workspace-sidebar" hidden={sketching}>
          <nav class="ws-tabs" aria-label={t("Workspace panels")}>
            {TABS.filter((x) => !device || x.device).map(({ name, icon, label }) => (
              <IconButton
                key={name}
                icon={icon}
                label={t(label)}
                class={sidebar && tab === name ? "active" : ""}
                pressed={sidebar && tab === name}
                onClick={() => {
                  setTab(name);
                  setSidebar(true);
                }}
              />
            ))}
            <span class="ws-grow" />
            <IconButton icon={sidebar ? PanelRightClose : PanelRightOpen} label={sidebar ? t("Collapse the sidebar") : t("Expand the sidebar")} onClick={() => setSidebar(!sidebar)} />
          </nav>
          <div class="ws-side-body" hidden={!sidebar}>
          <div hidden={tab !== "layers"}>
            {selection.value.size > 0 && <PropertiesPanel />}
            <LayersPanel />
            <ObjectsPanel />
          </div>
          <div hidden={tab !== "materials"}><MaterialsPanel /></div>
          {device && tab === "job" && <DevicePanel />}
          <MachineTab visible={!sketching && sidebar && tab === "machine"} content={machineContent} />
          </div>
        </aside>
      </div>
      {!sketching && !device && <PaletteBar />}
      {!sketching && <StatusBar />}
      <div class={`ws-jobbar${sketching && !running ? " ws-sketch-stop" : ""}`} hidden={sketching && !connected && !running}>
        <div class="ws-run-slot" hidden={sketching && !running}>{device || running ? <RunPanel /> : <PrepareBar />}</div>
        <div ref={stop} class="ws-stop-slot" />
      </div>
      <Toasts />
      <ContextMenu />
      <StartDialog />
      <ShortcutSheet />
    </div>
  );
}

window.addEventListener("keydown", handleKey);
installKeyboardJog();
render(<App />, document.getElementById("workspace")!);
