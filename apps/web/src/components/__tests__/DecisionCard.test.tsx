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

  it("shows Recommended badge on recommended option", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });

  it("shows pros and cons", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText(/Clean separation/)).toBeInTheDocument();
    expect(screen.getByText(/More files/)).toBeInTheDocument();
  });

  it("shows effort and risk badges", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("medium effort")).toBeInTheDocument();
    expect(screen.getAllByText("low risk")).toHaveLength(2);
  });

  it("shows Select button after clicking an option", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);

    // Click on the first option
    fireEvent.click(screen.getByText("Extract to Service"));

    // Select button should appear
    expect(screen.getByText("Select")).toBeInTheDocument();
  });

  it("shows reasoning input after clicking an option", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);

    fireEvent.click(screen.getByText("Refactor In-Place"));

    expect(screen.getByPlaceholderText("Why? (optional)")).toBeInTheDocument();
  });

  it("calls API on submit and shows resolved state", async () => {
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

    // Click option
    fireEvent.click(screen.getByText("Extract to Service"));

    // Click select
    fireEvent.click(screen.getByText("Select"));

    // Wait for the fetch to complete
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/decisions/dec_001"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    // Should show resolved state
    await vi.waitFor(() => {
      expect(screen.getByText("Decision Made")).toBeInTheDocument();
    });

    expect(onResolved).toHaveBeenCalled();
  });

  it("shows Decision Needed indicator with pulse", () => {
    render(<DecisionCard event={decisionEvent} sessionId="sess_1" />);
    expect(screen.getByText("Decision Needed")).toBeInTheDocument();
  });
});
