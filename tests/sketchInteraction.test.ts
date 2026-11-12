import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addConstraint, addEntity, addPoint, emptySketch } from "../src/sketch/model";
import { loadSolver } from "../src/sketch/solver";
import { constrainSelected, deleteSelected, preview, resetTool, sketchKey, sketchPointerDown, sketchPointerMove, sketchPointerUp } from "../src/workspace/sketch/controller";
import { dimensionSuggestions, editingSuggestion, session, setSketch, setTool, undoSketch } from "../src/workspace/sketch/state";
import { view } from "../src/workspace/view";
import { prefs, profile } from "../src/scene/store";
import { apply } from "../src/geom/geom";
import { toUser } from "../src/scene/model";
import { dimensionAnchor } from "../src/sketch/constrain";

beforeAll(async () => {
  await loadSolver("node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm");
});

afterEach(() => {
  resetTool();
  session.value = null;
});

function setupSketch() {
  const firstA = addPoint(emptySketch(), { x: 20, y: 50 });
  const firstB = addPoint(firstA.s, { x: 120, y: 50 });
  const first = addEntity(firstB.s, { kind: "line", p1: firstA.id, p2: firstB.id });
  const secondA = addPoint(first.s, { x: 20, y: 100 });
  const secondB = addPoint(secondA.s, { x: 120, y: 100 });
  const second = addEntity(secondB.s, { kind: "line", p1: secondA.id, p2: secondB.id });
  const sketch = second.s;
  session.value = {
    objectId: "test",
    name: "Test",
    mat: [1, 0, 0, 1, 0, 0],
    original: sketch,
    sketch,
    undo: [],
    redo: [],
    tool: "select",
    construction: false,
    selected: new Set(),
    status: { ok: true, dof: 0, conflicting: [], free: new Set() },
  };
  view.value = { zoom: 1, ox: 0, oy: 0 };
  return { first, second, firstA, secondA };
}

function pointer(shiftKey = false): PointerEvent {
  return { button: 0, shiftKey } as PointerEvent;
}

function click(x: number, y: number, shiftKey = false) {
  const p = { x, y };
  const e = pointer(shiftKey);
  sketchPointerDown(e, p, p);
  sketchPointerUp(e, p, p);
}

