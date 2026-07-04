import type { Comment } from "@deeppairing/shared";
import { buildThreads } from "./threading";

/**
 * The single source of truth for "a human question still awaiting the agent".
 * Used by ConversationRail (pill count, filter, inline marker) AND App (the
 * Conversation-button badge) so they can't drift. A question is unanswered when
 * it's a human question with no threaded reply, not answered out-of-band
 * (answeredByCommentId), and not resolved by the human (humanResolvedAt).
 */
export function isUnansweredQuestion(comment: Comment, replies: Comment[]): boolean {
  const c = comment as {
    intent?: string;
    answeredByCommentId?: string | null;
    humanResolvedAt?: string | null;
  };
  return (
    comment.author === "human" &&
    c.intent === "question" &&
    !c.answeredByCommentId &&
    !c.humanResolvedAt &&
    replies.length === 0
  );
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
