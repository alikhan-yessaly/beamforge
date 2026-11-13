// What to do on an empty bed: import a drawing, start a sketch, or open the sample. Shown over the canvas.
import { Sparkles } from "lucide-preact";
import { useRef } from "preact/hooks";
import { t } from "../i18n";
import { ImportDesign, SketchSheet } from "../ui/customIcons";
import { openSample } from "../project/state";
import { IMPORT_ACCEPT, importFiles } from "./actions";
import { newSketch } from "./sketch/state";

export function EmptyBed() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div class="ws-empty-bed">
      <p>{t("The bed is empty. Drop a file here, or:")}</p>
      <div class="ws-empty-bed-actions">
        <button type="button" onClick={() => fileRef.current?.click()}>
          <ImportDesign size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{t("Import a drawing")}</span>
          <small>{t("DXF, SVG, PDF, AI, PLT or a picture")}</small>
        </button>
        <button type="button" onClick={() => void newSketch()}>
          <SketchSheet size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{t("New sketch")}</span>
          <small>{t("Draw with dimensions and constraints")}</small>
        </button>
        <button type="button" onClick={() => openSample()}>
          <Sparkles size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{t("Open the sample")}</span>
          <small>{t("A small tag to cut and engrave")}</small>
        </button>
      </div>
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
    </div>
  );
}
