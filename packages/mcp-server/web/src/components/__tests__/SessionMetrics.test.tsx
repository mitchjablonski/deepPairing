import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SessionMetrics } from "../SessionMetrics";
import { useArtifactStore } from "../../stores/artifact";

function mockMetricsFetch(partial: any) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      version: 1,
      firstSeenAt: "2026-03-01",
      lastActivityAt: "2026-04-20",
      sessions: 0,
      counts: {
        preflightBlocks: { total: 0, bySource: { session: 0, team: 0 } },
        ledgerWrites: { total: 0, rejected: 0, approved: 0 },
        retrospectives: { total: 0, right: 0, wrong: 0, mixed: 0 },
        horizonChecksRequested: 0,
        questions: { asked: 0, answered: 0 },
      },
      ...partial,
    }),
  });
}

beforeEach(() => {
  useArtifactStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionMetrics — R1 cumulative block", () => {
  it("does NOT render the cumulative block when sessions is 0", async () => {
    vi.stubGlobal("fetch", mockMetricsFetch({ sessions: 0 }));
    render(<SessionMetrics />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/across all sessions/i)).not.toBeInTheDocument();
  });

  it("renders the cumulative block once sessions > 0", async () => {
    vi.stubGlobal("fetch", mockMetricsFetch({
      sessions: 5,
      counts: {
        preflightBlocks: { total: 3, bySource: { session: 2, team: 1 } },
        ledgerWrites: { total: 7, rejected: 4, approved: 3 },
        retrospectives: { total: 2, right: 1, wrong: 1, mixed: 0 },
        horizonChecksRequested: 4,
        questions: { asked: 6, answered: 5 },
      },
    }));
    render(<SessionMetrics />);
    await waitFor(() => expect(screen.getByText(/across all sessions/i)).toBeInTheDocument());

    expect(screen.getByText(/^Sessions$/)).toBeInTheDocument();
    expect(screen.getByText(/Pre-flight blocks/)).toBeInTheDocument();
    expect(screen.getByText(/2 you · 1 team/)).toBeInTheDocument();
    expect(screen.getByText(/Ledger writes/)).toBeInTheDocument();
    expect(screen.getByText(/4 avoid · 3 prefer/)).toBeInTheDocument();
    expect(screen.getByText(/1 right · 1 wrong · 0 mixed/)).toBeInTheDocument();
    expect(screen.getByText(/5 answered/)).toBeInTheDocument();
  });

  it("hides per-metric details when the counter is 0 (keeps the grid tidy)", async () => {
    vi.stubGlobal("fetch", mockMetricsFetch({
      sessions: 1,
      counts: {
        preflightBlocks: { total: 0, bySource: { session: 0, team: 0 } },
        ledgerWrites: { total: 0, rejected: 0, approved: 0 },
        retrospectives: { total: 0, right: 0, wrong: 0, mixed: 0 },
        horizonChecksRequested: 0,
        questions: { asked: 0, answered: 0 },
      },
    }));
    render(<SessionMetrics />);
    await waitFor(() => expect(screen.getByText(/across all sessions/i)).toBeInTheDocument());
    expect(screen.queryByText(/you · .* team/)).not.toBeInTheDocument();
    expect(screen.queryByText(/avoid · .* prefer/)).not.toBeInTheDocument();
  });

  it("silently hides the cumulative block when /api/metrics fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<SessionMetrics />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/across all sessions/i)).not.toBeInTheDocument();
  });
});

describe("C5 — concepts named this session", () => {
  beforeEach(() => {
    // E2 review — this describe previously inherited the PREVIOUS test's
    // fetch stub (restoreAllMocks doesn't undo stubGlobal); run with .only it
    // hit real network and could reintroduce the AbortError leak class.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })),
    ));
  });

  it("lists concept chips with counts and deep-links into the taste drawer", () => {
    useArtifactStore.setState((s: any) => ({
      artifacts: [
        ...s.artifacts,
        { id: "d1", sessionId: "s1", type: "decision", version: 1, parentId: null, title: "t",
          status: "approved", agentReasoning: null, createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          content: { context: "c", decisionId: "dd", options: [
            { id: "a", title: "A", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: true, concept: { name: "fakes over mocks" } },
            { id: "b", title: "B", description: "d", pros: [], cons: [], effort: "low", risk: "low", recommendation: false, concept: { name: "fakes over mocks" } },
          ] } },
      ],
    }));
    let detail: any = null;
    const listener = (e: Event) => { detail = (e as CustomEvent).detail; };
    window.addEventListener("dp:open-your-taste", listener);

    render(<SessionMetrics />);
    const chip = screen.getByRole("button", { name: /fakes over mocks/i });
    expect(chip).toHaveTextContent("×2");
    fireEvent.click(chip);
    expect(detail).toMatchObject({ initialTab: "ledger", highlightConcept: "fakes over mocks" });

    window.removeEventListener("dp:open-your-taste", listener);
  });
});
