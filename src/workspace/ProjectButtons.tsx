// Toolbar: New, Open (with recent files), Save (to the project's file), Save As… (to a new file), project name.
import { ChevronDown, FileOutput, FilePlus, FolderOpen, Save } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { dirty, newProject, openProject, openRecent, project, recentFiles, saveProject, saveProjectAs } from "../project/state";
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
  const fileName = `${project.value.name}.laserproj`;
  return (
    <>
      <IconButton icon={FilePlus} label="New project" onClick={newProject} />
      <div class="ws-split" ref={ref}>
        <IconButton icon={FolderOpen} label="Open a project… (⌘O)" onClick={() => void openProject()} />
        {recent.length > 0 && (
          <IconButton icon={ChevronDown} class="ws-split-more" label="Recent projects" pressed={open} onClick={() => setOpen(!open)} />
        )}
        {open && (
          <div class="ws-popover ws-menu" role="menu" aria-label="Recent projects">
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
            ? "Save — not available until the project has a file: use Save As… first"
            : dirty.value
              ? `Save changes to ${fileName} (⌘S)`
              : `Save — no changes since ${fileName} was saved`
        }
        disabled={!hasFile || !dirty.value}
        onClick={() => void saveProject()}
      />
      <IconButton icon={FileOutput} label={`Save As… — save the project to a new .laserproj file (⇧⌘S)`} onClick={() => void saveProjectAs()} />
      <span
        class={`ws-project-name${dirty.value ? " dirty" : ""}`}
        title={`${hasFile ? `Project file: ${fileName}` : "Not saved to a file yet (use Save As…)"}${dirty.value ? " · unsaved changes" : ""}. Your work is also autosaved in this browser, so a reload keeps it.`}
      >
        {project.value.name}
        {hasFile ? <small>.laserproj</small> : <small> · not saved to a file</small>}
        {dirty.value && hasFile && <i aria-label="unsaved changes" />}
      </span>
    </>
  );
}
