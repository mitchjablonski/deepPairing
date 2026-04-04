import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolCallCard } from "../ToolCallCard";
import type { ToolCallEvent, ToolResultEvent } from "@deeppairing/shared";

const readCall: ToolCallEvent = {
  type: "tool_call",
  toolCallId: "tc_001",
  tool: "Read",
  input: { file_path: "/src/auth.ts", limit: 100 },
  summary: "Read /src/auth.ts (first 100 lines)",
};

const readResult: ToolResultEvent = {
  type: "tool_result",
  toolCallId: "tc_001",
  tool: "Read",
  output: 'export function login() { /* ... */ }',
  duration: 45,
};

const bashCall: ToolCallEvent = {
  type: "tool_call",
  toolCallId: "tc_002",
  tool: "Bash",
  input: { command: "npm test" },
  summary: "Run npm test",
};

const grepCall: ToolCallEvent = {
  type: "tool_call",
  toolCallId: "tc_003",
  tool: "Grep",
  input: { pattern: "TODO", path: "/src" },
  summary: 'Grep for "TODO" in /src',
};

describe("ToolCallCard", () => {
  it("renders the tool name and summary", () => {
    render(<ToolCallCard toolCall={readCall} />);
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Read /src/auth.ts (first 100 lines)")).toBeInTheDocument();
  });

  it("shows duration when tool result is provided", () => {
    render(<ToolCallCard toolCall={readCall} toolResult={readResult} />);
    expect(screen.getByText("45ms")).toBeInTheDocument();
  });

  it("expands to show input/output on click", () => {
    render(<ToolCallCard toolCall={readCall} toolResult={readResult} />);

    // Input should not be visible initially
    expect(screen.queryByText("Input")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText("Read"));

    // Now input and output sections should be visible
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("renders different tool types", () => {
    const { rerender } = render(<ToolCallCard toolCall={bashCall} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();

    rerender(<ToolCallCard toolCall={grepCall} />);
    expect(screen.getByText("Grep")).toBeInTheDocument();
  });

  it("falls back to JSON input when no summary", () => {
    const noSummaryCall: ToolCallEvent = {
      type: "tool_call",
      toolCallId: "tc_004",
      tool: "Read",
      input: { file_path: "/test.ts" },
    };
    render(<ToolCallCard toolCall={noSummaryCall} />);
    expect(screen.getByText(/\/test\.ts/)).toBeInTheDocument();
  });
});
