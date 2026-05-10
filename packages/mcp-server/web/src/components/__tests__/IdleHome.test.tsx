import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdleHome } from "../IdleHome";

/**
 * BB7 — pre-BB7 the cold-start home was SessionBrowser. Now it's the
 * cross-project ledger digest + AA9 SeedAffordance, with past sessions
 * as a secondary tab. These tests pin the tab structure, the default
 * landing surface (ledger), and the seed-then-refetch loop.
 */

const ledgerEmpty = {
  shapedThisProject: 0,
  nearMissesThisProject: 0,
  blockedThisProject: 0,
  sessionsTouched: 0,
  topCitedStances: [],
  globalLedger: { concepts: 0, projects: 0, multiProjectConcepts: 0 },
};

const ledgerPopulated = {
  shapedThisProject: 7,
  nearMissesThisProject: 2,
  blockedThisProject: 1,
  sessionsTouched: 3,
  topCitedStances: [
    { concept: "global mutable state", source: "session", citationCount: 4, sampleArtifactId: "art_1" },
  ],
  globalLedger: { concepts: 5, projects: 2, multiProjectConcepts: 1 },
};

function fetchHandler(handlers: Record<string, any>) {
  return vi.fn((url: string) => {
    const match = Object.keys(handlers).find((k) => url.includes(k));
    if (!match) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    const body = handlers[match];
    return Promise.resolve({ ok: true, json: async () => body });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IdleHome (BB7)", () => {
  it("defaults to the 'Your ledger' tab on first paint", async () => {
    vi.stubGlobal("fetch", fetchHandler({ "/api/ledger/digest": ledgerPopulated }));
    render(<IdleHome />);
    await waitFor(() => expect(screen.getByText(/proposals shaped here/i)).toBeInTheDocument());
    // Stat tile values render from the populated mock.
    expect(screen.getByText("7")).toBeInTheDocument();
    // The cited stance label uses font-mono; the seed-affordance placeholder
    // also mentions "global mutable state" (CC7 example list) so target the
    // row by font-mono class to disambiguate.
    const matches = screen.getAllByText(/global mutable state/);
    expect(matches.some((el) => el.className.includes("font-mono"))).toBe(true);
    // Seed affordance is on the home screen, not behind the drawer.
    expect(screen.getByText(/seed your ledger/i)).toBeInTheDocument();
  });

  it("switches to the 'Past sessions' tab when clicked", async () => {
    vi.stubGlobal("fetch", fetchHandler({
      "/api/ledger/digest": ledgerEmpty,
      "/api/sessions": { sessions: [] },
    }));
    render(<IdleHome />);
    await userEvent.click(screen.getByRole("button", { name: /past sessions/i }));
    // SessionBrowser renders its empty/demo state — pick a stable text fragment.
    await waitFor(() => {
      // The "Your ledger" content (Seed your ledger affordance) should not
      // be in the DOM once we're on the sessions tab.
      expect(screen.queryByText(/seed your ledger/i)).not.toBeInTheDocument();
    });
  });

  it("CC3 — primary 'Your ledger' tab is sized larger than the secondary 'Past sessions' pill", async () => {
    vi.stubGlobal("fetch", fetchHandler({ "/api/ledger/digest": ledgerEmpty }));
    render(<IdleHome />);
    const ledgerTab = await screen.findByRole("button", { name: /your ledger/i });
    const sessionsPill = screen.getByRole("button", { name: /past sessions/i });
    // Asymmetric weighting per PMF council: primary tab is text-sm
    // semibold; secondary pill is text-2xs and pill-shaped (rounded).
    expect(ledgerTab.className).toMatch(/text-sm/);
    expect(ledgerTab.className).toMatch(/font-semibold/);
    expect(sessionsPill.className).toMatch(/text-2xs/);
    expect(sessionsPill.className).toMatch(/rounded/);
    expect(sessionsPill.className).not.toMatch(/text-sm/);
  });

  it("CC4 — refetches /api/ledger/digest when a dp:preflight-trace event fires", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/api/ledger/digest")) {
        return Promise.resolve({ ok: true, json: async () => ledgerEmpty });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IdleHome />);
    await waitFor(() => expect(screen.getByText(/your ledger is empty/i)).toBeInTheDocument());
    const initialFetchCount = fetchMock.mock.calls.filter((c: any[]) =>
      String(c[0]).includes("/api/ledger/digest"),
    ).length;
    expect(initialFetchCount).toBe(1);
    // Simulate the WS bridge dispatching a fresh trace event.
    window.dispatchEvent(
      new CustomEvent("dp:preflight-trace", {
        detail: { artifactId: "art_x", trace: { consideredCount: 1 } },
      }),
    );
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("/api/ledger/digest"),
      ).length;
      expect(after).toBe(2);
    });
  });

  it("renders the ledger empty-state copy when no proposals have been shaped yet", async () => {
    vi.stubGlobal("fetch", fetchHandler({ "/api/ledger/digest": ledgerEmpty }));
    render(<IdleHome />);
    await waitFor(() => expect(screen.getByText(/your ledger is empty/i)).toBeInTheDocument());
    // Even on cold start the seed affordance is reachable.
    expect(screen.getByText(/seed your ledger/i)).toBeInTheDocument();
  });
});