describe("trim hover", () => {
  it("uses a point drawn on an edge as a trim boundary", () => {
    const { first } = setupSketch();
    setTool("point");
    click(70, 50);
    const marker = session.value!.sketch.entities.find((e) => e.kind === "point");
    expect(marker?.kind).toBe("point");
    setTool("trim");
    sketchPointerMove(pointer(), { x: 100, y: 50 }, { x: 100, y: 50 });
    expect(preview.value.shapes).toContainEqual({ kind: "trim", piece: { kind: "line", a: { x: 70, y: 50 }, b: { x: 120, y: 50 } } });
    click(100, 50);
    const kept = session.value!.sketch.entities.find((e) => e.id === first.id);
    if (!kept || kept.kind !== "line" || !marker || marker.kind !== "point") throw new Error("Expected line and point");
    expect(kept.p2).toBe(marker.p);
    expect(session.value!.status.ok).toBe(true);
  });

  describe("drag attachment", () => {
    it("suggests and attaches a dragged endpoint to another line as one undo step", () => {
      const { firstA, second } = setupSketch();
      sketchPointerDown(pointer(), { x: 20, y: 50 }, { x: 20, y: 50 });
      sketchPointerMove(pointer(), { x: 70, y: 96 }, { x: 70, y: 96 });
      expect(preview.value.hint).toMatch(/Release to attach/);
      expect(preview.value.shapes).toContainEqual({ kind: "snap", type: "curve", at: expect.objectContaining({ y: expect.closeTo(100, 2) }) });
      expect(session.value!.sketch.constraints).toHaveLength(0);
      sketchPointerUp(pointer(), { x: 70, y: 96 }, { x: 70, y: 96 });
      expect(session.value!.sketch.constraints).toContainEqual(expect.objectContaining({ type: "pointOnLine", refs: [firstA.id, second.id] }));
      expect(session.value!.status.ok).toBe(true);
      undoSketch();
      expect(session.value!.sketch.constraints).toHaveLength(0);
      expect(session.value!.sketch.points[firstA.id]).toMatchObject({ x: 20, y: 50 });
    });

    it("lets Shift bypass an attachment at release", () => {
      const { firstA } = setupSketch();
      sketchPointerDown(pointer(), { x: 20, y: 50 }, { x: 20, y: 50 });
      sketchPointerMove(pointer(), { x: 70, y: 96 }, { x: 70, y: 96 });
      expect(preview.value.hint).toMatch(/Release to attach/);
      sketchPointerUp(pointer(true), { x: 70, y: 96 }, { x: 70, y: 96 });
      expect(session.value!.sketch.constraints).toHaveLength(0);
      expect(session.value!.sketch.points[firstA.id]!.y).toBeCloseTo(96, 2);
    });

    it("attaches a dragged line endpoint to another point without moving the target", () => {
      const { firstA, secondA } = setupSketch();
      sketchPointerDown(pointer(), { x: 20, y: 50 }, { x: 20, y: 50 });
      sketchPointerMove(pointer(), { x: 23, y: 97 }, { x: 23, y: 97 });
      expect(preview.value.shapes).toContainEqual({ kind: "snap", type: "point", at: expect.objectContaining({ x: expect.closeTo(20, 2), y: expect.closeTo(100, 2) }) });
      sketchPointerUp(pointer(), { x: 23, y: 97 }, { x: 23, y: 97 });
      expect(session.value!.sketch.constraints).toContainEqual(expect.objectContaining({ type: "coincident", refs: [firstA.id, secondA.id] }));
      expect(session.value!.sketch.points[secondA.id]).toMatchObject({ x: 20, y: 100 });
    });

    it("attaches to a circle and does not change the circle", () => {
      const { firstA } = setupSketch();
      const c = addPoint(session.value!.sketch, { x: 200, y: 100 });
      const circle = addEntity(c.s, { kind: "circle", c: c.id, r: 30 });
      setSketch(circle.s);
      sketchPointerDown(pointer(), { x: 20, y: 50 }, { x: 20, y: 50 });
      sketchPointerMove(pointer(), { x: 228, y: 100 }, { x: 228, y: 100 });
      expect(preview.value.shapes).toContainEqual(expect.objectContaining({ kind: "snap", type: "curve" }));
      sketchPointerUp(pointer(), { x: 228, y: 100 }, { x: 228, y: 100 });
      expect(session.value!.sketch.constraints).toContainEqual(expect.objectContaining({ type: "pointOnCircle", refs: [firstA.id, circle.id] }));
      expect(session.value!.sketch.entities.find((e) => e.id === circle.id)).toMatchObject({ r: 30 });
    });

    it("suggests an attachment for the endpoint of a dragged line", () => {
      const { first, second } = setupSketch();
      sketchPointerDown(pointer(), { x: 70, y: 50 }, { x: 70, y: 50 });
      sketchPointerMove(pointer(), { x: 100, y: 96 }, { x: 100, y: 96 });
      expect(preview.value.hint).toMatch(/Release to attach/);
      sketchPointerUp(pointer(), { x: 100, y: 96 }, { x: 100, y: 96 });
      const moved = session.value!.sketch.entities.find((e) => e.id === first.id);
      if (!moved || moved.kind !== "line") throw new Error("Expected line");
      expect(session.value!.sketch.constraints.some((c) => c.type === "pointOnLine" && c.refs[1] === second.id && [moved.p1, moved.p2].includes(c.refs[0]!))).toBe(true);
    });

    it("attaches to an arc within its visible span", () => {
      const { firstA } = setupSketch();
      const c = addPoint(session.value!.sketch, { x: 200, y: 100 });
      const a = addPoint(c.s, { x: 230, y: 100 });
      const b = addPoint(a.s, { x: 170, y: 100 });
      const arc = addEntity(b.s, { kind: "arc", c: c.id, r: 30, start: a.id, end: b.id });
      setSketch(arc.s);
      sketchPointerDown(pointer(), { x: 20, y: 50 }, { x: 20, y: 50 });
      sketchPointerMove(pointer(), { x: 200, y: 128 }, { x: 200, y: 128 });
      expect(preview.value.hint).toMatch(/Release to attach/);
      sketchPointerUp(pointer(), { x: 200, y: 128 }, { x: 200, y: 128 });
      expect(session.value!.sketch.constraints).toContainEqual(expect.objectContaining({ type: "pointOnCircle", refs: [firstA.id, arc.id] }));
    });
  });

  describe("dimension and conflict feedback", () => {
    it("marks a dimension locked when its length is already constrained and refuses to add it", () => {
      const { first } = setupSketch();
      setSketch(addConstraint(session.value!.sketch, { type: "distance", refs: [first.id], value: 100 }).s);
      setTool("dimension");
      click(70, 50);
      sketchPointerMove(pointer(), { x: 70, y: 25 }, { x: 70, y: 25 });
      expect(preview.value.hint).toMatch(/Already constrained/);
      expect(preview.value.shapes).toContainEqual(expect.objectContaining({ kind: "dimension", locked: true }));
      click(70, 25);
      expect(session.value!.sketch.constraints).toHaveLength(1);
    });

    it("reports conflicting constraints and allows deleting a conflict to recover", () => {
      const { first } = setupSketch();
      setSketch(addConstraint(session.value!.sketch, { type: "distance", refs: [first.id], value: 100 }).s);
      patchForTest([first.id]);
      constrainSelected("horizontal");
      constrainSelected("vertical");
      expect(session.value!.status.ok).toBe(false);
      const conflicts = session.value!.status.conflicting;
      expect(conflicts.length).toBeGreaterThan(0);
      patchForTest([conflicts[0]!]);
      deleteSelected();
      expect(session.value!.status.ok).toBe(true);
    });

    it("reports redundant constraints so they can be deleted", () => {
      const { first } = setupSketch();
      patchForTest([first.id]);
      constrainSelected("horizontal");
      constrainSelected("horizontal");
      const redundant = session.value!.status.redundant ?? [];
      expect(redundant.length).toBeGreaterThan(0);
      patchForTest([redundant[0]!]);
      deleteSelected();
      expect(session.value!.status.redundant ?? []).toHaveLength(0);
    });
  });

  function patchForTest(ids: string[]) {
    session.value = { ...session.value!, selected: new Set(ids) };
  }

  it("highlights only the piece the click removes, and clears off geometry", () => {
    const { first } = setupSketch();
    const a = addPoint(session.value!.sketch, { x: 60, y: 30 });
    const b = addPoint(a.s, { x: 60, y: 70 });
    const cross = addEntity(b.s, { kind: "line", p1: a.id, p2: b.id });
    session.value = { ...session.value!, sketch: cross.s, selected: new Set([first.id]) };
    setTool("trim");
    sketchPointerMove(pointer(), { x: 90, y: 50 }, { x: 90, y: 50 });
    expect(preview.value.hover).toBeNull();
    expect(preview.value.shapes).toContainEqual({ kind: "trim", piece: { kind: "line", a: { x: 60, y: 50 }, b: { x: 120, y: 50 } } });
    click(90, 50);
    expect(preview.value.shapes.some((shape) => shape.kind === "trim")).toBe(false);
    const kept = session.value!.sketch.entities.find((e) => e.id === first.id);
    expect(kept?.kind).toBe("line");
    if (!kept || kept.kind !== "line") throw new Error("Expected a shortened line");
    expect(session.value!.sketch.points[kept.p2]).toMatchObject({ x: 60, y: 50 });
    sketchPointerMove(pointer(), { x: 300, y: 300 }, { x: 300, y: 300 });
    expect(preview.value.shapes.some((shape) => shape.kind === "trim")).toBe(false);
  });
});

