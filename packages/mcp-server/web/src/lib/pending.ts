import type { Artifact, Comment } from "@deeppairing/shared";

/**
 * Single source of truth for "what is waiting on the human" — used by the
 * PendingBanner and the cross-project waiting badge so they can't drift apart
 * (pre-this, each computed its own filter: PendingBanner counted only
 * decision/plan, etc.).
 *
 * "Waiting on you" == draft reviewable artifacts you must act on
 * (Approve/Revise/Reject, or Dismiss → obsolete). Resolving a decision/plan
 * flips its status, so it leaves this set naturally.
 *
 * A human's own unanswered question is deliberately EXCLUDED: that's the
 * AGENT's turn (you asked it; the agent owes the answer). TurnIndicator
 * surfaces those separately as a violet "waiting on the agent" badge. Counting
 * them here kept the "waiting on YOU" signal lit on something you can't action
 * — the same exclusion lives in the daemon's computeDaemonPendingCount.
 * `isUnresolvedQuestion` is still exported for the agent-turn surfaces.
 */

/** Artifact types whose `draft` state means "the human needs to review this".
 *  `reasoning` is excluded (agent narration, no review cycle). #175 —
 *  `changeset` joins the set: a draft changeset genuinely awaits your review, so
 *  the `n` key and the changeset's own post-verdict auto-advance treat it as
 *  pending (it matches the server's PENDING_DRAFT_TYPES). */
const REVIEWABLE_TYPES = new Set(["research", "spec", "plan", "decision", "code_change", "changeset"]);

export function isDraftAwaitingReview(a: Artifact): boolean {
  return a.status === "draft" && REVIEWABLE_TYPES.has(a.type);
}

export function isUnresolvedQuestion(c: Comment): boolean {
  return (
    c.author === "human" &&
    (c as any).intent === "question" &&
    !(c as any).answeredByCommentId &&
    !(c as any).humanResolvedAt
  );
}

export interface PendingSummary {
  /** Draft artifacts awaiting the human's review. */
  drafts: Artifact[];
  /** drafts.length — the single number the "waiting on you" badge shows. */
  total: number;
}

/**
 * Compute everything currently waiting on the human ("your turn") across an
 * artifact list. Human-asked questions are excluded — they're the agent's turn
 * (see the module docstring) and belong to the separate "waiting on the agent"
 * surface, not this count.
 *
 * Takes the per-artifact comment map for signature stability with callers even
 * though the count no longer depends on it.
 */
export function computePending(
  artifacts: Artifact[],
  _commentsByArtifact: Record<string, Comment[]> = {},
): PendingSummary {
  const drafts = artifacts.filter(isDraftAwaitingReview);
  return { drafts, total: drafts.length };
}
