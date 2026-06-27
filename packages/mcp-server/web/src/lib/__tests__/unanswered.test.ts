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

  it("does NOT count a human question posted as a REPLY (matches the rail's top-level-only scan)", () => {
    const all = [
      mk({ id: "root", intent: "question" }),
      mk({ id: "r_q", intent: "question", parentCommentId: "root" }), // a reply that is itself a question
    ];
    // root has a reply → not counted; the reply is not a root → not counted.
    expect(countUnansweredQuestions(all)).toBe(0);
  });
});
