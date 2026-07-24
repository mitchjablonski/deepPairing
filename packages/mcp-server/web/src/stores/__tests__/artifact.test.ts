import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useArtifactStore } from "../artifact";
import { useReplayStore } from "../replay";
import type { Artifact, Comment } from "@deeppairing/shared";

function artifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    sessionId: "s1",
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

function comment(id: string, artifactId: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    sessionId: "s1",
    target: { artifactId },
    parentCommentId: null,
    author: "human",
    content: `comment ${id}`,
    acknowledged: false,
    createdAt: "2026-04-16T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useArtifactStore.getState().reset();
  // Silence network calls from mutators we don't exercise in these tests
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact store — addArtifact", () => {
  it("appends the artifact and auto-selects the first one", () => {
    useArtifactStore.getState().addArtifact(artifact("a1"));
    const state = useArtifactStore.getState();
    expect(state.artifacts).toHaveLength(1);
    expect(state.selectedArtifactId).toBe("a1");
  });

  it("does NOT clobber the selection when a later artifact arrives", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a1");
  });

  it("marks newly-arrived artifacts as unread when something else is selected", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    // a1 is selected; a2 should show up in unreadIds
    s.addArtifact(artifact("a2"));
    expect(useArtifactStore.getState().unreadIds).toEqual(["a2"]);
    // a3 piles on
    s.addArtifact(artifact("a3"));
    expect(useArtifactStore.getState().unreadIds).toEqual(["a2", "a3"]);
  });

  it("dedupes by id — repeated artifact_created events don't multiply (U0.1)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a1"));
    expect(useArtifactStore.getState().artifacts).toHaveLength(1);
  });

  it("merges fields on re-add so a status-bearing rebroadcast can update in place", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "v1", status: "draft" }));
    s.addArtifact(artifact("a1", { title: "v1", status: "approved" }));
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("approved");
  });
});

describe("artifact store — selectArtifact", () => {
  it("clears the selected artifact's unreadIds entry", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    expect(useArtifactStore.getState().unreadIds).toContain("a2");
    s.selectArtifact("a2");
    expect(useArtifactStore.getState().selectedArtifactId).toBe("a2");
    expect(useArtifactStore.getState().unreadIds).not.toContain("a2");
  });

  it("accepts null to deselect", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.selectArtifact(null);
    expect(useArtifactStore.getState().selectedArtifactId).toBeNull();
  });
});

describe("artifact store — updateArtifact", () => {
  it("patches status in place, leaving other fields intact", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Keep me" }));
    s.updateArtifact("a1", "approved");
    const a = useArtifactStore.getState().artifacts[0]!;
    expect(a.status).toBe("approved");
    expect(a.title).toBe("Keep me");
  });

  it("updates version when provided", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { version: 1 }));
    s.updateArtifact("a1", "superseded", 2);
    expect(useArtifactStore.getState().artifacts[0]!.version).toBe(2);
  });

  it("is a no-op for unknown ids (no throw)", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    expect(() => s.updateArtifact("art_nope", "approved")).not.toThrow();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
  });
});

describe("artifact store — addComment", () => {
  it("groups comments by target artifact id", () => {
    const s = useArtifactStore.getState();
    s.addComment(comment("c1", "a1"));
    s.addComment(comment("c2", "a1"));
    s.addComment(comment("c3", "a2"));
    const { comments } = useArtifactStore.getState();
    expect(comments["a1"]).toHaveLength(2);
    expect(comments["a2"]).toHaveLength(1);
    expect(comments["a1"]![0]!.id).toBe("c1");
    expect(comments["a1"]![1]!.id).toBe("c2");
  });

  it("can carry __session__ target for free-form messages", () => {
    const s = useArtifactStore.getState();
    s.addComment(comment("c1", "__session__"));
    expect(useArtifactStore.getState().comments["__session__"]).toHaveLength(1);
  });

  it("dedupes by id — repeated WS broadcasts for the same comment don't multiply (U0.1)", () => {
    // Field bug: a single posted comment visibly multiplied while the user
    // sat on the page because the WebSocket replayed `comment_added` (or
    // re-hydrated initial state) and the store blindly appended each time.
    const s = useArtifactStore.getState();
    const c = comment("c_dup", "a1");
    s.addComment(c);
    s.addComment(c);
    s.addComment({ ...c, content: "ignored — same id wins" });
    const { comments } = useArtifactStore.getState();
    expect(comments["a1"]).toHaveLength(1);
    expect(comments["a1"]![0]!.id).toBe("c_dup");
  });
});

