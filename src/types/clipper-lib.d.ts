// Minimal types for the parts of clipper-lib (Clipper 1 by Angus Johnson, Boost license) used in src/job/fill.ts.
declare module "clipper-lib" {
  interface IntPoint {
    X: number;
    Y: number;
  }
  type Path = IntPoint[];
  type Paths = Path[];
  class PolyNode {
    Childs(): PolyNode[];
    Contour(): Path;
    IsHole(): boolean;
  }
  class PolyTree extends PolyNode {}
  class Clipper {
    AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
    Execute(clipType: number, solution: Paths | PolyTree, subjFill: number, clipFill: number): boolean;
  }
  class ClipperOffset {
    constructor(miterLimit?: number, arcTolerance?: number);
    AddPaths(paths: Paths, joinType: number, endType: number): void;
    Execute(solution: Paths, delta: number): void;
  }
  const ClipperLib: {
    Clipper: typeof Clipper;
    ClipperOffset: typeof ClipperOffset;
    Paths: { new (): Paths };
    PolyTree: typeof PolyTree;
    PolyType: { ptSubject: number; ptClip: number };
    ClipType: { ctUnion: number };
    PolyFillType: { pftEvenOdd: number; pftNonZero: number };
    JoinType: { jtRound: number; jtMiter: number };
    EndType: { etClosedPolygon: number };
  };
  export type PolyNodeType = PolyNode;
  export default ClipperLib;
}
