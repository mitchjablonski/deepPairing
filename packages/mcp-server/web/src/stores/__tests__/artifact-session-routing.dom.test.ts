import { describe, it, expect, afterEach, vi } from "vitest";
import type { Artifact, Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../artifact";
import { useConnectionStore } from "../connection";
import { useToastStore } from "../toast";

/**
 * #407 review — a comment mutation's ROUTING is resolved when the call starts.
 * On the suspected-foreign path the owner guard awaits a confirming
 * refreshSessions() (up to 4s); re-deriving the owner after it read the NEW
 * session's store, so after an A→B switch the X-Session-Id fell back to B and
 * the write was stored in the wrong session server-side. DOM env: the guard,
 * the tab binding and sessionHeaders all read window.__dpConnectionStore.
 */
function artifact(id: string, sessionId: string): Artifact {
  return {
    id, sessionId, type: "research", version: 1, parentId: null, title: id, status: "draft",
    content: {}, agentReasoning: null, createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z",
  };
}
function comment(id: string, artifactId: string, over: Partial<Comment> = {}): Comment {
  return {
    id, sessionId: "s1", target: { artifactId }, parentCommentId: null, author: "human", content: `comment ${id}`,
    acknowledged: false, createdAt: "2026-04-16T10:00:00.000Z", ...over,
  } as Comment;
}
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const headerOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>)["X-Session-Id"];

/** Tab bound to s1. `lag` is a same-daemon session the 10s poll hasn't
 *  listed yet, so the guard AWAITS a refresh the test holds open. A fresh id
 *  per test: a previous test's switch can still be settling session state. */
let lagSeq = 0;
function bind() {
  const lag = `sLag${++lagSeq}`;
  // The shared test setup deletes this bridge after every test; the store only
  // installs it at creation, so re-point it at the live store.
  (window as any).__dpConnectionStore = { getState: () => useConnectionStore.getState() };
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  const switched: string[] = [];
  let releaseRefresh!: (v: boolean) => void;
  const refresh = new Promise<boolean>((res) => { releaseRefresh = res; });
  useConnectionStore.setState({
    sessionId: "s1",
    activeSessions: [{ sessionId: "s1" }],
    refreshSessions: () => refresh,
    adapter: { switchSession: (id: string) => switched.push(id) },
  } as any);
  const switchTo = async (id: string) => {
    const n = switched.length;
    useConnectionStore.getState().switchSession(id);
    await vi.waitFor(() => expect(switched).toHaveLength(n + 1));
  };
  const releaseGuard = () => {
    // The refresh lists sLag after all: poll lag, not a foreign daemon.
    useConnectionStore.setState({ activeSessions: [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: lag }] } as any);
    releaseRefresh(true);
  };
  return { switchTo, releaseGuard, lag };
}

afterEach(() => {
  useConnectionStore.setState({ adapter: null, sessionId: null, activeSessions: [] } as any);
  vi.unstubAllGlobals();
});

describe("#407 review — routing is pinned before the foreign-owner guard's await", () => {
  it("submitComment: a switch during the guard still routes to the OWNER captured at the call", async () => {
    const { switchTo, releaseGuard, lag } = bind();
    useArtifactStore.setState({ artifacts: [artifact("a_lag", lag)] });
    const fetchSpy = vi.fn().mockResolvedValue(ok({ comment: comment("c_lag", "a_lag") }));
    vi.stubGlobal("fetch", fetchSpy);
    const submitted = useArtifactStore.getState().submitComment("a_lag", "for the lagging session");
    await switchTo("s2");
    expect(fetchSpy).not.toHaveBeenCalled(); // still inside the guard
    releaseGuard();
    await submitted;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(headerOf(fetchSpy.mock.calls[0]!)).toBe(lag);
    expect(useArtifactStore.getState().comments.a_lag).toBeUndefined(); // nothing painted in B
  });

  it("markQuestionResolved: a switch during the guard still routes to the comment's owner; a failure stays silent in B", async () => {
    const { switchTo, releaseGuard, lag } = bind();
    useArtifactStore.getState().addComment(comment("q_lag", "a_lag", { sessionId: lag, intent: "question" }));
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchSpy);
    const resolving = useArtifactStore.getState().markQuestionResolved("q_lag");
    await switchTo("s2");
    expect(fetchSpy).not.toHaveBeenCalled();
    releaseGuard();
    await expect(resolving).rejects.toBeTruthy(); // the caller still learns
    expect(headerOf(fetchSpy.mock.calls[0]!)).toBe(lag);
    expect(useArtifactStore.getState().comments).toEqual({});
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("resolveSuggestion: a switch during the guard still routes to the owner and never upserts into B", async () => {
    const { switchTo, releaseGuard, lag } = bind();
    useArtifactStore.setState({ artifacts: [artifact("a_lag", lag)] });
    const sug = comment("sug_lag", "a_lag", {
      suggestion: { originalText: "x", replacementText: "y", lineStart: 1, lineEnd: 1, state: "pending" },
    } as Partial<Comment>);
    useArtifactStore.getState().addComment(sug);
    const fetchSpy = vi.fn().mockResolvedValue(ok({ comment: sug }));
    vi.stubGlobal("fetch", fetchSpy);
    const resolving = useArtifactStore.getState().resolveSuggestion("sug_lag", "take_counter");
    await switchTo("s2");
    expect(fetchSpy).not.toHaveBeenCalled();
    releaseGuard();
    await resolving;
    expect(headerOf(fetchSpy.mock.calls[0]!)).toBe(lag);
    expect(useArtifactStore.getState().comments).toEqual({});
  });
});
