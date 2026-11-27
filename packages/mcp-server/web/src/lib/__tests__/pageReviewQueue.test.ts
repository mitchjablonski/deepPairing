/**
 * #714 gap 7 — review-queue state derivation: one honest state per anchored
 * comment, with addressed (revision / answer / resolved) winning over
 * orphaned, and the MCP drain ("seen") staying open.
 */
import { describe, it, expect } from "vitest";
import type { Comment } from "@deeppairing/shared";
import { buildQueue, deriveCommentState, pinState, queueCounts, stateLabel, threadReplies } from "../pageReviewQueue";

const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 10, n)).toISOString();
const c = (id: string, n: number, extra: Partial<Comment> = {}): Comment => ({
  id,
  sessionId: "s",
  target: { artifactId: "art_1", htmlAnchor: { kind: "element", locator: "p", quote: id } },
  parentCommentId: null,
  author: "human",
  content: id,
  acknowledged: false,
  createdAt: at(n),
  ...extra,
});

describe("deriveCommentState", () => {
  it("open, and seen (drained) is still open", () => {
    expect(deriveCommentState(c("a", 1), [], false)).toEqual({ kind: "open", seen: false });
    expect(deriveCommentState(c("a", 1, { acknowledged: true }), [], false)).toEqual({ kind: "open", seen: true });
  });

  it("addressed via a revision ack names the version, even when the spot is gone", () => {
    const rev = c("a", 1, { acknowledged: true, addressedIn: { artifactId: "art_3", version: 3 } });
    expect(deriveCommentState(rev, [], true)).toEqual({ kind: "addressed", via: "revision", version: 3 });
    expect(stateLabel(deriveCommentState(rev, [], true)).text).toBe("Addressed in v3");
  });

  it("addressed via an agent answer (answeredByCommentId or an agent reply after it)", () => {
    expect(deriveCommentState(c("a", 1, { answeredByCommentId: "x" }), [], false)).toEqual({ kind: "addressed", via: "answer" });
    const agentReply = c("r", 2, { author: "agent", parentCommentId: "a" });
    expect(deriveCommentState(c("a", 1), [agentReply], false)).toEqual({ kind: "addressed", via: "answer" });
    // A human reply doesn't count.
    expect(deriveCommentState(c("a", 1), [c("r", 2, { parentCommentId: "a" })], false).kind).toBe("open");
  });

  it("resolved by you, then orphaned, then open", () => {
    expect(deriveCommentState(c("a", 1, { humanResolvedAt: at(3) }), [], true)).toEqual({ kind: "addressed", via: "resolved" });
    expect(deriveCommentState(c("a", 1, { acknowledged: true }), [], true)).toEqual({ kind: "orphaned" });
  });

  it("each state has its own wording", () => {
    const texts = [
      deriveCommentState(c("a", 1), [], false),
      deriveCommentState(c("a", 1, { acknowledged: true }), [], false),
      deriveCommentState(c("a", 1, { addressedIn: { artifactId: "x", version: 2 } }), [], false),
      deriveCommentState(c("a", 1, { answeredByCommentId: "x" }), [], false),
      deriveCommentState(c("a", 1, { humanResolvedAt: at(2) }), [], false),
      deriveCommentState(c("a", 1), [], true),
    ].map((s) => stateLabel(s).text);
    expect(texts).toEqual(["Open", "Seen by agent", "Addressed in v2", "Answered by the agent", "Resolved by you", "Not found in this version"]);
  });

  it("pin colour: addressed greys, everything else is open", () => {
    expect(pinState({ kind: "addressed", via: "answer" })).toBe("addressed");
    expect(pinState({ kind: "open", seen: true })).toBe("open");
    expect(pinState({ kind: "orphaned" })).toBe("open");
  });
});

