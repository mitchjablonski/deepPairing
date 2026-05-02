import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreflightTrace } from "@deeppairing/shared";
import { PreflightBreadcrumb } from "../PreflightBreadcrumb";

function trace(overrides: Partial<PreflightTrace> = {}): PreflightTrace {
  return {
    version: 1,
    at: new Date("2026-04-30T12:00:00Z").toISOString(),
    artifactId: "art_test",
    toolName: "present_findings",
    decision: "admitted",
    consideredCount: 0,
    consideredConcepts: [],
    nearMisses: [],
    ...overrides,
  };
}

function mockFetchTrace(t: PreflightTrace | null) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ trace: t }),
  });
}

beforeEach(() => {
  // Z3 — clear the bootstrap-dismissed flag between tests so each test
  // starts from a clean "first-time user" state.
  try { sessionStorage.removeItem("dp:preflight-bootstrap-dismissed"); } catch {}
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PreflightBreadcrumb (Y1')", () => {
  it("renders nothing when no trace exists", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(null));
    const { container } = render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  // Z3 — Y1' originally hid the breadcrumb on empty ledger; PMF council
  // amendment turned that into a bootstrap onboarding moment so first-
  // time users learn the moat exists. Suppressed once the user dismisses
  // (sessionStorage), or once they hit any non-empty trace.
  it("Z3: renders bootstrap onboarding when consideredCount is zero (and not dismissed)", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({ consideredCount: 0 })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => expect(
      screen.getByText(/Your philosophy ledger is empty/),
    ).toBeInTheDocument());
    expect(
      screen.getByText(/Reject something — or add reasoning/),
    ).toBeInTheDocument();
  });

  it("Z3: dismiss button persists via sessionStorage", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", mockFetchTrace(trace({ consideredCount: 0 })));
    const first = render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => screen.getByText(/Your philosophy ledger is empty/));
    await user.click(screen.getByRole("button", { name: /dismiss bootstrap message/i }));
    // Disappears from this instance.
    expect(screen.queryByText(/Your philosophy ledger is empty/)).not.toBeInTheDocument();
    first.unmount();

    // Mount a NEW instance for a different artifact — should still be hidden.
    render(<PreflightBreadcrumb artifactId="art_test_2" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Your philosophy ledger is empty/)).not.toBeInTheDocument();
  });

  it("Z3: renders the active-voice headline with considered count + pluralization", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 14,
      consideredConcepts: [{ source: "session", concept: "graphql federation" }],
    })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => expect(
      screen.getByText(/14 prior stances shaped this proposal/),
    ).toBeInTheDocument());
  });

  it("Z3: uses 'stance' (singular) for count of 1", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 1,
      consideredConcepts: [{ source: "session", concept: "x" }],
    })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => expect(
      screen.getByText(/1 prior stance shaped this proposal/),
    ).toBeInTheDocument());
    expect(screen.queryByText(/1 prior stances shaped/)).not.toBeInTheDocument();
  });

  it("renders the near-miss line above the expand toggle (always visible when present)", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 3,
      consideredConcepts: [{ source: "session", concept: "x" }],
      nearMisses: [{
        source: "session",
        concept: "useEffect cleanup",
        why: "Partial token overlap (67%) with a past rejection.",
      }],
    })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => expect(
      screen.getByText(/Almost flagged this — your past stance on/),
    ).toBeInTheDocument());
    expect(screen.getByText("useEffect cleanup")).toBeInTheDocument();
  });

  it("expand toggle reveals considered concepts on click", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 2,
      consideredConcepts: [
        { source: "session", concept: "global mutable state", reason: "testability" },
        { source: "team", concept: "manual SQL", reason: "use the orm" },
      ],
    })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => screen.getByText(/shaped this proposal/));
    expect(screen.queryByText("Considered:")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Considered:")).toBeInTheDocument();
    expect(screen.getByText("global mutable state")).toBeInTheDocument();
    expect(screen.getByText("manual SQL")).toBeInTheDocument();
  });

  it("picks up live trace via dp:preflight-trace event without a refetch", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(null)); // no trace at fetch time
    render(<PreflightBreadcrumb artifactId="art_live" />);
    await new Promise((r) => setTimeout(r, 20));
    // Component is currently empty (no trace, no bootstrap).
    expect(screen.queryByText(/shaped this proposal/)).not.toBeInTheDocument();

    // Simulate the daemon broadcasting a fresh trace.
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:preflight-trace", {
        detail: {
          artifactId: "art_live",
          trace: trace({
            artifactId: "art_live",
            consideredCount: 5,
            consideredConcepts: [{ source: "session", concept: "x" }],
          }),
        },
      }));
    });
    expect(
      screen.getByText(/5 prior stances shaped this proposal/),
    ).toBeInTheDocument();
  });

  it("ignores broadcast events scoped to a different artifact", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(null));
    render(<PreflightBreadcrumb artifactId="art_mine" />);
    await new Promise((r) => setTimeout(r, 20));
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:preflight-trace", {
        detail: {
          artifactId: "art_someone_else",
          trace: trace({ consideredCount: 99, consideredConcepts: [{ source: "session", concept: "x" }] }),
        },
      }));
    });
    expect(screen.queryByText(/Cross-checked/)).not.toBeInTheDocument();
  });
});
