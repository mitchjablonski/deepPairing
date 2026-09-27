import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Artifact, Comment } from "@deeppairing/shared";
import { useArtifactStore } from "../artifact";
import { useToastStore } from "../toast";

/**
 * #422 — a failing optimistic request may only undo state it still OWNS.
 *
 * Every optimistic action snapshotted the prior value and restored it
 * unconditionally on failure: an OLDER request failing after a NEWER one
 * succeeded (or after an authoritative WS update) reverted the newer value in
 * the UI while the server kept it. Deferred fetches make every ordering exact.
 */
function artifact(id: string, over: Partial<Artifact> = {}): Artifact {
  return {
    id, sessionId: "s1", type: "changeset", version: 1, parentId: null, title: `Artifact ${id}`, status: "draft",
    content: { files: [] }, agentReasoning: null,
    createdAt: "2026-04-16T10:00:00.000Z", updatedAt: "2026-04-16T10:00:00.000Z", ...over,
  } as Artifact;
}
const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const fail = () => new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });

/** fetch fake: each call gets its own deferred, settled by the test in any order. */
let calls: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
beforeEach(() => {
  useArtifactStore.getState().reset();
  useToastStore.getState().dismissAll();
  calls = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve, reject) => { calls.push({ resolve, reject }); })));
});
afterEach(() => vi.unstubAllGlobals());

const content = (id = "cs") =>
  useArtifactStore.getState().artifacts.find((a) => a.id === id)!.content as {
    reviewState?: Record<string, string>; reviewReasons?: Record<string, string>;
  };
const toasts = () => useToastStore.getState().toasts.map((t) => t.title);

describe("#422 — setChangesetFileReview: a stale failure can't revert newer state", () => {
  beforeEach(() => useArtifactStore.setState({ artifacts: [artifact("cs")] }));

  it("older request fails AFTER a newer one on the same file succeeded → the newer flag + reason stay", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "src/x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "src/x.ts", "needs_changes", "missing null check");
    calls[1]!.resolve(ok());
    await b;
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content().reviewState?.["src/x.ts"]).toBe("needs_changes");
    expect(content().reviewReasons?.["src/x.ts"]).toBe("missing null check");
    expect(toasts()).toContain("Mark file reviewed failed"); // the failure stays visible
  });

  it("an authoritative broadcast lands before the older failure → the broadcast's state stays", async () => {
    const a = useArtifactStore.getState().setChangesetFileReview("cs", "src/x.ts", "reviewed");
    // The server's truth (another request/tab) arrives as changeset_review_updated.
    useArtifactStore.getState().replaceArtifact(artifact("cs", {
      content: { files: [], reviewState: { "src/x.ts": "needs_changes" }, reviewReasons: { "src/x.ts": "from the server" } } as any,
    }));
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content().reviewState?.["src/x.ts"]).toBe("needs_changes");
    expect(content().reviewReasons?.["src/x.ts"]).toBe("from the server");
  });

  it("overlapping REASON updates: an older reason failing never replaces the newer saved reason", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "src/x.ts", "needs_changes", "first reason");
    const b = s.setChangesetFileReview("cs", "src/x.ts", "needs_changes", "second reason");
    calls[1]!.resolve(ok());
    await b;
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content().reviewReasons?.["src/x.ts"]).toBe("second reason");
  });

  it("CONTROL — no newer update: the failure restores disposition AND reason together, and toasts", async () => {
    useArtifactStore.setState({ artifacts: [artifact("cs", {
      content: { files: [], reviewState: { "src/x.ts": "needs_changes" }, reviewReasons: { "src/x.ts": "orig" } } as any,
    })] });
    const a = useArtifactStore.getState().setChangesetFileReview("cs", "src/x.ts", "reviewed");
    expect(content().reviewReasons?.["src/x.ts"]).toBeUndefined(); // optimistic clears the reason
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content().reviewState?.["src/x.ts"]).toBe("needs_changes");
    expect(content().reviewReasons?.["src/x.ts"]).toBe("orig");
    expect(toasts()).toEqual(["Mark file reviewed failed"]);
  });

  it("INDEPENDENT files: a failure on file 1 still rolls file 1 back while file 2's success stays", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "one.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "two.ts", "reviewed");
    calls[1]!.resolve(ok());
    await b;
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content().reviewState?.["one.ts"]).toBeUndefined();
    expect(content().reviewState?.["two.ts"]).toBe("reviewed");
  });

  it("INDEPENDENT artifacts: same file path on another artifact doesn't block the rollback", async () => {
    useArtifactStore.setState({ artifacts: [artifact("cs"), artifact("cs2")] });
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs2", "x.ts", "reviewed");
    calls[1]!.resolve(ok());
    await b;
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content("cs").reviewState?.["x.ts"]).toBeUndefined();
    expect(content("cs2").reviewState?.["x.ts"]).toBe("reviewed");
  });

  it("RESET/HYDRATION boundary: a stale failure never alters the newly loaded snapshot (toast still shown)", async () => {
    const a = useArtifactStore.getState().setChangesetFileReview("cs", "src/x.ts", "reviewed");
    // A same-session reconnect reloads the snapshot — say the server holds "reviewed".
    useArtifactStore.getState().reset();
    useArtifactStore.getState().addArtifact(artifact("cs", {
      content: { files: [], reviewState: { "src/x.ts": "reviewed" } } as any,
    }));
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(content().reviewState?.["src/x.ts"]).toBe("reviewed");
    expect(toasts()).toEqual(["Mark file reviewed failed"]);
  });
});

