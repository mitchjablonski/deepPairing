import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityStream } from "../ActivityStream";
import { useSessionStore } from "../../stores/session";
import type { AgentEvent } from "@deeppairing/shared";

// Reset store between tests
beforeEach(() => {
  useSessionStore.setState({
    sessionId: null,
    status: "idle",
    events: [],
    error: null,
  });
});

function setEvents(events: AgentEvent[], status: "idle" | "gathering" | "completed" = "gathering") {
  useSessionStore.setState({ events, status, sessionId: "test_session" });
}

describe("ActivityStream", () => {
  it("shows empty state when idle with no events", () => {
    render(<ActivityStream />);
    expect(screen.getByText(/enter a prompt/i)).toBeInTheDocument();
  });

  it("renders text events", () => {
    setEvents([{ type: "text", content: "Analyzing the codebase now." }]);
    render(<ActivityStream />);
    expect(screen.getByText("Analyzing the codebase now.")).toBeInTheDocument();
  });

  it("renders tool call cards", () => {
    setEvents([
      {
        type: "tool_call",
        toolCallId: "tc_001",
        tool: "Read",
        input: { file_path: "/src/index.ts" },
        summary: "Read /src/index.ts",
      },
    ]);
    render(<ActivityStream />);
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Read /src/index.ts")).toBeInTheDocument();
  });

  it("pairs tool calls with results", () => {
    setEvents([
      {
        type: "tool_call",
        toolCallId: "tc_001",
        tool: "Grep",
        input: { pattern: "TODO" },
        summary: "Search for TODO",
      },
      {
        type: "tool_result",
        toolCallId: "tc_001",
        tool: "Grep",
        output: "found 3 matches",
        duration: 120,
      },
    ]);
    render(<ActivityStream />);
    // Duration from result should show on the card
    expect(screen.getByText("120ms")).toBeInTheDocument();
  });

  it("renders status dividers", () => {
    setEvents([{ type: "status", phase: "gathering" }]);
    render(<ActivityStream />);
    expect(screen.getByText("gathering")).toBeInTheDocument();
  });

  it("renders result blocks", () => {
    setEvents([
      { type: "result", content: "Analysis complete.", stopReason: "end_turn" },
    ], "completed");
    render(<ActivityStream />);
    expect(screen.getByText("Analysis complete.")).toBeInTheDocument();
    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("renders error blocks", () => {
    setEvents([{ type: "error", message: "Something went wrong" }]);
    render(<ActivityStream />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders findings blocks", () => {
    setEvents([
      {
        type: "findings",
        summary: "Found 2 issues.",
        findings: [
          {
            category: "Security",
            detail: "No input validation",
            evidence: "auth.ts:7",
            significance: "high" as const,
          },
        ],
      },
    ]);
    render(<ActivityStream />);
    expect(screen.getByText("Research Findings")).toBeInTheDocument();
    expect(screen.getByText("Found 2 issues.")).toBeInTheDocument();
    expect(screen.getByText("No input validation")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
  });

  it("renders reasoning blocks", () => {
    setEvents([
      {
        type: "reasoning",
        action: "Refactor auth module",
        reasoning: "Better separation of concerns.",
        confidence: "high" as const,
      },
    ]);
    render(<ActivityStream />);
    expect(screen.getByText("Refactor auth module")).toBeInTheDocument();
    expect(screen.getByText("Better separation of concerns.")).toBeInTheDocument();
  });

  it("renders decision request cards", () => {
    setEvents([
      {
        type: "decision_request",
        decisionId: "dec_001",
        context: "How to restructure auth?",
        options: [
          {
            id: "a",
            title: "Option A",
            description: "desc",
            pros: [],
            cons: [],
            effort: "low" as const,
            risk: "low" as const,
            recommendation: true,
          },
          {
            id: "b",
            title: "Option B",
            description: "desc",
            pros: [],
            cons: [],
            effort: "low" as const,
            risk: "low" as const,
            recommendation: false,
          },
        ],
      },
    ]);
    render(<ActivityStream />);
    expect(screen.getByText("Decision Needed")).toBeInTheDocument();
    expect(screen.getByText("How to restructure auth?")).toBeInTheDocument();
  });

  it("does not render tool_result events standalone", () => {
    setEvents([
      {
        type: "tool_result",
        toolCallId: "tc_orphan",
        tool: "Read",
        output: "orphan result",
        duration: 10,
      },
    ]);
    render(<ActivityStream />);
    // The standalone result text should NOT appear outside a ToolCallCard
    expect(screen.queryByText("orphan result")).not.toBeInTheDocument();
  });

  it("renders multiple events in order", () => {
    setEvents([
      { type: "status", phase: "gathering" },
      { type: "text", content: "Starting analysis." },
      {
        type: "tool_call",
        toolCallId: "tc_001",
        tool: "Read",
        input: {},
        summary: "Read file",
      },
      { type: "status", phase: "presenting" },
      { type: "result", content: "Done.", stopReason: "end_turn" },
    ], "completed");
    render(<ActivityStream />);
    expect(screen.getByText("Starting analysis.")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });
});
