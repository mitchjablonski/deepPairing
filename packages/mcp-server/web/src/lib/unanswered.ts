/**
 * #192 — the unanswered-question predicate now lives in @deeppairing/shared so
 * the SERVER reuses the exact same tail-walk definition (first-call hint +
 * check_feedback carryover) instead of a second, drifting one. This module stays
 * as the web import path so ConversationRail, TurnIndicator, and App's badge
 * count are unchanged.
 */
export { isUnansweredQuestion, countUnansweredQuestions } from "@deeppairing/shared";
import { buildThreads, type Comment } from "@deeppairing/shared";

/**
 * #430 PR 1c (docs/design/attention-hierarchy.md §2.8, §8 1c) — the PER-QUESTION
 * "still waiting?" rule every per-comment surface uses (AskTrigger's count and
 * pulse, the comment receipt, LineComments, OpenQuestionSection, and
 * computeAttention's Waiting items). A human question is answered only when
 *   - it carries an out-of-band answer (`answeredByCommentId`), or
 *   - an AGENT reply exists AFTER it in its thread,
 * and it is cleared when the human resolved it (`humanResolvedAt`).
 *
 * The old per-surface check was flat (`!answeredByCommentId`) and missed the
 * threaded reply. The shared tail-walk (`collectUnansweredQuestions`) is a
 * THREAD-level rule — at most one open question per thread (the tail) — which is
 * right for "how many threads wait on the agent" but wrong per question: a
 * human follow-up after Q1 would hide Q1 (review of #448). So this walks each
 * thread chronologically: an agent message closes every question before it.
 *
 * Returns the ids of the questions still OPEN across `comments` (pass the whole
 * thread set, not a pre-filtered slice, so replies are seen).
 */
export function unansweredQuestionIds(comments: Comment[]): Set<string> {
  const open = new Set<string>();
  for (const { root, replies } of buildThreads(comments)) {
    // Chronological (buildThreads sorts replies; the root is first).
    let waiting: string[] = [];
    for (const m of [root, ...replies]) {
      if (m.author === "agent") {
        waiting = []; // an agent reply answers every question before it in the thread
        continue;
      }
      const x = m as { intent?: string; answeredByCommentId?: string | null; humanResolvedAt?: string | null };
      if (x.intent === "question" && !x.answeredByCommentId && !x.humanResolvedAt) waiting.push(m.id);
    }
    for (const id of waiting) open.add(id);
  }
  return open;
}
