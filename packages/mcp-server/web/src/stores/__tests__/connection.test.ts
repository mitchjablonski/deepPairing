import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConnectionAdapter } from "../../lib/connection-adapter";

/**
 * FakeAdapter — a controllable ConnectionAdapter we can push messages into
 * from tests. Follows the fakes-not-mocks preference: implements the full
 * real interface, just with in-memory triggers.
 */
class FakeAdapter implements ConnectionAdapter {
  messageHandler: ((data: any) => void) | null = null;
  connectHandler: (() => void) | null = null;
  disconnectHandler: (() => void) | null = null;
  connected = false;
  refreshUrlCalls = 0;
  switchedSessions: string[] = [];

  connect() { this.connected = true; this.connectHandler?.(); }
  disconnect() { this.connected = false; this.disconnectHandler?.(); }
  onMessage(h: (data: any) => void) { this.messageHandler = h; }
  onConnect(h: () => void) { this.connectHandler = h; }
  onDisconnect(h: () => void) { this.disconnectHandler = h; }
  refreshUrl() { this.refreshUrlCalls++; }
  switchSession(sessionId: string) { this.switchedSessions.push(sessionId); }

  fatalMismatchHandler: ((info: { liveProjectRoot?: string; liveHash: string }) => void) | null = null;
  onFatalMismatch(h: (info: { liveProjectRoot?: string; liveHash: string }) => void) { this.fatalMismatchHandler = h; }

  /** Test helper: deliver a message to the connection store. */
  emit(data: any) {
    this.messageHandler?.(data);
  }

  /** Test helper: simulate the adapter detecting a cross-project daemon (II3). */
  triggerFatalMismatch(info: { liveProjectRoot?: string; liveHash: string } = { liveHash: "other-hash" }) {
    this.fatalMismatchHandler?.(info);
  }
}

let activeAdapter: FakeAdapter;

vi.mock("../../lib/connection-adapter", () => ({
  createAdapter: () => activeAdapter,
}));

// Import AFTER the mock so the store picks up the fake
let useConnectionStore: typeof import("../connection").useConnectionStore;
let useArtifactStore: typeof import("../artifact").useArtifactStore;