describe("artifact store — reset", () => {
  it("wipes artifacts, comments, selection, and unreadIds", () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1"));
    s.addArtifact(artifact("a2"));
    s.addComment(comment("c1", "a1"));
    s.reset();
    const after = useArtifactStore.getState();
    expect(after.artifacts).toEqual([]);
    expect(after.comments).toEqual({});
    expect(after.selectedArtifactId).toBeNull();
    expect(after.unreadIds).toEqual([]);
  });
});

describe("artifact store — mutation error surfacing (U3)", () => {
  // Pre-U3 every mutator dropped fetch responses on the floor; a 4xx/5xx
  // was indistinguishable from success. Now every failure throws and the
  // store toasts so the user reacts instead of waiting on something that
  // never landed.
  it("submitComment toasts an error when the daemon returns 409 no_active_session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "x", code: "no_active_session" }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    )));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.submitComment("a1", "hi")).rejects.toMatchObject({ name: "ApiError" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe("error");
    expect(toasts[0]!.title).toBe("Send comment failed");
  });

  it("updateArtifactStatus toasts a status-specific title on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.updateArtifactStatus("a1", "approved")).rejects.toBeDefined();
    const toasts = useToastStore.getState().toasts;
    expect(toasts[0]!.title).toBe("Approve failed");
  });

  it("updateArtifactStatus optimistically flips local status so a dismissed draft leaves the 'waiting' set without the WS broadcast", async () => {
    // Regression: dismissing a draft persisted obsolete server-side but the
    // local artifact stayed `draft` (no optimistic update), so it kept
    // rendering as "waiting for you" until a session-scoped artifact_updated
    // broadcast arrived — which never reaches a tab viewing a project it
    // switched into. The optimistic flip must happen regardless of the WS.
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("d1", { type: "decision", status: "draft" }));
    // Don't await: status must already be optimistic before the POST settles.
    const p = s.updateArtifactStatus("d1", "obsolete");
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("obsolete");
    await p;
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("obsolete");
  });

  it("updateArtifactStatus rolls back the optimistic status change on failure", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("d1", { type: "decision", status: "draft" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    await expect(s.updateArtifactStatus("d1", "obsolete")).rejects.toBeDefined();
    // After rollback the draft is back so it isn't silently hidden from review.
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
  });

  it("updateArtifactStatus rollback is SURGICAL — a WS artifact that arrived mid-flight survives", async () => {
    // The rollback used to restore a whole-array snapshot captured BEFORE the
    // POST, so an artifact_created that arrived over the WS while the request
    // was in flight got erased on failure. Surgical rollback reverts only the
    // one artifact's status and leaves everything else as-is.
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { status: "draft" }));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      // Simulate a session-scoped WS broadcast landing mid-request.
      useArtifactStore.getState().addArtifact(artifact("ws-arrival", { status: "draft" }));
      return new Response("oops", { status: 500 });
    }));
    await expect(s.updateArtifactStatus("a1", "approved")).rejects.toBeDefined();
    const ids = useArtifactStore.getState().artifacts.map((a) => a.id);
    expect(ids).toContain("ws-arrival"); // not erased by the rollback
    expect(useArtifactStore.getState().artifacts.find((a) => a.id === "a1")?.status).toBe("draft"); // reverted
  });

  it("submitComment rollback is SURGICAL — only the provisional is removed, a mid-flight WS comment survives", async () => {
    const s = useArtifactStore.getState();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      // A real comment_added for the SAME artifact arrives over the WS while
      // the send is in flight; it must outlive the failed provisional.
      useArtifactStore.getState().addComment(comment("ws-c", "a1"));
      return new Response("oops", { status: 500 });
    }));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    await expect(s.submitComment("a1", "my reply")).rejects.toBeDefined();
    const list = useArtifactStore.getState().comments["a1"] ?? [];
    expect(list.map((c) => c.id)).toEqual(["ws-c"]); // provisional gone, WS comment kept
  });

  it("resolveDecision optimistically marks the matching decision artifact approved so it leaves the 'waiting' set without the WS broadcast", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("dec-art", { type: "decision", status: "draft", content: { decisionId: "dec1", context: "c", options: [] } }));
    const p = s.resolveDecision("dec1", "o1");
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("approved");
    await p;
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("approved");
  });

  it("resolveDecision rolls back the optimistic approval on failure", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("dec-art", { type: "decision", status: "draft", content: { decisionId: "dec1", context: "c", options: [] } }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    await expect(s.resolveDecision("dec1", "o1")).rejects.toBeDefined();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
  });

  it("submitComment optimistically shows the comment, then reconciles to the server comment (no dup)", async () => {
    const s = useArtifactStore.getState();
    const serverComment = {
      id: "srv1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null,
      author: "human", content: "hello", acknowledged: false, createdAt: "2026-01-01T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ comment: serverComment }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    const p = s.submitComment("a1", "hello");
    // Optimistic: a provisional comment is visible synchronously, before the POST resolves.
    const optimistic = useArtifactStore.getState().comments["a1"] ?? [];
    expect(optimistic.some((c) => c.content === "hello" && c.id.startsWith("local_"))).toBe(true);
    await p;
    // Reconciled: provisional swapped for the server id, exactly one record.
    expect((useArtifactStore.getState().comments["a1"] ?? []).map((c) => c.id)).toEqual(["srv1"]);
  });

  it("submitComment rolls back the optimistic comment on failure", async () => {
    const s = useArtifactStore.getState();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    await expect(s.submitComment("a1", "hello")).rejects.toBeDefined();
    expect(useArtifactStore.getState().comments["a1"] ?? []).toEqual([]);
    expect(useToastStore.getState().toasts[0]!.title).toBe("Send comment failed");
  });

  it("renameArtifact rolls back the optimistic title change on failure", async () => {
    const s = useArtifactStore.getState();
    s.addArtifact(artifact("a1", { title: "Original" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 500 })));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    await expect(s.renameArtifact("a1", "New Name")).rejects.toBeDefined();
    // After rollback the title should be back to the original.
    expect(useArtifactStore.getState().artifacts[0]!.title).toBe("Original");
    expect(useToastStore.getState().toasts[0]!.title).toBe("Rename artifact failed");
  });

  it("BB10 — project_hash_mismatch toasts a sticky 'reload' action instead of the generic error copy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Project hash mismatch", code: "project_hash_mismatch", expected: "abc12345" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.submitComment("a1", "hi")).rejects.toMatchObject({ name: "ApiError" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe("error");
    expect(toasts[0]!.title).toMatch(/stale daemon/i);
    expect(toasts[0]!.ttl).toBe(0); // sticky
    expect(toasts[0]!.action?.label).toBe("Reload");
  });

  it("network-error rejection toasts the doctor hint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.submitComment("a1", "hi")).rejects.toBeDefined();
    expect(useToastStore.getState().toasts[0]!.body).toMatch(/init\.js doctor/i);
  });
});

