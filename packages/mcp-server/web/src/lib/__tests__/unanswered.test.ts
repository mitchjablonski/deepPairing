import { describe, it, expect } from "vitest";
import type { Comment } from "@deeppairing/shared";
import { isUnansweredQuestion, countUnansweredQuestions } from "../unanswered";

const mk = (over: Partial<Comment>): Comment =>
  ({
    id: "c",
    sessionId: "s",
    author: "human",
    content: "",
    target: { artifactId: "a1" },
    parentCommentId: null,
    createdAt: "2026-06-26T00:00:00.000Z",
    ...over,
  }) as any;

describe("isUnansweredQuestion", () => {
  it("true for a human question with no reply, not answered/resolved", () => {
    expect(isUnansweredQuestion(mk({ intent: "question" }), [])).toBe(true);
  });
  it("false for a plain comment / suggestion", () => {
    expect(isUnansweredQuestion(mk({ intent: "comment" }), [])).toBe(false);
    expect(isUnansweredQuestion(mk({ intent: "suggestion" }), [])).toBe(false);
  });
  it("false once the AGENT replies, or answered out-of-band, or human-resolved", () => {
    // Tail-walk: an AGENT reply answers; a human plain reply does NOT (that
    // was the shared (1b) gap — "btw also consider X" silently closed the
    // thread with zero agent involvement).
    expect(isUnansweredQuestion(mk({ intent: "question" }), [mk({ id: "r", author: "agent" })])).toBe(false);
    expect(isUnansweredQuestion(mk({ intent: "question", answeredByCommentId: "x" } as any), [])).toBe(false);
    expect(isUnansweredQuestion(mk({ intent: "question", humanResolvedAt: "t" } as any), [])).toBe(false);
  });
  it("false for an agent question", () => {
    expect(isUnansweredQuestion(mk({ intent: "question", author: "agent" }), [])).toBe(false);
  });

  // The TAIL blind spot (the fix): the predicate judges the thread's
  // chronological last message, not merely "does a reply exist". replies come
  // from buildThreads already sorted, so replies[last] IS the tail.
  describe("the thread TAIL governs, not 'has any reply'", () => {
    const root = mk({ id: "root", intent: "question" });
    const agentAns = mk({ id: "ans", author: "agent", parentCommentId: "root" });

    it("(a) ends in an un-answered human follow-up question → UNANSWERED", () => {
      const followup = mk({ id: "fu", intent: "question", parentCommentId: "ans" });
      expect(isUnansweredQuestion(root, [agentAns, followup])).toBe(true);
    });

    it("(b) ends in an agent reply → answered", () => {
      const followup = mk({ id: "fu", intent: "question", parentCommentId: "root" });
      expect(isUnansweredQuestion(root, [followup, agentAns])).toBe(false);
    });

    it("(c) tail follow-up question answered out-of-band → answered", () => {
      const followup = mk({ id: "fu", intent: "question", parentCommentId: "ans", answeredByCommentId: "x" } as any);
      expect(isUnansweredQuestion(root, [agentAns, followup])).toBe(false);
    });

    it("(d) tail follow-up question human-resolved → answered", () => {
      const followup = mk({ id: "fu", intent: "question", parentCommentId: "ans", humanResolvedAt: "t" } as any);
      expect(isUnansweredQuestion(root, [agentAns, followup])).toBe(false);
    });

    it("I4 — a human question ASKED AS A REPLY re-flags a human-comment-rooted thread", () => {
      // The common case: human comments on the agent's artifact, then flips the
      // reply composer to Ask. Pre-I4 this was silently inert (root not a
      // question); the pure tail-walk now counts it (an open human question is
      // awaiting the agent regardless of what the thread started as).
      const plainRoot = mk({ id: "root", intent: "comment" });
      const followup = mk({ id: "fu", intent: "question", parentCommentId: "root" });
      expect(isUnansweredQuestion(plainRoot, [followup])).toBe(true);
    });
    it("a plain-comment thread with no question anywhere is still not waiting", () => {
      const plainRoot = mk({ id: "root", intent: "comment" });
      const plainReply = mk({ id: "r", intent: "comment", parentCommentId: "root" });
      expect(isUnansweredQuestion(plainRoot, [plainReply])).toBe(false);
    });
    it("I4 — a human question on an AGENT-rooted thread counts (human awaits the agent)", () => {
      const agentRoot = mk({ id: "root", author: "agent" });
      const humanQ = mk({ id: "q", intent: "question", parentCommentId: "root" });
      expect(isUnansweredQuestion(agentRoot, [humanQ])).toBe(true);
    });
    it("a CLOSED human-question reply on a comment root does not flag", () => {
      const plainRoot = mk({ id: "root", intent: "comment" });
      const closedQ = mk({ id: "q", intent: "question", parentCommentId: "root", answeredByCommentId: "x" } as any);
      expect(isUnansweredQuestion(plainRoot, [closedQ])).toBe(false);
    });
    it("multi-hop: comment root → agent reply → open human question re-flags", () => {
      const plainRoot = mk({ id: "root", intent: "comment" });
      const agentAns = mk({ id: "a", author: "agent", parentCommentId: "root", createdAt: "2026-06-26T00:01:00.000Z" });
      const humanQ = mk({ id: "q", intent: "question", parentCommentId: "root", createdAt: "2026-06-26T00:02:00.000Z" });
      expect(isUnansweredQuestion(plainRoot, [agentAns, humanQ])).toBe(true);
    });
  });
});

