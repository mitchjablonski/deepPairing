import { describe, it, expect, beforeEach } from "vitest";
import { useArtifactStore } from "../artifact";

/**
 * L1 (#218) — selectDefaultOnHydration: the one-shot fallback that fills a
 * blank center pane after hydration. Guarded to `selectedArtifactId === null`
 * so it never overrides addArtifact's / restoreSelection's pick and never
 * steals focus mid-review. Prefers the first draft awaiting review; else the
 * earliest visible artifact (the served demo's hero rejected-research).
 *
 * `.dom.test.ts` for a real localStorage (the store touches it elsewhere).
 */
const mk = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    type: "research",
    title: id,
    status: "draft",
    version: 1,
    content: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as any;

/** Force selection to null WITHOUT going through addArtifact's auto-pick, to
 *  simulate a hydration that left nothing selected. */
function seedWithoutSelection(artifacts: any[]): void {
  useArtifactStore.setState({ artifacts, selectedArtifactId: null, unreadIds: [] });
}

describe("selectDefaultOnHydration (L1 #218)", () => {
  beforeEach(() => {
    useArtifactStore.getState().reset();
    localStorage.clear();
  });

  it("lands on the first DRAFT awaiting review (by createdAt) when nothing is selected", () => {
    seedWithoutSelection([
      mk("rejected-hero", { status: "rejected", createdAt: "2026-01-01T00:00:01.000Z" }),
      mk("draft-plan", { type: "plan", status: "draft", createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("draft-plan");
  });

  it("falls back to the earliest VISIBLE artifact when no draft awaits review (the demo's rejected hero)", () => {
    // The scripted demo: research rejected, then read-only explainer/debrief.
    seedWithoutSelection([
      mk("hero-research", { status: "rejected", createdAt: "2026-01-01T00:00:01.000Z" }),
      mk("explainer", { type: "explainer", status: "approved", createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("hero-research");
  });

  it("ignores superseded artifacts", () => {
    seedWithoutSelection([
      mk("dead", { status: "superseded", createdAt: "2026-01-01T00:00:01.000Z" }),
      mk("live", { status: "rejected", createdAt: "2026-01-01T00:00:02.000Z" }),
    ]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("live");
  });

  it("no-ops when something is already selected (never steals focus)", () => {
    useArtifactStore.setState({
      artifacts: [mk("a"), mk("b")],
      selectedArtifactId: "b",
      unreadIds: [],
    });
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("b");
  });

  it("no-ops when there are no visible (non-superseded) artifacts", () => {
    seedWithoutSelection([mk("dead", { status: "superseded" })]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });

  it("does not persist the fallback pick (leaves a saved cross-session selection intact)", () => {
    localStorage.setItem("dp-selected-artifact", "from-another-session");
    seedWithoutSelection([mk("here", { status: "rejected" })]);
    useArtifactStore.getState().selectDefaultOnHydration();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("here");
    expect(localStorage.getItem("dp-selected-artifact")).toBe("from-another-session");
  });
});
