import { describe, it, expect } from "vitest";
import type { Comment } from "../schemas/comment.js";
import {
  isUnansweredQuestion,
  findOpenQuestion,
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

  it("findOpenQuestion returns the specific open-question comment (or null)", () => {
    const root = c({ id: "root", intent: "comment" } as any);
    const agent = c({ id: "a", author: "agent", parentCommentId: "root", createdAt: "2026-01-01T00:01:00.000Z" });
    const followup = c({ id: "fu", intent: "question", parentCommentId: "a", createdAt: "2026-01-01T00:02:00.000Z" } as any);
    expect(findOpenQuestion(root, [agent, followup])?.id).toBe("fu");
    // An agent reply after the follow-up closes it → null.
    const agentAnswer = c({ id: "a2", author: "agent", parentCommentId: "fu", createdAt: "2026-01-01T00:03:00.000Z" });
    expect(findOpenQuestion(root, [agent, followup, agentAnswer])).toBeNull();
  });
});
