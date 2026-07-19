import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCard } from "../DecisionCard";
import { useArtifactStore } from "../../stores/artifact";
import { useLedgerStore, resetLedgerStoreForTests } from "../../stores/ledger";

// DV1 — stub Mermaid so the diagram disclosure test is deterministic (no async
// mermaid render in jsdom). VisualBody's diagram branch renders this.
vi.mock("../MermaidDiagram", () => ({
  MermaidDiagram: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));

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

describe("DecisionCard — resolved options disclosure", () => {
  it("reveals each option's full detail in place via Show options (no re-pair needed)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} decisionId="dec_abc" initialResolved={{ optionId: "o1" }} />);
    // Collapsed by default: a rejected option's description is not shown.
    expect(screen.queryByText("Just the edge")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /show options/i }));
    // Expanded: both options' full detail render in place, read-only.
    expect(screen.getByText("In-memory store")).toBeInTheDocument(); // chosen
    expect(screen.getByText("Just the edge")).toBeInTheDocument(); // rejected
    expect(screen.getByText("✓ Chosen")).toBeInTheDocument();
    expect(screen.getByText("Not chosen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hide options/i })).toBeInTheDocument();
  });
});

describe("DecisionCard — tolerates options missing pros/cons", () => {
  it("renders an option whose pros/cons arrays are absent without crashing", () => {
    // content is cast unchecked in ArtifactPanel, so a partial/hand-edited
    // decision can omit pros/cons. Unguarded option.pros.length threw and took
    // the whole panel down.
    const malformed = {
      type: "decision_request" as const,
      decisionId: "dec_x",
      context: "Which?",
      options: [
        { id: "o1", title: "Option A", description: "no pros/cons here", effort: "low", risk: "low", recommendation: true },
      ],
    } as any;
    expect(() => render(<DecisionCard event={malformed} decisionId="dec_x" />)).not.toThrow();
    expect(screen.getByText("Option A")).toBeInTheDocument();
  });
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
    // D3 — selection moved to the explicit per-option button.
    await userEvent.click(screen.getByRole("button", { name: "Select Redis" }));
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

  // X11 — affordance hierarchy. The recommendation should be visually
  // unmistakable (not just a star), and the escape hatches (reasoning,
  // send-back) should sit in a single tertiary footer row instead of
  // two stacked bordered blocks competing with the option grid.
  it("X11: recommended option carries a 'Recommended' pill, not just a star", () => {
    render(<DecisionCard event={event} />);
    expect(screen.getByText(/Recommended/)).toBeInTheDocument();
    // Star is still in the DOM (inside the pill) — keeps the keyboard
    // affordance for users who learned it pre-X11.
    expect(screen.getAllByText("★")).toHaveLength(1);
  });

  it("X11: escape hatches collapse into one tertiary row by default", () => {
    render(<DecisionCard event={event} artifactId="art_x11" />);
    // Both triggers exist as muted text links.
    expect(
      screen.getByRole("button", { name: /\+ Add reasoning/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send decision back/i }),
    ).toBeInTheDocument();
    // Neither composer is open before the user reaches for them.
    expect(screen.queryByPlaceholderText(/Why — becomes the/i)).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/all 4 are matchers/i),
    ).not.toBeInTheDocument();
  });

  it("X11: opening 'Add reasoning' closes 'Send back' (mutually exclusive)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} artifactId="art_x11" />);
    await user.click(screen.getByRole("button", { name: /send decision back/i }));
    expect(
      screen.getByPlaceholderText(/all 4 are matchers/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /\+ Add reasoning/i }));
    // Send-back composer is gone; reasoning input is up.
    expect(
      screen.queryByPlaceholderText(/all 4 are matchers/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Why — becomes the/i),
    ).toBeInTheDocument();
  });

  it("X11: opening 'Send back' closes 'Add reasoning' (mutually exclusive)", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={event} artifactId="art_x11" />);
    await user.click(screen.getByRole("button", { name: /\+ Add reasoning/i }));
    expect(
      screen.getByPlaceholderText(/Why — becomes the/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /send decision back/i }));
    expect(
      screen.queryByPlaceholderText(/Why — becomes the/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/all 4 are matchers/i),
    ).toBeInTheDocument();
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

