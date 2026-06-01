import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { PlanArtifact } from "../artifacts/PlanArtifact";

/**
 * Regression for the "Failed to render" per-artifact crash. Two real shape-drift
 * bugs the renderers must tolerate:
 *  - SpecArtifact: a spec missing `requirements` (or a requirement missing
 *    `acceptanceCriteria`) hit unguarded `.length`/`.map`.
 *  - PlanArtifact (MotivatedByBadges): a step's `motivatedBy` carries non-
 *    artifact-id labels (e.g. "REQ-1"); resolving them scanned research
 *    artifacts via `content.findings?.some(...)`, which THREW when a research
 *    artifact's `findings` was a non-array (`?.` guards null, not wrong-type).
 */
const mk = (type: string, content: any, over: any = {}) =>
  ({ id: "x", type, title: "t", status: "draft", version: 1, createdAt: "2026-06-01T00:00:00.000Z", content, ...over }) as any;

describe("SpecArtifact — tolerates missing optional arrays", () => {
  beforeEach(() => useArtifactStore.getState().reset());

  it("renders a spec missing `requirements` entirely without crashing", () => {
    render(<SpecArtifact artifact={mk("spec", { objective: "minimal spec objective" })} />);
    expect(screen.getByText("minimal spec objective")).toBeInTheDocument();
  });

  it("renders a requirement missing `acceptanceCriteria` without crashing", () => {
    render(<SpecArtifact artifact={mk("spec", {
      objective: "obj",
      requirements: [{ id: "R1", statement: "do the thing", rationale: "because" }],
    })} />);
    expect(screen.getByText("do the thing")).toBeInTheDocument();
  });
});

describe("PlanArtifact — MotivatedByBadges tolerates unresolved / odd data", () => {
  beforeEach(() => useArtifactStore.getState().reset());

  it("renders a plan step whose motivatedBy is a non-artifact-id, even when a research artifact has non-array findings", () => {
    // Seed a research artifact whose `findings` is a STRING (the exact shape
    // that made `findings?.some` throw before the guard).
    useArtifactStore.getState().addArtifact(
      mk("research", { summary: "s", findings: "not-an-array" }, { id: "res1", title: "Some research" }),
    );
    const plan = mk("plan", {
      steps: [{ description: "step one", reasoning: "r", files: [], motivatedBy: ["REQ-1"] }],
      estimatedChanges: 1,
    }, { id: "plan1" });

    expect(() => render(<PlanArtifact artifact={plan} />)).not.toThrow();
    // The unresolved label degrades to a plain badge.
    expect(screen.getByText("REQ-1")).toBeInTheDocument();
  });
});
