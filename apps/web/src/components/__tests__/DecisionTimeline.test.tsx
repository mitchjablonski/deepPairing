import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DecisionTimeline } from "../DecisionTimeline";
import { useSessionStore } from "../../stores/session";
import type { AgentEvent } from "@deeppairing/shared";

beforeEach(() => {
  useSessionStore.setState({ events: [], status: "idle", sessionId: null, error: null });
});

describe("DecisionTimeline", () => {
  it("renders nothing when no decision events", () => {
    useSessionStore.setState({
      events: [{ type: "text", content: "Hello" }],
      status: "gathering",
    });
    const { container } = render(<DecisionTimeline />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a pending decision", () => {
    const events: AgentEvent[] = [
      {
        type: "decision_request",
        decisionId: "dec_1",
        context: "How to restructure auth?",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      },
    ];
    useSessionStore.setState({ events, status: "presenting" });
    render(<DecisionTimeline />);

    expect(screen.getByText("Decision History")).toBeInTheDocument();
    expect(screen.getByText("How to restructure auth?")).toBeInTheDocument();
  });

  it("renders a resolved decision with selected action", () => {
    const events: AgentEvent[] = [
      {
        type: "decision_request",
        decisionId: "dec_1",
        context: "How to restructure auth?",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      },
      { type: "status", phase: "executing" },
      {
        type: "reasoning",
        action: "Create AuthService class",
        reasoning: "Following service pattern.",
        confidence: "high",
      },
    ];
    useSessionStore.setState({ events, status: "executing" });
    render(<DecisionTimeline />);

    expect(screen.getByText("How to restructure auth?")).toBeInTheDocument();
    expect(screen.getByText("→ Create AuthService class")).toBeInTheDocument();
  });

  it("renders multiple decisions", () => {
    const events: AgentEvent[] = [
      {
        type: "decision_request",
        decisionId: "dec_1",
        context: "First question",
        options: [
          { id: "a", title: "A", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "b", title: "B", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      },
      { type: "status", phase: "executing" },
      { type: "reasoning", action: "Action 1", reasoning: ".", confidence: "high" as const },
      {
        type: "decision_request",
        decisionId: "dec_2",
        context: "Second question",
        options: [
          { id: "x", title: "X", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: true },
          { id: "y", title: "Y", description: "", pros: [], cons: [], effort: "low", risk: "low", recommendation: false },
        ],
      },
    ];
    useSessionStore.setState({ events, status: "presenting" });
    render(<DecisionTimeline />);

    expect(screen.getByText("First question")).toBeInTheDocument();
    expect(screen.getByText("Second question")).toBeInTheDocument();
  });
});