describe("#182 — daemon-restart-under-tab (401-on-write identity check)", () => {
  // Field bug: the daemon restarted while a tab was open. The WS reconnected
  // (reads work) but the page's bearer token is stale, so a write 401s with a
  // raw "Authorization required" toast. A 401/403 must trigger an identity
  // check (/api/daemon-info) — only a CONFIRMED restart swaps the raw error for
  // the actionable reload toast; a genuine auth error keeps its own message.
  beforeEach(async () => {
    // This test file runs in the web-node env (no jsdom window). The tab
    // "booted" knowing daemon A's identity — expose it the way the real
    // connection store does, on window.__dpConnectionStore. Cleaned up by the
    // file-level afterEach (vi.unstubAllGlobals()).
    vi.stubGlobal("window", {
      __dpConnectionStore: { getState: () => ({ daemonStartedAt: "daemon-A", sessionId: "s1" }) },
    });
    // Clear the once-per-restart dedup latch so cases don't leak into each other
    // (this file does not resetModules between tests).
    const { __resetDaemonRestartToast } = await import("../../lib/daemon-restart");
    __resetDaemonRestartToast();
  });

  /** A fetch that 401s writes (stale bearer) but answers /api/daemon-info with
   *  `liveStartedAt`. */
  function stubAuthFailWithDaemonInfo(liveStartedAt: string) {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any) => {
      if (String(url).includes("/api/daemon-info")) {
        return new Response(
          JSON.stringify({ pid: 2, startedAt: liveStartedAt, projectHash: "h" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: "Authorization required for this action.", code: "daemon_auth_required" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }));
  }

  it("a 401 write + identity-CONFIRMED restart shows the reload toast (not the raw auth error)", async () => {
    // daemon-info reports a DIFFERENT startedAt than the tab knows → restart.
    stubAuthFailWithDaemonInfo("daemon-B");
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.submitComment("a1", "hi")).rejects.toMatchObject({ name: "ApiError" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.title).toBe("Daemon restarted");
    expect(toasts[0]!.ttl).toBe(0); // persistent
    expect(toasts[0]!.body).toMatch(/reload this tab/i);
    expect(toasts[0]!.action?.label).toBe("Reload");
    // The raw "Send comment failed" auth toast is NOT shown.
    expect(toasts.some((t) => t.title === "Send comment failed")).toBe(false);
  });

  it("a 401 write with the SAME daemon identity keeps the original auth error (genuine permissions issue)", async () => {
    // daemon-info reports the SAME startedAt the tab knows → not a restart.
    stubAuthFailWithDaemonInfo("daemon-A");
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.submitComment("a1", "hi")).rejects.toMatchObject({ name: "ApiError" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    // Original error preserved — no restart toast.
    expect(toasts[0]!.title).toBe("Send comment failed");
    expect(toasts[0]!.body).toMatch(/authorization required/i);
    expect(toasts.some((t) => t.title === "Daemon restarted")).toBe(false);
  });

  it("does NOT restart-toast when the identity probe itself fails (daemon genuinely down)", async () => {
    // Write 401s AND /api/daemon-info is unreachable → cannot confirm a restart,
    // so we must not falsely claim one; the raw auth error stands.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url: any) => {
      if (String(url).includes("/api/daemon-info")) throw new TypeError("Failed to fetch");
      return new Response(
        JSON.stringify({ error: "Authorization required for this action.", code: "daemon_auth_required" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }));
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();
    const s = useArtifactStore.getState();
    await expect(s.submitComment("a1", "hi")).rejects.toMatchObject({ name: "ApiError" });
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.title === "Daemon restarted")).toBe(false);
    expect(toasts[0]!.title).toBe("Send comment failed");
  });
});

