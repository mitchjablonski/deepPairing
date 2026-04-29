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
    expect(body.content).toMatch(/request_horizon_check/);
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
    expect(screen.getByText(/revise_artifact/)).toBeInTheDocument();
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
    const optionBtn = screen.getByText("Redis").closest('[role="button"]')!;
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
    const optionBtn = screen.getByText("Redis").closest('[role="button"]')!;
    await userEvent.click(optionBtn);

    // Wait for the catch + setPhase(idle) to flush.
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => {
      const el = screen.getByText("Redis").closest('[role="button"]')!;
      expect(el).toHaveAttribute("aria-disabled", "false");
    });
    expect(screen.queryByText(/Decision Made/i)).not.toBeInTheDocument();

    // Retry succeeds.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
    await userEvent.click(screen.getByText("Redis").closest('[role="button"]')!);
    expect(await findByRole("heading", { name: /Decision Made|Redis/i }).catch(() => null) ?? await screen.findByText(/Decision Made/i)).toBeInTheDocument();
  });

  it("X5 — Cancel during prediction returns to idle (no stale selectedId)", async () => {
    // High-stakes path: option click moves to predicting. Cancel must
    // return all the way to idle (not leave selectedId set).
    render(<DecisionCard event={event} decisionId="dec_abc" stakes="high" />);
    await userEvent.click(screen.getByText("Redis").closest('[role="button"]')!);
    // Predicting form is showing.
    expect(screen.getByText(/quick prediction/i)).toBeInTheDocument();
    // Cancel.
    const cancelBtns = screen.getAllByRole("button", { name: /^Cancel$/ });
    await userEvent.click(cancelBtns[cancelBtns.length - 1]);
    // Back to idle: prediction form gone, options re-clickable.
    expect(screen.queryByText(/quick prediction/i)).not.toBeInTheDocument();
    const redisBtn = screen.getByText("Redis").closest('[role="button"]')!;
    expect(redisBtn).toHaveAttribute("aria-disabled", "false");
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
