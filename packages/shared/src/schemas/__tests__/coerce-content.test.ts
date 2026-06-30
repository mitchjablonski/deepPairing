import { describe, it, expect } from "vitest";
import {
  coerceResearchContent,
  coercePlanContent,
  coerceSpecContent,
  coerceDecisionContent,
  coerceCodeChangeContent,
  coerceReasoningContent,
  coerceArtifactContent,
} from "../coerce-content.js";

/**
 * The coercers guarantee a fully-shaped content object from raw/partial/
 * malformed input so renderers can trust the shape. Three invariants per type:
 *   1. empty {} → required fields present, arrays = [], no throw
 *   2. wrong-type values (a string where an array belongs) → safe defaults
 *   3. valid content passes through unchanged
 */
describe("coerceResearchContent", () => {
  it("empty → summary '' and findings []", () => {
    expect(coerceResearchContent({})).toEqual({ summary: "", findings: [] });
  });
  it("non-array findings → []", () => {
    expect(coerceResearchContent({ summary: "s", findings: "nope" }).findings).toEqual([]);
  });
  it("coerces each finding (missing significance → 'low', drops nothing valid)", () => {
    const r = coerceResearchContent({ summary: "s", findings: [{ category: "perf", detail: "d", title: "T" }] });
    expect(r.findings[0]).toMatchObject({ category: "perf", detail: "d", title: "T", significance: "low" });
  });
  it("preserves a finding's UI-only `confidence` (present_findings accepts it; schema doesn't model it)", () => {
    const r = coerceResearchContent({ findings: [{ category: "c", detail: "d", confidence: "high" }] });
    expect((r.findings[0] as { confidence?: string }).confidence).toBe("high");
    // invalid confidence is dropped, not defaulted
    const bad = coerceResearchContent({ findings: [{ category: "c", detail: "d", confidence: "sorta" }] });
    expect((bad.findings[0] as { confidence?: string }).confidence).toBeUndefined();
  });
});