describe("DecisionCard — horizon check trigger (Q3)", () => {
  it("does NOT render the horizon-check buttons on non-high-stakes decisions", () => {
    render(
      <DecisionCard
        event={event}
        artifactId="art_1"
        initialResolved={{ optionId: "o1" }}
      />,
    );
    expect(screen.queryByRole("button", { name: /request horizon check/i })).not.toBeInTheDocument();
  });

  it("renders 3mo / 1y / 2y buttons on high-stakes decisions", () => {
    render(
      <DecisionCard
        event={event}
        artifactId="art_1"
        stakes="high"
        initialResolved={{ optionId: "o1" }}
      />,
    );
    expect(screen.getByRole("button", { name: /request horizon check at 3mo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request horizon check at 1y/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request horizon check at 2y/i })).toBeInTheDocument();
  });

  it("POSTs a question-intent comment with the horizon sectionId when clicked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DecisionCard
        event={event}
        artifactId="art_1"
        stakes="high"
        initialResolved={{ optionId: "o1" }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /request horizon check at 1y/i }));

    const call = fetchMock.mock.calls.find((c: any[]) =>
      String(c[0]).includes("/api/comments") ||
      (c[1]?.body && String(c[1].body).includes("artifactId"))
    );
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body);
    expect(body.artifactId).toBe("art_1");
    expect(body.intent).toBe("question");
    expect(body.target?.sectionId).toBe("horizon_check:request:1y");
    // III12 — asks for a horizon prediction the agent ANSWERS directly; it must
    // NOT tell the agent to call the removed `request_horizon_check` tool.
    expect(body.content).toMatch(/1y out/);
    expect(body.content).not.toMatch(/request_horizon_check/);
  });

  it("replaces the buttons with an 'Asked' confirmation after click (prevents double-fire)", async () => {
    render(
      <DecisionCard
        event={event}
        artifactId="art_1"
        stakes="high"
        initialResolved={{ optionId: "o1" }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /request horizon check at 3mo/i }));
    expect(screen.queryByRole("button", { name: /request horizon check/i })).not.toBeInTheDocument();
    expect(screen.getByText(/✓ Asked \(3mo\)/)).toBeInTheDocument();
  });

  it("U2 — rolls back to the buttons (not a stuck '✓ Asked') when the POST fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    render(
      <DecisionCard event={event} artifactId="art_1" stakes="high" initialResolved={{ optionId: "o1" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /request horizon check at 1y/i }));
    // optimistic "Asked" must roll back so the human can retry
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /request horizon check at 1y/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText(/✓ Asked/)).not.toBeInTheDocument();
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

  it("FF9 — high-stakes Enter-select honors the prediction opt-in (no stale keydown closure)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);
    render(<DecisionCard event={event} decisionId="dec_abc" stakes="high" artifactId="art_x" />);

    // Opt in to prediction capture (this is what the stale closure missed).
    await user.click(screen.getByRole("button", { name: /capture prediction with my pick/i }));

    // Select via the container's NATIVE Enter handler (not a card click).
    const container = screen.getByText("Let's think this through").closest("div")!.parentElement!;
    (container as HTMLElement).focus();
    fireEvent.keyDown(container, { key: "Enter" });

    // Must enter the prediction-capture phase, NOT resolve immediately.
    expect(screen.getByText(/quick prediction/i)).toBeInTheDocument();
    const resolveCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes("/api/decisions"));
    expect(resolveCalls).toHaveLength(0);
  });

  it("ArrowDown/ArrowUp mirror j/k", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    const container = screen.getByText("Let's think this through").closest("div")!.parentElement!;
    // We just need to verify the keydown handler is wired — the selection
    // behavior was covered above.
    expect(() => fireEvent.keyDown(container, { key: "ArrowDown" })).not.toThrow();
    expect(() => fireEvent.keyDown(container, { key: "ArrowUp" })).not.toThrow();
  });

  it("U4 — focusing an option (Tab) syncs the highlight so the container's Enter selects THAT option", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    // o1 (Redis) is the recommended default at focusedIndex 0. Tab DOM-focus
    // now lands on the option's Select button (D3) — pre-fix the j/k highlight
    // stayed on o1, so Enter selected o1.
    const opt2 = screen.getByRole("button", { name: "Select CDN edge cache" });
    fireEvent.focus(opt2);
    const container = screen.getByText("Let's think this through").closest("div")!.parentElement!;
    fireEvent.keyDown(container, { key: "Enter" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/decisions/dec_abc"),
      expect.objectContaining({ body: expect.stringContaining('"optionId":"o2"') }),
    );
  });

  it("D3 (was U5e) — each option exposes a distinctly-named real Select button; the roving highlight styles the focused one", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    // The AT affordance is now a REAL button per option with a distinct
    // accessible name (aria-current on a role-less div was the old signal;
    // the nested-interactive violation is gone with the role).
    const b1 = screen.getByRole("button", { name: "Select Redis" });
    const b2 = screen.getByRole("button", { name: "Select CDN edge cache" });
    // o1 (Redis) is the recommended default → focusedIndex 0 → filled style.
    expect(b1.className).toContain("bg-accent-blue-strong text-white");
    expect(b2.className).toContain("bg-surface-secondary");
  });

  it("UX2 — a draft decision auto-focuses + stops j from bubbling to the global handler", () => {
    const { container } = render(<DecisionCard event={event} decisionId="dec_abc" />);
    const card = container.firstElementChild as HTMLElement;
    // auto-focused so its ↑↓/Enter nav is live without a Tab first
    expect(card.contains(document.activeElement)).toBe(true);
    // j is handled + stopPropagation'd → a document-level listener (App's global
    // nav) does not also receive it
    const docSpy = vi.fn();
    document.addEventListener("keydown", docSpy);
    fireEvent.keyDown(card, { key: "j" });
    document.removeEventListener("keydown", docSpy);
    expect(docSpy).not.toHaveBeenCalled();
  });

  it("F8 (M4) — the approve shortcut ARMS a confirm, then commits when it runs out (was: one keystroke = irreversible)", () => {
    vi.useFakeTimers();
    try {
      render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_x" />);
      fireEvent(window, new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "art_x", action: "approve" } }));
      // Armed, not committed.
      expect(screen.getByText(/will select/i)).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/decisions/dec_abc"),
        expect.anything(),
      );
      // Each tick schedules the NEXT timeout from an effect — one act per hop.
      for (let i = 0; i < 4; i++) act(() => { vi.advanceTimersByTime(1100); });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/decisions/dec_abc"),
        expect.objectContaining({ body: expect.stringContaining('"optionId":"o1"') }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("F8 (M4) — Escape disarms the pending select", () => {
    vi.useFakeTimers();
    try {
      render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_x" />);
      fireEvent(window, new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "art_x", action: "approve" } }));
      expect(screen.getByText(/will select/i)).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByText(/will select/i)).toBeNull();
      for (let i = 0; i < 5; i++) act(() => { vi.advanceTimersByTime(1100); });
      expect(fetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/decisions/dec_abc"),
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("UX6 — the global revise shortcut opens the send-back composer on a decision", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_x" />);
    expect(screen.queryByPlaceholderText(/all 4 are matchers/i)).not.toBeInTheDocument();
    fireEvent(window, new CustomEvent("dp:artifact-shortcut", { detail: { artifactId: "art_x", action: "revise" } }));
    expect(screen.getByPlaceholderText(/all 4 are matchers/i)).toBeInTheDocument();
  });
});