beforeEach(async () => {
  activeAdapter = new FakeAdapter();
  // Reset module cache so each test re-imports a clean store
  vi.resetModules();
  const connMod = await import("../connection");
  const artMod = await import("../artifact");
  useConnectionStore = connMod.useConnectionStore;
  useArtifactStore = artMod.useArtifactStore;
  useArtifactStore.getState().reset();
  vi.stubGlobal("Notification", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Give the dynamic import("./artifact") inside handleMessage a tick to resolve. */
async function flush() {
  // The store does an ESM dynamic import per message; microtasks + a macrotask
  // cover the chain on all supported platforms.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("connection store — handleMessage dispatch", () => {
  it("C5 — hydrated flips true on the first `connected` payload", async () => {
    expect(useConnectionStore.getState().hydrated).toBe(false);
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", projectRoot: "/p", state: { sessionId: "s", artifacts: [], comments: [] } });
    await flush();
    expect(useConnectionStore.getState().hydrated).toBe(true);
  });

  it("hydrates artifact store on `connected` with state", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/home/mitch/proj",
      state: {
        sessionId: "sess_1",
        autonomyLevel: "balanced",
        artifacts: [
          { id: "a1", sessionId: "sess_1", type: "research", version: 1, parentId: null,
            title: "A", status: "draft", content: {}, agentReasoning: null,
            createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z" },
        ],
        comments: [
          { id: "c1", sessionId: "sess_1", target: { artifactId: "a1" }, parentCommentId: null,
            author: "human", content: "hi", acknowledged: false,
            createdAt: "2026-04-16T10:01:00.000Z" },
        ],
      },
    });
    await flush();

    const conn = useConnectionStore.getState();
    expect(conn.sessionId).toBe("sess_1");
    expect(conn.projectRoot).toBe("/home/mitch/proj");
    expect(conn.autonomyLevel).toBe("balanced");

    const art = useArtifactStore.getState();
    expect(art.artifacts).toHaveLength(1);
    expect(art.artifacts[0]!.id).toBe("a1");
    expect(art.comments["a1"]).toHaveLength(1);
  });

  it("HH1 — calls adapter.refreshUrl after `connected` arrives so the WS rebuilds with projectHash", async () => {
    // Pre-HH1 the URL was built once at construction (before
    // projectHash was known) and never updated. Every long-lived UI
    // session silently used the daemon's back-compat path and the
    // GG2 defense-in-depth never engaged. The connection store now
    // calls adapter.refreshUrl after `connected` so the next WS
    // upgrade carries the hash.
    useConnectionStore.getState().connect();
    expect(activeAdapter.refreshUrlCalls).toBe(0);
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/home/mitch/proj",
      projectHash: "abcd1234",
      state: { sessionId: "sess_hh1", autonomyLevel: "balanced", artifacts: [], comments: [] },
    });
    await flush();
    expect(activeAdapter.refreshUrlCalls).toBe(1);
    expect(useConnectionStore.getState().projectHash).toBe("abcd1234");
  });

  it("resets before hydrating so reconnect doesn't duplicate artifacts", async () => {
    // Seed the store as if a prior connect happened
    useArtifactStore.getState().addArtifact({
      id: "stale", sessionId: "sess_old", type: "research", version: 1, parentId: null,
      title: "Stale", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-04-16T09:00:00.000Z", updatedAt: "2026-04-16T09:00:00.000Z",
    });

    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "connected",
      state: {
        sessionId: "sess_fresh",
        autonomyLevel: "supervised",
        artifacts: [
          { id: "fresh", sessionId: "sess_fresh", type: "research", version: 1, parentId: null,
            title: "Fresh", status: "draft", content: {}, agentReasoning: null,
            createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z" },
        ],
      },
    });
    await flush();

    const art = useArtifactStore.getState();
    expect(art.artifacts.map((a) => a.id)).toEqual(["fresh"]);
  });

  it("appends artifacts on `artifact_created`", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "artifact_created",
      artifact: {
        id: "a1", sessionId: "s1", type: "plan", version: 1, parentId: null,
        title: "New plan", status: "draft", content: {}, agentReasoning: null,
        createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
      },
    });
    await flush();
    expect(useArtifactStore.getState().artifacts).toHaveLength(1);
  });

  it("updates status on `artifact_updated`", async () => {
    useArtifactStore.getState().addArtifact({
      id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null,
      title: "A", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    });

    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "artifact_updated", artifactId: "a1", status: "approved" });
    await flush();

    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("approved");
  });

  it("appends comments on `comment_added`", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "comment_added",
      comment: {
        id: "c1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null,
        author: "agent", content: "reply", acknowledged: true,
        createdAt: "2026-04-16T10:00:00.000Z",
      },
    });
    await flush();
    expect(useArtifactStore.getState().comments["a1"]).toHaveLength(1);
  });

  it("upserts (not duplicates) an existing comment on `comment_updated`", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "comment_added",
      comment: {
        id: "q1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null,
        author: "human", content: "why?", acknowledged: false, intent: "question",
        createdAt: "2026-04-16T10:00:00.000Z",
      },
    });
    await flush();

    activeAdapter.emit({
      type: "comment_updated",
      comment: {
        id: "q1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null,
        author: "human", content: "why?", acknowledged: false, intent: "question",
        humanResolvedAt: "2026-04-16T11:00:00.000Z",
        createdAt: "2026-04-16T10:00:00.000Z",
      },
    });
    await flush();

    const list = useArtifactStore.getState().comments["a1"];
    expect(list).toHaveLength(1); // upsert, not append
    expect((list![0] as any).humanResolvedAt).toBe("2026-04-16T11:00:00.000Z");
  });

  it("renames artifact on `artifact_renamed`", async () => {
    useArtifactStore.getState().addArtifact({
      id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null,
      title: "Old title", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    });

    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "artifact_renamed", artifactId: "a1", title: "New title" });
    await flush();

    expect(useArtifactStore.getState().artifacts[0]!.title).toBe("New title");
  });

  it("updates autonomyLevel on `preference_changed`", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "preference_changed", autonomyLevel: "autonomous" });
    await flush();
    expect(useConnectionStore.getState().autonomyLevel).toBe("autonomous");
  });

  it("flips artifact status to approved on `decision_resolved`", async () => {
    useArtifactStore.getState().addArtifact({
      id: "a1", sessionId: "s1", type: "decision", version: 1, parentId: null,
      title: "Which pattern?", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    });

    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "decision_resolved", artifactId: "a1", decisionId: "dec_1", optionId: "opt_x", reasoning: "why" });
    await flush();

    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("approved");
    // Bug3 — a cross-tab resolve records the choice so a remount opens resolved.
    expect(useArtifactStore.getState().resolvedDecisions["dec_1"]).toMatchObject({ optionId: "opt_x", reasoning: "why" });
  });

  it("Bug3 — hydrate seeds resolvedDecisions from data.state.decisions so a resolved decision survives a cold reload", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/p",
      state: {
        sessionId: "sess_r",
        artifacts: [
          { id: "art_dec", sessionId: "sess_r", type: "decision", version: 1, parentId: null,
            title: "Which cache?", status: "approved", content: { decisionId: "dec_r", context: "c", options: [] },
            agentReasoning: null, createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z" },
        ],
        comments: [],
        // The persisted DecisionRecord carries the human's response + resolvedAt
        // even before the agent has drained (acknowledged) it.
        decisions: [
          { decisionId: "dec_r", artifactId: "art_dec", acknowledged: false,
            response: { optionId: "o2", reasoning: "cheapest" },
            resolvedAt: "2026-04-16T10:05:00.000Z" },
        ],
      },
    });
    await flush();

    const resolved = useArtifactStore.getState().resolvedDecisions["dec_r"];
    expect(resolved).toMatchObject({
      optionId: "o2",
      reasoning: "cheapest",
      resolvedAt: "2026-04-16T10:05:00.000Z",
    });
  });

  describe("pair-tempo events (O7)", () => {
    it("pushes a 'preflight-block' hero toast on `preflight_blocked`", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "preflight_blocked",
        toolName: "present_options",
        source: "team",
        match: {
          concept: "global state",
          proposal: "add a global config store",
          reason: "breaks testability",
          via: "avoid",
          addedBy: "alex",
        },
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.kind).toBe("preflight-block");
      expect(toasts[0]!.hero?.source).toBe("team");
      expect(toasts[0]!.hero?.concept).toBe("global state");
      expect(toasts[0]!.hero?.addedBy).toBe("alex");
    });

    it("#168 — dedupes the hero toast: a replayed/re-delivered block does NOT re-fire it", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();
      useConnectionStore.getState().connect();

      const block = {
        type: "preflight_blocked",
        toolName: "present_findings",
        source: "session",
        match: { concept: "global mutable state for config", proposal: "Add a global mutable state singleton to hold config", reason: "broke testability", via: "concept" },
      };
      // Live delivery (t+5s), then the daemon's reconnect REPLAY of the same block.
      activeAdapter.emit(block);
      activeAdapter.emit({ ...block, replayed: true });
      await flush();

      expect(useToastStore.getState().toasts.filter((t) => t.kind === "preflight-block")).toHaveLength(1);

      // A genuinely DIFFERENT block is NOT suppressed by the dedupe.
      activeAdapter.emit({ ...block, match: { ...block.match, concept: "singleton service locator", proposal: "add a service-locator singleton" } });
      await flush();
      expect(useToastStore.getState().toasts.filter((t) => t.kind === "preflight-block")).toHaveLength(2);
    });

    it("#169 — ALSO persists the block into the PreflightBlockLog store (survives the 12s toast)", async () => {
      const { usePreflightBlockStore } = await import("../preflightBlocks");
      usePreflightBlockStore.getState().clear();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "preflight_blocked",
        toolName: "present_options",
        source: "session",
        match: {
          concept: "redis for caching",
          proposal: "add a redis cache",
          reason: "wrong question, not wrong options",
          via: "concept",
          rejectedAt: "2026-04-16T10:00:00.000Z",
        },
      });
      await flush();

      const blocks = usePreflightBlockStore.getState().blocks;
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.source).toBe("session");
      expect(blocks[0]!.concept).toBe("redis for caching");
      expect(blocks[0]!.reason).toBe("wrong question, not wrong options");
      expect(blocks[0]!.via).toBe("concept");
      expect(blocks[0]!.rejectedAt).toBe("2026-04-16T10:00:00.000Z");
      // The record carries a client id + timestamp so the log can key + sort it.
      expect(typeof blocks[0]!.id).toBe("string");
      expect(typeof blocks[0]!.at).toBe("string");
    });

    it("II3 — pushes a sticky 'reload to re-bind' toast on a fatal project mismatch (no silent rebind)", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect("s1");
      activeAdapter.triggerFatalMismatch({ liveHash: "different-project-hash", liveProjectRoot: "/other/project" });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => t.kind === "error" && t.ttl === 0 && /re-bind/i.test(t.body ?? ""))).toBe(true);
      expect(useConnectionStore.getState().connected).toBe(false);
    });

    it("pushes an info toast on `ledger_write` naming the CONCEPT, with the reason as the body", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "ledger_write",
        kind: "rejected",
        description: "Auth refactor: rolling your own JWT signing",
        concept: "hand-rolled JWT signing",
        reason: "maintenance overhead",
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.kind).toBe("info");
      // R2 — the toast names the cross-project memory KEY the human typed, not
      // the artifact title the agent minted. Pre-R2 this quoted `description`,
      // so a changeset reject told the user their new stance was
      // "packages/api/src/…ts — hoist the settings object".
      expect(toasts[0]!.title).toBe("Added to your Ledger: avoid — hand-rolled JWT signing");
      expect(toasts[0]!.title).not.toContain("Auth refactor");
      expect(toasts[0]!.body).toContain("maintenance overhead");
      // R2 — the 🧭 moved out of the title string into a named SVG mark.
      expect(toasts[0]!.title).not.toContain("🧭");
      expect(toasts[0]!.icon).toBe("compass");
    });

    it("falls back to the description when a ledger_write carries no concept", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();
      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "ledger_write",
        kind: "rejected",
        description: "Auth refactor: rolling your own JWT signing",
      });
      await flush();
      expect(useToastStore.getState().toasts[0]!.title).toContain("Auth refactor");
    });

    it("differentiates approved vs rejected in the ledger-write title", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();
      useConnectionStore.getState().connect();
      activeAdapter.emit({ type: "ledger_write", kind: "approved", description: "Service layer" });
      await flush();
      expect(useToastStore.getState().toasts[0]!.title).toContain("prefer — Service layer");
    });

    it("pushes a success toast on `question_answered` with a jump-to-answer action", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "question_answered",
        questionId: "cmt_q1",
        answerId: "cmt_a1",
        artifactId: "art_1",
        answerExcerpt: "because the repository layer would double-wrap the error",
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.kind).toBe("success");
      expect(toasts[0]!.title).toMatch(/question was answered/i);
      expect(toasts[0]!.action?.label).toMatch(/jump to answer/i);
    });

    it("BB9 — pushes a sticky error toast on `daemon_evicting` and flips connected=false", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      // Simulate the connect lifecycle setting connected=true.
      useConnectionStore.setState({ connected: true });
      activeAdapter.emit({
        type: "daemon_evicting",
        reason: "evicted_by_doctor",
        projectRoot: "/Users/alice/other-project",
        pid: 12345,
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.kind).toBe("error");
      expect(toasts[0]!.title).toMatch(/daemon shut down/i);
      expect(toasts[0]!.body).toContain("/Users/alice/other-project");
      expect(toasts[0]!.ttl).toBe(0); // sticky — user must dismiss
      expect(useConnectionStore.getState().connected).toBe(false);
    });

    it("pushes an info toast on `feedback_received` (Q5 pair-tempo signal)", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "feedback_received",
        commentId: "cmt_1",
        artifactId: "art_1",
        intent: "comment",
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.kind).toBe("info");
      expect(toasts[0]!.title).toMatch(/claude will see this/i);
    });

    it("L3 (#196) — a LIVE agent gets the 'next check' toast", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: true } as any] });
      activeAdapter.emit({ type: "feedback_received", commentId: "cmt_1" });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]!.title).toMatch(/next check/i);
      expect(toasts[0]!.title).not.toMatch(/resumes/i);
    });

    it("L3 (#196) — an EXITED agent gets the 'when the session resumes' toast, not the 30s promise", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      useConnectionStore.setState({ activeSessions: [{ sessionId: "s1", live: false } as any] });
      activeAdapter.emit({ type: "feedback_received", commentId: "cmt_1" });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts[0]!.title).toMatch(/when the session resumes/i);
      expect(toasts[0]!.title).not.toMatch(/next check/i);
      expect(toasts[0]!.body).not.toMatch(/every 30 seconds/i);
    });

    it("debounces `feedback_received` bursts — 2 emits in quick succession = 1 toast", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({ type: "feedback_received", commentId: "cmt_1" });
      await flush();
      activeAdapter.emit({ type: "feedback_received", commentId: "cmt_2" });
      await flush();

      // Two emits within the debounce window — only one toast.
      expect(useToastStore.getState().toasts).toHaveLength(1);
    });
  });
});