describe("D9 (M10) — WS echo replaces the optimistic provisional", () => {
  it("a server comment matching a local_ provisional (author+content) replaces it in place", () => {
    const store = useArtifactStore.getState();
    const target = { artifactId: "art_1" } as any;
    store.addComment({
      id: "local_123", artifactId: "art_1", content: "great point", author: "human",
      createdAt: "2026-07-01T00:00:00.000Z", target,
    } as any);
    // The WS echo (server id) lands BEFORE the POST response swap.
    store.addComment({
      id: "cmt_srv", artifactId: "art_1", content: "great point", author: "human",
      createdAt: "2026-07-01T00:00:01.000Z", target,
    } as any);
    const bucket = useArtifactStore.getState().comments["art_1"];
    expect(bucket).toHaveLength(1);
    expect(bucket![0]!.id).toBe("cmt_srv");
  });

  it("distinct content does NOT replace — only true echoes collapse", () => {
    const store = useArtifactStore.getState();
    const target = { artifactId: "art_2" } as any;
    store.addComment({ id: "local_9", artifactId: "art_2", content: "first", author: "human", createdAt: "2026-07-01T00:00:00.000Z", target } as any);
    store.addComment({ id: "cmt_x", artifactId: "art_2", content: "second", author: "human", createdAt: "2026-07-01T00:00:01.000Z", target } as any);
    expect(useArtifactStore.getState().comments["art_2"]).toHaveLength(2);
  });
});

describe("F6 — mutations route by the OWNING session", () => {
  const art = (id: string, sessionId: string) =>
    ({
      id, sessionId, type: "research", version: 1, parentId: null,
      title: id, status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    }) as any;

  it("updateArtifactStatus on a merged FOREIGN artifact carries the owner's X-Session-Id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "updated" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    useArtifactStore.setState({ artifacts: [art("art_mine", "sess_tab"), art("art_foreign", "sess_owner")] });

    await useArtifactStore.getState().updateArtifactStatus("art_foreign", "approved");

    const [, init] = fetchSpy.mock.calls[0]!;
    // Pre-F6 this carried the TAB's session and the write silently no-op'd.
    expect((init.headers as Record<string, string>)["X-Session-Id"]).toBe("sess_owner");
  });

  it("markQuestionResolved routes by the COMMENT's owning session (the fifth route)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "resolved" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    useArtifactStore.setState({
      comments: {
        art_foreign: [{
          id: "cmt_q", artifactId: "art_foreign", sessionId: "sess_owner", author: "human",
          content: "?", intent: "question", createdAt: "2026-07-01T00:00:00.000Z",
          target: { artifactId: "art_foreign" },
        } as any],
      },
    });

    await useArtifactStore.getState().markQuestionResolved("cmt_q");

    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-Session-Id"]).toBe("sess_owner");
  });
});

