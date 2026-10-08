import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDecisionsModal } from "../ProjectDecisionsModal";
import { openSessionReplay, type SessionReplayResult } from "../../lib/session-replay";

// The navigation scheme is exercised by its own module; here we assert the
// modal CALLS it with the right target (and closes) — a fake, not a mock of fetch.
vi.mock("../../lib/session-replay", () => ({
  openSessionReplay: vi.fn().mockResolvedValue({ status: "opened" }),
}));

const RESOLVED = {
  decisionId: "d1",
  sessionId: "s1",
  sessionTitle: "Cache work",
  artifactId: "a1",
  artifactTitle: "Which cache?",
  artifactMissing: false,
  context: "Which cache should we use?",
  stakes: "high" as const,
  optionCount: 2,
  resolved: true,
  chosenOptionId: "o1",
  chosenOptionTitle: "Redis",
  reasoning: "lowest latency",
  createdAt: "2026-07-01T10:00:00Z",
  resolvedAt: "2026-07-01T11:00:00Z",
};
const UNRESOLVED = {
  decisionId: "d2",
  sessionId: "s2",
  sessionTitle: "Queue work",
  artifactId: "a2",
  artifactTitle: "Which queue?",
  artifactMissing: false,
  context: "Which queue should we use?",
  optionCount: 2,
  resolved: false,
  createdAt: "2026-07-02T10:00:00Z",
};

function stubDecisions(payload: { decisions: unknown[]; failedSessions: unknown[] }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => payload }));
}

