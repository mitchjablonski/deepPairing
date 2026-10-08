import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Artifact } from "@deeppairing/shared";
import { enterSessionReplay, openSessionReplay } from "../session-replay";
import { beginSessionTransition } from "../session-transition";
import { useArtifactStore } from "../../stores/artifact";
import { useReplayStore } from "../../stores/replay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

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
  requests: [
    { id: "req1", sessionId: "s1", text: "Explain this", intent: "explain", createdAt: "2026-07-01T10:02:00Z" },
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
    active: false, exiting: false, sessionId: null, events: [], cursor: "", playing: false,
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
    expect(art.resolvedDecisions["d1"]).toMatchObject({ optionId: "o1" });
    expect(art.requests.map((request) => request.id)).toEqual(["req1"]);
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

  it("uses a generation, not the session string, for reversed A -> B -> A responses", async () => {
    const firstA = deferred<any>();
    const b = deferred<any>();
    const lastA = deferred<any>();
    vi.stubGlobal("fetch", vi.fn()
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(lastA.promise)
      .mockResolvedValue({ ok: true, json: async () => ({ annotations: [] }) }));

    const enteringA1 = enterSessionReplay("A");
    const enteringB = enterSessionReplay("B");
    const enteringA2 = enterSessionReplay("A");
    lastA.resolve({ ok: true, json: async () => ({
      ...SESSION_STATE, sessionId: "A",
      artifacts: [{ ...SESSION_STATE.artifacts[0], id: "new-A", sessionId: "A" }],
    }) });
    await enteringA2;
    b.resolve({ ok: true, json: async () => ({
      ...SESSION_STATE, sessionId: "B",
      artifacts: [{ ...SESSION_STATE.artifacts[0], id: "stale-B", sessionId: "B" }],
    }) });
    firstA.resolve({ ok: true, json: async () => ({
      ...SESSION_STATE, sessionId: "A",
      artifacts: [{ ...SESSION_STATE.artifacts[0], id: "old-A", sessionId: "A" }],
    }) });
    await Promise.all([enteringA1, enteringB]);

    expect(useReplayStore.getState().sessionId).toBe("A");
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["new-A"]);
  });
});

// #469 — callers must tell a genuine failure (show + retry) from a transition
// that lost to newer navigation or was cancelled (stay silent). Never rejects.
describe("openSessionReplay outcomes", () => {
  function expectUntouched() {
    expect(useReplayStore.getState().active).toBe(false);
    expect(useArtifactStore.getState().artifacts).toEqual([]);
  }

  it("opened on success", async () => {
    stubFetch(true);
    await expect(openSessionReplay("s1", "a1")).resolves.toEqual({ status: "opened" });
    expect(useReplayStore.getState().active).toBe(true);
  });

  it("failed/http on a non-2xx response", async () => {
    stubFetch(false);
    await expect(openSessionReplay("s1", "a1")).resolves.toMatchObject({ status: "failed", kind: "http" });
    expectUntouched();
  });

  it("failed/network (not a rejection) when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(openSessionReplay("s1", "a1")).resolves.toMatchObject({ status: "failed", kind: "network" });
    // The boolean wrapper no longer rejects either.
    await expect(enterSessionReplay("s1", "a1")).resolves.toBe(false);
    expectUntouched();
  });

  it("failed/invalid when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); },
    }));
    await expect(openSessionReplay("s1", "a1")).resolves.toMatchObject({ status: "failed", kind: "invalid" });
    expectUntouched();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "oops"],
    ["non-array artifacts", { artifacts: { a1: {} } }],
  ])("failed/invalid when the JSON is %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }));
    await expect(openSessionReplay("s1", "a1")).resolves.toMatchObject({ status: "failed", kind: "invalid" });
    expectUntouched();
  });

  it("superseded — not failed — when newer navigation starts mid-load, even if the load then fails", async () => {
    const pending = deferred<any>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise));
    const opening = openSessionReplay("s1", "a1");
    beginSessionTransition("other");
    pending.resolve({ ok: false, status: 500, json: async () => ({}) });
    await expect(opening).resolves.toEqual({ status: "superseded" });
    expectUntouched();
  });

  it("cancelled when its signal aborts before the replay commits", async () => {
    const pending = deferred<any>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(pending.promise));
    const controller = new AbortController();
    const opening = openSessionReplay("s1", "a1", { signal: controller.signal });
    controller.abort();
    pending.resolve({ ok: true, status: 200, json: async () => SESSION_STATE });
    await expect(opening).resolves.toEqual({ status: "cancelled" });
    expectUntouched();
  });
});

