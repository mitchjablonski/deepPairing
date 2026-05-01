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
  // jsdom default — clean slate.
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

  it("renders nothing when consideredCount is zero (empty ledger reads as broken)", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({ consideredCount: 0 })));
    const { container } = render(<PreflightBreadcrumb artifactId="art_test" />);
    // Wait a tick for the loaded state to flip.
    await new Promise((r) => setTimeout(r, 20));
    expect(container.firstChild).toBeNull();
  });

  it("renders the headline with the considered count and pluralization", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 14,
      consideredConcepts: [{ source: "session", concept: "graphql federation" }],
    })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    await waitFor(() => expect(
      screen.getByText(/Cross-checked your 14 prior stances/),
    ).toBeInTheDocument());
  });

  it("uses 'stance' (singular) for count of 1", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 1,
      consideredConcepts: [{ source: "session", concept: "x" }],
    })));
    render(<PreflightBreadcrumb artifactId="art_test" />);
    // Match the full singular-form line; assert the plural form is absent.
    await waitFor(() => expect(
      screen.getByText(/Cross-checked your 1 prior stance before proposing this/),
    ).toBeInTheDocument());
    expect(screen.queryByText(/1 prior stances/)).not.toBeInTheDocument();
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
    await waitFor(() => screen.getByText(/Cross-checked/));
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
    // Component is currently empty.
    expect(screen.queryByText(/Cross-checked/)).not.toBeInTheDocument();

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
      screen.getByText(/Cross-checked your 5 prior stances/),
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
