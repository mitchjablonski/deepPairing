/**
 * U2 — `parseArtifactContent` discriminated parser. Replaces the unchecked
 * `getTypedContent<T>` cast that the code-quality reviewer flagged as a
 * type-safety hole: web components were rendering whatever the daemon sent
 * with no validation, so a malformed artifact crashed the renderer with a
 * "cannot read property X of undefined" instead of failing at the boundary.
 *
 * The new parser switches on artifact.type and runs the matching schema's
 * .safeParse, returning either { ok: true, data } or { ok: false, error }.
 * Callers handle the failure case explicitly — no silent type lies.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "../artifact.js";
import { parseArtifactContent } from "../artifact.js";

function art(type: Artifact["type"], content: any, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_x",
    sessionId: "s",
    type,
    version: 1,
    parentId: null,
    title: "T",
    status: "draft",
    content,
    agentReasoning: null,
    createdAt: "2026-04-25T12:00:00.000Z",
    updatedAt: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseArtifactContent (U2)", () => {
  it("validates a research artifact's content via ResearchContentSchema", async () => {
    const r = await parseArtifactContent(art("research", {
      summary: "x", findings: [{ category: "c", detail: "d", significance: "low", evidence: "snip" }],
    }));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.data as any).summary).toBe("x");
  });

  it("returns ok=false when a required field is missing", async () => {
    const r = await parseArtifactContent(art("research", { summary: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0].path.join(".")).toBe("findings");
  });

  it("validates a decision artifact (matches DecisionContentSchema)", async () => {
    const r = await parseArtifactContent(art("decision", {
      context: "Pick a cache",
      decisionId: "dec_1",
      options: [{
        id: "a", title: "Redis", description: "fast", pros: ["a"], cons: ["b"],
        effort: "low", risk: "low", recommendation: true,
      }],
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects a decision artifact with malformed options (missing required fields)", async () => {
    const r = await parseArtifactContent(art("decision", {
      context: "x", decisionId: "d",
      options: [{ id: "a" }],  // missing title, description, etc.
    }));
    expect(r.ok).toBe(false);
  });

  it("validates a code_change artifact", async () => {
    const r = await parseArtifactContent(art("code_change", {
      filePath: "x.ts", changeType: "modify", before: "a", after: "b", reasoning: "fix",
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects a code_change with an unknown changeType", async () => {
    const r = await parseArtifactContent(art("code_change", {
      filePath: "x", changeType: "yeet", before: "", after: "", reasoning: "",
    }));
    expect(r.ok).toBe(false);
  });

  it("validates a plan artifact via PlanContentSchema", async () => {
    const r = await parseArtifactContent(art("plan", {
      steps: [{ description: "step 1", reasoning: "why", files: [] }],
      estimatedChanges: 1,
    }));
    expect(r.ok).toBe(true);
  });

  it("validates a spec artifact", async () => {
    const r = await parseArtifactContent(art("spec", {
      objective: "ship",
      requirements: [{
        id: "REQ-1", statement: "do x", rationale: "because", acceptanceCriteria: ["x is done"],
      }],
    }));
    expect(r.ok).toBe(true);
  });

  it("validates a reasoning artifact (concept optional)", async () => {
    const r = await parseArtifactContent(art("reasoning", {
      action: "use DI", reasoning: "testability",
    }));
    expect(r.ok).toBe(true);
  });
});