describe("DecisionCard — hard reject the framing (#169 F1/F2)", () => {
  it("shows the reject trigger only with an artifactId", () => {
    const { rerender } = render(<DecisionCard event={event} decisionId="dec_abc" />);
    expect(screen.queryByRole("button", { name: /reject this framing/i })).not.toBeInTheDocument();
    rerender(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    expect(screen.getByRole("button", { name: /reject this framing/i })).toBeInTheDocument();
  });

  it("POSTs status:'rejected' with the reason + named concept to /api/artifacts/:id/status", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /reject this framing/i }));
    await userEvent.type(
      screen.getByPlaceholderText(/we don't need a cache at all/i),
      "wrong question — measure first",
    );
    await userEvent.type(
      screen.getByLabelText(/name the pattern you're rejecting/i),
      "premature caching",
    );
    await userEvent.click(screen.getByRole("button", { name: /reject & remember/i }));

    const statusCall = (fetch as any).mock.calls.find(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("/api/artifacts/art_dec/status"),
    );
    expect(statusCall).toBeTruthy();
    const body = JSON.parse(statusCall[1].body);
    expect(body.status).toBe("rejected");
    expect(body.feedback).toContain("wrong question");
    expect(body.concept).toBe("premature caching");
  });

  it("after reject, shows the confirmation and hides the composer", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /reject this framing/i }));
    await userEvent.type(screen.getByPlaceholderText(/we don't need a cache at all/i), "no caching here");
    await userEvent.click(screen.getByRole("button", { name: /reject & remember/i }));

    expect(screen.getByText(/you rejected this framing/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/we don't need a cache at all/i)).not.toBeInTheDocument();
  });

  it("reject confirm is disabled until a reason is typed", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /reject this framing/i }));
    expect(screen.getByRole("button", { name: /reject & remember/i })).toBeDisabled();
  });
});