describe("coercePlanContent", () => {
  it("empty → steps [] and estimatedChanges 0", () => {
    expect(coercePlanContent({})).toEqual({ steps: [], estimatedChanges: 0 });
  });
  it("non-array steps → []", () => {
    expect(coercePlanContent({ steps: "nope" }).steps).toEqual([]);
  });
  it("a step keeps description/reasoning and omits absent optional files", () => {
    const p = coercePlanContent({ steps: [{ description: "run tests", reasoning: "verify" }], estimatedChanges: 2 });
    expect(p.steps[0]).toEqual({ description: "run tests", reasoning: "verify" });
    expect(p.estimatedChanges).toBe(2);
  });
  it("preserves UI-only condition/branches (present_plan accepts them; schema doesn't model them)", () => {
    const p = coercePlanContent({
      steps: [{ description: "maybe", reasoning: "r", condition: "if tests fail", branches: [{ description: "fix", reasoning: "why", files: ["a.ts"] }] }],
    });
    const step = p.steps[0] as { condition?: string; branches?: { description: string; files?: unknown[] }[] };
    expect(step.condition).toBe("if tests fail");
    expect(step.branches?.[0]).toMatchObject({ description: "fix", reasoning: "why", files: ["a.ts"] });
  });
  it("coerces visuals: keeps a valid diagram, shapes a file_map, and fills id/kind defaults", () => {
    const p = coercePlanContent({
      visuals: [
        { id: "v1", kind: "diagram", source: "graph TD; A-->B", title: "Arch" },
        { id: "v2", kind: "file_map", files: [{ path: "a.ts", change: "create" }, "junk", { path: "b.ts", change: "bogus" }] },
        { kind: "weird" }, // no id, bad kind → id fallback + kind defaults to "diagram"
      ],
    });
    expect(p.visuals).toHaveLength(3);
    expect(p.visuals![0]).toMatchObject({ id: "v1", kind: "diagram", source: "graph TD; A-->B", title: "Arch" });
    // non-object dropped; an invalid change enum dropped, leaving a clean { path }
    expect(p.visuals![1].files).toEqual([{ path: "a.ts", change: "create" }, { path: "b.ts" }]);
    expect(p.visuals![2]).toMatchObject({ id: "visual_2", kind: "diagram" });
  });
  it("non-array visuals → omitted (no throw)", () => {
    expect(coercePlanContent({ visuals: "nope" }).visuals).toBeUndefined();
  });

  it("F4 — a visual without an id gets a CONTENT-stable fallback id (survives reorder)", () => {
    const ids = (visuals: unknown[]) => coercePlanContent({ visuals }).visuals!;
    const a = ids([{ kind: "diagram", source: "graph TD; A-->B" }, { kind: "file_map", files: [{ path: "x.ts" }] }]);
    // same two visuals, reordered — the diagram's id must follow its CONTENT,
    // not its index, so a revision diff matches it across versions.
    const b = ids([{ kind: "file_map", files: [{ path: "x.ts" }] }, { kind: "diagram", source: "graph TD; A-->B" }]);
    const aDia = a.find((v) => v.kind === "diagram")!.id;
    const bDia = b.find((v) => v.kind === "diagram")!.id;
    expect(aDia).toBe(bDia);
    expect(a[0].id).not.toBe(a[1].id); // distinct visuals → distinct ids
  });

  it("F4 — an empty visual still falls back to the positional id", () => {
    expect(coercePlanContent({ visuals: [{ kind: "diagram" }] }).visuals![0].id).toBe("visual_0");
  });

  it("coerces an annotated_code visual: keeps code/filePath/lineStart, shapes annotations, drops junk", () => {
    const p = coercePlanContent({
      visuals: [
        {
          id: "ac",
          kind: "annotated_code",
          code: "const x = 1;\nreturn x;",
          filePath: "src/x.ts",
          language: "ts",
          lineStart: 40,
          annotations: [
            { line: 40, note: "declare", kind: "add" },
            { line: 41, note: "return it" }, // no kind → kept, kind omitted
            { line: "nope", note: "bad line" }, // dropped (line not a number)
            { line: 42 }, // dropped (no note)
            "junk", // dropped (not an object)
          ],
        },
      ],
    });
    const v = p.visuals![0];
    expect(v).toMatchObject({ id: "ac", kind: "annotated_code", code: "const x = 1;\nreturn x;", filePath: "src/x.ts", language: "ts", lineStart: 40 });
    expect(v.annotations).toEqual([
      { line: 40, note: "declare", kind: "add" },
      { line: 41, note: "return it" },
    ]);
  });

  it("annotated_code with wrong-typed fields → safe (no throw, junk dropped)", () => {
    const v = coercePlanContent({
      visuals: [{ id: "ac", kind: "annotated_code", code: 42, lineStart: "x", annotations: "nope" }],
    }).visuals![0];
    expect(v.kind).toBe("annotated_code");
    expect(v.code).toBeUndefined(); // non-string dropped
    expect(v.lineStart).toBeUndefined(); // non-number dropped
    expect(v.annotations).toBeUndefined(); // non-array dropped
  });
});

describe("coerceSpecContent", () => {
  it("empty → objective '' and requirements []", () => {
    expect(coerceSpecContent({})).toEqual({ objective: "", requirements: [] });
  });
  it("a requirement missing acceptanceCriteria → []", () => {
    const s = coerceSpecContent({ objective: "o", requirements: [{ id: "R1", statement: "do", rationale: "why" }] });
    expect(s.requirements[0]).toEqual({ id: "R1", statement: "do", rationale: "why", acceptanceCriteria: [] });
  });
  it("coerces visuals (specs carry them too)", () => {
    const s = coerceSpecContent({ objective: "o", requirements: [], visuals: [{ id: "v", kind: "diagram", source: "graph TD; A-->B" }] });
    expect(s.visuals).toEqual([{ id: "v", kind: "diagram", source: "graph TD; A-->B" }]);
  });
});