describe("the latest word in the thread decides (#722 review)", () => {
  const human = (id: string, n: number) => c(id, n, { parentCommentId: "a" });
  const agent = (id: string, n: number) => c(id, n, { parentCommentId: "a", author: "agent" });

  it("an agent reply after your follow-up answers it again; your follow-up after the agent's reply reopens it", () => {
    expect(deriveCommentState(c("a", 1), [agent("r1", 2), human("h1", 3)], false)).toEqual({ kind: "open", seen: false, reopened: true });
    expect(stateLabel(deriveCommentState(c("a", 1), [agent("r1", 2), human("h1", 3)], false)).text).toBe("Reopened");
    expect(deriveCommentState(c("a", 1), [agent("r1", 2), human("h1", 3), agent("r2", 4)], false)).toEqual({ kind: "addressed", via: "answer" });
    // An agent clarifying question still reads as answered until you reply.
    expect(deriveCommentState(c("a", 1), [agent("q", 2)], false).kind).toBe("addressed");
  });

  it("a human reply before the agent's reply doesn't reopen it", () => {
    expect(deriveCommentState(c("a", 1), [human("h1", 2), agent("r1", 3)], false)).toEqual({ kind: "addressed", via: "answer" });
  });

  it("a revision addresses it only when it came after your latest message", () => {
    const rev = (at?: string) => c("a", 1, { addressedIn: { artifactId: "art_v2", version: 2, ...(at ? { at } : {}) } });
    expect(deriveCommentState(rev(at(5)), [human("h1", 3)], false)).toEqual({ kind: "addressed", via: "revision", version: 2 });
    expect(deriveCommentState(rev(at(5)), [human("h1", 6)], false)).toEqual({ kind: "open", seen: false, reopened: true });
    // No `at`: the revision artifact's createdAt from the store chain.
    const opts = { revisionAt: (id: string) => (id === "art_v2" ? at(5) : undefined) };
    expect(deriveCommentState(rev(), [human("h1", 6)], false, opts).kind).toBe("open");
    expect(deriveCommentState(rev(), [human("h1", 4)], false, opts).kind).toBe("addressed");
    // Neither known: right after the root, so any later human reply reopens.
    expect(deriveCommentState(rev(), [], false).kind).toBe("addressed");
    expect(deriveCommentState(rev(), [human("h1", 2)], false).kind).toBe("open");
  });

  it("an answer link without its reply in the thread counts as just after the root", () => {
    expect(deriveCommentState(c("a", 1, { answeredByCommentId: "x" }), [], false).kind).toBe("addressed");
    expect(deriveCommentState(c("a", 1, { answeredByCommentId: "x" }), [human("h1", 2)], false).kind).toBe("open");
  });

  it("your resolve, then a reply, reopens; a reopened comment whose spot is gone is orphaned", () => {
    expect(deriveCommentState(c("a", 1, { humanResolvedAt: at(3) }), [human("h1", 4)], false)).toMatchObject({ kind: "open", reopened: true });
    expect(deriveCommentState(c("a", 1), [agent("r1", 2), human("h1", 3)], true)).toEqual({ kind: "orphaned" });
    expect(pinState(deriveCommentState(c("a", 1), [agent("r1", 2), human("h1", 3)], false))).toBe("open");
  });
});

describe("threadReplies and buildQueue", () => {
  it("counts every reply in the thread, nested ones included, and nothing from other threads", () => {
    const a = c("a", 1);
    const all = [a, c("b", 2), c("r1", 3, { parentCommentId: "a" }), c("r2", 4, { parentCommentId: "r1" }), c("r3", 5, { parentCommentId: "b" })];
    expect(threadReplies(a, all).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("builds entries with pin order, reply counts and per-bucket counts", () => {
    const roots = [c("a", 1), c("b", 2, { addressedIn: { artifactId: "x", version: 2 } }), c("d", 3)];
    const all = [...roots, c("r", 4, { parentCommentId: "a" })];
    const q = buildQueue(roots, all, (_c, i) => i === 2);
    expect(q.map((e) => [e.comment.id, e.index, e.state.kind, e.replies, e.missing])).toEqual([
      ["a", 0, "open", 1, false],
      ["b", 1, "addressed", 0, false],
      ["d", 2, "orphaned", 0, true],
    ]);
    expect(queueCounts(q)).toEqual({ open: 1, addressed: 1, orphaned: 1 });
  });
});
