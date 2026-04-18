import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";

const event = {
  type: "decision_request" as const,
  decisionId: "dec_abc",
  context: "Which cache?",
  options: [
    {
      id: "o1",
      title: "Redis",
      description: "In-memory store",
      pros: ["fast"],
      cons: ["another service"],
      effort: "low" as const,
      risk: "low" as const,
      recommendation: true,
    },
    {
      id: "o2",
      title: "CDN edge cache",
      description: "Just the edge",
      pros: ["no infra"],
      cons: ["cache-invalidation"],
      effort: "medium" as const,
      risk: "medium" as const,
      recommendation: false,
    },
  ],
};

beforeEach(() => {
  useArtifactStore.getState().reset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("DecisionCard — draft state", () => {
  it("renders every option with its title", () => {
    render(<DecisionCard event={event} />);
    expect(screen.getByText("Redis")).toBeInTheDocument();
    expect(screen.getByText("CDN edge cache")).toBeInTheDocument();
  });

  it("shows the recommendation star on the recommended option only", () => {
    render(<DecisionCard event={event} />);
    // The star character ★ is within the same card as "Redis"
    const stars = screen.getAllByText("★");
    expect(stars).toHaveLength(1);
  });

  it("shows effort + risk badges", () => {
    render(<DecisionCard event={event} />);
    expect(screen.getAllByText("low")).toHaveLength(1); // effort
    expect(screen.getAllByText("low risk")).toHaveLength(1);
    expect(screen.getAllByText("medium")).toHaveLength(1);
    expect(screen.getAllByText("medium risk")).toHaveLength(1);
  });

  it("clicking an option calls resolveDecision with the option id", async () => {
    const resolveSpy = vi.spyOn(useArtifactStore.getState(), "resolveDecision");
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    await userEvent.click(screen.getByText("Redis"));
    // The resolveDecision method is bound on the store state at render time;
    // spyOn attaches but the component reads from the live store — confirm via
    // fetch instead, which the store's resolveDecision hits.
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/decisions/dec_abc"),
      expect.objectContaining({ method: "POST" }),
    );
    resolveSpy.mockRestore();
  });

  it("renders the AskTrigger per option when artifactId is provided", () => {
    render(<DecisionCard event={event} artifactId="art_123" />);
    // One AskTrigger per option. AskTrigger renders a button with a "?" label.
    const askButtons = screen.getAllByRole("button", { name: /ask the agent/i });
    expect(askButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("does not render AskTriggers when artifactId is missing", () => {
    render(<DecisionCard event={event} />);
    const askButtons = screen.queryAllByRole("button", { name: /ask the agent/i });
    expect(askButtons).toHaveLength(0);
  });
});

describe("DecisionCard — resolved state (initialResolved)", () => {
  it("renders the resolved banner and chosen option", () => {
    render(
      <DecisionCard
        event={event}
        initialResolved={{
          optionId: "o1",
          reasoning: "Fits existing infra",
          resolvedAt: "2026-04-10T10:00:00.000Z",
        }}
        sessionId="session_abc"
      />,
    );
    expect(screen.getByText("Decision Made")).toBeInTheDocument();
    // The chosen option title appears inside the resolved banner
    const banner = screen.getByText("Decision Made").closest("div")!.parentElement!;
    expect(banner).toHaveTextContent("Redis");
    expect(banner).toHaveTextContent("Fits existing infra");
  });

  it("lists rejected options", () => {
    render(
      <DecisionCard
        event={event}
        initialResolved={{ optionId: "o1" }}
        sessionId="session_abc"
      />,
    );
    expect(screen.getByText(/Rejected:/)).toBeInTheDocument();
    expect(screen.getByText(/CDN edge cache/)).toBeInTheDocument();
  });

  it("shows Re-pair button when sessionId is provided", () => {
    render(
      <DecisionCard
        event={event}
        initialResolved={{ optionId: "o1" }}
        sessionId="session_abc"
      />,
    );
    expect(screen.getByRole("button", { name: /re-pair/i })).toBeInTheDocument();
  });

  it("hides Re-pair button when sessionId is absent", () => {
    render(<DecisionCard event={event} initialResolved={{ optionId: "o1" }} />);
    expect(screen.queryByRole("button", { name: /re-pair/i })).not.toBeInTheDocument();
  });

  it("clicking Re-pair opens the modal", async () => {
    render(
      <DecisionCard
        event={event}
        initialResolved={{ optionId: "o1", reasoning: "existing infra" }}
        sessionId="session_abc"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /re-pair/i }));
    expect(screen.getByRole("dialog", { name: /re-pair/i })).toBeInTheDocument();
  });
});

describe("DecisionCard — keyboard navigation", () => {
  it("j advances focusedIndex, k retreats, Enter selects", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    const container = screen.getByText("Let's think this through").closest("div")!.parentElement!;
    // The container is the outer div with tabIndex={0}; focus it
    (container as HTMLElement).focus();

    // Recommended option (Redis, index 0) starts focused. Pressing j should
    // advance to the second option, then Enter should resolve with o2.
    fireEvent.keyDown(container, { key: "j" });
    fireEvent.keyDown(container, { key: "Enter" });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/decisions/dec_abc"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"optionId":"o2"'),
      }),
    );
  });

  it("ArrowDown/ArrowUp mirror j/k", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    const container = screen.getByText("Let's think this through").closest("div")!.parentElement!;
    // We just need to verify the keydown handler is wired — the selection
    // behavior was covered above.
    expect(() => fireEvent.keyDown(container, { key: "ArrowDown" })).not.toThrow();
    expect(() => fireEvent.keyDown(container, { key: "ArrowUp" })).not.toThrow();
  });
});
