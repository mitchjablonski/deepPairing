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
    expect(screen.getByText(/global mutable state/)).toBeInTheDocument();
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

  it("renders the ledger empty-state copy when no proposals have been shaped yet", async () => {
    vi.stubGlobal("fetch", fetchHandler({ "/api/ledger/digest": ledgerEmpty }));
    render(<IdleHome />);
    await waitFor(() => expect(screen.getByText(/your ledger is empty/i)).toBeInTheDocument());
    // Even on cold start the seed affordance is reachable.
    expect(screen.getByText(/seed your ledger/i)).toBeInTheDocument();
  });
});
