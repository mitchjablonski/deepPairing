import { describe, it, expect } from "vitest";
import type { Comment } from "../schemas/comment.js";
import {
  isUnansweredQuestion,
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

describe("#192 — shared unanswered-question queue (the ONE tail-walk definition)", () => {
  it("isUnansweredQuestion: an open human question with no reply is waiting", () => {
    const root = c({ id: "q1", intent: "question" } as any);
    expect(isUnansweredQuestion(root, [])).toBe(true);
  });

  it("isUnansweredQuestion: an agent reply after the question closes it (agent had the last word)", () => {
    const root = c({ id: "q1", intent: "question" } as any);
    const reply = c({ id: "a1", author: "agent", parentCommentId: "q1", createdAt: "2026-01-01T00:01:00.000Z" });
    expect(isUnansweredQuestion(root, [reply])).toBe(false);
  });

  it("isUnansweredQuestion: humanResolvedAt closes it even with no agent reply", () => {
    const root = c({ id: "q1", intent: "question", humanResolvedAt: "2026-01-02T00:00:00.000Z" } as any);
    expect(isUnansweredQuestion(root, [])).toBe(false);
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

  it("collectUnansweredQuestions: a follow-up question asked as a reply still counts (tail-walk)", () => {
    // Human comments, agent replies, human asks a follow-up question on the reply.
    const comments = [
      c({ id: "root", intent: "comment", createdAt: "2026-01-01T00:00:00.000Z" } as any),
      c({ id: "agent1", author: "agent", parentCommentId: "root", createdAt: "2026-01-01T00:01:00.000Z" }),
      c({ id: "followup", intent: "question", parentCommentId: "agent1", createdAt: "2026-01-01T00:02:00.000Z" } as any),
    ];
    const out = collectUnansweredQuestions(comments);
    expect(out.length).toBe(1);
    // The queue entry roots at the thread root (the original comment).
    expect(out[0]!.root.id).toBe("root");
  });
});
