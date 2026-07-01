import { nanoid } from "nanoid";
import type { ToolContext, ToolResult } from "./types.js";

/** B3 — answer_question, extracted verbatim from the server.ts switch. */
export async function handleAnswerQuestion(ctx: ToolContext, args: any): Promise<ToolResult> {
  const { store, broadcast } = ctx;

  const commentId = String(args?.commentId ?? "").trim();
  const answer = String(args?.answer ?? "").trim();
  if (!commentId || !answer) {
    return {
      content: [{ type: "text", text: "answer_question requires commentId and answer." }],
      isError: true,
    };
  }

  // AA7b — getComment is required on IStore; cast was dead weight.
  const parent = await store.getComment(commentId);
  if (!parent) {
    return {
      content: [{ type: "text", text: `answer_question: no comment with id ${commentId}.` }],
      isError: true,
    };
  }

  const answerId = `cmt_${nanoid(10)}`;
  const codeRefs = Array.isArray(args?.evidence)
    ? args.evidence
        .filter((e: any) => e && typeof e === "object")
        .map((e: any) => ({
          filePath: String(e.filePath ?? ""),
          lineStart: Number(e.lineStart ?? 1),
          lineEnd: Number(e.lineEnd ?? e.lineStart ?? 1),
          snippet: e.snippet ? String(e.snippet) : undefined,
        }))
        .filter((e: any) => e.filePath)
    : undefined;

  // FN1 — pass codeReferences as a first-class param so it survives the
  // DaemonClient HTTP round-trip in production. Pre-FN1 it was mutated
  // onto the returned object, which is a throwaway copy in daemon mode →
  // the agent's code evidence never reached the store or the UI.
  const answerComment = await store.addComment({
    id: answerId,
    artifactId: parent.target?.artifactId ?? "__session__",
    content: answer,
    author: "agent",
    target: parent.target ?? { artifactId: "__session__" },
    parentCommentId: commentId,
    ...(codeRefs && codeRefs.length > 0 ? { codeReferences: codeRefs } : {}),
  } as any);

  // AA7b — markCommentAnswered is required on IStore.
  await store.markCommentAnswered(commentId, answerId);

  broadcast({ type: "comment_added", comment: answerComment });
  // O7: distinct event so the UI can toast the answer moment (otherwise
  // it just blends into the artifact's comment thread and the human
  // might not notice their question was picked up).
  broadcast({
    type: "question_answered",
    questionId: commentId,
    answerId,
    artifactId: parent.target?.artifactId,
    answerExcerpt: answer.slice(0, 120),
  });
  return {
    content: [{ type: "text", text: `Answered ${commentId}. The human will see the reply under their question.${await ctx.helpers.getPassiveFeedback()}` }],
  };
}
