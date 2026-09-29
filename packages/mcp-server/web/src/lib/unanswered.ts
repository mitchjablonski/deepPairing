/**
 * #192 — the unanswered-question rule lives in @deeppairing/shared so the SERVER
 * (check_feedback carryover, first-call hint, daemon/context-bank counts) and
 * every UI surface use the exact same definition. This module is the web import
 * path.
 *
 * #430 PR 1c — the shared rule is PER QUESTION (see shared/src/unanswered.ts): a
 * human question is answered only by `answeredByCommentId` or an agent reply
 * after it in its thread, and cleared by `humanResolvedAt`. Counts are counts of
 * QUESTIONS; `threadHasOpenQuestion` is the one, explicitly thread-level, view.
 */
import { collectUnansweredQuestions, type Comment } from "@deeppairing/shared";
export { countUnansweredQuestions, threadHasOpenQuestion, openQuestionsInThread } from "@deeppairing/shared";

/** Ids of the questions still OPEN across `comments` (pass the whole thread set,
 *  not a pre-filtered slice, so replies are seen) — AskTrigger, the receipt,
 *  LineComments, OpenQuestionSection and computeAttention read this. */
export function unansweredQuestionIds(comments: Comment[]): Set<string> {
  return new Set(collectUnansweredQuestions(comments).map((q) => q.question.id));
}