describe("coerceDecisionContent", () => {
  it("empty → context '', options [], decisionId ''", () => {
    expect(coerceDecisionContent({})).toEqual({ context: "", options: [], decisionId: "" });
  });
  it("an option missing pros/cons → [], missing effort/risk → 'medium'", () => {
    const d = coerceDecisionContent({ context: "c", decisionId: "x", options: [{ id: "o1", title: "A", description: "d" }] });
    expect(d.options[0]).toEqual({
      id: "o1", title: "A", description: "d", pros: [], cons: [], effort: "medium", risk: "medium", recommendation: false,
    });
  });
  it("drops an empty concept (name '') but keeps a real one", () => {
    expect(coerceDecisionContent({ options: [{ id: "o", concept: { name: "" } }] }).options[0].concept).toBeUndefined();
    expect(coerceDecisionContent({ options: [{ id: "o", concept: { name: "DI" } }] }).options[0].concept).toEqual({ name: "DI" });
  });

  it("DV1 — coerces per-option visuals, keeping an agent-provided id", () => {
    const d = coerceDecisionContent({
      options: [{ id: "o1", visuals: [{ id: "v_custom", kind: "diagram", source: "graph TD; A-->B" }] }],
    });
    expect(d.options[0].visuals).toHaveLength(1);
    expect(d.options[0].visuals![0]).toMatchObject({ id: "v_custom", kind: "diagram", source: "graph TD; A-->B" });
  });

  it("DV1 — id-less visuals get distinct ids (content-hashed), and a content-less one falls back to the option-scoped index", () => {
    const d = coerceDecisionContent({
      options: [
        { id: "o1", visuals: [{ kind: "diagram", source: "a" }] },
        { id: "o2", visuals: [{ kind: "diagram", source: "b" }] },
        { id: "o3", visuals: [{ kind: "diagram" }] }, // no content → option-scoped index id
      ],
    });
    // Different content → different ids: comment threads won't cross-anchor.
    expect(d.options[0].visuals![0].id).not.toBe(d.options[1].visuals![0].id);
    // The degenerate content-less visual falls back to the option-scoped index.
    expect(d.options[2].visuals![0].id).toBe("o3_visual_0");
  });
});

describe("coerceCodeChangeContent", () => {
  it("empty → all strings '' and changeType 'modify'", () => {
    expect(coerceCodeChangeContent({})).toEqual({ filePath: "", changeType: "modify", before: "", after: "", reasoning: "" });
  });
  it("invalid changeType → 'modify'", () => {
    expect(coerceCodeChangeContent({ changeType: "frobnicate" }).changeType).toBe("modify");
  });
});

describe("coerceReasoningContent", () => {
  it("empty → action '' and reasoning ''", () => {
    expect(coerceReasoningContent({})).toEqual({ action: "", reasoning: "" });
  });
  it("keeps valid optional arrays, drops a malformed relatesTo", () => {
    const r = coerceReasoningContent({ action: "a", reasoning: "r", alternativesConsidered: ["x", 1], relatesTo: { artifactId: "z" } });
    expect(r.alternativesConsidered).toEqual(["x"]); // non-string dropped
    expect(r.relatesTo).toBeUndefined(); // missing/invalid kind → dropped
  });
});

describe("coerceArtifactContent dispatcher", () => {
  it("routes by type and returns null for an unknown/contentless type", () => {
    expect(coerceArtifactContent({ type: "plan", content: {} })).toEqual({ steps: [], estimatedChanges: 0 });
    expect(coerceArtifactContent({ type: "reasoning" as any, content: { action: "a", reasoning: "r" } })).toMatchObject({ action: "a" });
    expect(coerceArtifactContent({ type: "unknown" as any, content: {} })).toBeNull();
  });
});
