import type { Comment } from "@deeppairing/shared";
import { buildThreads } from "./threading";

/**
 * The single source of truth for "a human question still awaiting the agent".
 * Used by ConversationRail (pill count, filter, inline marker), TurnIndicator
 * (the ❓ badge), and App/countUnansweredQuestions (the Conversation-button
 * badge) so none of them can drift.
 *
 * A thread is unanswered when — walking its chronological messages from the
 * TAIL back to the root — the first SUBSTANTIVE message is an OPEN human
 * question (one lacking an out-of-band answer `answeredByCommentId` and a
 * human resolution `humanResolvedAt`). The walk: an agent message means the
 * agent had the last word (not waiting); an open human question means waiting;
 * a closed human question means done; a human non-question ("btw also…") is
 * context and the walk continues. No open human question anywhere → not
 * waiting. When `replies` is empty the tail IS the root.
 *
 * History: #130 first made this judge the TAIL (a thread whose last message is
 * an open follow-up question is waiting, not "answered because a reply
 * exists"). I4 then DROPPED the earlier "root must be a human question" gate:
 * comment threads are almost always human-rooted (a human commenting on the
 * agent's artifact), so the common flow — human comments, agent replies, human
 * asks a follow-up via the reply Ask-toggle — has a non-question root, and the
 * gate made that follow-up silently not count. The tail-walk alone already
 * stops plain-comment threads from flagging, so an open human question now
 * awaits the agent regardless of what the thread started as.
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