describe("countUnansweredQuestions (flat list — the App badge)", () => {
  it("counts only genuinely-open human questions, matching the rail", () => {
    const all = [
      mk({ id: "q_open", intent: "question" }),                                   // counts
      mk({ id: "q_ans", intent: "question", answeredByCommentId: "a" } as any),   // answered out-of-band
      mk({ id: "q_res", intent: "question", humanResolvedAt: "t" } as any),       // resolved
      mk({ id: "q_replied", intent: "question" }),
      mk({ id: "r1", author: "agent", parentCommentId: "q_replied" }),            // → q_replied answered
      mk({ id: "plain", intent: "comment" }),                                     // not a question
    ];
    expect(countUnansweredQuestions(all)).toBe(1);
  });

  it("counts a thread ending in a human follow-up question ONCE (top-level-only scan)", () => {
    const all = [
      mk({ id: "root", intent: "question" }),
      mk({ id: "r_q", intent: "question", parentCommentId: "root" }), // a reply that is itself a question
    ];
    // The tail is an open human follow-up question → the root thread counts.
    // The reply is not its own root, so it is counted once (not twice) — the
    // rail's top-level-only scan is preserved.
    expect(countUnansweredQuestions(all)).toBe(1);
  });

  it("does NOT count a thread whose human follow-up question was answered by the agent", () => {
    const all = [
      mk({ id: "root", intent: "question" }),
      mk({ id: "r_q", intent: "question", parentCommentId: "root", createdAt: "2026-06-26T00:01:00.000Z" }),
      mk({ id: "a1", author: "agent", parentCommentId: "r_q", createdAt: "2026-06-26T00:02:00.000Z" }), // tail = agent
    ];
    expect(countUnansweredQuestions(all)).toBe(0);
  });
});

describe("tail-walk (review) — trailing human non-questions don't decide", () => {
  const root = mk({ id: "q", intent: "question" } as any);

  it("open root + trailing human CONTEXT comment stays UNANSWERED (no agent involvement)", () => {
    const context = mk({ id: "ctx", parentCommentId: "q", createdAt: "2026-06-26T00:01:00.000Z" } as any);
    expect(isUnansweredQuestion(root, [context])).toBe(true);
  });

  it("agent answer + trailing human context stays ANSWERED", () => {
    const ans = mk({ id: "ans", author: "agent", parentCommentId: "q", createdAt: "2026-06-26T00:01:00.000Z" } as any);
    const context = mk({ id: "ctx", parentCommentId: "q", createdAt: "2026-06-26T00:02:00.000Z" } as any);
    expect(isUnansweredQuestion(root, [ans, context])).toBe(false);
  });

  it("open follow-up question + trailing human context stays UNANSWERED", () => {
    const ans = mk({ id: "ans", author: "agent", parentCommentId: "q", createdAt: "2026-06-26T00:01:00.000Z" } as any);
    const fup = mk({ id: "fup", intent: "question", parentCommentId: "q", createdAt: "2026-06-26T00:02:00.000Z" } as any);
    const context = mk({ id: "ctx", parentCommentId: "q", createdAt: "2026-06-26T00:03:00.000Z" } as any);
    expect(isUnansweredQuestion(root, [ans, fup, context])).toBe(true);
  });

  it("resolved root + only human context replies stays ANSWERED (resolution holds)", () => {
    const resolved = mk({ id: "q2", intent: "question", humanResolvedAt: "2026-06-26T00:00:30.000Z" } as any);
    const context = mk({ id: "ctx", parentCommentId: "q2", createdAt: "2026-06-26T00:01:00.000Z" } as any);
    expect(isUnansweredQuestion(resolved, [context])).toBe(false);
  });
});
