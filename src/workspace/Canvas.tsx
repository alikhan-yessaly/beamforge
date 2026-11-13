import { useEffect, useRef, useState } from "preact/hooks";
import { EmptyBed } from "./EmptyBed";
import { type Box, type Vec, apply, distToSegment, invert, translate } from "../geom/geom";
import { appMode } from "./mode";
import type { Doc } from "../scene/model";
import { boxCenter, objectBox, rotateAbout, scaleAbout, transformSelected } from "../scene/ops";
import { commit, cursor, doc, prefs, profile, selBox, selection } from "../scene/store";
import { importFiles } from "./actions";
import { preview as sketchPreview, resetTool as resetSketchTool, sketchDoubleClick, sketchPointerDown, sketchPointerMove, sketchPointerUp } from "./sketch/controller";
import { drawSketch } from "./sketch/render";
import { lang } from "../i18n";
import { fillClick, fillHover, fillTool, hoverRings, regionUnder } from "./fillTool";
import { fontsVersion } from "./sketch/fonts";
import { DimensionEditor, TextEditor } from "./sketch/SketchToolbar";
import { closeTextEditor, dimensionSuggestions, editSketch, editingText, session as sketchSession } from "./sketch/state";
import { fromUser } from "../scene/model";
import { jobEstimate, preview, toolpath } from "./job";
import { designOrigin } from "../job/build";
import { visibleDocument } from "../job/layers";
import { headUm, relativePlacement, StartFromControl } from "./RunPanel";
import { relativeHeadOnDrawing } from "./placement";
import { bedLoad } from "../app/connection";
import { contextMenu } from "./ContextMenu";
import { HANDLE, HANDLES, ROTATE_OFFSET, draw, imagesVersion, selectionScreenRect } from "./render";
import { type View, canvasSize, fitBed, toBed, view, viewTouched, zoomAt } from "./view";

type Drag =
  | { kind: "pan"; start: Vec; view: View }
  | { kind: "move"; startBed: Vec; startDoc: Doc; box: Box }
  | { kind: "scale"; startDoc: Doc; box: Box; hx: number; hy: number }
  | { kind: "rotate"; startDoc: Doc; center: Vec; a0: number }
  | { kind: "marquee"; start: Vec; end: Vec; additive: boolean };

function hitObject(d: Doc, v: View, p: Vec): string | null {
  d = visibleDocument(d);
  const tol = 5 / v.zoom;
  for (let i = d.objects.length - 1; i >= 0; i--) {
    const o = d.objects[i]!;
    const b = objectBox(o);
    if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue;
    if (o.image) {
      // Pictures are picked anywhere inside them, not just on an outline.
      const q = apply(invert(o.mat), p);
      if (q.x >= 0 && q.y >= 0 && q.x <= o.image.w && q.y <= o.image.h) return o.id;
    }
    for (const path of o.paths) {
      const pts = path.points.map((q) => apply(o.mat, q));
      const n = path.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < n; k++) if (distToSegment(p, pts[k]!, pts[(k + 1) % pts.length]!) <= tol) return o.id;
    }
  }
  return null;
}

/** Snap an internal coordinate to the grid as measured from the origin corner. */
function snap(value: number, axis: "x" | "y"): number {
  const p = profile.value;
  const step = prefs.value.gridStep;
  const flip = axis === "x" ? p.origin.endsWith("right") : p.origin.startsWith("bottom");
  const size = flip ? (axis === "x" ? p.bedW : p.bedH) : 0;
  const u = flip ? size - value : value - size;
  const s = Math.round(u / step) * step;
  return flip ? size - s : size + s;
}

