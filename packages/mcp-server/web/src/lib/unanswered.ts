import type { Comment } from "@deeppairing/shared";
import { buildThreads } from "./threading";

/**
 * The single source of truth for "a human question still awaiting the agent".
 * Used by ConversationRail (pill count, filter, inline marker) AND App (the
 * Conversation-button badge) so they can't drift.
 *
 * A thread is unanswered when its ROOT is a human question AND its chronological
 * TAIL is itself an open human question — one that lacks an out-of-band answer
 * (answeredByCommentId) and a human resolution (humanResolvedAt). Judging the
 * TAIL (not just "has any reply") is the fix for the blind spot where a thread
 * whose LAST message was a human FOLLOW-UP question read as "answered" merely
 * because a reply existed. When `replies` is empty the tail IS the root, so this
 * reduces exactly to the pre-fix no-reply behavior.
 *
 * The root-question requirement stays: a thread rooted at a non-question does
 * not become one just because a later follow-up is a question.
 */
export function isUnansweredQuestion(comment: Comment, replies: Comment[]): boolean {
  const isOpenHumanQuestion = (m: Comment): boolean => {
    const x = m as {
      intent?: string;
      answeredByCommentId?: string | null;
      humanResolvedAt?: string | null;
    };
    return (
      m.author === "human" &&
      x.intent === "question" &&
      !x.answeredByCommentId &&
      !x.humanResolvedAt
    );
  };
  const root = comment as { intent?: string };
  // Root must be a human question (see doc: a non-question root never re-opens).
  if (comment.author !== "human" || root.intent !== "question") return false;
  // Review (tail-walk) — a trailing human NON-question ("btw also consider X")
  // must not flip an unanswered thread to answered: walk backward past human
  // non-question comments; the first substantive message governs. Hitting an
  // agent reply or a closed question = answered; hitting an open human
  // question = unanswered; exhausting the replies falls through to the root
  // (which the guard above ensured is a question — open-ness decides).
  for (let i = replies.length - 1; i >= 0; i--) {
    const r = replies[i]!;
    if (r.author !== "human") return false; // agent replied after the last question
    const rx = r as { intent?: string };
    if (rx.intent === "question") return isOpenHumanQuestion(r);
    // human non-question — keep walking
  }
  return isOpenHumanQuestion(comment);
}

/**
 * Count unanswered human questions across a FLAT comment list (App only has the
 * `comments` Record, not the rail's grouped threads). Builds replies-per-parent
 * then applies the shared predicate to each ROOT comment — matching the rail,
 * which only evaluates top-level threads, so the badge and the pill agree.
 */
export function countUnansweredQuestions(comments: Comment[]): number {
  // H1 — count over buildThreads, the SAME grouping every rendering surface
  // uses: the old `if (parentCommentId) continue` dropped ORPHANED question
  // roots (missing parent) that the rail still rendered and counted —
  // exactly the drift this module's contract forbids. buildThreads roots
  // orphans at self and flattens transitively (F7), so count == rendered.
  let n = 0;
  for (const t of buildThreads(comments)) {
    if (isUnansweredQuestion(t.root, t.replies)) n++;
  }
  return n;
}
