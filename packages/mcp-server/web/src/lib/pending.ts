import type { Artifact, Comment } from "@deeppairing/shared";

/**
 * Single source of truth for "what is waiting on the human" — used by the
 * PendingBanner, TurnIndicator, and the cross-project waiting badge so they
 * can't drift apart (pre-this, each computed its own filter: PendingBanner
 * counted only decision/plan, TurnIndicator counted research/spec/decision/plan
 * but not code_change, etc.).
 *
 * A trustworthy "agent is waiting for you" signal requires that EVERY counted
 * item be human-dismissable — so the set here is exactly the set the dismiss
 * affordances cover:
 *   - draft reviewable artifacts → Approve/Revise/Reject, or Dismiss (obsolete)
 *   - unanswered human questions that aren't human-resolved → "Mark resolved"
 *     (answered or humanResolvedAt clears them)
 * Decisions/plans are artifacts in `draft`; resolving them flips status, so
 * they leave this set naturally.
 */

/** Artifact types whose `draft` state means "the human needs to review this".
 *  `reasoning` is excluded (agent narration, no review cycle). */
const REVIEWABLE_TYPES = new Set(["research", "spec", "plan", "decision", "code_change"]);

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
  /** Unanswered, un-dismissed human questions (with the artifact they're on). */
  questions: Array<{ artifactId: string; comment: Comment }>;
  /** drafts.length + questions.length — the single number a badge shows. */
  total: number;
}

/**
 * Compute everything currently waiting on the human across an artifact list +
 * the per-artifact comment map (the shape the web artifact store holds:
 * Record<artifactId, Comment[]>).
 */
export function computePending(
  artifacts: Artifact[],
  commentsByArtifact: Record<string, Comment[]>,
): PendingSummary {
  const drafts = artifacts.filter(isDraftAwaitingReview);
  const questions: Array<{ artifactId: string; comment: Comment }> = [];
  for (const [artifactId, list] of Object.entries(commentsByArtifact)) {
    for (const c of list ?? []) {
      if (isUnresolvedQuestion(c)) questions.push({ artifactId, comment: c });
    }
  }
  questions.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt));
  return { drafts, questions, total: drafts.length + questions.length };
}
