import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact } from "@deeppairing/shared";
import { DecisionArtifactView } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";

vi.mock("../MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));

const decisionArtifact: Artifact = {
  id: "art_dec",
  sessionId: "s1",
  type: "decision",
  version: 1,
  parentId: null,
  title: "Which cache?",
  status: "approved",
  content: {
    decisionId: "dec_abc",
    context: "Which cache?",
    options: [
      { id: "o1", title: "Redis", description: "In-memory store", pros: ["fast"], cons: [], effort: "low", risk: "low", recommendation: true },
      { id: "o2", title: "CDN edge", description: "Just the edge", pros: [], cons: [], effort: "medium", risk: "medium" },
    ],
  },
  agentReasoning: null,
  createdAt: "2026-04-16T10:00:00.000Z",
  updatedAt: "2026-04-16T10:00:00.000Z",
};

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

/**
 * Bug3 (v0.1.1 field bug) — on a cold (non-replay) reload the resolved state
 * was derived ONLY from the replay store (empty on a live load), so a decision
 * the human had already resolved came back showing its options grid as if
 * unresolved. The hydrate handler now seeds the artifact store's
 * resolvedDecisions from data.state.decisions; DecisionArtifactView reads that
 * when replay is inactive and opens in the resolved state.
 */
describe("Bug3 — resolved decision shows selected after a cold hydrate", () => {
  it("opens in the resolved state when resolvedDecisions is seeded (no replay)", () => {
    // Simulate what the connection hydrate does: record the resolution.
    useArtifactStore.getState().recordResolvedDecision("dec_abc", {
      optionId: "o1",
      reasoning: "cheapest to run",
      resolvedAt: "2026-04-16T10:05:00.000Z",
    });

    render(<DecisionArtifactView artifact={decisionArtifact} />);

    // The resolved hero card (ResolvedDecisionView), not the options grid.
    expect(screen.getByText("Decision Made")).toBeInTheDocument();
    expect(screen.getByText("Redis")).toBeInTheDocument(); // chosen option
    expect(screen.getByText(/cheapest to run/)).toBeInTheDocument(); // reasoning
    // The unresolved affordance must be gone.
    expect(screen.queryByText("Let's think this through")).not.toBeInTheDocument();
  });

  it("stays in the options grid when nothing is recorded (unresolved)", () => {
    render(<DecisionArtifactView artifact={{ ...decisionArtifact, status: "draft" }} />);
    expect(screen.getByText("Let's think this through")).toBeInTheDocument();
    expect(screen.queryByText("Decision Made")).not.toBeInTheDocument();
  });
});
