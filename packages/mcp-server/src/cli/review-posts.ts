import { ReviewPostJournal } from "../store/review-post-journal.js";

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
