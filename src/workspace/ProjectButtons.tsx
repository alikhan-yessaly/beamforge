// Toolbar: New, Open (with recent files), Save (to the project's file), Save As… (to a new file), project name.
import { t } from "../i18n";
import { ChevronDown, FilePlus, FolderOpen, Save } from "lucide-preact";
import { SaveAs } from "../ui/customIcons";
import { useEffect, useRef, useState } from "preact/hooks";
import { InlineNameField } from "../ui/InlineName";
import { dirty, newProject, renameProject, openProject, openRecent, project, recentFiles, saveProject, saveProjectAs } from "../project/state";
import { IconButton } from "../ui/icons";

export function ProjectButtons() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const recent = recentFiles.value;
  const hasFile = project.value.handle !== null;
  const [editingName, setEditingName] = useState(false);
  const fileName = project.value.handle?.name ?? `${project.value.name}.laserproj`;
  const shownName = project.value.name === "Untitled" ? t("Untitled") : project.value.name;
  return (
    <>
      <IconButton icon={FilePlus} label={t("New project")} onClick={newProject} />
      <div class="ws-split" ref={ref}>
        <IconButton icon={FolderOpen} label={t("Open a project… (⌘O)")} onClick={() => void openProject()} />
        {recent.length > 0 && (
          <IconButton icon={ChevronDown} class="ws-split-more" label={t("Recent projects")} pressed={open} onClick={() => setOpen(!open)} />
        )}
        {open && (
          <div class="ws-popover ws-menu" role="menu" aria-label={t("Recent projects")}>
            {recent.map((r) => (
              <button
                key={`${r.name}-${r.openedAt}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void openRecent(r);
                }}
              >
                <span>{r.name.replace(/\.laserproj$/i, "")}</span>
                <small>{new Date(r.openedAt).toLocaleDateString()}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      <IconButton
        icon={Save}
        class={hasFile && dirty.value ? "ws-dirty" : ""}
        label={
          !hasFile
            ? t("Save — not available until the project has a file: use Save As… first")
            : dirty.value
              ? t("Save changes to {file} (⌘S)", { file: fileName })
              : t("Save — no changes since {file} was saved", { file: fileName })
        }
        disabled={!hasFile || !dirty.value}
        onClick={() => void saveProject()}
      />
      <IconButton icon={SaveAs} label={t("Save As… — save the project to a new .laserproj file (⇧⌘S)")} onClick={() => void saveProjectAs()} />
      {editingName ? (
        <InlineNameField class="ws-project-name-field" value={shownName} label={t("Project name")} onCommit={renameProject} onDone={() => setEditingName(false)} />
      ) : (
      <span
        class={`ws-project-name${dirty.value ? " dirty" : ""}`}
        title={`${hasFile ? t("Project file: {file}", { file: fileName }) : t("Not saved to a file yet (use Save As…)")}${dirty.value ? ` · ${t("unsaved changes")}` : ""}. ${t("Your work is also autosaved in this browser, so a reload keeps it.")} ${t("Double-click to rename.")}`}
        onDblClick={() => setEditingName(true)}
      >
        {shownName}
        {hasFile ? <small>{fileName === `${project.value.name}.laserproj` ? t(".laserproj") : ` · ${fileName}`}</small> : <small>{" "}{t("· not saved to a file")}</small>}
        {dirty.value && hasFile && <i aria-label={t("unsaved changes")} />}
      </span>
      )}
    </>
  );
}