// #469 (Sol review) — a malformed HTTP-200 snapshot must be rejected BEFORE any
// store changes: the live frame survives, replay never activates, and nothing
// leaks as an unhandled rejection.
describe("openSessionReplay validates the snapshot before touching any store", () => {
  const LIVE: Artifact = {
    id: "live_1", sessionId: "live", type: "spec", version: 1, parentId: null,
    title: "Live work", status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-07-09T00:00:00Z", updatedAt: "2026-07-09T00:00:00Z",
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  let realEnterReplay: ReturnType<typeof useReplayStore.getState>["enterReplay"];

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    realEnterReplay = useReplayStore.getState().enterReplay;
    useArtifactStore.getState().addArtifact(LIVE);
  });
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    useReplayStore.setState({ enterReplay: realEnterReplay });
  });

  function serve(body: unknown) {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/annotations")) return Promise.resolve({ ok: true, json: async () => ({ annotations: [] }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    }));
  }
  async function expectLiveFrameKept() {
    await new Promise((r) => setTimeout(r, 0));
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["live_1"]);
    expect(useReplayStore.getState().active).toBe(false);
    expect(unhandled).toEqual([]);
  }

  const { comments: _c, ...NO_COMMENTS } = SESSION_STATE;
  it.each([
    ["a null artifact", { ...SESSION_STATE, artifacts: [null] }],
    ["an artifact missing createdAt", { ...SESSION_STATE, artifacts: [{ ...SESSION_STATE.artifacts[0], createdAt: undefined }] }],
    ["a comment with no target", { ...NO_COMMENTS, comments: [{ ...SESSION_STATE.comments[0], target: undefined }] }],
    ["a decision with non-array options", { ...SESSION_STATE, decisions: [{ ...SESSION_STATE.decisions[0], options: "o1" }] }],
    ["a null request", { ...SESSION_STATE, requests: [null] }],
    ["an error object", { error: "history unavailable" }],
    ["a different session's snapshot", { ...SESSION_STATE, sessionId: "someone-else" }],
  ])("rejects %s as failed/invalid and keeps the live frame", async (_label, body) => {
    serve(body);
    await expect(openSessionReplay("s1", "a1")).resolves.toMatchObject({ status: "failed", kind: "invalid" });
    await expectLiveFrameKept();
  });

  it("still opens a valid snapshot carrying extra (back-compat) fields", async () => {
    serve({ ...SESSION_STATE, futureField: { x: 1 }, artifacts: SESSION_STATE.artifacts.map((a) => ({ ...a, featureId: "f", extra: true })) });
    await expect(openSessionReplay("s1", "a1")).resolves.toEqual({ status: "opened" });
    expect(useArtifactStore.getState().artifacts.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
  });

  it("observes a rejecting replay init: failed, no unhandled rejection, replay not left active", async () => {
    serve(SESSION_STATE);
    useReplayStore.setState({
      enterReplay: async () => {
        useReplayStore.setState({ active: true });
        throw new TypeError("timeline exploded");
      },
    });
    await expect(openSessionReplay("s1", "a1")).resolves.toMatchObject({ status: "failed" });
    // Recovery handed to exitReplay (the normal live-frame restore path):
    // either already complete, or exiting with the write lock held.
    const replay = useReplayStore.getState();
    expect(!replay.active || replay.exiting).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });
});
