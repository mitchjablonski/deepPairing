import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { coerceDecisionContent } from "@deeppairing/shared";
import { useArtifactStore } from "../../stores/artifact";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { PlanArtifact } from "../artifacts/PlanArtifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { CodeChangeArtifact } from "../artifacts/CodeChangeArtifact";
import { ReasoningCard } from "../artifacts/ReasoningCard";
import { DecisionCard } from "../DecisionCard";

/**
 * The "gauntlet" for the coercion-boundary migration (PR #10): every renderer
 * now feeds raw `artifact.content` through a coercer instead of an unchecked
 * cast. Two properties must hold per type:
 *
 *   1. PARITY  — fully-populated, well-formed content still renders the fields
 *      a reader expects to see. This is the regression guard the unit tests on
 *      the coercer can't give: it proves migrating the renderer didn't silently
 *      drop a field on the way to the DOM.
 *   2. SURVIVAL — deeply adversarial content (nulls, numbers where strings
 *      belong, strings where arrays belong, nested junk) renders WITHOUT
 *      throwing, and any salvageable sub-data still shows. This is what the
 *      live malformed-artifact gauntlet checks, pinned as an automated test.
 */

const mk = (type: string, content: unknown) =>
  ({
    id: "x", type, title: "An Artifact", status: "draft", version: 1,
    sessionId: "s", createdAt: "2026-06-01T00:00:00.000Z", content,
  }) as any;

const textOf = (el: HTMLElement) => el.textContent ?? "";

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

// --- PARITY: well-formed content still surfaces its fields ---------------------

describe("gauntlet · parity (well-formed content renders its fields)", () => {
  it("research: category, title, detail, impact, recommendation all show", () => {
    const { container } = render(
      <ResearchArtifact
        artifact={mk("research", {
          summary: "Overall summary",
          findings: [
            {
              category: "performance",
              title: "N+1 query",
              detail: "The loader fetches per-row.",
              significance: "high",
              severity: "critical",
              confidence: "high",
              impact: "Slow dashboards.",
              recommendation: "Batch the fetch.",
            },
          ],
        })}
      />,
    );
    const t = textOf(container);
    expect(t).toContain("performance");
    expect(t).toContain("N+1 query");
    expect(t).toContain("The loader fetches per-row.");
    expect(t).toContain("Slow dashboards.");
    expect(t).toContain("Batch the fetch.");
    // confidence is a UI-extension field the coercer must preserve (high → confident badge)
    expect(t).toContain("confident");
  });

  it("plan: step descriptions, '~N file changes', and condition/branches show", () => {
    const { container } = render(
      <PlanArtifact
        artifact={mk("plan", {
          estimatedChanges: 3,
          steps: [
            { description: "Add the coercer", reasoning: "single boundary", files: ["coerce.ts"] },
            {
              description: "Wire renderers",
              reasoning: "trust the shape",
              condition: "if tests pass",
              branches: [{ description: "ship it", reasoning: "green" }],
            },
          ],
        })}
      />,
    );
    const t = textOf(container);
    expect(t).toContain("Add the coercer");
    expect(t).toContain("Wire renderers");
    expect(t).toContain("3 file changes");
    // UI-extension fields the coercer must preserve
    expect(t).toContain("if tests pass");
    expect(t).toContain("ship it");
  });

  it("spec: objective + requirement statements + acceptance criteria show", () => {
    const { container } = render(
      <SpecArtifact
        artifact={mk("spec", {
          objective: "Make rendering crash-proof",
          requirements: [
            {
              id: "REQ-1",
              statement: "Renderers never throw on partial content",
              rationale: "agents ship partial data",
              acceptanceCriteria: ["empty content renders", "wrong types degrade"],
              priority: "must",
            },
          ],
          openQuestions: ["Do we log dropped fields?"],
        })}
      />,
    );
    const t = textOf(container);
    expect(t).toContain("Make rendering crash-proof");
    expect(t).toContain("Renderers never throw on partial content");
    expect(t).toContain("empty content renders");
    expect(t).toContain("Do we log dropped fields?");
  });

  it("code_change: filePath, reasoning, and concept name show", () => {
    const { container } = render(
      <CodeChangeArtifact
        artifact={mk("code_change", {
          filePath: "src/coerce.ts",
          changeType: "create",
          before: "",
          after: "export const x = 1;",
          reasoning: "centralize the shape contract",
          concept: { name: "anti-corruption layer", oneLineExplanation: "translate at the boundary" },
        })}
      />,
    );
    const t = textOf(container);
    expect(t).toContain("src/coerce.ts");
    expect(t).toContain("centralize the shape contract");
    expect(t).toContain("anti-corruption layer");
  });

  it("reasoning: action, reasoning, and concept show", () => {
    const { container } = render(
      <ReasoningCard
        artifact={mk("reasoning", {
          action: "Introduce a coercion boundary",
          reasoning: "guards were scattered and missed cases",
          confidence: "high",
          concept: { name: "defensive boundary", oneLineExplanation: "validate once, trust after" },
          alternativeDetails: [{ title: "strict parse", reason: "would hide partial data" }],
        })}
      />,
    );
    const t = textOf(container);
    expect(t).toContain("Introduce a coercion boundary");
    expect(t).toContain("guards were scattered and missed cases");
    expect(t).toContain("defensive boundary");
  });

  it("decision: coerced options feed the card and render", () => {
    const dc = coerceDecisionContent({
      context: "Coerce or strict-parse?",
      decisionId: "dec_1",
      options: [
        { id: "o1", title: "Coercion boundary", description: "fill the gaps", pros: ["shows partial data"], cons: ["silent defaults"], recommendation: true },
        { id: "o2", title: "Strict parse", description: "reject bad content" },
      ],
    });
    const { container } = render(
      <DecisionCard
        event={{ type: "decision_request", decisionId: "dec_1", context: dc.context, options: dc.options }}
        decisionId="dec_1"
      />,
    );
    const t = textOf(container);
    expect(t).toContain("Coercion boundary");
    expect(t).toContain("Strict parse");
  });
});

