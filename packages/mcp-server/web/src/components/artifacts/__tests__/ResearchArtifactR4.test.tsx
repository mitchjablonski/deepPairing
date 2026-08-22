import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { ResearchArtifact } from "../ResearchArtifact";
import { researchArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { useArtifactStore } from "../../../stores/artifact";
import { resetLedgerStoreForTests, type LedgerDigest } from "../../../stores/ledger";

// R4 (#284) — P-A `concept` on a finding → ledger-aware ConceptBadge in the
// research renderer (which rendered ZERO concept UI before); P-B `visuals`
// surfacing through the shared ArtifactVisuals block.

/** The fixture research artifact with a concept on its first finding + a visual. */
const researchWithR4: Artifact = {
  ...researchArtifact,
  id: "art_research_r4",
  content: {
    ...(researchArtifact.content as Record<string, unknown>),
    // Only keep the first finding, and stamp a concept on it.
    findings: [
      {
        ...(researchArtifact.content as { findings: any[] }).findings[0],
        concept: {
          name: "password-hash work factor tuning",
          oneLineExplanation: "the cost should make brute-force impractical at today's hardware",
        },
      },
    ],
    visuals: [
      { id: "sys", kind: "diagram", title: "The auth flow", source: "graph TD; Login-->Verify-->Session" },
    ],
  },
};

beforeEach(() => {
  useArtifactStore.getState().reset();
  useArtifactStore.getState().addArtifact(researchWithR4);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("ResearchArtifact — R4 P-A concept badge", () => {
  it("renders the ledger-aware ConceptBadge inline on a finding that carries a concept", () => {
    render(<ResearchArtifact artifact={researchWithR4} />);
    // The badge names the concept (its aria-label starts "Concept: <name>").
    expect(screen.getByRole("button", { name: /Concept: password-hash work factor tuning/i })).toBeInTheDocument();
  });

  it("a finding WITHOUT a concept renders no badge (back-compat: absent = unchanged)", () => {
    const noConcept: Artifact = {
      ...researchWithR4,
      id: "art_research_noconcept",
      content: {
        ...(researchWithR4.content as Record<string, unknown>),
        findings: [{ category: "perf", detail: "N+1 query", significance: "medium" }],
        visuals: [],
      },
    };
    useArtifactStore.getState().addArtifact(noConcept);
    render(<ResearchArtifact artifact={noConcept} />);
    expect(screen.queryByRole("button", { name: /^Concept:/i })).not.toBeInTheDocument();
  });
});

describe("ResearchArtifact — R4 P-B visuals", () => {
  it("renders an attached diagram through the shared ArtifactVisuals block", () => {
    render(<ResearchArtifact artifact={researchWithR4} />);
    expect(screen.getByText(/Visuals \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/The auth flow/i)).toBeInTheDocument();
  });
});

// R4 P-A (LOW #2) — the badge is LEDGER-AWARE, not just present. Seed a digest
// that knows the concept, then assert (a) the "seen N×" recurrence label + the
// stance render on the badge, and (b) clicking through fires dp:open-your-taste
// with the ledger's CANONICAL name (the drawer's exact-match highlight keys off
// it) — not merely that the badge toggles aria-expanded.
const SEEDED_DIGEST: LedgerDigest = {
  shapedThisProject: 0,
  nearMissesThisProject: 0,
  blockedThisProject: 0,
  sessionsTouched: 0,
  topCitedStances: [],
  seededStances: [
    { concept: "password-hash work factor tuning", stance: "avoid", citedTimesElsewhere: 3 },
  ],
  globalLedger: { concepts: 1, projects: 2, multiProjectConcepts: 1 },
};

describe("ResearchArtifact — R4 P-A ledger-aware concept badge", () => {
  beforeEach(() => {
    resetLedgerStoreForTests();
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(researchWithR4);
    // The badge's ensureLedgerSubscriptions() refetches /api/ledger/digest on
    // mount — return the seeded digest so recurrence resolves.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: any) =>
        String(url).includes("/api/ledger/digest")
          ? Promise.resolve({ ok: true, json: async () => SEEDED_DIGEST })
          : Promise.resolve({ ok: true, json: async () => ({}) }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLedgerStoreForTests();
  });

  it("shows the 'seen N×' recurrence label + the stance once the digest is known", async () => {
    render(<ResearchArtifact artifact={researchWithR4} />);
    // The aria-label folds in both the recurrence count and the stance.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: /Concept: password-hash work factor tuning, seen 3 times, you avoid this/i,
        }),
      ).toBeInTheDocument(),
    );
    // And the visible chips render too.
    expect(screen.getByText(/seen 3×/i)).toBeInTheDocument();
    expect(screen.getByText(/you avoid this/i)).toBeInTheDocument();
  });

  it("clicking through fires dp:open-your-taste with the ledger's canonical concept name", async () => {
    const user = userEvent.setup();
    const details: any[] = [];
    const handler = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener("dp:open-your-taste", handler);
    try {
      render(<ResearchArtifact artifact={researchWithR4} />);
      const badge = await screen.findByRole("button", {
        name: /Concept: password-hash work factor tuning, seen 3 times/i,
      });
      await user.click(badge); // expand the panel
      const viewLink = await screen.findByRole("button", { name: /View in your ledger/i });
      await user.click(viewLink);
      await waitFor(() => expect(details).toHaveLength(1));
      expect(details[0]).toMatchObject({
        initialTab: "ledger",
        highlightConcept: "password-hash work factor tuning",
      });
    } finally {
      window.removeEventListener("dp:open-your-taste", handler);
    }
  });
});