describe("DecisionCard — Send back for revision (Fix B)", () => {
  // Field bug: a human commented on the overall decision; the agent thought
  // about it (visible in the chat) but didn't post back to the UI, AND the
  // decision stayed pending with no clear "I want a revised option set"
  // signal. This affordance + the firstCallHint surfacing close that loop.

  it("does NOT show the Send-back button when artifactId is missing (no anchor)", () => {
    // The button needs an artifactId to attach the comment to. Without
    // one, no affordance.
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    expect(screen.queryByRole("button", { name: /send decision back for revised options/i })).not.toBeInTheDocument();
  });

  it("shows the Send-back button when artifactId is present", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    expect(screen.getByRole("button", { name: /send decision back for revised options/i })).toBeInTheDocument();
  });

  it("opens an inline form on click and Cancel returns to the trigger", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    expect(screen.getByPlaceholderText(/all 4 are matchers/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // Trigger button is back.
    expect(screen.getByRole("button", { name: /send decision back for revised options/i })).toBeInTheDocument();
  });

  it("submits a question-intent comment tagged decision_revision_requested", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    await userEvent.type(
      screen.getByPlaceholderText(/all 4 are matchers/i),
      "all four are matchers — what about a hybrid?",
    );
    // Click the explicit submit button (the trigger button text starts the
    // same way — disambiguate by exact name).
    await userEvent.click(screen.getByRole("button", { name: /^↻ Send back for revision$/ }));

    const calls = (fetch as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[0][1].body);
    expect(body.artifactId).toBe("art_dec");
    expect(body.content).toContain("hybrid");
    expect(body.intent).toBe("question");
    expect(body.target.sectionId).toBe("decision_revision_requested");
  });

  it("after submit, shows the awaiting-revision indicator and hides the form", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    await userEvent.type(screen.getByPlaceholderText(/all 4 are matchers/i), "redo this");
    await userEvent.click(screen.getByRole("button", { name: /^↻ Send back for revision$/ }));

    expect(screen.getByText(/Revision requested/)).toBeInTheDocument();
    expect(screen.getByText(/the agent will post a revised set of options/i)).toBeInTheDocument();
    // Form is gone.
    expect(screen.queryByPlaceholderText(/all 4 are matchers/i)).not.toBeInTheDocument();
  });

  it("does NOT submit when the textarea is empty (button is disabled)", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    const submit = screen.getByRole("button", { name: /^↻ Send back for revision$/ });
    expect(submit).toBeDisabled();
  });

  it("Esc inside the textarea cancels and clears the draft", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    const textarea = screen.getByPlaceholderText(/all 4 are matchers/i);
    await userEvent.type(textarea, "draft text{Escape}");
    // Form gone, trigger button is back, draft is not retained.
    expect(screen.queryByPlaceholderText(/all 4 are matchers/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    expect((screen.getByPlaceholderText(/all 4 are matchers/i) as HTMLTextAreaElement).value).toBe("");
  });

  it("X5 — rapid double-click on an option fires only ONE POST (sync race-guard)", async () => {
    // Pre-X5: handleSelect → setSubmitting(true) → POST. The setSubmitting
    // call is async (React state batching), so a second rapid click could
    // see submitting=false and fire a duplicate POST. The inFlightRef
    // mirrors submission state synchronously — second tap short-circuits.
    let resolveFetch: (v: any) => void = () => {};
    const fetchPromise = new Promise((r) => { resolveFetch = r; });
    const fetchMock = vi.fn().mockImplementation(() => fetchPromise);
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionCard event={event} decisionId="dec_abc" />);
    const optionBtn = screen.getByRole("button", { name: "Select Redis" });
    // Fire two clicks back-to-back, before the first POST resolves.
    await userEvent.click(optionBtn);
    await userEvent.click(optionBtn);
    // The race guard should have caught the second one — fetch fires once.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Resolve so the test cleans up.
    resolveFetch({ ok: true, json: async () => ({}) });
  });

  it("X5 — network error rolls phase back to idle so the user can retry", async () => {
    // Pre-X5: a failed POST left selectedId reset but submitting=false,
    // so the user could retry but the UI flickered through inconsistent
    // states. Now phase rolls cleanly to idle, observable via the
    // option's aria-disabled returning to "false".
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const { findByRole } = render(<DecisionCard event={event} decisionId="dec_abc" />);
    const optionBtn = screen.getByRole("button", { name: "Select Redis" });
    await userEvent.click(optionBtn);

    // Wait for the catch + setPhase(idle) to flush.
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => {
      // D3 — native button: real disabled attribute, not aria-disabled.
      const el = screen.getByRole("button", { name: "Select Redis" });
      expect(el).toBeEnabled();
    });
    expect(screen.queryByText(/Decision Made/i)).not.toBeInTheDocument();

    // Retry succeeds.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
    await userEvent.click(screen.getByRole("button", { name: "Select Redis" }));
    expect(await findByRole("heading", { name: /Decision Made|Redis/i }).catch(() => null) ?? await screen.findByText(/Decision Made/i)).toBeInTheDocument();
  });

  it("X5 — Cancel during prediction returns to idle (no stale selectedId)", async () => {
    // High-stakes path with FF9 opt-in: enable prediction capture
    // explicitly, then option click moves to predicting. Cancel must
    // return all the way to idle (not leave selectedId set).
    render(<DecisionCard event={event} decisionId="dec_abc" stakes="high" />);
    // FF9 — opt in to prediction capture before clicking the option.
    await userEvent.click(screen.getByRole("button", { name: /capture prediction/i }));
    await userEvent.click(screen.getByRole("button", { name: "Select Redis" }));
    // Predicting form is showing.
    expect(screen.getByText(/quick prediction/i)).toBeInTheDocument();
    // Cancel.
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/ });
    await userEvent.click(cancelBtns[cancelBtns.length - 1]!);
    // Back to idle: prediction form gone, options re-clickable.
    expect(screen.queryByText(/quick prediction/i)).not.toBeInTheDocument();
    const redisBtn = screen.getByRole("button", { name: "Select Redis" });
    expect(redisBtn).toBeEnabled();
  });

  it("FF9 — high-stakes pick WITHOUT opting in submits directly (no prediction modal)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DecisionCard event={event} decisionId="dec_abc" stakes="high" />);
    // No opt-in click. Pick directly.
    await userEvent.click(screen.getByRole("button", { name: "Select Redis" }));
    // Pre-FF9 this would have entered the predicting modal. Now it
    // submits straight through.
    expect(screen.queryByText(/quick prediction/i)).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("/api/decisions"));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Body has no prediction payload.
    const body = JSON.parse(calls[0]![1]!.body as string);
    expect(body.predictedOutcome).toBeUndefined();
    expect(body.confidence).toBeUndefined();
  });

  it("FF9 — high-stakes pick WITH opting in enters predicting + submits prediction payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DecisionCard event={event} decisionId="dec_abc" stakes="high" />);
    await userEvent.click(screen.getByRole("button", { name: /capture prediction/i }));
    await userEvent.click(screen.getByRole("button", { name: "Select Redis" }));
    expect(screen.getByText(/quick prediction/i)).toBeInTheDocument();
    // Fill prediction and confirm.
    await userEvent.type(screen.getByPlaceholderText(/cache hit rate/i), "smooth rollout");
    const confirmBtn = await screen.findByRole("button", { name: /commit with prediction/i });
    await userEvent.click(confirmBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("/api/decisions"));
    const body = JSON.parse(calls[calls.length - 1]![1]!.body as string);
    expect(body.predictedOutcome).toBe("smooth rollout");
  });

  it("FF9 — toggle button is HIDDEN on non-high-stakes decisions", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" stakes="medium" />);
    expect(screen.queryByRole("button", { name: /capture prediction/i })).toBeNull();
  });

  it("X5 — sendBack rapid double-submit fires only ONE comment POST", async () => {
    let resolveFetch: (v: any) => void = () => {};
    const fetchPromise = new Promise((r) => { resolveFetch = r; });
    const fetchMock = vi.fn().mockImplementation(() => fetchPromise);
    vi.stubGlobal("fetch", fetchMock);

    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    await userEvent.type(screen.getByPlaceholderText(/all 4 are matchers/i), "redo this");
    const submit = screen.getByRole("button", { name: /^↻ Send back for revision$/ });
    await userEvent.click(submit);
    await userEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: async () => ({}) });
  });

  it("does NOT swallow j/k keystrokes typed into the send-back textarea (regression)", async () => {
    // Field bug: the option-navigation handler was attached to the card
    // container, and j/k keystrokes from nested inputs bubbled up and got
    // preventDefault'd. The user couldn't type "k" or "j" in the
    // composer. Pin that the editable-element guard now skips the
    // navigation handler entirely when focus is on a textarea.
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_dec" />);
    await userEvent.click(screen.getByRole("button", { name: /send decision back for revised options/i }));
    const textarea = screen.getByPlaceholderText(/all 4 are matchers/i) as HTMLTextAreaElement;
    // Type a string that contains both j and k. Pre-fix the j/k characters
    // would be eaten and the value would be a subset of the typed string.
    await userEvent.type(textarea, "knock knock — just checking");
    expect(textarea.value).toBe("knock knock — just checking");
  });
});

