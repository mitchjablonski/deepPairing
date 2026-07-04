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
  it("false once it has a reply, or is answered out-of-band, or human-resolved", () => {
    expect(isUnansweredQuestion(mk({ intent: "question" }), [mk({ id: "r" })])).toBe(false);
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

    it("root requirement stays: a non-question root does not re-open on a follow-up question", () => {
      const plainRoot = mk({ id: "root", intent: "comment" });
      const followup = mk({ id: "fu", intent: "question", parentCommentId: "root" });
      expect(isUnansweredQuestion(plainRoot, [followup])).toBe(false);
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