beforeEach(() => {
  vi.mocked(openSessionReplay).mockReset();
  vi.mocked(openSessionReplay).mockResolvedValue({ status: "opened" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProjectDecisionsModal", () => {
  it("lists a resolved decision with its chosen option and reasoning", async () => {
    stubDecisions({ decisions: [RESOLVED], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Which cache should we use?")).toBeInTheDocument());
    expect(screen.getByText("Redis")).toBeInTheDocument();
    expect(screen.getByText(/lowest latency/)).toBeInTheDocument();
    expect(screen.getByText("Cache work")).toBeInTheDocument();
  });

  it("marks an unresolved decision as visibly distinct (awaiting decision pill)", async () => {
    stubDecisions({ decisions: [UNRESOLVED], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Which queue should we use?")).toBeInTheDocument());
    expect(screen.getByText(/awaiting your decision/i)).toBeInTheDocument();
  });

  it("shows an honest partial-data banner when a session failed to load", async () => {
    stubDecisions({ decisions: [RESOLVED], failedSessions: [{ sessionId: "s_bad", reason: "bad json" }] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument());
    expect(screen.getByText(/s_bad/)).toBeInTheDocument();
    // The good decision still renders alongside the warning — never truncated.
    expect(screen.getByText("Which cache should we use?")).toBeInTheDocument();
  });

  it("renders the empty state only when nothing was recorded AND nothing failed", async () => {
    stubDecisions({ decisions: [], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no decisions yet/i)).toBeInTheDocument());
  });

  it("does NOT claim 'no decisions yet' when a session failed but none loaded", async () => {
    stubDecisions({ decisions: [], failedSessions: [{ sessionId: "s_bad", reason: "bad json" }] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument());
    expect(screen.queryByText(/no decisions yet/i)).not.toBeInTheDocument();
  });

  it("filters client-side across decision text, chosen option, and session", async () => {
    stubDecisions({ decisions: [RESOLVED, UNRESOLVED], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Which cache should we use?")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText(/search decisions/i), "queue");
    expect(screen.getByText("Which queue should we use?")).toBeInTheDocument();
    expect(screen.queryByText("Which cache should we use?")).not.toBeInTheDocument();
  });

  it("clicking a row navigates to that decision in its session, then closes", async () => {
    const onClose = vi.fn();
    stubDecisions({ decisions: [RESOLVED], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={onClose} />);
    const row = await screen.findByText("Which cache should we use?");
    await userEvent.click(row);
    await waitFor(() => expect(openSessionReplay).toHaveBeenCalledWith("s1", "a1", expect.anything()));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("renders a dateless decision honestly as 'date unknown' (never a fabricated time)", async () => {
    const dateless = {
      decisionId: "d3", sessionId: "s3", sessionTitle: "Old work",
      artifactId: "a3", artifactTitle: "Legacy choice", artifactMissing: false,
      context: "A decision with no timestamp", optionCount: 2, resolved: false,
    };
    stubDecisions({ decisions: [dateless], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("A decision with no timestamp")).toBeInTheDocument());
    expect(screen.getByText(/date unknown/i)).toBeInTheDocument();
  });

  it("surfaces a load failure honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't load decisions/i)).toBeInTheDocument());
  });

  // #153 (S5) — a decision whose artifact was superseded while unresolved can
  // never resolve; a permanent "Awaiting your decision" pill would lie.
  it("renders 'Superseded (never resolved)' instead of the awaiting pill for closedUnresolved", async () => {
    const stuck = { ...UNRESOLVED, decisionId: "d4", context: "Superseded before anyone chose", closedUnresolved: true };
    stubDecisions({ decisions: [stuck], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Superseded before anyone chose")).toBeInTheDocument());
    expect(screen.getByText(/superseded \(never resolved\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting your decision/i)).not.toBeInTheDocument();
  });

  // #209 (J1) — a RETRACTED decision is out of the awaiting bucket and badged
  // "Withdrawn" (keyed on closedStatus), never a permanent "Awaiting" pill.
  it("renders 'Withdrawn' instead of the awaiting pill for a retracted (closedStatus) decision", async () => {
    const withdrawn = {
      ...UNRESOLVED, decisionId: "d5", context: "Withdrawn before anyone chose",
      closedUnresolved: true, closedStatus: "retracted",
    };
    stubDecisions({ decisions: [withdrawn], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Withdrawn before anyone chose")).toBeInTheDocument());
    expect(screen.getByText(/^Withdrawn$/)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting your decision/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/superseded/i)).not.toBeInTheDocument();
  });

  // #213 (J1 review) — a REJECTED decision (the human turned it down) badges
  // "Rejected", NOT "Withdrawn" — "Withdrawn" reads as an AGENT action and only
  // a retracted decision (the agent backed its own proposal out) earns it.
  it("renders 'Rejected' (not 'Withdrawn') for a rejected (closedStatus) decision", async () => {
    const rejected = {
      ...UNRESOLVED, decisionId: "d6", context: "Rejected before anyone chose",
      closedUnresolved: true, closedStatus: "rejected",
    };
    stubDecisions({ decisions: [rejected], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Rejected before anyone chose")).toBeInTheDocument());
    expect(screen.getByText(/^Rejected$/)).toBeInTheDocument();
    expect(screen.queryByText(/^Withdrawn$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting your decision/i)).not.toBeInTheDocument();
  });

  // P3 — the ORPHAN: an unresolved record whose artifact was APPROVED without an
  // option pick. It leaves the awaiting bucket server-side (the closed set now
  // includes `approved`), and it must NOT inherit the "Superseded (never
  // resolved)" default badge — that would tell a story that didn't happen.
  it("renders 'Approved (no option picked)' for an approved-origin orphan", async () => {
    const orphan = {
      ...UNRESOLVED, decisionId: "d7", context: "Approved before anyone chose",
      closedUnresolved: true, closedStatus: "approved",
    };
    stubDecisions({ decisions: [orphan], failedSessions: [] });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Approved before anyone chose")).toBeInTheDocument());
    expect(screen.getByText("Approved (no option picked)")).toBeInTheDocument();
    expect(screen.queryByText(/awaiting your decision/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/superseded/i)).not.toBeInTheDocument();
  });

  // #153 — the recovered-corruption case keeps the honest-partial banner
  // truthful after a session re-open rewrote a fresh valid decisions.json.
  it("words the partial banner for a recovered-from-corruption session and points at the sidecar", async () => {
    stubDecisions({
      decisions: [RESOLVED],
      failedSessions: [{
        sessionId: "s_recovered",
        reason: "earlier decisions were recovered from corruption; the pre-corruption file is preserved at decisions.json.corrupt",
        kind: "recovered",
      }],
    });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument());
    expect(screen.getByText(/previously recovered from a corrupted file/i)).toBeInTheDocument();
    expect(screen.getByText(/s_recovered/)).toBeInTheDocument();
    expect(screen.getByText(/decisions\.json\.corrupt/)).toBeInTheDocument();
    // The recovered wording replaces (not joins) the unreadable-NOW sentence.
    expect(screen.queryByText(/unreadable/i)).not.toBeInTheDocument();
    // The healthy decision still renders — the list is partial, not blank.
    expect(screen.getByText("Which cache should we use?")).toBeInTheDocument();
  });

  it("can report an unreadable session AND a recovered session in the same banner", async () => {
    stubDecisions({
      decisions: [],
      failedSessions: [
        { sessionId: "s_bad", reason: "bad json", kind: "unreadable" },
        { sessionId: "s_recovered", reason: "recovered", kind: "recovered" },
      ],
    });
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument());
    expect(screen.getByText(/s_bad/)).toBeInTheDocument();
    expect(screen.getByText(/s_recovered/)).toBeInTheDocument();
    expect(screen.getByText(/previously recovered/i)).toBeInTheDocument();
  });

  // #469 — the recorded rationale is searchable, not just displayed.
  describe("search covers the recorded reasoning (#469)", () => {
    const WITH_REASON = { ...RESOLVED, reasoning: "Avoids the Zanzibar quota entirely" };
    const NO_REASON = { ...RESOLVED, decisionId: "d8", sessionId: "s8", context: "Which logger?", chosenOptionTitle: "pino", reasoning: undefined };

    it("finds a decision by a term that appears ONLY in its reasoning (case-insensitive)", async () => {
      stubDecisions({ decisions: [WITH_REASON, NO_REASON, UNRESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={() => {}} />);
      await screen.findByText("Which cache should we use?");
      await userEvent.type(screen.getByLabelText(/search decisions/i), "zANZIBAR");
      expect(screen.getByText("Which cache should we use?")).toBeInTheDocument();
      expect(screen.queryByText("Which logger?")).not.toBeInTheDocument();
      expect(screen.queryByText("Which queue should we use?")).not.toBeInTheDocument();
    });

    it("keeps the existing fields searchable and reports an accurate empty result with reason-less records", async () => {
      stubDecisions({ decisions: [WITH_REASON, NO_REASON, UNRESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={() => {}} />);
      await screen.findByText("Which cache should we use?");
      const input = screen.getByLabelText(/search decisions/i);
      await userEvent.type(input, "pino"); // chosen option of the reason-less record
      expect(screen.getByText("Which logger?")).toBeInTheDocument();
      await userEvent.clear(input);
      await userEvent.type(input, "queue work"); // session title
      expect(screen.getByText("Which queue should we use?")).toBeInTheDocument();
      await userEvent.clear(input);
      await userEvent.type(input, "no-such-reason");
      expect(screen.getByText(/no decisions match “no-such-reason”/i)).toBeInTheDocument();
    });
  });

  // #469 — a session that can't be opened must say so, keep the modal, the
  // query and the results, and offer a keyboard-reachable Retry. Superseded /
  // cancelled transitions stay silent, and a late result changes nothing.
  describe("session open failures (#469)", () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => { resolve = res; });
      return { promise, resolve };
    }
    const FAILED: SessionReplayResult = { status: "failed", kind: "http", message: "The session couldn't be loaded (HTTP 404)." };

    it("shows an alert with Retry, keeps modal + query + results, and Retry succeeds", async () => {
      const onClose = vi.fn();
      vi.mocked(openSessionReplay).mockResolvedValueOnce(FAILED).mockResolvedValueOnce({ status: "opened" });
      stubDecisions({ decisions: [RESOLVED, UNRESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={onClose} />);
      await screen.findByText("Which cache should we use?");
      await userEvent.type(screen.getByLabelText(/search decisions/i), "cache");
      await userEvent.click(screen.getByText("Which cache should we use?"));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/couldn't open “Cache work”/i);
      expect(alert).toHaveTextContent(/HTTP 404/);
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("decisions-view")).toBeInTheDocument();
      expect(screen.getByLabelText(/search decisions/i)).toHaveValue("cache");
      expect(screen.getByText("Which cache should we use?")).toBeInTheDocument();
      // The row is re-enabled (not stuck in "opening").
      expect(screen.getByText("Which cache should we use?").closest("button")).not.toBeDisabled();

      const retry = screen.getByRole("button", { name: /retry/i });
      expect(retry).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(openSessionReplay).toHaveBeenCalledTimes(2);
      expect(vi.mocked(openSessionReplay).mock.calls[1]!.slice(0, 2)).toEqual(["s1", "a1"]);
    });

    it("keyboard: Enter on a row announces 'Opening session…', then the failure alert", async () => {
      const pending = deferred<SessionReplayResult>();
      vi.mocked(openSessionReplay).mockReturnValueOnce(pending.promise);
      stubDecisions({ decisions: [RESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={() => {}} />);
      await screen.findByText("Which cache should we use?");
      const row = screen.getByText("Which cache should we use?").closest("button")!;
      row.focus();
      await userEvent.keyboard("{Enter}");
      const status = screen.getByTestId("decision-open-status");
      expect(status).toHaveAttribute("role", "status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toHaveTextContent("Opening session…");
      expect(row).toHaveAttribute("aria-busy", "true");
      await act(async () => { pending.resolve(FAILED); });
      expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't open/i);
      expect(status).toHaveTextContent("");
    });

    it("dismissing the alert keeps the results", async () => {
      vi.mocked(openSessionReplay).mockResolvedValueOnce(FAILED);
      stubDecisions({ decisions: [RESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={() => {}} />);
      await userEvent.click(await screen.findByText("Which cache should we use?"));
      await screen.findByRole("alert");
      await userEvent.click(screen.getByRole("button", { name: /dismiss error/i }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByText("Which cache should we use?")).toBeInTheDocument();
    });

    it.each(["superseded", "cancelled"] as const)("a %s transition is silent: no alert, no close", async (status) => {
      const onClose = vi.fn();
      vi.mocked(openSessionReplay).mockResolvedValueOnce({ status });
      stubDecisions({ decisions: [RESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={onClose} />);
      await userEvent.click(await screen.findByText("Which cache should we use?"));
      await waitFor(() => expect(screen.getByText("Which cache should we use?").closest("button")).not.toBeDisabled());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("closing the modal cancels the open; a late result neither closes nor reports", async () => {
      const onClose = vi.fn();
      const pending = deferred<SessionReplayResult>();
      vi.mocked(openSessionReplay).mockReturnValueOnce(pending.promise);
      stubDecisions({ decisions: [RESOLVED], failedSessions: [] });
      const { unmount } = render(<ProjectDecisionsModal onClose={onClose} />);
      await userEvent.click(await screen.findByText("Which cache should we use?"));
      const signal = (vi.mocked(openSessionReplay).mock.calls[0]![2] as { signal: AbortSignal }).signal;
      expect(signal.aborted).toBe(false);
      unmount();
      expect(signal.aborted).toBe(true);
      await act(async () => { pending.resolve({ status: "opened" }); });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("an older click's late result never overwrites the newer one", async () => {
      const onClose = vi.fn();
      const first = deferred<SessionReplayResult>();
      vi.mocked(openSessionReplay).mockReturnValueOnce(first.promise).mockResolvedValueOnce(FAILED);
      stubDecisions({ decisions: [RESOLVED, UNRESOLVED], failedSessions: [] });
      render(<ProjectDecisionsModal onClose={onClose} />);
      await userEvent.click(await screen.findByText("Which cache should we use?"));
      await userEvent.click(screen.getByText("Which queue should we use?"));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(/Queue work/);
      // The first click's controller was aborted by the second click.
      expect((vi.mocked(openSessionReplay).mock.calls[0]![2] as { signal: AbortSignal }).signal.aborted).toBe(true);
      await act(async () => { first.resolve({ status: "opened" }); });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(/Queue work/);
    });
  });
});
