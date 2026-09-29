import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArtifactPanel } from "../ArtifactPanel";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import { WAITING_TONE } from "../../lib/waitingTone";

/**
 * #430 PR 1d (docs/design/attention-hierarchy.md §2.8, §8 1d) — waiting-on-the-
 * agent is ONE blue token everywhere, including the `revised` sidebar dot (was
 * violet) — and it is never colour-only (glyph + label stay).
 */
const art = (id: string, status: string, title: string) => ({
  id, sessionId: "s1", type: "research", version: 1, parentId: null, title, status,
  content: { summary: "s", findings: [] }, agentReasoning: null,
  createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
}) as any;

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ connected: false, agentActivityAt: null, agentActiveSince: null, activeSessions: [] } as any);
});

describe("#430 PR 1d — the waiting-on-agent colour token", () => {
  it("the token is the blue family (not violet)", () => {
    for (const cls of Object.values(WAITING_TONE)) {
      expect(cls).toContain("accent-blue");
      expect(cls).not.toContain("violet");
    }
  });

  it("a `revised` artifact's sidebar dot and header chip use the waiting token, with ↻ and a label", () => {
    useArtifactStore.getState().addArtifact(art("rev", "revised", "Backfill plan"));
    render(<ArtifactPanel />);
    const dot = screen.getAllByLabelText("Revision requested").find((el) => el.textContent === "↻")!;
    expect(dot.className).toContain(WAITING_TONE.dot);
    expect(dot.className).not.toContain("violet");
    const chip = screen.getAllByText(/Revision requested/).find((el) => el.className.includes("rounded"))!;
    expect(chip.className).toContain(WAITING_TONE.chip);
  });

});