describe("connection store — lifecycle", () => {
  it("connect marks connected; disconnect clears", () => {
    const s = useConnectionStore.getState();
    s.connect();
    expect(useConnectionStore.getState().connected).toBe(true);
    s.disconnect();
    expect(useConnectionStore.getState().connected).toBe(false);
  });

  it("connect is idempotent — a second call does not create a second adapter", () => {
    const connectSpy = vi.spyOn(activeAdapter, "connect");
    useConnectionStore.getState().connect();
    useConnectionStore.getState().connect();
    // The adapter's connect() was called exactly once (the second store.connect
    // detects an existing adapter and returns early).
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("connection store — safe daemon recovery (#339)", () => {
  const artifact = (id: string, sessionId: string) => ({
    id, sessionId, type: "research", version: 1, parentId: null,
    title: id, status: "draft", content: {}, agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
  });
  const snapshot = (sessionId: string, artifacts: any[] = []) => ({
    sessionId, artifacts, comments: [], requests: [], decisions: [],
  });

  it("leaves an active historical replay and pending annotations untouched", async () => {
    const annotations = deferredResponse();
    const { useReplayStore } = await import("../replay");
    const { useToastStore } = await import("../toast");
    const fetchMock = vi.fn((url: string | URL | Request) =>
      String(url).includes("/annotations")
        ? annotations.promise
        : Promise.resolve(new Response(JSON.stringify(snapshot("A", [artifact("live", "A")])))));
    vi.stubGlobal("fetch", fetchMock);
    useConnectionStore.getState().connect();
    useConnectionStore.setState({ sessionId: "A" });

    const entering = useReplayStore.getState().enterReplay("historic", {
      artifacts: [artifact("historic", "historic") as any], comments: [],
    });
    useArtifactStore.getState().addArtifact(artifact("historic", "historic") as any);
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });

    annotations.resolve(new Response(JSON.stringify({
      annotations: [{ id: "historic-note", sessionId: "historic", targetEventId: "event", note: "note", tags: [], createdAt: "now" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await entering;
    await flush();

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/api/state"))).toBe(false);
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic"]);
    expect(useReplayStore.getState().annotations.map((item) => item.id)).toEqual(["historic-note"]);
    expect(useReplayStore.getState().active).toBe(true);
    expect(useToastStore.getState().toasts.some((toast) => toast.title.includes("Daemon restarted"))).toBe(true);
    useReplayStore.setState({ active: false, exiting: false });
  });

  it("keeps replay read-only with its historical frame when live exit hydration never arrives", async () => {
    const { useReplayStore, replayRehydrateSettled } = await import("../replay");
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ annotations: [] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: snapshot("A", [artifact("live-before-replay", "A")]) });
    await flush();

    await useReplayStore.getState().enterReplay("historic", {
      artifacts: [artifact("historic", "historic") as any], comments: [],
    });
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(artifact("historic", "historic") as any);

    vi.useFakeTimers();
    useReplayStore.getState().exitReplay();
    await replayRehydrateSettled();
    expect(activeAdapter.switchedSessions).toEqual(["A"]);
    expect(useReplayStore.getState()).toMatchObject({ active: true, exiting: true });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic"]);

    activeAdapter.emit({ type: "artifact_created", artifact: artifact("live-during-exit", "A") });
    await Promise.resolve();
    await Promise.resolve();
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic"]);

    activeAdapter.emit({ type: "connected" });
    await Promise.resolve();
    await Promise.resolve();
    expect(useReplayStore.getState()).toMatchObject({ active: true, exiting: true });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic"]);

    activeAdapter.emit({ type: "connected", state: {
      ...snapshot("A"), decisions: [null],
    } });
    await Promise.resolve();
    await Promise.resolve();
    expect(useReplayStore.getState()).toMatchObject({ active: true, exiting: true });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic"]);

    activeAdapter.emit({ type: "connected", state: {
      sessionId: "A", artifacts: [], comments: [],
    } });
    await Promise.resolve();
    await Promise.resolve();
    expect(useReplayStore.getState()).toMatchObject({ active: true, exiting: true });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic"]);

    await vi.advanceTimersByTimeAsync(10_000);
    const recovery = useToastStore.getState().toasts.find((toast) => toast.title.includes("Couldn't leave replay"));
    expect(recovery).toMatchObject({ kind: "error", ttl: 0, action: { label: "Retry" } });

    recovery!.action!.onClick();
    await replayRehydrateSettled();
    expect(activeAdapter.switchedSessions).toEqual(["A", "A"]);
    activeAdapter.emit({ type: "connected", state: snapshot("A", [artifact("live-after-retry", "A")]) });
    await vi.runAllTimersAsync();
    expect(useReplayStore.getState()).toMatchObject({ active: false, exiting: false });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["live-after-retry"]);

    await useReplayStore.getState().enterReplay("newer-history", {
      artifacts: [artifact("newer-history", "newer-history") as any], comments: [],
    });
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(artifact("newer-history", "newer-history") as any);
    recovery!.action!.onClick();
    expect(activeAdapter.switchedSessions).toEqual(["A", "A"]);
    expect(useReplayStore.getState()).toMatchObject({
      active: true, exiting: false, sessionId: "newer-history",
    });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["newer-history"]);
    vi.useRealTimers();
  });

  it("does not let a late replay-exit snapshot unlock a newer replay", async () => {
    const { useReplayStore, replayRehydrateSettled } = await import("../replay");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ annotations: [] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: snapshot("A", [artifact("live", "A")]) });
    await flush();

    await useReplayStore.getState().enterReplay("historic-1", {
      artifacts: [artifact("historic-1", "historic-1") as any], comments: [],
    });
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(artifact("historic-1", "historic-1") as any);
    useReplayStore.getState().exitReplay();
    await replayRehydrateSettled();

    await useReplayStore.getState().enterReplay("historic-2", {
      artifacts: [artifact("historic-2", "historic-2") as any], comments: [],
    });
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(artifact("historic-2", "historic-2") as any);
    activeAdapter.emit({ type: "connected", state: snapshot("A", [artifact("late-live", "A")]) });
    await flush();

    expect(useReplayStore.getState()).toMatchObject({
      active: true, exiting: false, sessionId: "historic-2",
    });
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["historic-2"]);
  });

  it("discards an A recovery after an A-B-A session transition", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();

    useConnectionStore.getState().switchSession("B");
    useConnectionStore.getState().switchSession("A");
    pending.resolve(new Response(JSON.stringify(snapshot("A", [artifact("stale-A", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();

    expect(useConnectionStore.getState().sessionId).toBe("A");
    expect(useArtifactStore.getState().artifacts).toEqual([]);
  });

  it.each(["already active", "entered before dispatch", "exiting"])(
    "protects the historical frame from live mutation messages when replay is %s",
    async (phase) => {
      const { useReplayStore } = await import("../replay");
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
      useConnectionStore.getState().connect();
      activeAdapter.emit({ type: "connected", state: snapshot("A", [artifact("historic", "historic")]) });
      await flush();
      const historicalState = useArtifactStore.getState();
      const enter = () => useReplayStore.getState().enterReplay("historic", {
        artifacts: historicalState.artifacts, comments: [],
      });
      if (phase !== "entered before dispatch") await enter();
      if (phase === "exiting") useReplayStore.setState({ exiting: true });

      for (const message of [
        { type: "artifact_created", artifact: artifact("live", "A") },
        { type: "artifact_updated", artifactId: "historic", status: "approved" },
        ...["plan_progress_updated", "changeset_review_updated", "artifact_content_updated"].map((type) => ({
          type, artifact: { ...artifact("historic", "A"), title: "live replacement" },
        })),
        { type: "comment_added", comment: { id: "c", target: { artifactId: "historic" }, content: "live" } },
        { type: "comment_updated", comment: { id: "c", target: { artifactId: "historic" }, content: "updated" } },
        { type: "request_added", request: { id: "r", sessionId: "A", prompt: "live" } },
        { type: "request_served", requestId: "r", artifactId: "historic" },
        { type: "artifact_renamed", artifactId: "historic", title: "live rename" },
        { type: "decision_resolved", artifactId: "historic", decisionId: "d", optionId: "o" },
        { type: "decisions_acknowledged", decisionIds: ["d"] },
      ]) activeAdapter.emit(message);
      if (phase === "entered before dispatch") await enter();
      await flush();
      expect(useArtifactStore.getState()).toEqual(historicalState);

      // The authoritative connected snapshot releases the exit write lock;
      // subsequent live events must resume normally.
      useReplayStore.setState({ exiting: true });
      activeAdapter.emit({ type: "connected", state: snapshot("A", [artifact("current", "A")]) });
      activeAdapter.emit({ type: "artifact_created", artifact: artifact("next", "A") });
      await flush();
      expect(useReplayStore.getState().active).toBe(false);
      expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["current", "next"]);
    },
  );

  it("discards a queued dynamic-import callback after a session switch", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();

    activeAdapter.emit({ type: "artifact_created", artifact: artifact("from-A", "A") });
    useConnectionStore.getState().switchSession("B");
    await flush();

    expect(useConnectionStore.getState().sessionId).toBe("B");
    expect(useArtifactStore.getState().artifacts).toEqual([]);
  });

  it("latest overlapping recovery preserves mutations buffered before and after it", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const stateResponses = [first.promise, second.promise];
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state")
        ? stateResponses.shift()!
        : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    activeAdapter.emit({ type: "artifact_created", artifact: artifact("before-second", "A") });
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    activeAdapter.emit({ type: "artifact_created", artifact: artifact("after-second", "A") });

    second.resolve(new Response(JSON.stringify(snapshot("A", [artifact("new", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    first.resolve(new Response(JSON.stringify(snapshot("A", [artifact("old", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id).sort()).toEqual([
      "after-second", "before-second", "new",
    ]);
  });

  it("discards a recovery response from a disconnected connection generation", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    useConnectionStore.getState().disconnect();
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [artifact("current", "A")], comments: [] } });
    await flush();

    pending.resolve(new Response(JSON.stringify(snapshot("A", [artifact("obsolete", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["current"]);
  });

  it("hydrates the snapshot and then replays a live event that arrived during fetch", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    activeAdapter.emit({ type: "artifact_created", artifact: artifact("live", "A") });
    await flush();
    pending.resolve(new Response(JSON.stringify(snapshot("A", [artifact("snapshot", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id).sort()).toEqual(["live", "snapshot"]);
  });

  it("drains buffered recovery events when a stateless connected frame supersedes the fetch", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: snapshot("A") });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    activeAdapter.emit({ type: "artifact_created", artifact: artifact("buffered", "A") });
    activeAdapter.emit({ type: "connected" });
    await flush();

    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["buffered"]);
    pending.resolve(new Response(JSON.stringify(snapshot("A", [artifact("obsolete", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useArtifactStore.getState().artifacts.map((item) => item.id)).toEqual(["buffered"]);
  });

  it("abandons an older snapshot rather than overwriting an optimistic rename", async () => {
    const recovery = deferredResponse();
    const rename = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/state")) return recovery.promise;
      if (target.includes("/rename")) return rename.promise;
      return Promise.resolve(new Response("{}"));
    }));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [artifact("a", "A")], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();

    const renamePromise = useArtifactStore.getState().renameArtifact("a", "optimistic");
    expect(useArtifactStore.getState().artifacts[0]?.title).toBe("optimistic");
    recovery.resolve(new Response(JSON.stringify(snapshot("A", [artifact("a", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useArtifactStore.getState().artifacts[0]?.title).toBe("optimistic");
    rename.resolve(new Response("{}", { status: 200 }));
    await renamePromise;
  });

  it("uses complete hydration and only reports recovery after success", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/state") ? new Response(JSON.stringify({
      sessionId: "A",
      artifacts: [artifact("decision-art", "A")], comments: [],
      requests: [{ id: "request-1", sessionId: "A", prompt: "help", createdAt: "now" }],
      decisions: [
        { decisionId: "acked", acknowledged: true },
        { decisionId: "resolved", acknowledged: false, response: { optionId: "option-2", reasoning: "best" }, resolvedAt: "then" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }) : new Response("{}")));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();

    const state = useArtifactStore.getState();
    expect(state.requests).toHaveLength(1);
    expect(state.acknowledgedDecisions).toMatchObject({ acked: true });
    expect(state.resolvedDecisions.resolved).toMatchObject({ optionId: "option-2", reasoning: "best" });
    expect(state.selectedArtifactId).toBe("decision-art");
    expect(useToastStore.getState().toasts.some((t) => t.title.includes("session state refetched"))).toBe(true);
  });

  it.each([
    ["null payload", null],
    ["malformed arrays", { sessionId: "A", artifacts: null, comments: [], requests: [], decisions: [] }],
    ["different session", snapshot("B", [artifact("from-B", "B")])],
    ["hydration exception", { ...snapshot("A", [artifact("partial", "A")]), decisions: [null] }],
  ])("preserves valid state and drains buffered events for an HTTP 200 %s", async (_label, payload) => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [artifact("valid", "A")], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    activeAdapter.emit({ type: "artifact_created", artifact: artifact("buffered", "A") });
    activeAdapter.emit({ type: "artifact_renamed", artifactId: "buffered", title: "latest title" });
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["valid"]);
    pending.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["valid", "buffered"]);
    expect(useArtifactStore.getState().artifacts[1]?.title).toBe("latest title");
    expect(useToastStore.getState().toasts.some((t) => t.title.includes("session state refetched"))).toBe(false);
  });

  it("does not replay non-state side effects after hydration", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    activeAdapter.emit({ type: "ledger_write", kind: "approved", concept: "small modules" });
    await flush();
    expect(useToastStore.getState().toasts.filter((t) => t.title.includes("Added to your Ledger"))).toHaveLength(1);
    pending.resolve(new Response(JSON.stringify(snapshot("A")), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useToastStore.getState().toasts.filter((t) => t.title.includes("Added to your Ledger"))).toHaveLength(1);
  });

  it("drops a nested side-effect import invalidated by a session switch", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [], comments: [] } });
    await flush();
    activeAdapter.emit({ type: "ledger_write", kind: "approved", concept: "stale" });
    useConnectionStore.getState().switchSession("B");
    await flush();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("bounds a hung recovery, applies its buffer, and ignores its eventual response", async () => {
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? pending.promise : Promise.resolve(new Response("{}"))));
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A", artifacts: [artifact("valid", "A")], comments: [] } });
    await flush();
    vi.useFakeTimers();
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    // The artifact module is already loaded; drain the import continuation
    // without using flush(), whose setTimeouts are intentionally faked here.
    await Promise.resolve();
    await Promise.resolve();
    activeAdapter.emit({ type: "artifact_created", artifact: artifact("buffered", "A") });
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    pending.resolve(new Response(JSON.stringify(snapshot("A", [artifact("late", "A")])), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id).sort()).toEqual(["buffered", "valid"]);
  });

  it("keeps valid state and does not claim success when recovery fails", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api/state") ? new Response("no", { status: 500 }) : new Response("{}")));
    useArtifactStore.getState().addArtifact(artifact("valid", "A") as any);
    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "connected", state: { sessionId: "A" } });
    await flush();
    useArtifactStore.getState().addArtifact(artifact("valid", "A") as any);
    activeAdapter.emit({ type: "daemon_resumed", sessionId: "A" });
    await flush();
    expect(useArtifactStore.getState().artifacts.map((a) => a.id)).toEqual(["valid"]);
    expect(useToastStore.getState().toasts.some((t) => t.title.includes("Daemon restarted"))).toBe(true);
    expect(useToastStore.getState().toasts.some((t) => t.title.includes("session state refetched"))).toBe(false);
  });
});

describe("connection store — daemon-restart detection (U4)", () => {
  // The architecture review's #2 finding: when the daemon shuts down (auto-
  // shutdown after 60s idle, crash, manual kill) and a NEW daemon takes
  // over the port, connected web UIs were silently talking to a different
  // process. In-flight optimistic updates the prior daemon never flushed
  // are now unreachable. With U4, the daemon's `daemonStartedAt` timestamp
  // travels in every `connected` payload; a value change across reconnects
  // triggers re-hydration plus a toast so the user knows to retry anything
  // they thought they'd just sent.

  it("captures daemonStartedAt on the first connected event", async () => {
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/p",
      daemonStartedAt: "2026-04-25T12:00:00.000Z",
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    expect(useConnectionStore.getState().daemonStartedAt).toBe("2026-04-25T12:00:00.000Z");
  });

  it("does NOT toast on the FIRST connected event (no prior baseline = no restart)", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/p",
      daemonStartedAt: "2026-04-25T12:00:00.000Z",
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("toasts and re-hydrates when a reconnect carries a NEW daemonStartedAt", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    useConnectionStore.getState().connect();
    // First connect — daemon A.
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/p",
      daemonStartedAt: "2026-04-25T12:00:00.000Z",
      state: {
        sessionId: "s1",
        artifacts: [{ id: "a_old", sessionId: "s1", type: "research", version: 1,
          parentId: null, title: "old", status: "draft", content: {}, agentReasoning: null,
          createdAt: "2026-04-25T12:01:00.000Z", updatedAt: "2026-04-25T12:01:00.000Z" }],
        comments: [],
      },
    });
    await flush();
    expect(useArtifactStore.getState().artifacts).toHaveLength(1);

    // Reconnect — daemon B took over the port, sending a different start time
    // and a fresh state with a different artifact.
    activeAdapter.emit({
      type: "connected",
      projectRoot: "/p",
      daemonStartedAt: "2026-04-25T13:00:00.000Z",
      state: {
        sessionId: "s1",
        artifacts: [{ id: "a_new", sessionId: "s1", type: "plan", version: 1,
          parentId: null, title: "new", status: "draft", content: { steps: [] }, agentReasoning: null,
          createdAt: "2026-04-25T13:00:30.000Z", updatedAt: "2026-04-25T13:00:30.000Z" }],
        comments: [],
      },
    });
    await flush();

    // State is fully replaced from the new daemon (the prior artifact is gone).
    const arts = useArtifactStore.getState().artifacts;
    expect(arts.map((a) => a.id)).toEqual(["a_new"]);
    expect(useConnectionStore.getState().daemonStartedAt).toBe("2026-04-25T13:00:00.000Z");

    // And the user is told — #182: a PERSISTENT (ttl 0), dismissible error toast
    // with a Reload button, NOT the old expiring info toast. Reads reconnected
    // but the stale bundle + bearer token only recover on a hard reload.
    const toasts = useToastStore.getState().toasts;
    const restart = toasts.find((t) => t.title.includes("Daemon restarted"));
    expect(restart).toBeDefined();
    expect(restart!.kind).toBe("error");
    expect(restart!.ttl).toBe(0); // persistent — survives until dismissed/reloaded
    expect(restart!.body).toMatch(/reload this tab/i);
    expect(restart!.action?.label).toBe("Reload");
  });

  it("#182 — CROSS-PATH dedupe: a 401-confirmed restart AND the WS `connected` detection for the SAME new startedAt toast ONCE (shared latch)", async () => {
    // The load-bearing job of restartToastFiredFor. NOTE: a pure-WS "A→B→B"
    // reconnect can't prove the latch — U4's own `previousStartedAt !== new`
    // store guard already suppresses the repeat, so that test would stay green
    // even with the latch removed. The genuine race the latch exists for is
    // CROSS-PATH: a write 401s and confirms the restart (toast #1) BEFORE the WS
    // reconnect delivers the new `connected`. At that point the WS store guard
    // does NOT suppress (the tab still knows daemon A), so the ONLY thing
    // stopping a second toast is the latch shared between the two call sites.
    // Neuter restartToastFiredFor → the WS path adds a second toast → red.
    const { useToastStore } = await import("../toast");
    const { __resetDaemonRestartToast } = await import("../../lib/daemon-restart");
    useToastStore.getState().dismissAll();
    __resetDaemonRestartToast();

    useConnectionStore.getState().connect();
    // Daemon A booted the tab (baseline — first connect never toasts).
    activeAdapter.emit({
      type: "connected", projectRoot: "/p", daemonStartedAt: "daemon-A",
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    expect(useToastStore.getState().toasts.filter((t) => t.title === "Daemon restarted")).toHaveLength(0);

    // A write 401s BEFORE the WS reconnect reconciled: the tab still knows
    // daemon A (window-exposed identity), /api/daemon-info reports daemon B → the
    // 401 path confirms the restart and fires the reload toast (#1). (web-node:
    // stub the window-exposed connection identity + fetch.)
    vi.stubGlobal("window", {
      __dpConnectionStore: { getState: () => ({ daemonStartedAt: "daemon-A", sessionId: "s1" }) },
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any) => {
      if (String(url).includes("/api/daemon-info")) {
        return new Response(JSON.stringify({ startedAt: "daemon-B" }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ error: "Authorization required for this action.", code: "daemon_auth_required" }),
        { status: 401, headers: { "Content-Type": "application/json" } });
    }));
    await expect(useArtifactStore.getState().submitComment("a1", "hi")).rejects.toMatchObject({ name: "ApiError" });
    expect(useToastStore.getState().toasts.filter((t) => t.title === "Daemon restarted")).toHaveLength(1);

    // NOW the WS reconnect delivers daemon B's `connected`. Its store guard
    // (previous=daemon-A !== daemon-B) does NOT suppress — only the shared latch
    // stops a second toast.
    activeAdapter.emit({
      type: "connected", projectRoot: "/p", daemonStartedAt: "daemon-B",
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    expect(useToastStore.getState().toasts.filter((t) => t.title === "Daemon restarted")).toHaveLength(1);
  });

  it("does NOT toast when reconnect carries the SAME daemonStartedAt (normal WS reconnect)", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    useConnectionStore.getState().connect();
    const startedAt = "2026-04-25T12:00:00.000Z";
    activeAdapter.emit({
      type: "connected", projectRoot: "/p", daemonStartedAt: startedAt,
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    activeAdapter.emit({
      type: "connected", projectRoot: "/p", daemonStartedAt: startedAt,
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does NOT toast when daemon omits daemonStartedAt (back-compat with older daemons)", async () => {
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    useConnectionStore.getState().connect();
    activeAdapter.emit({
      type: "connected", projectRoot: "/p", daemonStartedAt: "2026-04-25T12:00:00.000Z",
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    // Reconnect to an older daemon with no daemonStartedAt field.
    activeAdapter.emit({
      type: "connected", projectRoot: "/p",
      state: { sessionId: "s1", artifacts: [], comments: [] },
    });
    await flush();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
