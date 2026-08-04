import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useArtifactStore } from "../../stores/artifact";
import { ArtifactPanel } from "../ArtifactPanel";

/**
 * The sidebar keeps a deep session scannable: only the most-recent N artifacts
 * show by default; older ones collapse behind a "Show N older" toggle.
 */
const mk = (i: number) =>
  ({
    id: `art_${i}`,
    type: "research",
    title: `Artifact ${i}`,
    status: "draft",
    version: 1,
    createdAt: `2026-06-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    content: { summary: "s", findings: [] },
  }) as any;

describe("ArtifactSidebar — collapse older artifacts", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    // 13 artifacts → 10 recent shown, 3 collapsed.
    for (let i = 0; i < 13; i++) useArtifactStore.getState().addArtifact(mk(i));
  });

  it("shows a 'Show N older' toggle and hides the oldest by default; reveals on click", () => {
    // addArtifact auto-selects the first artifact added (art_0, the oldest),
    // and the sidebar force-keeps the SELECTED artifact visible — so select a
    // recent one to exercise the plain "collapse the oldest" path. With the
    // selection on a recent item, the 3 oldest (0,1,2) fall outside the top-10.
    useArtifactStore.getState().selectArtifact("art_12");
    render(<ArtifactPanel />);
    expect(screen.getByText("▾ Show 3 older")).toBeInTheDocument();
    expect(screen.queryByText("Artifact 0")).not.toBeInTheDocument();
    // A recent one is visible. (In flow grouping each artifact is also its own
    // group header, so its title appears twice — use queryAllByText.)
    expect(screen.queryAllByText("Artifact 12").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("▾ Show 3 older"));
    // Now the oldest is revealed and the toggle flips.
    expect(screen.queryAllByText("Artifact 0").length).toBeGreaterThan(0);
    expect(screen.getByText("▴ Show fewer")).toBeInTheDocument();
  });

  it("force-keeps the selected artifact visible even when it's old", () => {
    // Select the oldest; it must remain visible despite being outside top-10.
    useArtifactStore.getState().selectArtifact("art_0");
    render(<ArtifactPanel />);
    expect(screen.queryAllByText("Artifact 0").length).toBeGreaterThan(0);
    // Only the 2 remaining old ones (1,2) are hidden.
    expect(screen.getByText("▾ Show 2 older")).toBeInTheDocument();
  });
});

/**
 * #189 — in the default Flow grouping a singleton group's ALL-CAPS header is
 * just the lone artifact's own title, one line above the row that already shows
 * it. Render the group header ONLY when the flow holds ≥2 items.
 */
describe("ArtifactSidebar — #189 flow-singleton header collapse", () => {
  beforeEach(() => useArtifactStore.getState().reset());

  it("renders NO group header when a flow holds a single artifact", () => {
    // Default grouping is Flow (fresh tab). One unrelated artifact = one
    // singleton flow → the repeated-title header is suppressed.
    useArtifactStore.getState().addArtifact(mk(1));
    render(<ArtifactPanel />);
    expect(screen.queryByTestId("sidebar-group-header")).not.toBeInTheDocument();
  });

  it("renders exactly one group header once a flow holds ≥2 artifacts", () => {
    // b joins a's causal chain via relatedArtifactIds → ONE flow of 2 items,
    // which DOES get a header (the shared root's title now names a real group).
    useArtifactStore.getState().addArtifact(mk(1));
    useArtifactStore.getState().addArtifact({ ...mk(2), relatedArtifactIds: ["art_1"] } as any);
    render(<ArtifactPanel />);
    const headers = screen.getAllByTestId("sidebar-group-header");
    expect(headers.length).toBe(1);
  });
});
