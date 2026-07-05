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
  // I4 — walk the thread from its chronological TAIL back to the root; the
  // first SUBSTANTIVE message decides who is waiting:
  //   - an AGENT message      → the agent has responded; nothing awaited
  //   - an OPEN human question → awaiting the agent's answer
  //   - a CLOSED human question (answered out-of-band or human-resolved) → done
  //   - a human NON-question ("btw also consider X") → context; keep walking
  // A thread with no open human question anywhere is not waiting.
  //
  // Pre-I4 this ALSO required the ROOT to be a human question — which made a
  // question ASKED AS A REPLY (the common case: human comments on the agent's
  // artifact, agent replies, human flips the composer to Ask and asks a
  // follow-up) silently never count. The tail-walk alone already stops
  // plain-comment threads from flagging (no question anywhere → false), so the
  // root gate was over-conservative and made the reply Ask-toggle cosmetic.
  const chain = [comment, ...replies];
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!;
    if (m.author !== "human") return false; // agent had the last substantive word
    if ((m as { intent?: string }).intent === "question") return isOpenHumanQuestion(m);
    // human non-question — context; keep walking back
  }
  return false;
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