export function Canvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const spaceDown = useRef(false);
  const rightDrag = useRef<{ start: Vec; moved: boolean; released: boolean; menu: Vec | null } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [cursorStyle, setCursorStyle] = useState("default");

  // Read signals during render so this component re-renders (and redraws) when they change.
  const v = view.value;
  const d = doc.value;
  const p = profile.value;
  const sel = selection.value;
  const sb = selBox.value;
  const size = canvasSize.value;
  const pv = preview.value;
  const device = appMode.value === "device";
  const pvData = pv.on || device ? { tp: toolpath.value, est: jobEstimate.value, t: pv.t } : null;
  const hu = headUm.value;
  const placement = relativePlacement.value;
  const mappedHead = hu && placement ? relativeHeadOnDrawing(hu, placement.start, placement.designOrigin) : null;
  const head = hu ? fromUser(p, { x: hu.x / 1000, y: hu.y / 1000 }) : null;
  const projectedHead = mappedHead ? fromUser(p, { x: mappedHead.x / 1000, y: mappedHead.y / 1000 }) : null;
  const originUm = prefs.value.startFrom === "current" ? (placement?.designOrigin ?? designOrigin(d, p)) : null;
  const jobOrigin = originUm ? fromUser(p, { x: originUm.x / 1000, y: originUm.y / 1000 }) : null;
  const bedStatus = bedLoad.value.state;
  const ses = sketchSession.value;
  const skPreview = sketchPreview.value;
  const skSuggestions = dimensionSuggestions.value;
  void fontsVersion.value; // redraw sketch text once its font has loaded
  void imagesVersion.value; // and imported pictures once decoded
  void lang.value; // canvas labels follow the interface language
  const ft = fillTool.value;
  const units = prefs.value.units ?? "mm";
  void fillHover.value;
  const fillPreview = ft ? hoverRings() : null;

  useEffect(() => {
    if (bedStatus === "ready") fitBed(profile.value);
  }, [bedStatus]);

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(size.w * dpr) || c.height !== Math.round(size.h * dpr)) {
      c.width = Math.round(size.w * dpr);
      c.height = Math.round(size.h * dpr);
    }
    const ctx = c.getContext("2d")!;
    if (ses) {
      // Sketch mode: everything else faded, the edited sketch drawn live on top.
      const others = { ...d, objects: d.objects.filter((o) => o.id !== ses.objectId) };
      draw(ctx, size.w, size.h, dpr, v, others, p, { selection: new Set(), selBox: null, hover: null, marquee: null, dimObjects: true, units });
      drawSketch(ctx, v, ses, skPreview, skSuggestions);
    } else draw(ctx, size.w, size.h, dpr, v, d, p, { selection: device ? new Set() : sel, selBox: device ? null : sb, hover: device ? null : hover, marquee, preview: pvData, head, projectedHead, jobOrigin, fillHover: ft && fillPreview ? { rings: fillPreview, color: ft.color } : null, units });
  });

  useEffect(() => {
    const c = ref.current!;
    let first = true;
    let lastSketching = !!sketchSession.value;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      const previous = canvasSize.value;
      const sketching = !!sketchSession.value;
      canvasSize.value = { w: r.width, h: r.height };
      // Keep fitting the bed while the layout settles (sidebar, fonts), until the user pans or zooms.
      if (first || !viewTouched.value) {
        first = false;
        fitBed(profile.value);
      } else if (sketching !== lastSketching) {
        view.value = { ...view.value, ox: view.value.ox + (r.width - previous.w) / 2, oy: view.value.oy + (r.height - previous.h) / 2 };
      }
      lastSketching = sketching;
    });
    ro.observe(c.parentElement!);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // Trackpad pinch arrives as ctrl+wheel; a plain mouse wheel has integer deltaY and no deltaX.
      const mouseWheel = e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
      if (e.ctrlKey || mouseWheel) zoomAt(at, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      else {
        viewTouched.value = true;
        view.value = { ...view.value, ox: view.value.ox - e.deltaX, oy: view.value.oy - e.deltaY };
      }
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) spaceDown.current = true;
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      ro.disconnect();
      c.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  const local = (e: PointerEvent): Vec => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Which selection handle is under the screen point: index into HANDLES, "rotate", or null. */
  const handleAt = (s: Vec): number | "rotate" | null => {
    const b = selBox.value;
    if (!b) return null;
    const r = selectionScreenRect(view.value, b);
    const cx = (r.x0 + r.x1) / 2;
    if (Math.hypot(s.x - cx, s.y - (r.y0 - ROTATE_OFFSET)) <= HANDLE) return "rotate";
    for (let i = 0; i < HANDLES.length; i++) {
      const [fx, fy] = HANDLES[i]!;
      const x = r.x0 + (r.x1 - r.x0) * fx;
      const y = r.y0 + (r.y1 - r.y0) * fy;
      if (Math.abs(s.x - x) <= HANDLE && Math.abs(s.y - y) <= HANDLE) return i;
    }
    return null;
  };

  const openContextMenu = (point: Vec) => {
    const rect = ref.current!.getBoundingClientRect();
    const hit = hitObject(doc.value, view.value, toBed(view.value, { x: point.x - rect.left, y: point.y - rect.top }));
    if (hit && !selection.value.has(hit)) selection.value = new Set([hit]);
    contextMenu.value = point;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) rightDrag.current = { start: { x: e.clientX, y: e.clientY }, moved: false, released: false, menu: null };
    const c = ref.current!;
    c.setPointerCapture(e.pointerId);
    c.focus();
    const s = local(e);
    const bed = toBed(view.value, s);
    if (e.button === 1 || e.button === 2 || spaceDown.current || appMode.value === "device") {
      drag.current = { kind: "pan", start: s, view: view.value };
      viewTouched.value = true;
      return;
    }
    if (sketchSession.value) {
      if (e.button === 0) {
        // No default mousedown focus: a dimension box opened by this click must keep the keyboard.
        e.preventDefault();
        if (editingText.value) closeTextEditor(true);
        sketchPointerDown(e, s, bed);
      }
      return;
    }
    if (e.button !== 0) return;
    if (fillTool.value) {
      fillClick(bed);
      return;
    }
    const h = handleAt(s);
    const b = selBox.value;
    if (h === "rotate" && b) {
      const center = boxCenter(b);
      drag.current = { kind: "rotate", startDoc: doc.value, center, a0: Math.atan2(bed.y - center.y, bed.x - center.x) };
      return;
    }
    if (typeof h === "number" && b) {
      const [hx, hy] = HANDLES[h]!;
      drag.current = { kind: "scale", startDoc: doc.value, box: b, hx, hy };
      return;
    }
    const hit = hitObject(doc.value, view.value, bed);
    if (hit) {
      if (e.shiftKey) {
        const next = new Set(selection.value);
        if (next.has(hit)) next.delete(hit);
        else next.add(hit);
        selection.value = next;
        return;
      }
      if (!selection.value.has(hit)) selection.value = new Set([hit]);
    }
    const nb = selBox.value;
    const insideSel = nb && bed.x >= nb.minX && bed.x <= nb.maxX && bed.y >= nb.minY && bed.y <= nb.maxY;
    if (hit || insideSel) {
      drag.current = { kind: "move", startBed: bed, startDoc: doc.value, box: nb! };
      return;
    }
    if (!e.shiftKey) selection.value = new Set();
    drag.current = { kind: "marquee", start: bed, end: bed, additive: e.shiftKey };
  };

  const onPointerMove = (e: PointerEvent) => {
    if (rightDrag.current && Math.hypot(e.clientX - rightDrag.current.start.x, e.clientY - rightDrag.current.start.y) > 4) rightDrag.current.moved = true;
    const s = local(e);
    const bed = toBed(view.value, s);
    cursor.value = bed;
    const g = drag.current;
    if (sketchSession.value && g?.kind !== "pan") {
      sketchPointerMove(e, s, bed);
      return;
    }
    if (fillTool.value && !g) {
      const r = regionUnder(bed);
      const cur = fillHover.value;
      if (r?.objectId !== cur?.objectId || r?.index !== cur?.index) fillHover.value = r;
      return;
    }
    if (!g) {
      const h = handleAt(s);
      if (h === "rotate") setCursorStyle("grab");
      else if (typeof h === "number") {
        const [fx, fy] = HANDLES[h]!;
        setCursorStyle(fx === 0.5 ? "ns-resize" : fy === 0.5 ? "ew-resize" : fx === fy ? "nwse-resize" : "nesw-resize");
      } else {
        const hit = hitObject(doc.value, view.value, bed);
        setHover(hit);
        setCursorStyle(spaceDown.current ? "grab" : hit ? "move" : "default");
      }
      return;
    }
    const ids = selection.value;
    switch (g.kind) {
      case "pan":
        view.value = { ...g.view, ox: g.view.ox + s.x - g.start.x, oy: g.view.oy + s.y - g.start.y };
        break;
      case "move": {
        let dx = bed.x - g.startBed.x;
        let dy = bed.y - g.startBed.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (prefs.value.snapToGrid !== e.altKey) {
          // Snap the box corner nearest the origin to the grid.
          const p = profile.value;
          const cx = p.origin.endsWith("right") ? g.box.maxX : g.box.minX;
          const cy = p.origin.startsWith("bottom") ? g.box.maxY : g.box.minY;
          dx = snap(cx + dx, "x") - cx;
          dy = snap(cy + dy, "y") - cy;
        }
        doc.value = transformSelected(g.startDoc, ids, translate(dx, dy));
        break;
      }
      case "scale": {
        const centered = e.altKey;
        const ax = centered ? (g.box.minX + g.box.maxX) / 2 : g.box.minX + (g.box.maxX - g.box.minX) * (1 - g.hx);
        const ay = centered ? (g.box.minY + g.box.maxY) / 2 : g.box.minY + (g.box.maxY - g.box.minY) * (1 - g.hy);
        const hx0 = g.box.minX + (g.box.maxX - g.box.minX) * g.hx;
        const hy0 = g.box.minY + (g.box.maxY - g.box.minY) * g.hy;
        const clamp = (k: number) => (Math.abs(k) < 1e-3 ? 1e-3 * Math.sign(k || 1) : k);
        let sx = g.hx === 0.5 || Math.abs(hx0 - ax) < 1e-9 ? 1 : clamp((bed.x - ax) / (hx0 - ax));
        let sy = g.hy === 0.5 || Math.abs(hy0 - ay) < 1e-9 ? 1 : clamp((bed.y - ay) / (hy0 - ay));
        const corner = g.hx !== 0.5 && g.hy !== 0.5;
        if (corner && prefs.value.lockAspect !== e.shiftKey) {
          const k = Math.abs(sx) > Math.abs(sy) ? sx : sy;
          sx = sy = k;
        }
        doc.value = transformSelected(g.startDoc, ids, scaleAbout({ x: ax, y: ay }, sx, sy));
        break;
      }
      case "rotate": {
        let deg = ((Math.atan2(bed.y - g.center.y, bed.x - g.center.x) - g.a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        doc.value = transformSelected(g.startDoc, ids, rotateAbout(g.center, deg));
        break;
      }
      case "marquee": {
        g.end = bed;
        setMarquee({
          minX: Math.min(g.start.x, bed.x),
          minY: Math.min(g.start.y, bed.y),
          maxX: Math.max(g.start.x, bed.x),
          maxY: Math.max(g.start.y, bed.y),
        });
        break;
      }
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (sketchSession.value) {
      const g = drag.current;
      if (e.button === 2 && rightDrag.current && !rightDrag.current.moved) resetSketchTool();
      rightDrag.current = null;
      if (g?.kind === "pan") drag.current = null;
      else if (e.button === 0) {
        const s = local(e);
        sketchPointerUp(e, s, toBed(view.value, s));
      }
      ref.current?.releasePointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2 && rightDrag.current) {
      rightDrag.current.released = true;
      if (rightDrag.current.menu) {
        if (!rightDrag.current.moved) openContextMenu(rightDrag.current.menu);
        rightDrag.current = null;
      }
    }
    const g = drag.current;
    drag.current = null;
    ref.current?.releasePointerCapture(e.pointerId);
    if (!g) return;
    if (g.kind === "move" || g.kind === "scale" || g.kind === "rotate") {
      if (doc.value !== g.startDoc) commit(doc.value, g.startDoc);
    } else if (g.kind === "marquee") {
      setMarquee(null);
      const m = {
        minX: Math.min(g.start.x, g.end.x),
        minY: Math.min(g.start.y, g.end.y),
        maxX: Math.max(g.start.x, g.end.x),
        maxY: Math.max(g.start.y, g.end.y),
      };
      // Left-to-right drag selects fully enclosed objects; right-to-left selects anything touched.
      const crossing = g.end.x < g.start.x;
      const next = new Set(g.additive ? selection.value : []);
      for (const o of visibleDocument(doc.value).objects) {
        const b = objectBox(o);
        const inside = b.minX >= m.minX && b.maxX <= m.maxX && b.minY >= m.minY && b.maxY <= m.maxY;
        const touches = b.maxX >= m.minX && b.minX <= m.maxX && b.maxY >= m.minY && b.minY <= m.maxY;
        if (crossing ? touches : inside) next.add(o.id);
      }
      selection.value = next;
    }
  };

  return (
    <div
      class="ws-canvas-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer?.files.length && appMode.value === "prepare") void importFiles(e.dataTransfer.files);
      }}
    >
      <canvas
        ref={ref}
        tabIndex={0}
        style={{ width: `${size.w}px`, height: `${size.h}px`, cursor: ses ? (ses.tool === "select" ? "default" : "crosshair") : ft ? "cell" : cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          cursor.value = null;
          if (sketchSession.value?.tool === "trim") sketchPreview.value = { shapes: [], hover: null };
          else if (sketchSession.value?.tool === "select" && sketchPreview.value.hover) sketchPreview.value = { ...sketchPreview.value, hover: null };
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (sketchSession.value || appMode.value === "device") return;
          const point = { x: e.clientX, y: e.clientY };
          const right = rightDrag.current;
          if (right && !right.released) right.menu = point;
          else {
            if (!right?.moved) openContextMenu(point);
            rightDrag.current = null;
          }
        }}
        onDblClick={(e) => {
          const s = local(e as unknown as PointerEvent);
          if (sketchSession.value) return sketchDoubleClick(s, toBed(view.value, s));
          if (appMode.value === "device") return fitBed(profile.value);
          const hit = hitObject(doc.value, view.value, toBed(view.value, s));
          const o = hit ? doc.value.objects.find((x) => x.id === hit) : null;
          if (o && (o.sketch || o.paths.length)) void editSketch(o);
          else if (!selBox.value) fitBed(profile.value);
        }}
      />
      {!ses && !device && doc.value.objects.length === 0 && <EmptyBed />}
      {ses ? (
        <>
          <DimensionEditor />
          <TextEditor />
        </>
      ) : (
        !device && <StartFromControl />
      )}
    </div>
  );
}