describe("sketch tool selection", () => {
  it("uses the neutral pointer when no tool is selected and toggles an active tool off", () => {
    session.value = {
      objectId: "test",
      name: "Test",
      mat: [1, 0, 0, 1, 0, 0],
      original: emptySketch(),
      sketch: emptySketch(),
      undo: [],
      redo: [],
      tool: "select",
      construction: false,
      selected: new Set(),
      status: { ok: true, dof: 0, conflicting: [], free: new Set() },
    };

    setTool("line");
    expect(session.value?.tool).toBe("line");

    setTool("line");
    expect(session.value?.tool).toBe("select");

    setTool("circle");
    expect(session.value?.tool).toBe("circle");
    setTool("line");
    expect(session.value?.tool).toBe("line");

  });
});

describe("line inference priority", () => {
  it("previews and commits coincidence instead of a horizontal inference at an existing endpoint", () => {
    const { first, firstA } = setupSketch();
    setTool("line");
    click(20, 50);
    sketchPointerMove(pointer(), { x: 120, y: 50 }, { x: 120, y: 50 });
    const linePreview = preview.value.shapes.find((shape) => shape.kind === "line");
    expect(linePreview).toMatchObject({ hv: null });
    expect(preview.value.shapes).toContainEqual(expect.objectContaining({ kind: "snap", type: "point" }));
    click(120, 50);
    const s = session.value!;
    const line = s.sketch.entities.at(-1)!;
    expect(line.kind).toBe("line");
    if (line.kind !== "line" || first.id === line.id) throw new Error("Expected a new line");
    expect(line.p1).toBe(firstA.id);
    const existing = s.sketch.entities.find((e) => e.id === first.id);
    if (!existing || existing.kind !== "line") throw new Error("Expected existing line");
    expect(line.p2).toBe(existing.p2);
    expect(s.sketch.constraints.filter((c) => c.refs.includes(line.id))).toHaveLength(0);
    expect(s.status.ok).toBe(true);
    expect(s.status.redundant ?? []).toHaveLength(0);
  });

  it("does not create a zero-length line by clicking the starting point twice", () => {
    setupSketch();
    setTool("line");
    click(20, 50);
    click(20, 50);
    expect(session.value!.sketch.entities).toHaveLength(2);
  });
});