describe("#422 — siblings with the same unconditional-restore catch", () => {
  it("updateArtifactStatus: older 'approved' fails after a newer 'revised' succeeded → stays revised", async () => {
    useArtifactStore.setState({ artifacts: [artifact("a1")] });
    const s = useArtifactStore.getState();
    const a = s.updateArtifactStatus("a1", "approved");
    const b = s.updateArtifactStatus("a1", "revised", "redo it");
    calls[1]!.resolve(ok());
    await b;
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("revised");
    expect(toasts()).toContain("Approve failed");
  });

  it("updateArtifactStatus: the artifact_updated broadcast lands before the failure → the broadcast's status stays", async () => {
    useArtifactStore.setState({ artifacts: [artifact("a1")] });
    const a = useArtifactStore.getState().updateArtifactStatus("a1", "approved");
    useArtifactStore.getState().updateArtifact("a1", "superseded", 2);
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("superseded");
  });

  it("CONTROL — updateArtifactStatus alone: the failure still rolls back", async () => {
    useArtifactStore.setState({ artifacts: [artifact("a1")] });
    const a = useArtifactStore.getState().updateArtifactStatus("a1", "approved");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
  });

  it("renameArtifact: an older rename failing after a newer one succeeded keeps the newer title", async () => {
    useArtifactStore.setState({ artifacts: [artifact("a1")] });
    const s = useArtifactStore.getState();
    const a = s.renameArtifact("a1", "First");
    const b = s.renameArtifact("a1", "Second");
    calls[1]!.resolve(ok());
    await b;
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().artifacts[0]!.title).toBe("Second");
  });

  it("resolveDecision: the decision_resolved broadcast (another tab picked o2) lands before o1's failure → o2 stays", async () => {
    useArtifactStore.setState({ artifacts: [artifact("dec_art", { type: "decision", content: { decisionId: "d1" } as any })] });
    const a = useArtifactStore.getState().resolveDecision("d1", "o1");
    useArtifactStore.getState().recordResolvedDecision("d1", { optionId: "o2" });
    useArtifactStore.getState().updateArtifact("dec_art", "approved");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().resolvedDecisions.d1?.optionId).toBe("o2");
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("approved");
  });

  it("CONTROL — resolveDecision alone: the failure rolls back both the record and the status", async () => {
    useArtifactStore.setState({ artifacts: [artifact("dec_art", { type: "decision", content: { decisionId: "d1" } as any })] });
    const a = useArtifactStore.getState().resolveDecision("d1", "o1");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().resolvedDecisions.d1).toBeUndefined();
    expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
  });

  it("resolveSuggestion: a comment_updated broadcast lands before the failure → the broadcast's suggestion stays", async () => {
    const sug = {
      id: "sg1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "human",
      content: "edit", acknowledged: false, createdAt: "2026-04-16T10:00:00.000Z",
      suggestion: { originalText: "x", replacementText: "y", lineStart: 1, lineEnd: 1, state: "pending" },
    } as Comment;
    useArtifactStore.getState().addComment(sug);
    const a = useArtifactStore.getState().resolveSuggestion("sg1", "insist");
    useArtifactStore.getState().updateComment({ ...sug, suggestion: { ...sug.suggestion!, state: "applied", appliedInVersion: 2 } });
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().comments.a1![0]!.suggestion!.state).toBe("applied");
  });
});

