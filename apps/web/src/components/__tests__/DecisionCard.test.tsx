import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DecisionCard } from "../DecisionCard";
import type { DecisionRequestEvent } from "@deeppairing/shared";

const decisionEvent: DecisionRequestEvent = {
  type: "decision_request",
  decisionId: "dec_001",
  context: "How should we restructure authentication?",
  options: [
    {
      id: "opt_a",
      title: "Extract to Service",
      description: "Move logic to a service layer.",
      pros: ["Clean separation", "Testable"],
      cons: ["More files"],
      effort: "medium",
      risk: "low",
      recommendation: true,
    },
    {
      id: "opt_b",
      title: "Refactor In-Place",
      description: "Clean up the existing code.",
      pros: ["Quick"],
      cons: ["Still messy"],
      effort: "low",
      risk: "low",
      recommendation: false,
    },
  ],
};

describe("DecisionCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the decision context", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(
      screen.getByText("How should we restructure authentication?"),
    ).toBeInTheDocument();
  });

  it("renders all options", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("Extract to Service")).toBeInTheDocument();
    expect(screen.getByText("Refactor In-Place")).toBeInTheDocument();
  });

  it("shows recommended badge", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("★")).toBeInTheDocument();
  });

  it("shows pros and cons with checkmarks", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("Clean separation")).toBeInTheDocument();
    expect(screen.getByText("More files")).toBeInTheDocument();
  });

  it("shows effort and risk badges", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getAllByText("low risk").length).toBeGreaterThan(0);
  });

  it("single-click selects and submits immediately", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "resolved" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const onResolved = vi.fn();
    render(
      <DecisionCard
        event={decisionEvent}
        sessionId="sess_1"
        onResolved={onResolved}
      />,
    );

    // Single click on option — immediately submits
    fireEvent.click(screen.getByText("Extract to Service"));

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/decisions/dec_001"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Decision Made")).toBeInTheDocument();
    });

    expect(onResolved).toHaveBeenCalled();
  });

  it("shows optional reasoning link", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("+ Add reasoning (optional)")).toBeInTheDocument();
  });

  it("expands reasoning input on click", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    fireEvent.click(screen.getByText("+ Add reasoning (optional)"));
    expect(screen.getByPlaceholderText("Why this choice?")).toBeInTheDocument();
  });

  it("shows Decision Needed with keyboard hint", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("Decision Needed")).toBeInTheDocument();
    expect(screen.getByText(/navigate/)).toBeInTheDocument();
  });
});
