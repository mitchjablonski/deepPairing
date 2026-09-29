/**
 * #192 — the unanswered-question predicate now lives in @deeppairing/shared so
 * the SERVER reuses the exact same tail-walk definition (first-call hint +
 * check_feedback carryover) instead of a second, drifting one. This module stays
 * as the web import path so ConversationRail, TurnIndicator, and App's badge
 * count are unchanged.
 */
export { isUnansweredQuestion, countUnansweredQuestions } from "@deeppairing/shared";
import { collectUnansweredQuestions, type Comment } from "@deeppairing/shared";

/**
 * #430 PR 1c (docs/design/attention-hierarchy.md §2.8, §8 1c) — the ONE
 * "unanswered question" rule for every per-comment surface: a question is
 * unanswered until an agent reply exists IN ITS THREAD (the shared tail-walk,
 * which also honours an out-of-band `answeredByCommentId`) or the human marked
 * it resolved. AskTrigger, LineComments, OpenQuestionSection and the comment
 * receipt used a FLAT check (`!answeredByCommentId`), so an agent's threaded
 * reply never cleared them while the rail, the header badge and
 * computeAttention (all tail-walk) already said "answered".
 *
 * Returns the ids of the questions that are still OPEN across `comments`
 * (pass the whole thread set, not a pre-filtered slice, so replies are seen).
 */
export function unansweredQuestionIds(comments: Comment[]): Set<string> {
  return new Set(collectUnansweredQuestions(comments).map((q) => q.question.id));
}
