import { describe, expect, it } from "vitest";
import { coercePlanContent } from "../coerce-content.js";
import { PlanVisualSchema, StoredPlanVisualSchema } from "../../index.js";

/**
 * Skeleton plans, parity PR 2 — the server-set `skeleton` snapshot on an
 * annotated_code visual survives the renderer's coercer, and stays out of the
 * agent-facing PlanVisualSchema (tool input strips it).
 */
describe("skeleton snapshot on a visual", () => {
  const visual = {
    id: "skelcode:a.ts",
    kind: "annotated_code",
    code: "x",
    filePath: "a.ts",
    skeleton: {
      fences: [
        { id: "1", title: "dedupe", openLine: 2, closeLine: 4, status: "todo" },
        { id: "2", openLine: 6, closeLine: 8, status: "filled" },
      ],
      truncated: { shownLines: 8, totalLines: 40 },
    },
  };

  it("coercePlanContent keeps the fences, tracked and truncated fields", () => {
    const out = coercePlanContent({ steps: [], estimatedChanges: 1, visuals: [visual] });
    expect(out.visuals?.[0]).toMatchObject({ id: "skelcode:a.ts", skeleton: visual.skeleton });
    const tracked = coercePlanContent({ steps: [], estimatedChanges: 1, visuals: [{ ...visual, skeleton: { fences: [], tracked: true } }] });
    expect((tracked.visuals?.[0] as any).skeleton).toEqual({ fences: [], tracked: true });
  });

  it("degrades a malformed snapshot to safe fences instead of passing garbage to the renderer", () => {
    const out = coercePlanContent({
      steps: [],
      estimatedChanges: 1,
      visuals: [{ ...visual, skeleton: { fences: [{ id: "", openLine: 1, closeLine: 2 }, { id: "3", openLine: "x" }, { id: "4", openLine: 1, closeLine: 3, status: "weird" }], truncated: "no" } }],
    });
    expect((out.visuals?.[0] as any).skeleton).toEqual({ fences: [{ id: "4", openLine: 1, closeLine: 3, status: "todo" }] });
  });

  it("only annotated_code carries it, and a visual without one is unchanged", () => {
    const diagram = coercePlanContent({ steps: [], estimatedChanges: 1, visuals: [{ id: "d", kind: "diagram", source: "graph TD; A-->B", skeleton: visual.skeleton }] });
    expect((diagram.visuals?.[0] as any).skeleton).toBeUndefined();
    const plain = coercePlanContent({ steps: [], estimatedChanges: 1, visuals: [{ id: "ac", kind: "annotated_code", code: "x" }] });
    expect(plain.visuals?.[0]).toEqual({ id: "ac", kind: "annotated_code", code: "x" });
  });

  it("only a skelcode: (server snapshot) id may carry it; withheld survives", () => {
    const stray = coercePlanContent({ steps: [], estimatedChanges: 1, visuals: [{ ...visual, id: "agent-visual" }] });
    expect((stray.visuals?.[0] as any).skeleton).toBeUndefined();
    const withheld = coercePlanContent({ steps: [], estimatedChanges: 1, visuals: [{ id: "skelcode:a.ts", kind: "annotated_code", skeleton: { fences: [], withheld: "possible secret detected" } }] });
    expect((withheld.visuals?.[0] as any).skeleton).toEqual({ fences: [], withheld: "possible secret detected" });
  });

  it("the agent-facing schema strips it; the stored schema accepts it", () => {
    const parsed = PlanVisualSchema.parse(visual) as Record<string, unknown>;
    expect(parsed.skeleton).toBeUndefined();
    expect(StoredPlanVisualSchema.parse(visual).skeleton?.fences).toHaveLength(2);
  });
});
