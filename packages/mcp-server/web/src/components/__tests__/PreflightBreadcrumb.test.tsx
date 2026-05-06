import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PreflightTrace } from "@deeppairing/shared";
import { PreflightBreadcrumb, classifyPreflightTier } from "../PreflightBreadcrumb";

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
  // AA6.5 — bootstrap-dismissed flag is now in localStorage scoped by
  // projectRoot. Wipe both to give each test a clean "first-time user"
  // state regardless of which storage the prior test used.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("dp:preflight-bootstrap-dismissed")) localStorage.removeItem(k);
    }
    sessionStorage.removeItem("dp:preflight-bootstrap-dismissed");
  } catch {}
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

  it("AA6.5: dismiss button persists via localStorage scoped by projectRoot", async () => {
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

  it("AA6.5: dismissal is scoped per projectRoot (project A's dismiss doesn't silence project B)", async () => {
    // Pre-AA6.5 the key was global; dismissing in any project silenced
    // the bootstrap everywhere. Now each projectRoot has its own key
    // so the user re-onboards once per project.
    (window as any).__dpConnectionStore = { getState: () => ({ projectRoot: "/projects/A" }) };
    vi.stubGlobal("fetch", mockFetchTrace(trace({ consideredCount: 0 })));
    const userA = userEvent.setup();
    const a = render(<PreflightBreadcrumb artifactId="art_a" />);
    await waitFor(() => screen.getByText(/Your philosophy ledger is empty/));
    await userA.click(screen.getByRole("button", { name: /dismiss bootstrap message/i }));
    a.unmount();

    // Switch to project B; the bootstrap should appear again.
    (window as any).__dpConnectionStore = { getState: () => ({ projectRoot: "/projects/B" }) };
    render(<PreflightBreadcrumb artifactId="art_b" />);
    await waitFor(() => expect(
      screen.getByText(/Your philosophy ledger is empty/),
    ).toBeInTheDocument());
  });

  it("AA6.5: a non-empty trace event implicit-dismisses the bootstrap", async () => {
    (window as any).__dpConnectionStore = { getState: () => ({ projectRoot: "/projects/A" }) };
    vi.stubGlobal("fetch", mockFetchTrace(trace({ consideredCount: 0 })));
    const a = render(<PreflightBreadcrumb artifactId="art_z" />);
    await waitFor(() => screen.getByText(/Your philosophy ledger is empty/));

    // Simulate the daemon broadcasting a non-empty trace for ANOTHER artifact.
    act(() => {
      window.dispatchEvent(new CustomEvent("dp:preflight-trace", {
        detail: {
          artifactId: "art_other_with_data",
          trace: trace({
            artifactId: "art_other_with_data",
            consideredCount: 5,
            consideredConcepts: [{ source: "session", concept: "x" }],
          }),
        },
      }));
    });
    // The bootstrap on THIS instance disappears (the user has a ledger now).
    expect(screen.queryByText(/Your philosophy ledger is empty/)).not.toBeInTheDocument();
    a.unmount();

    // Mount a fresh instance — dismissal persists in localStorage for this project.
    vi.stubGlobal("fetch", mockFetchTrace(trace({ consideredCount: 0 })));
    render(<PreflightBreadcrumb artifactId="art_after" />);
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

// AA8 — three-tier visual treatment. Pure helper test plus per-tier
// render assertions. PMF council Z review pushed back on always-on
// violet box ("50 violet bars saying 'trust me'"); these tests pin the
// scarcity-equals-signal rules.
describe("classifyPreflightTier (AA8)", () => {
  it("bootstrap when consideredCount is 0", () => {
    expect(classifyPreflightTier(trace({ consideredCount: 0 }))).toBe("bootstrap");
  });

  it("signal when there's at least one near-miss", () => {
    expect(
      classifyPreflightTier(
        trace({
          consideredCount: 3,
          consideredConcepts: [{ source: "session", concept: "x" }],
          nearMisses: [{ source: "session", concept: "almost" }],
        }),
      ),
    ).toBe("signal");
  });

  it("signal when at least one considered concept is team-source", () => {
    expect(
      classifyPreflightTier(
        trace({
          consideredCount: 1,
          consideredConcepts: [{ source: "team", concept: "use the orm" }],
          nearMisses: [],
        }),
      ),
    ).toBe("signal");
  });

  it("ambient when only session-source concepts and no near-misses", () => {
    expect(
      classifyPreflightTier(
        trace({
          consideredCount: 5,
          consideredConcepts: [
            { source: "session", concept: "a" },
            { source: "session", concept: "b" },
          ],
          nearMisses: [],
        }),
      ),
    ).toBe("ambient");
  });

  it("near-miss wins over ambient even when other concepts are session-only", () => {
    expect(
      classifyPreflightTier(
        trace({
          consideredCount: 4,
          consideredConcepts: [{ source: "session", concept: "x" }],
          nearMisses: [{ source: "session", concept: "x" }],
        }),
      ),
    ).toBe("signal");
  });
});

describe("PreflightBreadcrumb tier render (AA8)", () => {
  it("ambient tier renders the headline WITHOUT the violet card border", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 7,
      consideredConcepts: [{ source: "session", concept: "graphql" }],
      nearMisses: [],
    })));
    const { container } = render(<PreflightBreadcrumb artifactId="art_amb" />);
    await waitFor(() => screen.getByText(/7 prior stances shaped this proposal/));
    // Top-level wrapper is the ambient div (no violet border classes).
    const root = container.firstChild as HTMLElement;
    expect(root?.className ?? "").not.toMatch(/border-accent-violet/);
    expect(root?.className ?? "").not.toMatch(/bg-accent-violet-dim/);
  });

  it("signal tier renders the violet card when nearMisses is non-empty", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 3,
      consideredConcepts: [{ source: "session", concept: "x" }],
      nearMisses: [{ source: "session", concept: "useEffect cleanup" }],
    })));
    const { container } = render(<PreflightBreadcrumb artifactId="art_sig" />);
    await waitFor(() => screen.getByText(/3 prior stances shaped this proposal/));
    const root = container.firstChild as HTMLElement;
    expect(root?.className ?? "").toMatch(/border-accent-violet/);
    expect(root?.className ?? "").toMatch(/bg-accent-violet-dim/);
    expect(screen.getByText(/Almost flagged this/)).toBeInTheDocument();
  });

  it("signal tier renders the violet card when a team-source concept was weighed", async () => {
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 1,
      consideredConcepts: [{ source: "team", concept: "use the orm" }],
      nearMisses: [],
    })));
    const { container } = render(<PreflightBreadcrumb artifactId="art_team" />);
    await waitFor(() => screen.getByText(/1 prior stance shaped this proposal/));
    const root = container.firstChild as HTMLElement;
    expect(root?.className ?? "").toMatch(/border-accent-violet/);
    expect(root?.className ?? "").toMatch(/bg-accent-violet-dim/);
    // No near-miss line here; team-source alone earns the violet
    // treatment but the amber "almost flagged" only appears when a
    // near-miss exists.
    expect(screen.queryByText(/Almost flagged this/)).not.toBeInTheDocument();
  });

  it("ambient tier still expands considered concepts on click", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", mockFetchTrace(trace({
      consideredCount: 2,
      consideredConcepts: [
        { source: "session", concept: "global mutable state", reason: "testability" },
        { source: "session", concept: "manual SQL", reason: "use the orm" },
      ],
      nearMisses: [],
    })));
    render(<PreflightBreadcrumb artifactId="art_amb_expand" />);
    await waitFor(() => screen.getByText(/2 prior stances shaped this proposal/));
    expect(screen.queryByText("Considered:")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Considered:")).toBeInTheDocument();
    expect(screen.getByText("global mutable state")).toBeInTheDocument();
  });
});
