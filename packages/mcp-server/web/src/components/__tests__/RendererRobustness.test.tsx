import { describe, it, expect, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { ResearchArtifact } from "../artifacts/ResearchArtifact";
import { PlanArtifact } from "../artifacts/PlanArtifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { CodeChangeArtifact } from "../artifacts/CodeChangeArtifact";
import { ReasoningCard } from "../artifacts/ReasoningCard";

/**
 * Renderers read `artifact.content` via an UNCHECKED cast (getTypedContent),
 * so the schema's "required" guarantees aren't enforced at the boundary — a
 * partial/legacy/malformed stored artifact can violate any of them at runtime.
 * Every type renderer must therefore degrade, never throw, on:
 *   - completely empty content ({})
 *   - an array field that's missing or the wrong type (the `findings.some`,
 *     `step.files.length`, `requirements.map` class of crash)
 * These tests pin the existing defensive coding so a future refactor can't
 * silently reintroduce a "Failed to render" crash.
 */
const mk = (type: string, content: any) =>
  ({
    id: "x", type, title: "t", status: "draft", version: 1,
    createdAt: "2026-06-01T00:00:00.000Z", content,
  }) as any;

beforeEach(() => useArtifactStore.getState().reset());

const renderers: Array<[string, (a: any) => ReactElement]> = [
  ["ResearchArtifact", (a) => <ResearchArtifact artifact={a} />],
  ["PlanArtifact", (a) => <PlanArtifact artifact={a} />],
  ["SpecArtifact", (a) => <SpecArtifact artifact={a} />],
  ["CodeChangeArtifact", (a) => <CodeChangeArtifact artifact={a} />],
  ["ReasoningCard", (a) => <ReasoningCard artifact={a} />],
];

describe("artifact renderers tolerate empty content without crashing", () => {
  for (const [name, renderFn] of renderers) {
    it(`${name} renders on content: {}`, () => {
      const type = name.replace(/Artifact|Card/, "").toLowerCase();
      expect(() => render(renderFn(mk(type, {})))).not.toThrow();
    });
  }
});

describe("artifact renderers tolerate wrong-type array fields", () => {
  it("ResearchArtifact: findings as a non-array string", () => {
    expect(() => render(<ResearchArtifact artifact={mk("research", { summary: "s", findings: "nope" })} />)).not.toThrow();
  });

  it("PlanArtifact: a step missing optional files, and steps as a non-array", () => {
    expect(() => render(<PlanArtifact artifact={mk("plan", { estimatedChanges: 0, steps: [{ description: "run tests", reasoning: "verify" }] })} />)).not.toThrow();
    expect(() => render(<PlanArtifact artifact={mk("plan", { steps: "nope" })} />)).not.toThrow();
  });

  it("SpecArtifact: requirements missing and a requirement missing acceptanceCriteria", () => {
    expect(() => render(<SpecArtifact artifact={mk("spec", { objective: "o" })} />)).not.toThrow();
    expect(() => render(<SpecArtifact artifact={mk("spec", { objective: "o", requirements: [{ id: "R1", statement: "do", rationale: "why" }] })} />)).not.toThrow();
  });

  it("ReasoningCard: alternatives/evidence arrays absent", () => {
    expect(() => render(<ReasoningCard artifact={mk("reasoning", { action: "a", reasoning: "r" })} />)).not.toThrow();
  });
});