describe("#424 review — every settle order rolls back to the last SERVER-CONFIRMED value", () => {
  beforeEach(() => useArtifactStore.setState({ artifacts: [artifact("cs")] }));
  const file = () => content().reviewState?.["x.ts"];
  const reason = () => content().reviewReasons?.["x.ts"];

  it("file review: A then B, BOTH fail, A first → back to the original (never A's phantom value)", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "x.ts", "needs_changes", "why");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(file()).toBe("needs_changes"); // B is still pending and on screen
    calls[1]!.resolve(fail());
    await expect(b).rejects.toBeTruthy();
    expect(file()).toBeUndefined();
    expect(reason()).toBeUndefined();
  });

  it("file review: BOTH fail, B first → shows A while A is pending, then the original when A fails", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "x.ts", "needs_changes", "why");
    calls[1]!.resolve(fail());
    await expect(b).rejects.toBeTruthy();
    expect(file()).toBe("reviewed");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(file()).toBeUndefined();
  });

  it("file review: B fails while A is pending, then A SUCCEEDS → A's value (now confirmed)", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "x.ts", "needs_changes", "why");
    calls[1]!.resolve(fail());
    await expect(b).rejects.toBeTruthy();
    calls[0]!.resolve(ok());
    await a;
    expect(file()).toBe("reviewed");
  });

  it("CONTROL — file review: A succeeds, then B fails → A's value (the confirmed base)", async () => {
    useArtifactStore.setState({ artifacts: [artifact("cs", {
      content: { files: [], reviewState: { "x.ts": "needs_changes" }, reviewReasons: { "x.ts": "orig" } } as any,
    })] });
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "x.ts", "needs_changes", "second");
    calls[0]!.resolve(ok());
    await a;
    calls[1]!.resolve(fail());
    await expect(b).rejects.toBeTruthy();
    expect(file()).toBe("reviewed");
    expect(reason()).toBeUndefined();
  });

  it("CONTROL — file review: A fails, then B succeeds → B", async () => {
    const s = useArtifactStore.getState();
    const a = s.setChangesetFileReview("cs", "x.ts", "reviewed");
    const b = s.setChangesetFileReview("cs", "x.ts", "needs_changes", "why");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    calls[1]!.resolve(ok());
    await b;
    expect(file()).toBe("needs_changes");
    expect(reason()).toBe("why");
  });

  it("status: two clicks, both fail (either order) → back to draft", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      useArtifactStore.setState({ artifacts: [artifact("a1")] });
      calls = [];
      const s = useArtifactStore.getState();
      const p = [s.updateArtifactStatus("a1", "approved"), s.updateArtifactStatus("a1", "revised", "redo")];
      for (const i of order) {
        calls[i]!.resolve(fail());
        await expect(p[i]).rejects.toBeTruthy();
      }
      expect(useArtifactStore.getState().artifacts.find((a) => a.id === "a1")!.status).toBe("draft");
    }
  });

  it("rename: two renames, both fail (either order) → the original title", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      useArtifactStore.setState({ artifacts: [artifact("a1")] });
      calls = [];
      const s = useArtifactStore.getState();
      const p = [s.renameArtifact("a1", "First"), s.renameArtifact("a1", "Second")];
      for (const i of order) {
        calls[i]!.resolve(fail());
        await expect(p[i]).rejects.toBeTruthy();
      }
      expect(useArtifactStore.getState().artifacts.find((a) => a.id === "a1")!.title).toBe("Artifact a1");
    }
  });

  it("rename: another tab's artifact_renamed broadcast survives an older local rename failing", async () => {
    useArtifactStore.setState({ artifacts: [artifact("a1")] });
    const a = useArtifactStore.getState().renameArtifact("a1", "Mine");
    useArtifactStore.getState().applyArtifactRename("a1", "Theirs");
    calls[0]!.resolve(fail());
    await expect(a).rejects.toBeTruthy();
    expect(useArtifactStore.getState().artifacts[0]!.title).toBe("Theirs");
  });

  it("decision: two resolves, both fail (either order) → no record, status draft", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      useArtifactStore.getState().reset();
      useArtifactStore.setState({ artifacts: [artifact("dec_art", { type: "decision", content: { decisionId: "d1" } as any })] });
      calls = [];
      const s = useArtifactStore.getState();
      const p = [s.resolveDecision("d1", "o1"), s.resolveDecision("d1", "o2")];
      for (const i of order) {
        calls[i]!.resolve(fail());
        await expect(p[i]).rejects.toBeTruthy();
      }
      expect(useArtifactStore.getState().resolvedDecisions.d1).toBeUndefined();
      expect(useArtifactStore.getState().artifacts[0]!.status).toBe("draft");
    }
  });

  it("suggestion: two actions, both fail (either order) → the original pending suggestion", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      useArtifactStore.getState().reset();
      calls = [];
      const sug = {
        id: "sg1", sessionId: "s1", target: { artifactId: "a1" }, parentCommentId: null, author: "human",
        content: "edit", acknowledged: false, createdAt: "2026-04-16T10:00:00.000Z",
        suggestion: { originalText: "x", replacementText: "y", lineStart: 1, lineEnd: 1, state: "pending" },
      } as Comment;
      useArtifactStore.getState().addComment(sug);
      const s = useArtifactStore.getState();
      const p = [s.resolveSuggestion("sg1", "insist"), s.resolveSuggestion("sg1", "take_counter")];
      for (const i of order) {
        calls[i]!.resolve(fail());
        await expect(p[i]).rejects.toBeTruthy();
      }
      expect(useArtifactStore.getState().comments.a1![0]!.suggestion!.state).toBe("pending");
    }
  });
});
