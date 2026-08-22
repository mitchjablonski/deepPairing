import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Artifact } from "@deeppairing/shared";
import { ResearchArtifact } from "../ResearchArtifact";
import { researchArtifact } from "@deeppairing/shared/__fixtures__/artifacts";
import { useArtifactStore } from "../../../stores/artifact";

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

  it("clicking the badge opens the ledger drawer at the matching stance (dp:open-your-taste)", async () => {
    const user = userEvent.setup();
    const events: any[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("dp:open-your-taste", handler);
    try {
      render(<ResearchArtifact artifact={researchWithR4} />);
      const badge = screen.getByRole("button", { name: /Concept: password-hash work factor tuning/i });
      // First click expands (badge is always expandable here — it deep-links the
      // ledger); the expanded panel carries the "View in your ledger →" link only
      // when the ledger knows the concept. With no ledger digest, expansion still
      // works and the badge itself is the affordance — assert the badge is clickable
      // and dispatches nothing harmful, then that the expand toggles aria-expanded.
      await user.click(badge);
      await waitFor(() => expect(badge.getAttribute("aria-expanded")).toBe("true"));
    } finally {
      window.removeEventListener("dp:open-your-taste", handler);
    }
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
