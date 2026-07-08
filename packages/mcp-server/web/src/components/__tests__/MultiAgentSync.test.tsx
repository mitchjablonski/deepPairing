import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MultiAgentSync } from "../ArtifactPanel";
import { useArtifactStore } from "../../stores/artifact";
import { useConnectionStore } from "../../stores/connection";
import type { Artifact } from "@deeppairing/shared";

/**
 * Bug B — a session with ONE stray artifact (e.g. a global-client tab that
 * received session B's `artifact_created` broadcast) used to be treated as
 * "fully loaded": the loader gated its /api/live-session/:id fetch on "do we
 * hold any artifact from B", so B's OLDER artifacts never backfilled and only
 * the newest showed. The loader must still fetch B's full state and merge the
 * older artifacts even when a stray artifact already sits in the store.
 */
function artifact(id: string, sessionId: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId,
    type: "research",
    version: 1,
    parentId: null,
    title: `Artifact ${id}`,
    status: "draft",
    content: {},
    agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  useConnectionStore.setState({ activeSessions: [], sessionId: "sess_tab" } as any);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useConnectionStore.setState({ activeSessions: [] } as any);
});

describe("Bug B — MultiAgentSync backfills a session that already has a stray artifact", () => {
  it("STILL fetches /api/live-session/B and merges B's older artifacts", async () => {
    // The store already holds ONE (newest) artifact from session B — the stray
    // that a global-client broadcast delivered.
    useArtifactStore.getState().addArtifact(artifact("b_newest", "sess_B"));

    // The daemon serves B's full state: the newest PLUS an older artifact.
    const fullState = {
      artifacts: [
        artifact("b_older", "sess_B", { createdAt: "2026-04-16T09:00:00.000Z" }),
        artifact("b_newest", "sess_B"),
      ],
      comments: [],
    };
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/live-session/sess_B")) {
        return Promise.resolve(new Response(JSON.stringify(fullState), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchSpy);

    // B is an active session on THIS daemon.
    useConnectionStore.setState({ activeSessions: [
      { sessionId: "sess_B", title: "B", project: "p", artifactCount: 2, live: true },
    ] } as any);

    render(<MultiAgentSync />);

    // The pre-fix gate ("we already hold an artifact from B") would have SKIPPED
    // this fetch entirely. It must fire.
    await waitFor(() => {
      expect(fetchSpy.mock.calls.some(([u]) => String(u).includes("/api/live-session/sess_B"))).toBe(true);
    });

    // And B's older artifact must now be in the store alongside the stray one.
    await waitFor(() => {
      const ids = useArtifactStore.getState().artifacts.map((a) => a.id);
      expect(ids).toContain("b_older");
      expect(ids).toContain("b_newest");
    });
  });

  it("does NOT re-fetch a session once it has been fully backfilled", async () => {
    const fullState = { artifacts: [artifact("b1", "sess_B")], comments: [] };
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify(fullState), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    useConnectionStore.setState({ activeSessions: [
      { sessionId: "sess_B", title: "B", project: "p", artifactCount: 1, live: true },
    ] } as any);

    render(<MultiAgentSync />);

    await waitFor(() => {
      expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes("/api/live-session/sess_B")).length).toBe(1);
    });
    // The 5s interval ticks are backoff/loaded-gated; the initial sync fetches
    // once and the fully-loaded gate prevents an immediate second fetch.
    const initialCount = fetchSpy.mock.calls.filter(([u]) => String(u).includes("/api/live-session/sess_B")).length;
    expect(initialCount).toBe(1);
  });
});
