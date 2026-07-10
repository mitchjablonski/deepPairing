import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDecisionsModal } from "../ProjectDecisionsModal";
import { enterSessionReplay } from "../../lib/session-replay";

// The navigation scheme is exercised by its own module; here we assert the
// modal CALLS it with the right target (and closes) — a fake, not a mock of fetch.
vi.mock("../../lib/session-replay", () => ({
  enterSessionReplay: vi.fn().mockResolvedValue(true),
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
  vi.mocked(enterSessionReplay).mockClear();
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
    await waitFor(() => expect(enterSessionReplay).toHaveBeenCalledWith("s1", "a1"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("surfaces a load failure honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<ProjectDecisionsModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/couldn't load decisions/i)).toBeInTheDocument());
  });
});
