import { ReviewPostJournal } from "../store/review-post-journal.js";
import { readReviewForReconciliation } from "../github/post-review.js";
import { verifyReconciledReview } from "../github/reconcile-review-post.js";

/** Explicit operator controls; never sends a GitHub request or steals a lock. */
export function reviewPostsCommand(projectRoot: string, args: string[]): string {
  const [sessionId, action = "list", operationId, ...extra] = args;
  if (!sessionId || extra.length || !["list", "cancel-reserved"].includes(action) ||
      (action === "list" && operationId !== undefined) || (action === "cancel-reserved" && !operationId)) {
    throw new Error("Usage: review-posts <session-id> [list | cancel-reserved <operation-id>]");
  }
  const journal = new ReviewPostJournal(projectRoot, sessionId);
  if (action === "cancel-reserved") {
    journal.cancelReserved(operationId!);
    return `Cancelled reserved operation ${operationId}. Its original caller can no longer begin a send. Re-check human authorization before a new post.`;
  }
  const operations = journal.list();
  // Do not print fencing-token digests, raw review text, or auth fingerprints.
  return JSON.stringify(operations.map(op => ({
    id: op.id, target: op.identity.target, event: op.identity.event,
    reviewedHeadSha: op.identity.reviewedHeadSha, state: op.state,
    createdAt: op.createdAt, updatedAt: op.updatedAt,
    ...(op.result ? { result: op.result } : {}),
  })), null, 2);
}

/** This explicit recovery command performs GETs only, followed by a local
 * journal commit. It cannot turn a missing or mismatched review into a retry. */
export async function reconcileReviewPostCommand(projectRoot: string, args: string[]): Promise<string> {
  const [sessionId, action, operationId, rawReviewId, ...extra] = args;
  if (!sessionId || action !== "reconcile" || !operationId || !rawReviewId || extra.length || !/^[1-9][0-9]*$/.test(rawReviewId)) {
    throw new Error("Usage: review-posts <session-id> reconcile <operation-id> <remote-review-id>");
  }
  const reviewId = Number(rawReviewId);
  if (!Number.isSafeInteger(reviewId)) throw new Error("Invalid remote review ID");
  const journal = new ReviewPostJournal(projectRoot, sessionId);
  const operation = journal.list().find(op => op.id === operationId);
  if (!operation || !["sending", "unknown", "succeeded"].includes(operation.state)) {
    throw new Error("No matching possibly sent operation to reconcile");
  }
  const remote = await readReviewForReconciliation(operation.identity.target, reviewId);
  const result = verifyReconciledReview(operation, remote.review, remote.comments);
  if (result.id !== reviewId) throw new Error("Remote response did not identify the selected review");
  journal.reconcileSucceeded(operationId, operation.identity, result);
  return `Recorded verified review ${result.htmlUrl} for operation ${operationId}. No review was posted by recovery.`;
}
