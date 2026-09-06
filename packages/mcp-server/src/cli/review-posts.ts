/**
 * The operator review-post surface. The offline half lives in
 * `review-posts-offline.ts` (re-exported here so every existing caller is
 * unchanged) and is the only half the marketplace plugin bundle ships; the
 * reconcile command below performs GitHub GETs through `gh` and stays in the
 * full CLI. See `review-posts-offline.ts` for why the split is load-bearing.
 */
import { ReviewPostJournal } from "../store/review-post-journal.js";
import { readReviewForReconciliation } from "../github/post-review.js";
import { verifyReconciledReview } from "../github/reconcile-review-post.js";

export { reviewPostsCommand } from "./review-posts-offline.js";

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