// --- SURVIVAL: adversarial content never throws, salvage what's valid ----------

const JUNK = [null, undefined, "a string", 42, [], { nested: { deep: "junk" } }];

describe("gauntlet · survival (adversarial content never throws)", () => {
  const renderers: Array<[string, string, (a: any) => React.ReactElement]> = [
    ["research", "research", (a) => <ResearchArtifact artifact={a} />],
    ["plan", "plan", (a) => <PlanArtifact artifact={a} />],
    ["spec", "spec", (a) => <SpecArtifact artifact={a} />],
    ["code_change", "code_change", (a) => <CodeChangeArtifact artifact={a} />],
    ["reasoning", "reasoning", (a) => <ReasoningCard artifact={a} />],
  ];

  for (const [label, type, renderFn] of renderers) {
    it(`${label}: every junk content shape renders without throwing`, () => {
      for (const junk of JUNK) {
        expect(() => render(renderFn(mk(type, junk)))).not.toThrow();
      }
    });
  }

  it("research: wrong-typed findings degrade, the one valid finding still shows", () => {
    const { container } = render(
      <ResearchArtifact
        artifact={mk("research", {
          summary: 99,
          findings: [null, 7, "x", { detail: 99, significance: "bogus", evidence: 5 }, { category: "kept", detail: "this survives" }],
        })}
      />,
    );
    expect(textOf(container)).toContain("this survives");
  });

  it("plan: a string-typed files / non-array branches / number step don't crash", () => {
    expect(() =>
      render(
        <PlanArtifact
          artifact={mk("plan", {
            estimatedChanges: "lots",
            steps: [{ description: "ok", reasoning: "r", files: "single.ts", motivatedBy: "REQ-1", preview: "nope", condition: 9, branches: "no" }, "junk", 5],
          })}
        />,
      ),
    ).not.toThrow();
  });

  it("spec: string requirements / number tasks / string acceptanceCriteria don't crash", () => {
    expect(() => render(<SpecArtifact artifact={mk("spec", { objective: 1, requirements: "nope", tasks: 5 })} />)).not.toThrow();
    expect(() =>
      render(<SpecArtifact artifact={mk("spec", { objective: "o", requirements: [{ id: "R1", statement: "s", rationale: "w", acceptanceCriteria: "not-an-array" }] })} />),
    ).not.toThrow();
  });

  it("code_change: bogus changeType / object before / array after don't crash", () => {
    expect(() => render(<CodeChangeArtifact artifact={mk("code_change", { changeType: 99, before: {}, after: [], concept: { name: 123 } })} />)).not.toThrow();
  });

  it("reasoning: string relatesTo / string evidence / malformed alternativeDetails don't crash", () => {
    expect(() =>
      render(
        <ReasoningCard
          artifact={mk("reasoning", { action: 1, reasoning: 2, relatesTo: "elsewhere", evidence: "see-file", alternativesConsidered: "x", alternativeDetails: [{ title: 1 }, "junk"] })}
        />,
      ),
    ).not.toThrow();
  });
});
