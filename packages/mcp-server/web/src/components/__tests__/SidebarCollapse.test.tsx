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
    render(<ArtifactPanel />);
    // The 3 oldest (0,1,2) are collapsed by default.
    expect(screen.getByText("▾ Show 3 older")).toBeInTheDocument();
    expect(screen.queryByText("Artifact 0")).not.toBeInTheDocument();
    // A recent one is visible.
    expect(screen.getByText("Artifact 12")).toBeInTheDocument();

    fireEvent.click(screen.getByText("▾ Show 3 older"));
    // Now the oldest is revealed and the toggle flips.
    expect(screen.getByText("Artifact 0")).toBeInTheDocument();
    expect(screen.getByText("▴ Show fewer")).toBeInTheDocument();
  });
});
