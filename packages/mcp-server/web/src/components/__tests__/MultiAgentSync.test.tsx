import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { MultiAgentSync } from "../ArtifactPanel";
import { useReplayStore } from "../../stores/replay";
import { isBackfilled, REFRESH_SESSION_EVENT } from "../../stores/artifact";
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

describe("#656 item 2 — accepted sibling baseline", () => {
  const session = (count = 1) => ({ sessionId: "sess_B", title: "B", project: "p", artifactCount: count, live: true });
  const refresh = () => fireEvent(window, new CustomEvent(REFRESH_SESSION_EVENT, { detail: { sessionId: "sess_B" } }));
  function transport() {
    const requests: Array<{ signal?: AbortSignal; resolve: (response: Response) => void }> = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => requests.push({ signal: init?.signal ?? undefined, resolve }))));
    return {
      requests,
      async deliver(index: number, artifacts: unknown, status = 200) {
        const request = requests[index];
        if (!request) throw new Error("Expected deferred sibling request");
        await act(async () => {
          request.resolve(new Response(JSON.stringify({ artifacts, comments: [], decisions: [] }), { status }));
          await Promise.resolve();
        });
      },
    };
  }
  beforeEach(() => {
    useReplayStore.setState({ active: false, exiting: false, cursor: "" });
    useConnectionStore.setState({ projectRoot: "/p", activeSessions: [session()] });
    useArtifactStore.getState().addArtifact(artifact("a", "sess_tab"));
  });
  it("keeps in-flight live unread, suppresses only new history, then marks later polled work unread across a real remount", async () => {
    const network = transport();
    const mounted = render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    act(() => useArtifactStore.getState().addArtifact(artifact("b-live", "sess_B")));
    await network.deliver(0, [artifact("b-history", "sess_B"), artifact("b-live", "sess_B")]);
    expect(useArtifactStore.getState().unreadIds).toEqual(["b-live"]);
    mounted.unmount();
    act(() => useConnectionStore.setState({ activeSessions: [session(3)] }));
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(2));
    await network.deliver(1, [artifact("b-history", "sess_B"), artifact("b-live", "sess_B"), artifact("b-new", "sess_B")]);
    expect(useArtifactStore.getState().unreadIds).toEqual(["b-live", "b-new"]);
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a");
  });
  it("accepts empty history without stopping empty-session polling; its first later artifact is live", async () => {
    const network = transport();
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    await network.deliver(0, []);
    // Existing empty-session backoff remains 30s; advance its clock, not an arbitrary sleep.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      act(refresh);
      await waitFor(() => expect(network.requests).toHaveLength(2));
      await network.deliver(1, [artifact("first-live", "sess_B")]);
      expect(useArtifactStore.getState().unreadIds).toEqual(["first-live"]);
      expect(isBackfilled("first-live")).toBe(false);
    } finally { clock.mockRestore(); }
  });
  it.each([null, [{ id: "bad", sessionId: "wrong-owner" }], "failed-http"])("does not consume malformed history %j", async (invalid) => {
    const network = transport();
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    await network.deliver(0, invalid === "failed-http" ? [] : invalid, invalid === "failed-http" ? 503 : 200);
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["a"]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    try {
      act(refresh);
      await waitFor(() => expect(network.requests).toHaveLength(2));
      await network.deliver(1, [artifact("history", "sess_B")]);
      expect(useArtifactStore.getState().unreadIds).toEqual([]);
    } finally { clock.mockRestore(); }
  });
  it("old finally cannot clear a replacement flight after true unmount", async () => {
    const network = transport();
    const mounted = render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    mounted.unmount();
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(2));
    expect(network.requests[0]?.signal?.aborted).toBe(true);
    await network.deliver(0, [artifact("stale", "sess_B")]);
    act(refresh);
    expect(network.requests).toHaveLength(2); // Replacement still owns single-flight.
    await network.deliver(1, [artifact("accepted", "sess_B")]);
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["a", "accepted"]);
    expect(useArtifactStore.getState().unreadIds).toEqual([]);
  });
  it.each(["hidden", "replay", "binding", "reset"])("rejects a stale %s roundtrip response without consuming baseline", async (mode) => {
    const network = transport();
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    if (mode === "hidden") {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => fireEvent(document, new Event("visibilitychange")));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => fireEvent(document, new Event("visibilitychange")));
    } else if (mode === "replay") {
      act(() => useReplayStore.setState({ active: true }));
      act(() => useReplayStore.setState({ active: false }));
    } else if (mode === "binding") {
      act(() => useConnectionStore.setState({ sessionId: "other" }));
      act(() => useConnectionStore.setState({ sessionId: "sess_tab" }));
    } else {
      act(() => useArtifactStore.getState().reset());
      act(() => useArtifactStore.getState().addArtifact(artifact("a", "sess_tab")));
    }
    await waitFor(() => expect(network.requests.length).toBeGreaterThan(1));
    await network.deliver(0, [artifact("stale", "sess_B")]);
    const last = network.requests.length - 1;
    await network.deliver(last, [artifact("accepted", "sess_B")]);
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["a", "accepted"]);
    expect(useArtifactStore.getState().unreadIds).toEqual([]);
  });
  it("fulfills an unknown explicit target only after the accepted first history batch", async () => {
    const network = transport();
    useArtifactStore.getState().bindAgentFilter("sess_tab", "/p");
    useArtifactStore.getState().chooseAgentFilter("sess_tab");
    useArtifactStore.getState().openArtifact("b-target");
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    await network.deliver(0, [artifact("b-other", "sess_B"), artifact("b-target", "sess_B")]);
    expect(useArtifactStore.getState().pendingOpen).toBeNull();
    expect(useArtifactStore.getState().selectedArtifactId).toBe("b-target");
    expect(useArtifactStore.getState().agentFilter).toBe("sess_B");
    expect(useConnectionStore.getState().sessionId).toBe("sess_tab");
    expect(useArtifactStore.getState().unreadIds).toEqual([]);
  });

  it("membership effect churn retains the baseline and does not refetch unchanged loaded history", async () => {
    const network = transport();
    render(<MultiAgentSync />);
    await waitFor(() => expect(network.requests).toHaveLength(1));
    await network.deliver(0, [artifact("history", "sess_B")]);
    act(() => useConnectionStore.setState({ activeSessions: [session(), { sessionId: "sess_C", title: "C", project: "p", artifactCount: 0 }] }));
    await waitFor(() => expect(network.requests).toHaveLength(2)); // C only; B is unchanged.
    await network.deliver(1, []);
    act(() => useConnectionStore.setState({ activeSessions: [session(2)] }));
    await waitFor(() => expect(network.requests).toHaveLength(3));
    await network.deliver(2, [artifact("history", "sess_B"), artifact("live", "sess_B")]);
    expect(useArtifactStore.getState().unreadIds).toEqual(["live"]);
  });

});
