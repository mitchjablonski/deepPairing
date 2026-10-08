import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DecisionArtifactView } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";

/**
 * #492 — a stale decision card whose decision was CLOSED elsewhere: the
 * daemon refuses with 409 decision_closed; the card shows the closed state to
 * you (second person), links the newer version when there is one, and offers
 * no Select buttons.
 */
const now = "2026-06-01T00:00:00.000Z";
const OPTS = [
  { id: "a", title: "Redis", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
  { id: "b", title: "Postgres", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
];
const decision = (id: string, decisionId: string, over: Record<string, unknown> = {}) => ({
  id, sessionId: "s1", type: "decision", version: 1, parentId: null, title: "Which store?", status: "draft",
  content: { context: "c", decisionId, options: OPTS }, agentReasoning: null, createdAt: now, updatedAt: now, ...over,
}) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: true, hydrated: true, sessionId: "s1", activeSessions: [{ sessionId: "s1", live: true }], disconnectedSince: null } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("#492 — a stale card learns its decision was closed", () => {
  it("superseded: after the 409 the card says 'revised — answer the new version', links it, and has no Select", async () => {
    const v1 = decision("art_d", "dec_d");
    const v2 = decision("art_d2", "dec_d2", { parentId: "art_d", version: 2 });
    useArtifactStore.setState({ artifacts: [v1, v2] } as any);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/api/decisions/dec_d")) {
        return Promise.resolve(new Response(JSON.stringify({
          error: "decision_closed", code: "decision_closed", currentStatus: "superseded", decisionId: "dec_d", artifactId: "art_d",
          supersededBy: { artifactId: "art_d2", decisionId: "dec_d2" },
          message: "This question was revised — answer the new version. Your answer to the old one wasn't recorded.",
        }), { status: 409, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    const { rerender } = render(<DecisionArtifactView artifact={v1} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Select Redis" })); });
    // The store applied the refusal's status; re-render the view with it.
    await waitFor(() => expect(useArtifactStore.getState().artifacts.find((a) => a.id === "art_d")?.status).toBe("superseded"));
    rerender(<DecisionArtifactView artifact={useArtifactStore.getState().artifacts.find((a) => a.id === "art_d")!} />);
    expect(screen.getByTestId("decision-closed")).toHaveTextContent("This question was revised — answer the new version.");
    expect(screen.queryAllByRole("button", { name: /^Select / })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open the new version →" }));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("art_d2");
  });

  it("retracted: 'Claude withdrew this question', options readable, no Select", () => {
    const v1 = decision("art_r", "dec_r", { status: "retracted" });
    useArtifactStore.setState({ artifacts: [v1] } as any);
    render(<DecisionArtifactView artifact={v1} />);
    expect(screen.getByTestId("decision-closed")).toHaveTextContent("Claude withdrew this question");
    expect(screen.getByText("Redis")).toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /^Select / })).toHaveLength(0);
  });
});
