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

  connect() { this.connected = true; this.connectHandler?.(); }
  disconnect() { this.connected = false; this.disconnectHandler?.(); }
  onMessage(h: (data: any) => void) { this.messageHandler = h; }
  onConnect(h: () => void) { this.connectHandler = h; }
  onDisconnect(h: () => void) { this.disconnectHandler = h; }

  /** Test helper: deliver a message to the connection store. */
  emit(data: any) {
    this.messageHandler?.(data);
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
  vi.unstubAllGlobals();
});

/** Give the dynamic import("./artifact") inside handleMessage a tick to resolve. */
async function flush() {
  // The store does an ESM dynamic import per message; microtasks + a macrotask
  // cover the chain on all supported platforms.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("connection store — handleMessage dispatch", () => {
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
    expect(art.artifacts[0].id).toBe("a1");
    expect(art.comments["a1"]).toHaveLength(1);
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

    expect(useArtifactStore.getState().artifacts[0].status).toBe("approved");
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

  it("renames artifact on `artifact_renamed`", async () => {
    useArtifactStore.getState().addArtifact({
      id: "a1", sessionId: "s1", type: "research", version: 1, parentId: null,
      title: "Old title", status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
    });

    useConnectionStore.getState().connect();
    activeAdapter.emit({ type: "artifact_renamed", artifactId: "a1", title: "New title" });
    await flush();

    expect(useArtifactStore.getState().artifacts[0].title).toBe("New title");
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
    activeAdapter.emit({ type: "decision_resolved", artifactId: "a1", optionId: "opt_x" });
    await flush();

    expect(useArtifactStore.getState().artifacts[0].status).toBe("approved");
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
      expect(toasts[0].kind).toBe("preflight-block");
      expect(toasts[0].hero?.source).toBe("team");
      expect(toasts[0].hero?.concept).toBe("global state");
      expect(toasts[0].hero?.addedBy).toBe("alex");
    });

    it("pushes an info toast on `ledger_write` with the truncated description", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "ledger_write",
        kind: "rejected",
        description: "Auth refactor: rolling your own JWT signing",
        reason: "maintenance overhead",
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].kind).toBe("info");
      expect(toasts[0].title).toContain("+ avoid");
      expect(toasts[0].body).toContain("Auth refactor");
    });

    it("differentiates approved vs rejected in the ledger-write title", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();
      useConnectionStore.getState().connect();
      activeAdapter.emit({ type: "ledger_write", kind: "approved", description: "Service layer" });
      await flush();
      expect(useToastStore.getState().toasts[0].title).toContain("+ prefer");
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
      expect(toasts[0].kind).toBe("success");
      expect(toasts[0].title).toMatch(/question was answered/i);
      expect(toasts[0].action?.label).toMatch(/jump to answer/i);
    });

    it("pushes a success toast on `decision_resolved_hero` with the captured prediction", async () => {
      const { useToastStore } = await import("../toast");
      useToastStore.getState().dismissAll();

      useConnectionStore.getState().connect();
      activeAdapter.emit({
        type: "decision_resolved_hero",
        artifactId: "art_d1",
        context: "Password hashing",
        chosenTitle: "argon2id",
        predictedOutcome: "zero-downtime migration",
        confidence: "medium",
      });
      await flush();

      const toasts = useToastStore.getState().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0].title).toContain("argon2id");
      expect(toasts[0].body).toContain("zero-downtime migration");
      expect(toasts[0].body).toContain("medium confidence");
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
      expect(toasts[0].kind).toBe("info");
      expect(toasts[0].title).toMatch(/claude will see this/i);
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

    // And the user is told.
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.title.includes("Daemon restarted"))).toBe(true);
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