describe("Bug A — cross-daemon mutation is refused (no silent approval loss)", () => {
  const art = (id: string, sessionId: string) =>
    ({
      id, sessionId, type: "research", version: 1, parentId: null,
      title: id, status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    }) as any;

  afterEach(() => {
    vi.useRealTimers(); // in case a test opted into fake timers
  });

  it("a mutation whose owner is STILL absent after a fresh refresh does NOT POST and surfaces the guard", async () => {
    // Tab bound to sess_tab; the daemon serves sess_tab only. art_foreign is
    // owned by sess_other (a different daemon) — a stray broadcast put it in
    // the store. An authoritative refresh confirms sess_other still isn't here,
    // so approving it must NOT fire the doomed POST.
    const refreshSessions = vi.fn(async () => true); // succeeds, but sess_other never appears
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: "sess_tab", activeSessions: [{ sessionId: "sess_tab" }], projectHash: "hX", refreshSessions }),
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();

    useArtifactStore.setState({ artifacts: [art("art_foreign", "sess_other")] });

    await expect(
      useArtifactStore.getState().updateArtifactStatus("art_foreign", "approved"),
    ).rejects.toThrow(/another|foreign|doesn't serve/i);

    // No POST fired — nothing to silently lose.
    expect(fetchSpy).not.toHaveBeenCalled();
    // And no optimistic flip left behind (guard runs BEFORE the patch).
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
    // Honest, sticky affordance with a re-bind action. The toast is pushed via
    // a lazy import (same pattern as assertNotReplay), so flush microtasks.
    await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
    const toasts = useToastStore.getState().toasts;
    expect(toasts[0]!.kind).toBe("error");
    expect(toasts[0]!.title).toMatch(/another project/i);
    expect(toasts[0]!.ttl).toBe(0);
    expect(toasts[0]!.action?.label).toBe("Reload");
    // The block was authoritative — it confirmed with a fresh fetch first.
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("a same-daemon session that only LAGS the activeSessions poll is NOT guarded once a fresh refresh includes it (global-tab repro)", async () => {
    // Global/aggregator tab (sessionId === null): sess_B's first artifact
    // arrived via the WS broadcast, but the 10s activeSessions poll hasn't
    // caught up yet, so sess_B is momentarily absent. The guard must confirm
    // with a fresh refresh — which now includes sess_B — and PROCEED, not
    // false-block a valid same-daemon approval.
    const conn: any = {
      sessionId: null,
      // Stale but HYDRATED (a sibling session already polled) — sess_B missing.
      activeSessions: [{ sessionId: "sess_A" }] as Array<{ sessionId: string }>,
      refreshSessions: vi.fn(async () => {
        conn.activeSessions = [{ sessionId: "sess_A" }, { sessionId: "sess_B" }]; // poll catches up
        return true;
      }),
    };
    vi.stubGlobal("window", { __dpConnectionStore: { getState: () => conn } });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "updated" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();

    useArtifactStore.setState({ artifacts: [art("art_b", "sess_B")] });
    await useArtifactStore.getState().updateArtifactStatus("art_b", "approved");

    // Proceeded: the POST fired with F6 owner routing and no false-block toast.
    expect(conn.refreshSessions).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0]![1].headers as Record<string, string>)["X-Session-Id"]).toBe("sess_B");
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("a failed refresh (network blip) PROCEEDS rather than false-blocking", async () => {
    // Suspected foreign, but the confirming refresh fails — staleness isn't
    // authoritative, so proceed (the POST 409s only in the rare genuine-foreign
    // + refresh-failure case, no worse than pre-guard).
    const refreshSessions = vi.fn(async () => false); // fetch failed
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: "sess_tab", activeSessions: [{ sessionId: "sess_tab" }], projectHash: "hX", refreshSessions }),
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "updated" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();

    useArtifactStore.setState({ artifacts: [art("art_x", "sess_other")] });
    await useArtifactStore.getState().updateArtifactStatus("art_x", "approved");

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // proceeded
    expect(useToastStore.getState().toasts).toHaveLength(0); // no false-block toast
  });

  it("a HUNG refresh fails OPEN within the timeout (does not stall or false-block)", async () => {
    // Suspected foreign, but the confirming refreshSessions() never resolves
    // (daemon hung). The guard must not wait on the browser's default fetch
    // timeout — it bounds the confirm with its own ~4s race and fails open.
    vi.useFakeTimers();
    const refreshSessions = vi.fn(() => new Promise<boolean>(() => {})); // never settles
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: "sess_tab", activeSessions: [{ sessionId: "sess_tab" }], projectHash: "hX", refreshSessions }),
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "updated" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { useToastStore } = await import("../toast");
    useToastStore.getState().dismissAll();

    useArtifactStore.setState({ artifacts: [art("art_x", "sess_other")] });
    const p = useArtifactStore.getState().updateArtifactStatus("art_x", "approved");
    // Drive the guard's internal timeout; the mutation resolves via fail-open.
    await vi.advanceTimersByTimeAsync(4000);
    await p;

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // proceeded within the timeout
    expect(useToastStore.getState().toasts).toHaveLength(0); // no false-block
    vi.useRealTimers();
  });

  it("a SAME-daemon multi-session mutation still POSTs normally with ZERO extra fetch (F6 common case, no regression)", async () => {
    // Both the tab session AND the owning session are served by THIS daemon
    // (the owner is in activeSessions — a MultiAgentSync-merged sibling).
    const refreshSessions = vi.fn(async () => true);
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({
          sessionId: "sess_tab",
          activeSessions: [{ sessionId: "sess_tab" }, { sessionId: "sess_sibling" }],
          projectHash: "hX",
          refreshSessions,
        }),
      },
    });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "updated" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    useArtifactStore.setState({ artifacts: [art("art_sibling", "sess_sibling")] });
    await useArtifactStore.getState().updateArtifactStatus("art_sibling", "approved");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    // F6 owner routing intact.
    expect((init.headers as Record<string, string>)["X-Session-Id"]).toBe("sess_sibling");
    // Same-daemon → hash/token still attached.
    expect((init.headers as Record<string, string>)["X-Project-Hash"]).toBe("hX");
    // Zero extra cost: the common path short-circuits before any confirm fetch.
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("sessionHeaders drops the current daemon's hash/token for an explicit FOREIGN owner", async () => {
    const { sessionHeaders } = await import("../../lib/api");
    vi.stubGlobal("window", {
      __dpConnectionStore: {
        getState: () => ({ sessionId: "sess_tab", activeSessions: [{ sessionId: "sess_tab" }], projectHash: "hX" }),
      },
      __deepPairingToken: "tok_current",
    });
    const h = sessionHeaders("sess_other");
    // The owning session id is still routed…
    expect(h["X-Session-Id"]).toBe("sess_other");
    // …but the CURRENT daemon's hash/token are withheld (they'd guarantee a 409).
    expect(h["X-Project-Hash"]).toBeUndefined();
    expect(h["Authorization"]).toBeUndefined();
  });
});

