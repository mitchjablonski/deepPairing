import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("renders a plan step missing optional `files` without crashing (files is optional per schema)", () => {
    // A step like "run tests" touches no files. `files` is optional in
    // PlanStepSchema, but the render did an unguarded `step.files.length` →
    // "Failed to render" for a perfectly valid plan.
    const plan = mk("plan", {
      steps: [{ description: "run the test suite", reasoning: "verify green" }],
      estimatedChanges: 0,
    }, { id: "planNoFiles" });
    expect(() => render(<PlanArtifact artifact={plan} />)).not.toThrow();
    expect(screen.getByText("run the test suite")).toBeInTheDocument();
  });

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

describe("plan/spec visuals render end-to-end through the artifact", () => {
  beforeEach(() => useArtifactStore.getState().reset());

  it("PlanArtifact renders a file_map visual block (artifact → coercer → ArtifactVisuals)", () => {
    const plan = mk("plan", {
      steps: [{ description: "do it", reasoning: "r" }],
      estimatedChanges: 1,
      visuals: [{ id: "fm", kind: "file_map", title: "Touch list", files: [{ path: "src/api.ts", change: "create" }] }],
    }, { id: "planViz" });
    render(<PlanArtifact artifact={plan} />);
    expect(screen.getByText("Visuals (1)")).toBeInTheDocument();
    expect(screen.getByText("Touch list")).toBeInTheDocument();
    expect(screen.getByText("api.ts")).toBeInTheDocument();
  });

  it("SpecArtifact renders a file_map visual block too (spec parity)", () => {
    const spec = mk("spec", {
      objective: "obj",
      requirements: [],
      visuals: [{ id: "fm", kind: "file_map", title: "Spec files", files: [{ path: "schema.sql", change: "create" }] }],
    }, { id: "specViz" });
    render(<SpecArtifact artifact={spec} />);
    expect(screen.getByText("Visuals (1)")).toBeInTheDocument();
    expect(screen.getByText("schema.sql")).toBeInTheDocument();
  });

  it("a plan with wrong-typed visuals doesn't crash the artifact (coercer + defensive render)", () => {
    const plan = mk("plan", {
      steps: [{ description: "x", reasoning: "y" }],
      estimatedChanges: 0,
      visuals: "not-an-array",
    }, { id: "planBadViz" });
    expect(() => render(<PlanArtifact artifact={plan} />)).not.toThrow();
    expect(screen.getByText("x")).toBeInTheDocument();
  });
});

describe("PlanArtifact — U3: 'Approve with modifications' is additive, not a footer takeover", () => {
  beforeEach(() => useArtifactStore.getState().reset());

  it("unchecking a step keeps the standard actions (Reject/etc) available alongside 'Approve with modifications'", () => {
    const plan = mk("plan", {
      estimatedChanges: 2,
      steps: [
        { description: "step one", reasoning: "r" },
        { description: "step two", reasoning: "r" },
      ],
    });
    render(<PlanArtifact artifact={plan} />);

    // standard actions present on a fresh draft (ArtifactStatusActions footer)
    expect(screen.getByTitle(/approve as-is/i)).toBeInTheDocument();

    // uncheck the first step → the additive mods button appears...
    fireEvent.click(screen.getAllByTitle(/uncheck to skip this step/i)[0]);
    expect(screen.getByRole("button", { name: /approve with modifications/i })).toBeInTheDocument();

    // ...and the standard actions footer is STILL there (regression: it used to
    // be replaced entirely, so you couldn't reject/respond while a step was off).
    expect(screen.getByTitle(/approve as-is/i)).toBeInTheDocument();
  });
});