describe("DV1 — decision-level 'Compare diagrams' bar", () => {
  const eventWithDiagram = {
    ...event,
    options: [
      {
        ...event.options[0]!,
        visuals: [{ id: "o1_v0", kind: "diagram" as const, source: "graph TD; A-->B", title: "Redis topology" }],
      },
      event.options[1]!, // no visuals
    ],
  };

  it("shows diagrams BY DEFAULT; the bar toggles them off and back on", async () => {
    const user = userEvent.setup();
    render(<DecisionCard event={eventWithDiagram} decisionId="dec_abc" />);
    expect(screen.getByTestId("mermaid")).toBeInTheDocument(); // shown by default
    expect(screen.getByText("Redis topology")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /hide diagrams/i }));
    expect(screen.queryByTestId("mermaid")).not.toBeInTheDocument(); // collapsed
    await user.click(screen.getByRole("button", { name: /compare diagrams/i }));
    expect(screen.getByTestId("mermaid")).toBeInTheDocument(); // back
  });

  it("shows the bar when ANY option has a visual; omits it when none do", () => {
    const { unmount } = render(<DecisionCard event={eventWithDiagram} decisionId="dec_abc" />);
    expect(screen.getByRole("button", { name: /hide diagrams|compare diagrams/i })).toBeInTheDocument();
    unmount();
    render(<DecisionCard event={event} decisionId="dec_abc" />); // no visuals
    expect(screen.queryByRole("button", { name: /hide diagrams|compare diagrams/i })).not.toBeInTheDocument();
  });

  const resolveCalls = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.filter(([url]) => String(url).includes("/api/decisions"));

  it("the bar lives OUTSIDE the option cards — toggling never resolves the decision (mouse + keyboard)", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);
    render(<DecisionCard event={eventWithDiagram} decisionId="dec_abc" />);

    // Mouse: collapse via the default "Hide diagrams" bar.
    await user.click(screen.getByRole("button", { name: /hide diagrams/i }));
    expect(resolveCalls(fetchSpy)).toHaveLength(0);

    // Keyboard: Enter on the (now "Compare diagrams") bar re-expands, doesn't
    // resolve. (Regression: the card's native keydown Enter → handleSelect fired
    // before React's synthetic stopPropagation; the bail-on-nested-button guard
    // covers this bar.)
    const bar = screen.getByRole("button", { name: /compare diagrams/i });
    bar.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("mermaid")).toBeInTheDocument();
    expect(resolveCalls(fetchSpy)).toHaveLength(0);
  });

  it("a per-option PROTOTYPE is runnable in the live decision view (Run affordance, not the static placeholder)", () => {
    // Field bug: a per-option prototype passed readOnly (to turn off
    // comment-anchoring) and that wrongly forced the static "open the live
    // version to run it" placeholder even in a LIVE session. It must RUN.
    const eventWithPrototype = {
      ...event,
      options: [
        {
          ...event.options[0]!,
          visuals: [{ id: "o1_proto", kind: "prototype" as const, title: "Redis mock", html: "<button>ping</button>" }],
        },
        event.options[1]!,
      ],
    };
    render(<DecisionCard event={eventWithPrototype} decisionId="dec_abc" />);
    expect(screen.getByRole("button", { name: /run prototype/i })).toBeInTheDocument();
    expect(screen.queryByText(/open the live version to run it/i)).not.toBeInTheDocument();
  });
});

