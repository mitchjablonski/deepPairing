import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { enterSessionReplay } from "../session-replay";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";

/**
 * Fix 3 — enterSessionReplay is the shared cross-session navigation scheme
 * extracted from SessionBrowser.loadSession and reused by the project-wide
 * decisions view. It had ZERO direct coverage: a broken extraction (dropped
 * reset / enterReplay / setCursor / selectArtifact) would ship green because
 * ProjectDecisionsModal mocks it and SessionBrowser has no nav test. This pins
 * EVERY side effect against the REAL stores (no mocks of the stores) so the
 * extraction can't silently regress.
 */

const SESSION_STATE = {
  sessionId: "s1",
  artifacts: [
    { id: "a1", sessionId: "s1", type: "decision", version: 1, parentId: null, title: "Which cache?", status: "approved", content: {}, createdAt: "2026-07-01T10:00:00Z", updatedAt: "2026-07-01T10:05:00Z" },
    { id: "a2", sessionId: "s1", type: "research", version: 1, parentId: null, title: "Audit", status: "draft", content: {}, createdAt: "2026-07-01T09:00:00Z", updatedAt: "2026-07-01T09:00:00Z" },
  ],
  comments: [
    { id: "c1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "human", content: "why?", acknowledged: false, createdAt: "2026-07-01T10:10:00Z" },
  ],
  decisions: [
    { decisionId: "d1", artifactId: "a1", context: "Which cache?", options: [], acknowledged: true, response: { optionId: "o1" }, createdAt: "2026-07-01T10:00:00Z", resolvedAt: "2026-07-01T10:05:00Z" },
  ],
  planReviews: [],
};

function stubFetch(sessionOk: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      // enterReplay fetches annotations; always resolve those empty.
      if (typeof url === "string" && url.includes("/annotations")) {
        return Promise.resolve({ ok: true, json: async () => ({ annotations: [] }) });
      }
      return Promise.resolve({
        ok: sessionOk,
        status: sessionOk ? 200 : 500,
        json: async () => SESSION_STATE,
      });
    }),
  );
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  // Reset replay via setState (not exitReplay, whose async rehydrate would fire
  // a fetch to /api/active-sessions we don't stub).
  useReplayStore.setState({
    active: false, sessionId: null, events: [], cursor: "", playing: false,
    speed: 1, annotations: [], decisions: [],
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enterSessionReplay", () => {
  it("loads the session, enters replay, and lands on the focused artifact", async () => {
    stubFetch(true);
    const ok = await enterSessionReplay("s1", "a1");
    expect(ok).toBe(true);

    const art = useArtifactStore.getState();
    // Artifacts + comments were loaded into the live store.
    expect(art.artifacts.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(art.comments["a1"]?.map((c) => c.id)).toEqual(["c1"]);
    // Agent-acknowledged decision receipt re-seeded (so it doesn't show a false
    // "will pick it up").
    expect(art.acknowledgedDecisions["d1"]).toBe(true);
    // Landed on the focused artifact.
    expect(art.selectedArtifactId).toBe("a1");

    const replay = useReplayStore.getState();
    expect(replay.active).toBe(true);
    expect(replay.sessionId).toBe("s1");
    // Cursor advanced to the focused artifact's creation event.
    expect(replay.cursor).toBe("2026-07-01T10:00:00Z");
    expect(replay.decisions.map((d) => d.decisionId)).toEqual(["d1"]);
  });

  it("enters replay without a focus when no artifactId is given", async () => {
    stubFetch(true);
    const ok = await enterSessionReplay("s1");
    expect(ok).toBe(true);
    expect(useReplayStore.getState().active).toBe(true);
    // No forced selection to a focus id; the store's own default pick applies.
    expect(useArtifactStore.getState().artifacts).toHaveLength(2);
  });

  it("on a non-2xx session load: returns false and does NOT reset the live store or enter replay", async () => {
    // Pre-seed the live store — the guard must not wipe it on a failed load.
    const liveArtifact: Artifact = {
      id: "live_1", sessionId: "live", type: "spec", version: 1, parentId: null,
      title: "Live work", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-07-09T00:00:00Z", updatedAt: "2026-07-09T00:00:00Z",
    };
    useArtifactStore.getState().addArtifact(liveArtifact);

    stubFetch(false);
    const ok = await enterSessionReplay("s_missing", "a1");
    expect(ok).toBe(false);
    // The live store is untouched (no reset), and replay never activated.
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["live_1"]);
    expect(useReplayStore.getState().active).toBe(false);
  });
});
