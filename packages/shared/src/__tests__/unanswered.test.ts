import { describe, it, expect } from "vitest";
import type { Comment } from "../schemas/comment.js";
import {
  threadHasOpenQuestion,
  openQuestionsInThread,
  countUnansweredQuestions,
  collectUnansweredQuestions,
  buildThreads,
} from "../unanswered.js";

const c = (over: Partial<Comment> & { id: string }): Comment =>
  ({
    sessionId: "s1",
    target: { artifactId: "art_1" },
    parentCommentId: null,
    author: "human",
    content: "why?",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as Comment;

describe("#192 / #430 PR 1c — shared unanswered-question queue (the ONE per-question definition)", () => {
  it("threadHasOpenQuestion: an open human question with no reply is waiting", () => {
    const root = c({ id: "q1", intent: "question" } as any);
    expect(threadHasOpenQuestion(root, [])).toBe(true);
  });

  it("threadHasOpenQuestion: an agent reply after the question closes it (agent had the last word)", () => {
    const root = c({ id: "q1", intent: "question" } as any);
    const reply = c({ id: "a1", author: "agent", parentCommentId: "q1", createdAt: "2026-01-01T00:01:00.000Z" });
    expect(threadHasOpenQuestion(root, [reply])).toBe(false);
  });

  it("threadHasOpenQuestion: humanResolvedAt closes it even with no agent reply", () => {
    const root = c({ id: "q1", intent: "question", humanResolvedAt: "2026-01-02T00:00:00.000Z" } as any);
    expect(threadHasOpenQuestion(root, [])).toBe(false);
  });

  it("countUnansweredQuestions matches the rendered thread grouping", () => {
    const comments = [
      c({ id: "q1", intent: "question" } as any),
      c({ id: "q2", intent: "question", answeredByCommentId: "x" } as any),
      c({ id: "note", intent: "comment" } as any),
    ];
    expect(countUnansweredQuestions(comments)).toBe(1);
    // Sanity: buildThreads groups roots, so the count derives from the same view.
    expect(buildThreads(comments).length).toBe(3);
  });

  it("collectUnansweredQuestions returns oldest-first, with artifact + comment refs", () => {
    const comments = [
      c({ id: "q_new", intent: "question", target: { artifactId: "art_2" }, createdAt: "2026-01-03T00:00:00.000Z" } as any),
      c({ id: "q_old", intent: "question", target: { artifactId: "art_1" }, createdAt: "2026-01-01T00:00:00.000Z" } as any),
      c({ id: "answered", intent: "question", answeredByCommentId: "z", createdAt: "2026-01-02T00:00:00.000Z" } as any),
    ];
    const out = collectUnansweredQuestions(comments);
    expect(out.map((q) => q.root.id)).toEqual(["q_old", "q_new"]);
    expect(out[0]!.artifactId).toBe("art_1");
    expect(out[1]!.artifactId).toBe("art_2");
  });

  it("collectUnansweredQuestions: a follow-up question asked as a reply targets the FOLLOW-UP, not the root (Fix 1)", () => {
    // The I4 common flow: human comments, agent replies, human asks a follow-up
    // question ON the reply. The open question is the FOLLOW-UP (thread tail).
    // Pre-Fix-1 the entry pointed at `root` (a non-question comment) — so the
    // agent would answer the wrong comment and the real question went unaddressed.
    const comments = [
      c({ id: "root", content: "here's a thought", intent: "comment", createdAt: "2026-01-01T00:00:00.000Z" } as any),
      c({ id: "agent1", author: "agent", content: "noted", parentCommentId: "root", createdAt: "2026-01-01T00:01:00.000Z" }),
      c({ id: "followup", content: "but does it handle retries?", intent: "question", parentCommentId: "agent1", createdAt: "2026-01-01T00:02:00.000Z" } as any),
    ];
    const out = collectUnansweredQuestions(comments);
    expect(out.length).toBe(1);
    // `question` is the actual open question to answer (answer_question commentId).
    expect(out[0]!.question.id).toBe("followup");
    expect(out[0]!.question.content).toBe("but does it handle retries?");
    // `root` is retained only for thread context.
    expect(out[0]!.root.id).toBe("root");
  });

  it("openQuestionsInThread returns the specific open-question comments", () => {
    const root = c({ id: "root", intent: "comment" } as any);
    const agent = c({ id: "a", author: "agent", parentCommentId: "root", createdAt: "2026-01-01T00:01:00.000Z" });
    const followup = c({ id: "fu", intent: "question", parentCommentId: "a", createdAt: "2026-01-01T00:02:00.000Z" } as any);
    expect(openQuestionsInThread(root, [agent, followup]).map((q) => q.id)).toEqual(["fu"]);
    // An agent reply after the follow-up closes it.
    const agentAnswer = c({ id: "a2", author: "agent", parentCommentId: "fu", createdAt: "2026-01-01T00:03:00.000Z" });
    expect(openQuestionsInThread(root, [agent, followup, agentAnswer])).toEqual([]);
  });
});

describe("#430 PR 1c (review of #448) — per QUESTION, never hidden by a follow-up", () => {
  const q1 = c({ id: "q1", intent: "question", createdAt: "2026-01-01T00:00:00.000Z" } as any);
  const q2 = (over: Record<string, unknown> = {}) =>
    c({ id: "q2", intent: "question", parentCommentId: "q1", createdAt: "2026-01-01T00:01:00.000Z", ...over } as any);
  const agentAfter = c({ id: "a", author: "agent", parentCommentId: "q2", createdAt: "2026-01-01T00:02:00.000Z" });

  it("A — Q1 then a follow-up Q2: BOTH open (the tail-walk said 1)", () => {
    const all = [q1, q2()];
    expect(collectUnansweredQuestions(all).map((u) => u.question.id)).toEqual(["q1", "q2"]);
    expect(countUnansweredQuestions(all)).toBe(2);
    expect(threadHasOpenQuestion(q1, [q2()])).toBe(true);
  });

  it("B — Q1 then Q2 resolved by the human: Q1 is still open (the tail-walk said 0)", () => {
    const all = [q1, q2({ humanResolvedAt: "2026-01-01T00:05:00.000Z" })];
    expect(collectUnansweredQuestions(all).map((u) => u.question.id)).toEqual(["q1"]);
    expect(countUnansweredQuestions(all)).toBe(1);
    expect(threadHasOpenQuestion(q1, [all[1]!])).toBe(true);
  });

  it("C — an agent reply after both answers both", () => {
    const all = [q1, q2(), agentAfter];
    expect(countUnansweredQuestions(all)).toBe(0);
    expect(threadHasOpenQuestion(q1, [q2(), agentAfter])).toBe(false);
  });
});
