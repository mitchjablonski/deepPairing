import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";

// The workbench mounts a read-only VisualBody; mock mermaid so no async render
// runs in happy-dom (the same seam #173/#174 tests use).
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

// A HIGH-STAKES decision so BOTH calibration actions ("+ Add reasoning" and
// "+ Capture prediction with my pick") are eligible to render.
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
  it("does NOT show '+ Add reasoning' or '+ Capture prediction' on the compact card", () => {
    render(<DecisionCard event={event} decisionId="dec_cal" artifactId="art_cal" stakes="high" />);
    // Pre-fix (DecisionFooter rendered these unconditionally) BOTH buttons were
    // present on the compact card — the 0/20 surface this demotion removes.
    expect(screen.queryByRole("button", { name: /Add reasoning/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Capture prediction/i })).not.toBeInTheDocument();
  });
});

describe("#190 calibration demotion — Discuss workbench", () => {
  it("SHOWS both calibration actions in the workbench footer", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_cal" artifactId="art_cal" stakes="high" />);

    // Sanity: confirmed absent on the compact card BEFORE opening the workbench
    // (guards against a false pass where the actions never render at all).
    expect(screen.queryByRole("button", { name: /Add reasoning/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Expand to discuss/i }));
    // The workbench passes showCalibrationActions → both actions surface here.
    expect(await screen.findByRole("button", { name: /Add reasoning/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Capture prediction/i })).toBeInTheDocument();
  });
});