describe("B4 review — Enter on a nested concept badge must not resolve the decision", () => {
  it("expands the badge instead of submitting (the option onKeyDown bails on BUTTON targets)", async () => {
    resetLedgerStoreForTests();
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);
    // Ledger knows the concept → the badge is expandable even without an explanation.
    useLedgerStore.setState({
      digest: {
        shapedThisProject: 0, nearMissesThisProject: 0, blockedThisProject: 0, sessionsTouched: 1,
        topCitedStances: [], seededStances: [{ concept: "external cache service", stance: "avoid", citedTimesElsewhere: 2 }],
        globalLedger: { concepts: 1, projects: 1, multiProjectConcepts: 0 },
      } as any,
    });
    const eventWithConcept = {
      ...event,
      options: [
        { ...event.options[0]!, concept: { name: "external cache service" } },
        event.options[1]!,
      ],
    };
    render(<DecisionCard event={eventWithConcept} decisionId="dec_abc" />);

    // Keydown path: Enter on the focused badge must NOT reach the option's
    // Enter→handleSelect (pre-fix this POSTed /api/decisions and suppressed the
    // badge's native Enter→click via the card's preventDefault).
    const badge = screen.getByRole("button", { name: /Concept: external cache service/i });
    badge.focus();
    fireEvent.keyDown(badge, { key: "Enter" });
    const resolveCalls = fetchSpy.mock.calls.filter(([u]) => String(u).includes("/api/decisions"));
    expect(resolveCalls).toHaveLength(0);

    // The badge still expands (click path — what a real browser's Enter→click
    // synthesis lands on) with the deep-link visible.
    await user.click(badge);
    expect(screen.getByRole("button", { name: /^view in your ledger/i })).toBeInTheDocument();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("/api/decisions"))).toHaveLength(0);
  });
});

