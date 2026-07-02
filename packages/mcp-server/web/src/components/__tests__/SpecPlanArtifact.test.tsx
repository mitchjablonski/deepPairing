import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { SpecArtifact } from "../artifacts/SpecArtifact";
import { PlanArtifact } from "../artifacts/PlanArtifact";
import { ArtifactStatusActions } from "../artifacts/ArtifactStatusActions";

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

  it("U1 — a draft spec renders the review actions (approve/respond/reject), not a dead-end", () => {
    render(<SpecArtifact artifact={mk("spec", { objective: "ship it" })} />);
    // ArtifactStatusActions footer is present for a draft (was missing entirely)
    expect(screen.getByTitle(/approve as-is/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Respond" })).toBeInTheDocument();
  });

  it("UX7c — checkedSteps resyncs when the same plan's steps grow in place (new step not struck-through)", () => {
    const planV1 = mk("plan", { estimatedChanges: 2, steps: [
      { description: "step one", reasoning: "r" },
      { description: "step two", reasoning: "r" },
    ] });
    const { rerender } = render(<PlanArtifact artifact={planV1} />);
    // same artifact id, a third step appended in place
    const planV2 = mk("plan", { estimatedChanges: 3, steps: [
      { description: "step one", reasoning: "r" },
      { description: "step two", reasoning: "r" },
      { description: "step three", reasoning: "r" },
    ] });
    rerender(<PlanArtifact artifact={planV2} />);
    // pre-fix: checkedSteps[2] was undefined → the new step rendered struck-through/skipped
    const newStep = screen.getByText("step three").closest("div")!;
    expect(newStep.className).not.toMatch(/line-through/);
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

    // fresh draft: standard approve is available
    expect(screen.getByTitle(/approve as-is/i)).toBeInTheDocument();

    // uncheck the first step → the additive mods button appears...
    fireEvent.click(screen.getAllByTitle(/uncheck to skip this step/i)[0]);
    expect(screen.getByRole("button", { name: /approve with modifications/i })).toBeInTheDocument();

    // ...the rest of the standard footer is STILL there (regression: it used to
    // be replaced entirely, so you couldn't reject/respond while a step was off)...
    expect(screen.getByRole("button", { name: "Respond" })).toBeInTheDocument();

    // ...but the plain "Approve" is suppressed, so it can't silently approve the
    // plan as-is and discard the human's deselection (review QUESTION).
    expect(screen.queryByTitle(/approve as-is/i)).not.toBeInTheDocument();
  });

  it("cancels an armed approve-countdown when approval gets suppressed mid-countdown (2nd-pass review)", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.spyOn(useArtifactStore.getState(), "updateArtifactStatus").mockResolvedValue(undefined);
      const artifact = mk("plan", { estimatedChanges: 1, steps: [{ description: "do it", reasoning: "r" }] });

      // hideApprove starts false → arm the 3s confirm countdown via the keyboard shortcut
      const { rerender } = render(<ArtifactStatusActions artifact={artifact} hideApprove={false} />);
      act(() => {
        window.dispatchEvent(new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: artifact.id, action: "approve" } }));
      });

      // approval gets suppressed mid-countdown (user unchecks a step)
      rerender(<ArtifactStatusActions artifact={artifact} hideApprove={true} />);

      // run well past the countdown — it must NOT auto-approve as-is
      act(() => { vi.advanceTimersByTime(6000); });
      expect(spy).not.toHaveBeenCalledWith(artifact.id, "approved");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("D8 — spec open questions are answerable (H1) and requirement counts work (M6)", () => {
  it("each open question renders Ask + Comment triggers targeted by questionIndex", () => {
    const artifact = mk("spec", {
      objective: "obj",
      openQuestions: ["Should auth be optional?", "Which DB?"],
    });
    useArtifactStore.setState({ artifacts: [artifact], comments: {} });
    render(<SpecArtifact artifact={artifact} />);
    expect(screen.getByText("Should auth be optional?")).toBeInTheDocument();
    // Two questions → two Ask triggers within the open-questions block
    const asks = screen.getAllByRole("button", { name: /ask/i });
    expect(asks.length).toBeGreaterThanOrEqual(2);
  });

  it("a comment targeting questionIndex marks the question answered", () => {
    const artifact = mk("spec", { objective: "obj", openQuestions: ["Which DB?"] });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          {
            id: "c1", artifactId: artifact.id, author: "human", text: "Postgres",
            createdAt: new Date().toISOString(),
            target: { artifactId: artifact.id, questionIndex: 0, sectionId: "open-question" },
          } as any,
        ],
      },
    });
    render(<SpecArtifact artifact={artifact} />);
    expect(screen.getByText(/answered/i)).toBeInTheDocument();
  });

  it("M6 — requirement comment counts increment for comments carrying requirementId", () => {
    const artifact = mk("spec", {
      objective: "obj",
      requirements: [{ id: "REQ-1", statement: "Must work", priority: "must" }],
    });
    useArtifactStore.setState({
      artifacts: [artifact],
      comments: {
        [artifact.id]: [
          {
            id: "c2", artifactId: artifact.id, author: "human", text: "clarify",
            createdAt: new Date().toISOString(),
            // Legacy trigger shape — exactly what main's CommentTrigger sent
            // (no sectionId), which main's filter could NEVER count. This
            // test fails on main; the requirementId shape is covered by the
            // new-trigger path implicitly.
            target: { artifactId: artifact.id, stepIndex: 0 },
          } as any,
        ],
      },
    });
    render(<SpecArtifact artifact={artifact} />);
    // The CommentTrigger badge shows the count — the old filter could never
    // reach 1 for trigger-created comments (sectionId was never sent).
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});