describe("F12 — the store refuses ALL mutations during replay (the mouse path)", () => {
  const art = (id: string) =>
    ({
      id, sessionId: "s_hist", type: "research", version: 1, parentId: null,
      title: id, status: "draft", content: {}, agentReasoning: null,
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    }) as any;

  beforeEach(() => {
    useReplayStore.setState({ active: true } as any);
  });
  afterEach(() => {
    useReplayStore.getState().exitReplay();
  });

  it("all five mutations REJECT (toast-then-throw, so callers' catch paths preserve drafts) — zero fetches", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    useArtifactStore.setState({ artifacts: [art("a_h")] });

    // THROW, not silent return (review): a silent return ran every caller's
    // SUCCESS path — composers wiped drafts, send-back showed a false
    // terminal "sent" state.
    const store = useArtifactStore.getState();
    await expect(store.updateArtifactStatus("a_h", "approved")).rejects.toThrow(/disabled during replay/);
    await expect(store.submitComment("a_h", "into the past")).rejects.toThrow(/disabled during replay/);
    await expect(store.renameArtifact("a_h", "rewritten history")).rejects.toThrow(/disabled during replay/);
    await expect(store.resolveDecision("dec_h", "o1")).rejects.toThrow(/disabled during replay/);
    await expect(store.markQuestionResolved("cmt_h")).rejects.toThrow(/disabled during replay/);

    expect(fetchSpy).not.toHaveBeenCalled();
    // The artifact is untouched (no optimistic flip either).
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
    const { useToastStore } = await import("../../stores/toast");
    expect(
      useToastStore.getState().toasts.filter((t) => t.title.includes("disabled during replay")),
    ).toHaveLength(5);
  });

  it("mutations work again after exitReplay", async () => {
    useReplayStore.getState().exitReplay();
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "updated" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    useArtifactStore.setState({ artifacts: [art("a_live")] });
    await useArtifactStore.getState().updateArtifactStatus("a_live", "approved");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
