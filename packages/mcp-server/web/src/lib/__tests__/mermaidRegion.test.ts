import { describe, it, expect } from "vitest";
import {
  normalizeRect,
  intersects,
  isClickDrag,
  hitTestNodes,
  regionFromDrag,
  regionFromNode,
  sameRegion,
  regionNodesMissing,
  type DiagramNode,
  type PxRect,
} from "../mermaidRegion";

const host: PxRect = { left: 100, top: 50, right: 500, bottom: 250 }; // 400 x 200

describe("normalizeRect", () => {
  it("normalizes a pixel rect to the host's 0..1 box", () => {
    const sel: PxRect = { left: 200, top: 100, right: 300, bottom: 150 };
    const r = normalizeRect(sel, host);
    expect(r.x).toBeCloseTo(0.25); // (200-100)/400
    expect(r.y).toBeCloseTo(0.25); // (100-50)/200
    expect(r.w).toBeCloseTo(0.25); // (300-200)/400
    expect(r.h).toBeCloseTo(0.25); // (150-100)/200
  });

  it("survives a resize: the SAME visual selection normalizes identically at 2x", () => {
    // A selection covering the middle quarter of the diagram at one size…
    const small = normalizeRect({ left: 200, top: 100, right: 300, bottom: 150 }, host);
    // …and the geometrically-equivalent selection when the whole diagram is
    // rendered twice as large (host and selection both scaled about the origin
    // proportionally) must yield the same normalized rect.
    const host2: PxRect = { left: 200, top: 100, right: 1000, bottom: 500 }; // 800 x 400
    const big = normalizeRect({ left: 400, top: 200, right: 600, bottom: 300 }, host2);
    expect(big.x).toBeCloseTo(small.x);
    expect(big.y).toBeCloseTo(small.y);
    expect(big.w).toBeCloseTo(small.w);
    expect(big.h).toBeCloseTo(small.h);
  });

  it("clamps a drag that runs past the diagram edge into the 0..1 box", () => {
    const r = normalizeRect({ left: 0, top: 0, right: 900, bottom: 900 }, host);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBe(1);
    expect(r.h).toBe(1);
  });

  it("degrades to a zero rect for a zero-size host instead of dividing by zero", () => {
    const r = normalizeRect({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 0, top: 0, right: 0, bottom: 0 });
    expect(r).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("isClickDrag", () => {
  it("treats a zero-area drag as a click", () => {
    expect(isClickDrag({ left: 10, top: 10, right: 10, bottom: 10 })).toBe(true);
  });
  it("treats a one-pixel drag as a click", () => {
    expect(isClickDrag({ left: 10, top: 10, right: 11, bottom: 11 })).toBe(true);
  });
  it("treats a real drag as a region", () => {
    expect(isClickDrag({ left: 10, top: 10, right: 60, bottom: 40 })).toBe(false);
  });
});

describe("intersects", () => {
  it("detects overlap and rejects disjoint / edge-only rects", () => {
    expect(intersects({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })).toBe(true);
    expect(intersects({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })).toBe(false);
    // Shared vertical edge only (no area overlap) → not an intersection.
    expect(intersects({ x: 0, y: 0, w: 0.2, h: 0.2 }, { x: 0.2, y: 0, w: 0.2, h: 0.2 })).toBe(false);
  });
});

// Two nodes laid out side by side in the normalized box.
const nodeA: DiagramNode = { id: "flowchart-AuthGate-1", label: "AuthGate", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } };
const nodeB: DiagramNode = { id: "flowchart-Login-2", label: "Login", rect: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 } };

describe("hitTestNodes", () => {
  it("returns the single node id + label for a rect over one node", () => {
    const hit = hitTestNodes({ x: 0.12, y: 0.12, w: 0.1, h: 0.1 }, [nodeA, nodeB]);
    expect(hit.elementIds).toEqual(["flowchart-AuthGate-1"]);
    expect(hit.labels).toEqual(["AuthGate"]);
  });

  it("returns both node ids + labels for a rect spanning two nodes", () => {
    const hit = hitTestNodes({ x: 0.05, y: 0.05, w: 0.85, h: 0.3 }, [nodeA, nodeB]);
    expect(hit.elementIds).toEqual(["flowchart-AuthGate-1", "flowchart-Login-2"]);
    expect(hit.labels).toEqual(["AuthGate", "Login"]);
  });

  it("returns nothing for a rect over blank space between nodes", () => {
    const hit = hitTestNodes({ x: 0.4, y: 0.1, w: 0.1, h: 0.1 }, [nodeA, nodeB]);
    expect(hit.elementIds).toEqual([]);
    expect(hit.labels).toEqual([]);
  });
});

describe("regionFromDrag / regionFromNode", () => {
  it("builds a region target from a drag, hit-testing the nodes it covers", () => {
    // Drag over node A's pixel area within the host.
    const sel: PxRect = { left: 100 + 0.12 * 400, top: 50 + 0.12 * 200, right: 100 + 0.25 * 400, bottom: 50 + 0.25 * 200 };
    const region = regionFromDrag(sel, host, [nodeA, nodeB]);
    expect(region.elementIds).toEqual(["flowchart-AuthGate-1"]);
    expect(region.labels).toEqual(["AuthGate"]);
  });

  it("builds a single-node region for the keyboard path", () => {
    const region = regionFromNode(nodeB);
    expect(region.elementIds).toEqual(["flowchart-Login-2"]);
    expect(region.labels).toEqual(["Login"]);
    expect(region.x).toBe(nodeB.rect.x);
  });
});

describe("sameRegion", () => {
  it("threads two regions covering the same node LABELS together (ignores render-unique ids)", () => {
    // Same label, DIFFERENT render-prefixed ids (as real mermaid emits across
    // renders). They must still thread — matching keys off labels, not ids.
    const stored = { x: 0, y: 0, w: 1, h: 1, elementIds: ["dp-mmd-1-2-flowchart-AuthGate-0"], labels: ["AuthGate"] };
    const fresh = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, elementIds: ["dp-mmd-9-9-flowchart-AuthGate-0"], labels: ["AuthGate"] };
    expect(sameRegion(stored, fresh)).toBe(true);
  });
  it("matches labels case-insensitively / whitespace-normalized", () => {
    expect(sameRegion({ x: 0, y: 0, w: 1, h: 1, labels: ["Auth Gate"] }, { x: 0, y: 0, w: 1, h: 1, labels: ["auth  gate"] })).toBe(true);
  });
  it("keeps regions over different nodes separate", () => {
    expect(sameRegion(regionFromNode(nodeA), regionFromNode(nodeB))).toBe(false);
  });
});

describe("regionNodesMissing", () => {
  it("is false while at least one referenced LABEL still exists", () => {
    expect(regionNodesMissing(regionFromNode(nodeA), [nodeA, nodeB])).toBe(false);
  });
  it("REGRESSION: a re-render that changed every node id but kept the label is NOT flagged missing", () => {
    // The exact defect the review caught: mermaid ids are render-unique, so an
    // id-based check would cry wolf here on every reload. Label-based must not.
    const stored = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, elementIds: ["dp-mmd-1-2-flowchart-A-0"], labels: ["AuthGate"] };
    const afterRerender: DiagramNode[] = [
      { id: "dp-mmd-3-4-flowchart-A-0", label: "AuthGate", rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    ];
    expect(regionNodesMissing(stored, afterRerender)).toBe(false);
  });
  it("is true once the referenced label genuinely disappears (node removed/renamed)", () => {
    const stored = { x: 0.1, y: 0.1, w: 0.2, h: 0.2, elementIds: ["dp-mmd-1-2-flowchart-Ghost-0"], labels: ["Ghost"] };
    const current: DiagramNode[] = [{ id: "dp-mmd-3-4-flowchart-A-0", label: "AuthGate", rect: { x: 0, y: 0, w: 0.2, h: 0.2 } }];
    expect(regionNodesMissing(stored, current)).toBe(true);
  });
  it("is false for a label-less region (a blank-area drag claimed no node)", () => {
    expect(regionNodesMissing({ x: 0, y: 0, w: 0.5, h: 0.5 }, [])).toBe(false);
  });
});