describe("sketch selection", () => {
  it("adds successive clicks, keeps an already selected item, and clears on empty space", () => {
    const { first, second } = setupSketch();
    click(70, 50);
    expect([...session.value!.selected]).toEqual([first.id]);
    click(70, 100);
    expect([...session.value!.selected]).toEqual([first.id, second.id]);
    click(70, 50);
    expect([...session.value!.selected]).toEqual([first.id, second.id]);
    click(200, 200);
    expect(session.value!.selected.size).toBe(0);
  });

  describe("sketch drawing snapping", () => {
    it("uses the 1 mm bed grid even if workspace grid snapping is disabled", () => {
      setupSketch();
      const oldPrefs = prefs.value;
      prefs.value = { ...oldPrefs, snapToGrid: false, gridStep: 10 };
      try {
        setTool("point");
        click(231.3, 244.7);
        const e = session.value!.sketch.entities.at(-1)!;
        expect(e.kind).toBe("point");
        if (e.kind !== "point") throw new Error("Expected a point");
        const user = toUser(profile.value, apply(session.value!.mat, session.value!.sketch.points[e.p]!));
        expect(user.x).toBeCloseTo(Math.round(user.x), 8);
        expect(user.y).toBeCloseTo(Math.round(user.y), 8);
      } finally {
        prefs.value = oldPrefs;
      }
    });

    describe("quick dimensions", () => {
      it("shows two temporary rectangle dimensions and picks the one nearest the pointer", () => {
        setupSketch();
        setTool("rect");
        click(230, 240);
        click(300, 280);
        expect(dimensionSuggestions.value).toHaveLength(2);
        const before = session.value!.sketch.constraints.length;
        const second = dimensionSuggestions.value[1]!;
        const anchor = dimensionAnchor(session.value!.sketch, { ...second, id: "" });
        const position = { x: anchor.x + (second.offset?.x ?? 0), y: anchor.y + (second.offset?.y ?? 0) };
        sketchPointerMove(pointer(), position, position);
        expect(sketchKey({ key: "4", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent)).toBe(true);
        expect(editingSuggestion.value).toEqual({ index: 1, initial: "4" });
        expect(session.value!.sketch.constraints).toHaveLength(before);
      });

      it("dismisses a line suggestion when drawing continues", () => {
        setupSketch();
        setTool("line");
        click(230, 240);
        click(260, 240);
        expect(dimensionSuggestions.value).toHaveLength(1);
        click(260, 280);
        expect(dimensionSuggestions.value).toHaveLength(1);
        const newLine = session.value!.sketch.entities.at(-1)!;
        expect(dimensionSuggestions.value[0]!.refs).toEqual([newLine.id]);
      });

      it("offers a circle diameter without adding a constraint", () => {
        setupSketch();
        setTool("circle");
        click(230, 240);
        click(260, 240);
        expect(dimensionSuggestions.value).toHaveLength(1);
        expect(dimensionSuggestions.value[0]!.type).toBe("diameter");
        expect(session.value!.sketch.constraints.some((c) => c.type === "diameter")).toBe(false);
      });
    });

    it("previews and constrains a line relative to its uncommitted first point", () => {
      setupSketch();
      setTool("line");
      click(230.3, 240.2);
      const p = { x: 260.2, y: 242.1 };
      sketchPointerMove(pointer(), p, p);
      expect(preview.value.shapes).toContainEqual({ kind: "guide", a: { x: 230, y: 240 }, b: { x: 260, y: 240 }, type: "horizontal" });
      click(p.x, p.y);
      const sketch = session.value!.sketch;
      const line = sketch.entities.at(-1)!;
      expect(line.kind).toBe("line");
      if (line.kind !== "line") throw new Error("Expected a line");
      expect(sketch.points[line.p1]!.y).toBeCloseTo(sketch.points[line.p2]!.y, 7);
      expect(sketch.constraints.some((c) => c.type === "horizontal" && c.refs.includes(line.id))).toBe(true);
    });

    it("allows Shift to bypass the grid and previous-point inference", () => {
      setupSketch();
      setTool("line");
      click(230.3, 240.2, true);
      click(260.2, 242.1, true);
      const sketch = session.value!.sketch;
      const line = sketch.entities.at(-1)!;
      if (line.kind !== "line") throw new Error("Expected a line");
      expect(sketch.points[line.p1]).toMatchObject({ x: 230.3, y: 240.2 });
      expect(sketch.points[line.p2]).toMatchObject({ x: 260.2, y: 242.1 });
      expect(sketch.constraints).toHaveLength(0);
    });

    it("uses the solved previous endpoint for the next vertical segment", () => {
      setupSketch();
      setTool("line");
      click(230, 240);
      click(260, 240);
      const p = { x: 261.2, y: 280.1 };
      sketchPointerMove(pointer(), p, p);
      expect(preview.value.shapes).toContainEqual({ kind: "guide", a: { x: 260, y: 240 }, b: { x: 260, y: 280 }, type: "vertical" });
      click(p.x, p.y);
      const sketch = session.value!.sketch;
      const line = sketch.entities.at(-1)!;
      if (line.kind !== "line") throw new Error("Expected a line");
      expect(sketch.points[line.p1]!.x).toBeCloseTo(sketch.points[line.p2]!.x, 7);
      expect(sketch.constraints.some((c) => c.type === "vertical" && c.refs.includes(line.id))).toBe(true);
    });

    it("rounds transformed sketches to the visible bed grid", () => {
      setupSketch();
      session.value = { ...session.value!, mat: [0, 1, -1, 0, 0.25, 0.4] };
      setTool("point");
      click(231.3, 244.7);
      const sketch = session.value!.sketch;
      const point = sketch.entities.at(-1)!;
      if (point.kind !== "point") throw new Error("Expected a point");
      const user = toUser(profile.value, apply(session.value!.mat, sketch.points[point.p]!));
      expect(user.x).toBeCloseTo(Math.round(user.x), 8);
      expect(user.y).toBeCloseTo(Math.round(user.y), 8);
    });
  });

  it("retains shift-click deselection and does not drag the deselected item", () => {
    const { first, second } = setupSketch();
    click(70, 50);
    click(70, 100);
    const e = pointer(true);
    const p = { x: 70, y: 50 };
    sketchPointerDown(e, p, p);
    sketchPointerMove(e, { x: 80, y: 60 }, { x: 80, y: 60 });
    sketchPointerUp(e, p, p);
    expect([...session.value!.selected]).toEqual([second.id]);
    expect(session.value!.sketch).toBe(second.s);
    expect(session.value!.selected.has(first.id)).toBe(false);
  });

  it("adds points independently for point constraints", () => {
    const { firstA, secondA } = setupSketch();
    click(20, 50);
    click(20, 100);
    expect([...session.value!.selected]).toEqual([firstA.id, secondA.id]);
  });

  it("preserves shift-drag additive marquee selection", () => {
    const { first, second } = setupSketch();
    click(70, 50);
    const e = pointer(true);
    sketchPointerDown(e, { x: 10, y: 80 }, { x: 10, y: 80 });
    sketchPointerMove(e, { x: 130, y: 120 }, { x: 130, y: 120 });
    sketchPointerUp(e, { x: 130, y: 120 }, { x: 130, y: 120 });
    expect([...session.value!.selected]).toEqual([first.id, second.id]);
  });

  it("drags all selected entities together after separate clicks", () => {
    const { firstA, secondA } = setupSketch();
    click(70, 50);
    click(70, 100);
    const e = pointer();
    sketchPointerDown(e, { x: 70, y: 100 }, { x: 70, y: 100 });
    sketchPointerMove(e, { x: 80, y: 110 }, { x: 80, y: 110 });
    sketchPointerUp(e, { x: 80, y: 110 }, { x: 80, y: 110 });
    expect(session.value!.sketch.points[firstA.id]!.x).toBeCloseTo(30, 3);
    expect(session.value!.sketch.points[firstA.id]!.y).toBeCloseTo(60, 3);
    expect(session.value!.sketch.points[secondA.id]!.x).toBeCloseTo(30, 3);
    expect(session.value!.sketch.points[secondA.id]!.y).toBeCloseTo(110, 3);
    expect(session.value!.undo).toHaveLength(1);
  });
});
