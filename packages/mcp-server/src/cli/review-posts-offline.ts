/**
 * The OFFLINE half of the operator review-post surface — `list`, `inspect`,
 * `cancel-reserved`, `release-claim`, `acknowledge-unknown`.
 *
 * Split out of `review-posts.ts` for one reason: distribution. The marketplace
 * plugin bundle now ships a self-contained operator entry
 * (`cli/review-posts-entry.ts` → `claude-plugin/server/review-posts.mjs`), and
 * that bundle must not contain the review POST path. `review-posts.ts` imports
 * `github/post-review.js` for the reconcile GET, which drags
 * `postPreparedPrReview` into any bundle that reaches it — esbuild inlines a
 * dynamic import into the same output, so deferring the import would not have
 * removed it either. This module imports the journal and nothing else, so
 * "the operator bundle cannot send a review" is a property of the module graph
 * rather than a promise (asserted in `__tests__/plugin-operator-entry.test.ts`).
 *
 * Nothing here performs network I/O, and none of it is reachable from MCP or
 * the daemon's mutation routes.
 */
import { ReviewPostJournal, reviewPostDigest } from "../store/review-post-journal.js";

/** Explicit operator controls; never sends a GitHub request or steals a live lock. */
export function reviewPostsCommand(projectRoot: string, args: string[]): string {
  const usage = "Usage: review-posts <session-id> [list | inspect | cancel-reserved <operation-id> | release-claim <digest> --all-writers-stopped | acknowledge-unknown <operation-id> <digest> --all-writers-stopped --accept-duplicate-risk]";
  const [sessionId, action = "list", operationId, ...extra] = args;
  if (!sessionId) throw new Error(usage);
  const journal = new ReviewPostJournal(projectRoot, sessionId);
  if (action === "release-claim") {
    if (!operationId || extra.length !== 1 || extra[0] !== "--all-writers-stopped") throw new Error(usage);
    journal.releaseClaim(operationId, true);
    return "Released only the inspected claim after your all-writers-stopped assertion. Journal/history unchanged; inspect unresolved operations before restarting writers.";
  }
  if (action === "acknowledge-unknown") {
    if (!operationId || extra.length !== 3 || extra[1] !== "--all-writers-stopped" || extra[2] !== "--accept-duplicate-risk") throw new Error(usage);
    journal.acknowledgeUnknown(operationId, extra[0]!, true, true);
    return `Recorded operator acknowledgement for ${operationId}; this does NOT prove the review was absent. History is preserved. No review was sent. A new attempt requires explicit human repost authorization and current verdict/SHA checks.`;
  }
  if (extra.length || !["list", "inspect", "cancel-reserved"].includes(action) ||
      (["list", "inspect"].includes(action) && operationId !== undefined) || (action === "cancel-reserved" && !operationId)) throw new Error(usage);
  if (action === "inspect") return JSON.stringify(journal.inspect(), null, 2);
  if (action === "cancel-reserved") {
    journal.cancelReserved(operationId!);
    return `Cancelled reserved operation ${operationId}. Its original caller can no longer begin a send. Re-check human authorization before a new post.`;
  }
  let operations;
  try { operations = journal.list(); journal.readLegacyHistory(); }
  catch { return JSON.stringify({ blocked: true, inspection: journal.inspect() }, null, 2); }
  // Do not print fencing-token digests, raw review text, or auth fingerprints.
  return JSON.stringify(operations.map(op => ({
    id: op.id, target: op.identity.target, event: op.identity.event,
    reviewedHeadSha: op.identity.reviewedHeadSha, state: op.state,
    createdAt: op.createdAt, updatedAt: op.updatedAt,
    operationDigest: reviewPostDigest(op),
    ...(op.operatorAcknowledgement ? { operatorAcknowledgement: op.operatorAcknowledgement } : {}),
    ...(op.unsentRelease ? { unsentRelease: op.unsentRelease } : {}),
    ...(op.result ? { result: op.result } : {}),
  })), null, 2);
}
