import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LedgerDrawer } from "../LedgerDrawer";
import { resetLedgerStoreForTests } from "../../stores/ledger";

function mockPhilosophyFetch(entries: any[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ entries, total: entries.length }),
  });
}

// URL-aware fetch mock — routes stances vs digest so tab switching in a
// single test can exercise both.
function mockFetchByUrl(handlers: Record<string, any>) {
  return vi.fn((url: string) => {
    const match = Object.keys(handlers).find((k) => url.includes(k));
    const body = match ? handlers[match] : null;
    if (!body) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, json: async () => body });
  });
}

beforeEach(() => {
  // The drawer fetches from window.location.host; jsdom sets this to localhost.
  resetLedgerStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLedgerStoreForTests();
});

describe("LedgerDrawer", () => {
  it("shows a loading state while fetching, then renders entries", async () => {
    const resolver: { fn?: (v: any) => void } = {};
    const pending = new Promise((resolve) => { resolver.fn = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending));

    render(<LedgerDrawer onClose={() => {}} />);
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();

    resolver.fn!({
      ok: true,
      json: async () => ({
        entries: [
          { key: "global state", concept: "global state", stance: "avoid", projectCount: 2, projects: ["a", "b"], instanceCount: 3, approved: 0, rejected: 3, latestReason: "breaks tests", firstSeenAt: "2026-01-01", lastSeenAt: "2026-04-01" },
        ],
        total: 1,
      }),
    });

    await waitFor(() => expect(screen.getByText("global state")).toBeInTheDocument());
    expect(screen.getByText(/breaks tests/)).toBeInTheDocument();
    // Stance badge visible
    expect(screen.getAllByText(/avoid/i).length).toBeGreaterThan(0);
  });

  it("shows the empty-state copy when the ledger has no entries", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([]));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument());
    expect(screen.getByText(/compounding/i)).toBeInTheDocument();
  });

  // AA9 — opt-in seed affordance lives in the empty state. PMF council
  // deep dive's resolution to the empty-ledger silent killer: let the
  // user paste a rule from their CLAUDE.md / code-review checklist
  // instead of presupposing taste with a baked-in stance list.
  it("AA9: renders the seed affordance only in the empty state", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([]));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/seed your ledger/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/global mutable state/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add to ledger/i })).toBeInTheDocument();
    // Both verdict pills are visible — radio semantics let the user toggle.
    expect(screen.getByRole("radio", { name: /prefer/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /avoid/i })).toBeInTheDocument();
  });

  it("AA9: seed affordance is HIDDEN once the ledger has any entries", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([
      { key: "x", concept: "x", stance: "avoid", projectCount: 1, projects: ["a"], instanceCount: 1, approved: 0, rejected: 1, firstSeenAt: "2026-01", lastSeenAt: "2026-01" },
    ]));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("x")).toBeInTheDocument());
    expect(screen.queryByText(/seed your ledger/i)).not.toBeInTheDocument();
  });

  it("AA9: clicking 'Add to ledger' POSTs to /api/philosophy/seed with the chosen verdict", async () => {
    const seedFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "seeded" }) });
    const stancesFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [], total: 0 }) });
    vi.stubGlobal("fetch", vi.fn((url: string, init?: any) => {
      if (init?.method === "POST" && url.includes("/api/philosophy/seed")) return seedFetch(url, init);
      return stancesFetch(url, init);
    }));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => screen.getByText(/seed your ledger/i));

    const textarea = screen.getByPlaceholderText(/global mutable state/i);
    await userEvent.type(textarea, "named exports only");
    await userEvent.click(screen.getByRole("radio", { name: /avoid/i }));
    await userEvent.click(screen.getByRole("button", { name: /add to ledger/i }));

    await waitFor(() => expect(seedFetch).toHaveBeenCalled());
    const [, init] = seedFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.concept).toBe("named exports only");
    expect(body.verdict).toBe("rejected");
  });

  it("filters by stance when a filter pill is clicked", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([
      { key: "a", concept: "global state", stance: "avoid", projectCount: 1, projects: ["x"], instanceCount: 1, approved: 0, rejected: 1, firstSeenAt: "2026-01", lastSeenAt: "2026-01" },
      { key: "b", concept: "repository pattern", stance: "prefer", projectCount: 1, projects: ["x"], instanceCount: 1, approved: 1, rejected: 0, firstSeenAt: "2026-01", lastSeenAt: "2026-01" },
    ]));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("global state")).toBeInTheDocument());
    expect(screen.getByText("repository pattern")).toBeInTheDocument();

    // Click the "Prefer" filter
    await userEvent.click(screen.getByRole("button", { name: /prefer \(1\)/i }));
    expect(screen.queryByText("global state")).not.toBeInTheDocument();
    expect(screen.getByText("repository pattern")).toBeInTheDocument();
  });

  it("surfaces fetch failures without crashing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/could not load the ledger/i)).toBeInTheDocument());
  });

  it("closes on Escape keypress", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([]));
    const onClose = vi.fn();
    render(<LedgerDrawer onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("hides the 'This week' digest tab by default (O3 gating)", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([]));
    render(<LedgerDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /this week/i })).not.toBeInTheDocument();
  });

  it("closes on backdrop click", async () => {
    vi.stubGlobal("fetch", mockPhilosophyFetch([]));
    const onClose = vi.fn();
    const { container } = render(<LedgerDrawer onClose={onClose} />);
    // Backdrop is the first fixed element with the overlay class.
    const backdrop = container.querySelector(".fixed.inset-0");
    expect(backdrop).toBeTruthy();
    await userEvent.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  describe("Digest tab (N3.2 — gated in O3)", () => {
    beforeEach(() => {
      // O3: the digest tab is hidden by default in the UI. The test suite
      // still locks its behavior, so force the flag on for these cases.
      (window as any).__DP_FORCE_DIGEST__ = true;
    });
    afterEach(() => {
      delete (window as any).__DP_FORCE_DIGEST__;
    });

    it("lazy-loads digest data when the This week tab is opened", async () => {
      const fetchMock = mockFetchByUrl({
        "/api/philosophy?": { entries: [], total: 0 },
        "/api/philosophy/digest": {
          window: { sinceDays: 7, fromIso: "2026-04-12", toIso: "2026-04-19" },
          totals: { concepts: 5, instances: 12, multiProjectConcepts: 2 },
          newThisPeriod: [
            { key: "new idea", concept: "use feature flags", stance: "prefer", projectCount: 1, latestReason: "safer rollouts" },
          ],
          strengthenedThisPeriod: [
            { key: "old concept", concept: "global state", stance: "avoid", projectCount: 3, newInstancesInPeriod: 2, latestReason: "hit again on proj-c" },
          ],
        },
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<LedgerDrawer onClose={() => {}} />);
      // Wait for initial stances load so the spinner resolves.
      await waitFor(() => expect(screen.queryByText(/loading…/i)).not.toBeInTheDocument());

      // Philosophy-digest endpoint shouldn't have been called yet
      // (EE2's shared ledger store fetches /api/ledger/digest on mount,
      // so we narrow the assertion to the philosophy-digest URL).
      expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes("/philosophy/digest"))).toBe(false);

      // Switch tabs — triggers the lazy load.
      await userEvent.click(screen.getByRole("button", { name: /this week/i }));

      await waitFor(() =>
        expect(fetchMock.mock.calls.some((c: any[]) => String(c[0]).includes("/philosophy/digest"))).toBe(true),
      );

      // Headline tiles render.
      await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument());
      expect(screen.getByText("concepts")).toBeInTheDocument();
      expect(screen.getByText("12")).toBeInTheDocument();
      expect(screen.getByText("multi-project")).toBeInTheDocument();

      // New + strengthened sections render.
      expect(screen.getByText(/new stances \(1\)/i)).toBeInTheDocument();
      expect(screen.getByText("use feature flags")).toBeInTheDocument();
      expect(screen.getByText(/strengthened \(1\)/i)).toBeInTheDocument();
      expect(screen.getByText("global state")).toBeInTheDocument();
      expect(screen.getByText(/\+2 this period/)).toBeInTheDocument();
    });

    it("shows the 'nothing landed' empty state when both periods are empty", async () => {
      vi.stubGlobal("fetch", mockFetchByUrl({
        "/api/philosophy?": { entries: [], total: 0 },
        "/api/philosophy/digest": {
          window: { sinceDays: 7, fromIso: "x", toIso: "y" },
          totals: { concepts: 0, instances: 0, multiProjectConcepts: 0 },
          newThisPeriod: [],
          strengthenedThisPeriod: [],
        },
      }));
      render(<LedgerDrawer onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: /this week/i }));
      await waitFor(() => expect(screen.getByText(/nothing landed in the ledger this week/i)).toBeInTheDocument());
    });

    it("surfaces digest fetch failures without affecting the stances tab", async () => {
      vi.stubGlobal("fetch", vi.fn((url: string) =>
        url.includes("/digest")
          ? Promise.resolve({ ok: false, status: 500 })
          : Promise.resolve({ ok: true, json: async () => ({ entries: [], total: 0 }) }),
      ));
      render(<LedgerDrawer onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: /this week/i }));
      await waitFor(() => expect(screen.getByText(/could not load the digest/i)).toBeInTheDocument());
    });
  });

  describe("Team tab (P3)", () => {
    it("nudges `team init` when team.json is absent", async () => {
      vi.stubGlobal("fetch", mockFetchByUrl({
        "/api/philosophy?": { entries: [], total: 0 },
        "/api/team-preferences": { preferences: [], exists: false },
      }));
      render(<LedgerDrawer onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: /^team$/i }));
      await waitFor(() => expect(screen.getByText(/no team conventions set up yet/i)).toBeInTheDocument());
      expect(screen.getByText(/npx deeppairing team init/i)).toBeInTheDocument();
    });

    it("renders preferences grouped by kind when team.json exists", async () => {
      vi.stubGlobal("fetch", mockFetchByUrl({
        "/api/philosophy?": { entries: [], total: 0 },
        "/api/team-preferences": {
          exists: true,
          preferences: [
            { id: "r1", kind: "require", concept: "argon2id for password hashing", rationale: "bcrypt is brute-forceable", addedBy: "alex" },
            { id: "a1", kind: "avoid", concept: "global mutable state", rationale: "testability", scope: { paths: ["packages/auth/**"] } },
            { id: "p1", kind: "prefer", concept: "repository pattern", rationale: "keeps SQL out of handlers" },
          ],
        },
      }));
      render(<LedgerDrawer onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: /^team$/i }));

      await waitFor(() => expect(screen.getByText(/required \(1\)/i)).toBeInTheDocument());
      expect(screen.getByText(/avoid \(1\)/i)).toBeInTheDocument();
      expect(screen.getByText(/preferred \(1\)/i)).toBeInTheDocument();

      expect(screen.getByText("argon2id for password hashing")).toBeInTheDocument();
      expect(screen.getByText(/bcrypt is brute-forceable/)).toBeInTheDocument();
      expect(screen.getByText(/added by alex/i)).toBeInTheDocument();
      expect(screen.getByText(/scope: packages\/auth\/\*\*/)).toBeInTheDocument();

      expect(screen.getByText(/read-only here/i)).toBeInTheDocument();
    });

    it("surfaces fetch failures on the team tab", async () => {
      vi.stubGlobal("fetch", vi.fn((url: string) =>
        url.includes("/api/team-preferences")
          ? Promise.resolve({ ok: false, status: 500 })
          : Promise.resolve({ ok: true, json: async () => ({ entries: [], total: 0 }) }),
      ));
      render(<LedgerDrawer onClose={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: /^team$/i }));
      await waitFor(() => expect(screen.getByText(/could not load team preferences/i)).toBeInTheDocument());
    });
  });

  describe("BB6 — breadcrumb ↔ ledger round-trip", () => {
    function mockLedgerFetch(topCitedStances: any[], opts?: { empty?: boolean; seededStances?: any[] }) {
      return vi.fn((url: string) => {
        if (url.includes("/api/ledger/digest")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              shapedThisProject: opts?.empty ? 0 : 5,
              nearMissesThisProject: opts?.empty ? 0 : 1,
              blockedThisProject: 0,
              sessionsTouched: opts?.empty ? 0 : 2,
              topCitedStances,
              seededStances: opts?.seededStances ?? [],
              globalLedger: opts?.empty
                ? { concepts: 0, projects: 0, multiProjectConcepts: 0 }
                : { concepts: 1, projects: 1, multiProjectConcepts: 0 },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ entries: [], total: 0 }) });
      });
    }

    it("clicking a top-cited stance with a sample artifact closes the drawer + selects the artifact", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([
        {
          concept: "global mutable state",
          source: "session",
          citationCount: 4,
          sampleArtifactId: "art_jumpback",
          sampleSessionId: "sess_a",
        },
      ]));
      const { useArtifactStore } = await import("../../stores/artifact");
      useArtifactStore.getState().reset();
      const onClose = vi.fn();
      render(<LedgerDrawer onClose={onClose} initialTab="ledger" />);
      const conceptText = await screen.findByText("global mutable state");
      const row = conceptText.closest("button")!;
      expect(row).toBeTruthy();
      expect(row.getAttribute("title")).toMatch(/art_jumpback/);
      await userEvent.click(row);
      expect(onClose).toHaveBeenCalled();
      expect(useArtifactStore.getState().selectedArtifactId).toBe("art_jumpback");
    });

    it("highlightConcept gives the matching row a violet ring", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([
        { concept: "alpha", source: "session", citationCount: 3, sampleArtifactId: "art_a" },
        { concept: "beta", source: "session", citationCount: 2, sampleArtifactId: "art_b" },
      ]));
      render(
        <LedgerDrawer
          onClose={() => {}}
          initialTab="ledger"
          highlightConcept="beta"
        />,
      );
      const betaConcept = await screen.findByText("beta");
      const betaButton = betaConcept.closest("button")!;
      expect(betaButton.className).toMatch(/ring-accent-violet/);
      const alphaConcept = await screen.findByText("alpha");
      const alphaButton = alphaConcept.closest("button")!;
      expect(alphaButton.className).not.toMatch(/ring-accent-violet/);
    });

    it("CC2/DD8 — orphan banner names the concrete threshold (top N + bottom citation count)", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([
        { concept: "alpha", source: "session", citationCount: 3, sampleArtifactId: "art_a" },
        { concept: "beta", source: "session", citationCount: 2, sampleArtifactId: "art_b" },
      ]));
      render(
        <LedgerDrawer
          onClose={() => {}}
          initialTab="ledger"
          highlightConcept="gamma" // not in the top stances above
        />,
      );
      const banner = await screen.findByTestId("ledger-orphan-banner");
      expect(banner.textContent).toContain("gamma");
      // DD8 — concrete threshold copy, not the vague "more citations".
      expect(banner.textContent).toMatch(/top 2 cited stances/i);
      expect(banner.textContent).toMatch(/cited 2×/i); // bottom entry's count
      // Existing rows still render unringed.
      const alpha = (await screen.findByText("alpha")).closest("button");
      expect(alpha?.className ?? "").not.toMatch(/ring-accent-violet/);
    });

    it("CC2 — highlightConcept that IS in topCitedStances does NOT show the orphan banner", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([
        { concept: "alpha", source: "session", citationCount: 3, sampleArtifactId: "art_a" },
      ]));
      render(
        <LedgerDrawer
          onClose={() => {}}
          initialTab="ledger"
          highlightConcept="alpha"
        />,
      );
      await screen.findByText("alpha");
      expect(screen.queryByTestId("ledger-orphan-banner")).toBeNull();
    });

    it("CC2/DD8 — orphan banner uses different copy when there are zero cited stances yet", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([], { empty: true }));
      render(
        <LedgerDrawer
          onClose={() => {}}
          initialTab="ledger"
          highlightConcept="brand new concept"
        />,
      );
      const banner = await screen.findByTestId("ledger-orphan-banner");
      expect(banner.textContent).toContain("brand new concept");
      // DD8 — special-case copy for the zero-list case (no "top N").
      expect(banner.textContent).toMatch(/haven't accumulated any cited stances yet/i);
      // Empty-state copy still renders alongside.
      expect(screen.getByText(/your ledger is empty/i)).toBeInTheDocument();
    });

    it("DD1 — renders 'Seeded by you' section with [SEED] badge when seededStances has entries", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([], {
        seededStances: [
          { concept: "global mutable state", stance: "avoid", citedTimesElsewhere: 0 },
          { concept: "named exports only", stance: "prefer", citedTimesElsewhere: 3 },
        ],
      }));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      const section = await screen.findByTestId("ledger-seeded-section");
      expect(section.textContent).toContain("Seeded by you");
      expect(section.textContent).toContain("global mutable state");
      expect(section.textContent).toContain("named exports only");
      // SEED badges visible.
      const seedBadges = within(section).getAllByText("SEED");
      expect(seedBadges).toHaveLength(2);
      // The cited seed shows the fired count.
      expect(section.textContent).toContain("fired 3×");
      // The orphan seed does NOT show "fired".
      const orphanRow = within(section).getByText("global mutable state").closest("li")!;
      expect(orphanRow.textContent).not.toContain("fired");
    });

    it("EE4 — concepts in BOTH seeded and topCited render only in the seeded section", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch(
        [
          { concept: "global mutable state", source: "session", citationCount: 4, sampleArtifactId: "art_a" },
          { concept: "unique cited concept", source: "session", citationCount: 2, sampleArtifactId: "art_b" },
        ],
        {
          seededStances: [
            { concept: "global mutable state", stance: "avoid", citedTimesElsewhere: 4 },
          ],
        },
      ));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      const seededSection = await screen.findByTestId("ledger-seeded-section");
      expect(seededSection.textContent).toContain("global mutable state");
      // The concept appears once total (in the seeded section), not duplicated in Top cited.
      expect(screen.getAllByText("global mutable state").length).toBe(1);
      // The unique top-cited row still renders.
      expect(screen.getByText("unique cited concept")).toBeInTheDocument();
    });

    it("EE4 — Top cited section is HIDDEN when every cited concept is also seeded (full overlap)", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch(
        [
          { concept: "alpha", source: "session", citationCount: 2, sampleArtifactId: "art_a" },
        ],
        {
          seededStances: [
            { concept: "alpha", stance: "avoid", citedTimesElsewhere: 2 },
          ],
        },
      ));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      await screen.findByTestId("ledger-seeded-section");
      // No "Top cited stances" header rendered (would be empty).
      expect(screen.queryByText(/top cited stances/i)).toBeNull();
    });

    it("FF1 — seeded row with sampleArtifactId becomes a clickable jump button", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([], {
        seededStances: [
          {
            concept: "FF1 hot seed",
            stance: "avoid",
            citedTimesElsewhere: 2,
            sampleArtifactId: "art_jump",
            sampleSessionId: "sess_x",
          },
        ],
      }));
      const { useArtifactStore } = await import("../../stores/artifact");
      useArtifactStore.getState().reset();
      const onClose = vi.fn();
      render(<LedgerDrawer onClose={onClose} initialTab="ledger" />);
      const seededSection = await screen.findByTestId("ledger-seeded-section");
      const conceptText = within(seededSection).getByText("FF1 hot seed");
      const button = conceptText.closest("button");
      expect(button).not.toBeNull();
      expect(button!.getAttribute("title")).toMatch(/art_jump/);
      await userEvent.click(button!);
      expect(useArtifactStore.getState().selectedArtifactId).toBe("art_jump");
      expect(onClose).toHaveBeenCalled();
    });

    it("FF1 — seeded row WITHOUT sampleArtifactId stays as a plain (non-clickable) list item", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([], {
        seededStances: [
          { concept: "FF1 cold seed", stance: "avoid", citedTimesElsewhere: 0 },
        ],
      }));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      const seededSection = await screen.findByTestId("ledger-seeded-section");
      const conceptText = within(seededSection).getByText("FF1 cold seed");
      expect(conceptText.closest("button")).toBeNull();
    });

    it("FF7 — 'Seed more' renders SeedAffordance inline (no toggle, matches cold-start gesture)", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([], {
        seededStances: [
          { concept: "alpha", stance: "avoid", citedTimesElsewhere: 0 },
        ],
      }));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      const seededSection = await screen.findByTestId("ledger-seeded-section");
      const seedMore = within(seededSection).getByTestId("ledger-seed-more");
      // Affordance is rendered directly — no "+ Seed more" toggle, no
      // Cancel. Matches the cold-start IdleHome path: the input is
      // always visible.
      expect(within(seedMore).getByText(/seed more/i)).toBeInTheDocument();
      expect(within(seedMore).getByText(/seed your ledger/i)).toBeInTheDocument();
      expect(within(seedMore).queryByRole("button", { name: /^\+ seed more$/i })).toBeNull();
      expect(within(seedMore).queryByRole("button", { name: /^cancel$/i })).toBeNull();
    });

    it("DD1 — seeded section is HIDDEN when seededStances is empty", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([
        { concept: "alpha", source: "session", citationCount: 3, sampleArtifactId: "art_a" },
      ]));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      await screen.findByText("alpha");
      expect(screen.queryByTestId("ledger-seeded-section")).toBeNull();
    });

    it("rows without a sampleArtifactId render as plain (non-clickable) list items", async () => {
      vi.stubGlobal("fetch", mockLedgerFetch([
        { concept: "no-sample-stance", source: "session", citationCount: 1 },
      ]));
      render(<LedgerDrawer onClose={() => {}} initialTab="ledger" />);
      await screen.findByText("no-sample-stance");
      expect(screen.queryByRole("button", { name: /jump to a citing artifact/i })).toBeNull();
    });
  });
});