describe("C2 — decision consumption receipt", () => {
  it("resolved card shows 'Delivered' until the agent acks, then '✓ Claude picked this up'", () => {
    render(
      <DecisionCard
        event={event}
        decisionId="dec_abc"
        initialResolved={{ optionId: event.options[0]!.id }}
      />,
    );
    expect(screen.getByText(/delivered — claude will pick it up/i)).toBeInTheDocument();

    act(() => {
      useArtifactStore.getState().markDecisionsAcknowledged(["dec_abc"]);
    });
    expect(screen.getByText(/claude picked this up — proceeding with/i)).toBeInTheDocument();
    expect(screen.queryByText(/delivered — claude will pick it up/i)).not.toBeInTheDocument();
  });
});

describe("D3 review — keyboard nav from a focused Select button", () => {
  it("j on a focused Select button moves highlight AND focus; Enter then selects the highlighted option", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DecisionCard event={event} decisionId="dec_abc" />);

    const b1 = screen.getByRole("button", { name: "Select Redis" });
    b1.focus();
    // Pre-fix: the blanket BUTTON guard returned, and App's global j
    // navigated AWAY from the decision mid-choice.
    fireEvent.keyDown(b1, { key: "j" });
    const b2 = screen.getByRole("button", { name: "Select CDN edge cache" });
    // DOM focus followed the highlight — without this, Enter would fire the
    // STALE button's native click (wrong-selection hazard).
    expect(document.activeElement).toBe(b2);

    fireEvent.keyDown(b2, { key: "Enter" });
    // Native activation path: the container guard returns for Enter on a
    // button; jsdom doesn't synthesize click from keydown, so simulate it.
    fireEvent.click(b2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/decisions/dec_abc"),
      expect.objectContaining({ body: expect.stringContaining('"optionId":"o2"') }),
    );
  });

  it("j on an AskTrigger button does NOT hijack the option highlight (pass-through scoped to Select buttons)", () => {
    render(<DecisionCard event={event} decisionId="dec_abc" artifactId="art_1" />);
    const ask = screen.getAllByRole("button", { name: /ask/i })[0]!;
    ask.focus();
    fireEvent.keyDown(ask, { key: "j" });
    // Focus stayed on the AskTrigger — the nav pass-through is data-select-option
    // only, so non-Select buttons keep their pre-existing behavior (the
    // wrapper's own stopPropagation, unchanged by D3).
    expect(document.activeElement).toBe(ask);
  });
});

describe("F3 decomp — pins for the extracted seams (review NITs)", () => {
  it("resolved view renders the Predicted block when initialResolved carries a prediction", () => {
    render(
      <DecisionCard
        event={event}
        decisionId="dec_abc"
        initialResolved={{ optionId: "o1", predictedOutcome: "cuts p95 in half", confidence: "high" }}
      />,
    );
    expect(screen.getByText(/predicted/i)).toBeInTheDocument();
    expect(screen.getByText(/cuts p95 in half/)).toBeInTheDocument();
  });

  it("reasoning-Enter commits the focused option with the trimmed reasoning (the onSelect substitution seam)", async () => {
    render(<DecisionCard event={event} decisionId="dec_abc" />);
    fireEvent.click(screen.getByText(/add reasoning/i));
    const input = screen.getByPlaceholderText(/becomes the 'don't propose these' reason/i);
    fireEvent.change(input, { target: { value: "  matcher-first fits the grammar  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/decisions/dec_abc"),
        expect.objectContaining({ body: expect.stringContaining('"reasoning":"matcher-first fits the grammar"') }),
      ),
    );
  });
});
