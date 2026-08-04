import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";

// The workbench mounts a read-only VisualBody; mock mermaid so no async render
// runs in happy-dom (the same seam #173/#174 tests use).
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

// A HIGH-STAKES decision so the "+ Add reasoning" action is eligible to render.
// (#194 E3 cut the sibling "+ Capture prediction" action along with the
// calibration loop; only "+ Add reasoning" survives, and only in the workbench.)
const event = {
  type: "decision_request" as const,
  decisionId: "dec_cal",
  context: "Which store?",
  options: [
    { id: "o1", title: "Redis", description: "external cache", pros: ["fast"], cons: ["ops"], effort: "low" as const, risk: "low" as const, recommendation: true },
    { id: "o2", title: "Postgres", description: "reuse db", pros: ["no infra"], cons: ["sweep"], effort: "low" as const, risk: "low" as const, recommendation: false },
  ],
};

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("#190 calibration demotion — compact DecisionCard", () => {
  it("does NOT show '+ Add reasoning' on the compact card, and never a '+ Capture prediction'", () => {
    render(<DecisionCard event={event} decisionId="dec_cal" artifactId="art_cal" stakes="high" />);
    // Pre-fix (DecisionFooter rendered these unconditionally) the reasoning
    // action was present on the compact card — the 0/20 surface this demotes.
    expect(screen.queryByRole("button", { name: /Add reasoning/i })).not.toBeInTheDocument();
    // #194 — the prediction-capture action is gone everywhere.
    expect(screen.queryByRole("button", { name: /Capture prediction/i })).not.toBeInTheDocument();
  });
});

describe("#190 calibration demotion — Discuss workbench", () => {
  it("SHOWS the '+ Add reasoning' action in the workbench footer (but never '+ Capture prediction')", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_cal" artifactId="art_cal" stakes="high" />);

    // Sanity: confirmed absent on the compact card BEFORE opening the workbench
    // (guards against a false pass where the action never renders at all).
    expect(screen.queryByRole("button", { name: /Add reasoning/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Expand to discuss/i }));
    // The workbench passes showCalibrationActions → "+ Add reasoning" surfaces.
    expect(await screen.findByRole("button", { name: /Add reasoning/i })).toBeInTheDocument();
    // #194 — no prediction-capture action, even in the workbench.
    expect(screen.queryByRole("button", { name: /Capture prediction/i })).not.toBeInTheDocument();
  });
});
