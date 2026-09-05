import type { GitHubReviewPayload } from "../export/format-markdown.js";
import {
  reviewPostDigest, reviewPostIdentitySchema, validateReviewPostResult,
  type ReviewPostIdentity, type ReviewPostLease, type ReviewPostResult,
} from "../store/review-post-journal.js";

type MaybePromise<T> = T | Promise<T>;
/** FileStore and DaemonClient must both implement this durable boundary. */
export interface DurableReviewPostStore {
  reserve(identity: ReviewPostIdentity, repost: boolean): MaybePromise<ReviewPostLease>;
  markSending(lease: ReviewPostLease, identity: ReviewPostIdentity): MaybePromise<void>;
  failBeforeSending(lease: ReviewPostLease): MaybePromise<void>;
  markUnknown(lease: ReviewPostLease): MaybePromise<void>;
  succeed(lease: ReviewPostLease, result: ReviewPostResult): MaybePromise<void>;
}

export class ReviewPostNotSentError extends Error {
  constructor(readonly operationId: string, cause: unknown, readonly reservationReleased: boolean) {
    super(`Review operation ${operationId} did not start its POST. ` +
      (reservationReleased ? "Its reservation was released; re-check authorization before trying again." :
        "Its local reservation needs inspection before trying again."), { cause });
    this.name = "ReviewPostNotSentError";
  }
}

export class ReviewPostUnknownError extends Error {
  constructor(readonly operationId: string, cause: unknown) {
    super(`Review operation ${operationId} may have reached GitHub. Do not retry or use repost; reconcile this operation first.`, { cause });
    this.name = "ReviewPostUnknownError";
  }
}

/**
 * Call only AFTER remote target/head preparation and the existing local verdict
 * gates. The final gate must re-run after reservation, because a daemon round
 * trip can yield while the pair changes their verdict. No network is held under
 * the journal's local filesystem claim. This is not a GitHub transaction.
 */
export async function executeDurableReviewPost(opts: {
  store: DurableReviewPostStore;
  identity: ReviewPostIdentity;
  payload: GitHubReviewPayload;
  repost: boolean;
  reauthorize: () => MaybePromise<ReviewPostIdentity>;
  send: (target: string, payload: GitHubReviewPayload) => Promise<unknown>;
}): Promise<{ operationId: string; result: ReviewPostResult; receipt: "recorded" | "unconfirmed" }> {
  // Never retain a caller's mutable payload across an await. The digest is of
  // the exact JSON-bound payload, including commit_id when present.
  const payload = JSON.parse(JSON.stringify(opts.payload)) as GitHubReviewPayload;
  const identity = reviewPostIdentitySchema.parse(opts.identity);
  const commitId = (payload as GitHubReviewPayload & { commit_id?: string }).commit_id;
  if (identity.payloadDigest !== reviewPostDigest(payload) || identity.event !== payload.event ||
      commitId !== identity.reviewedHeadSha) {
    throw new Error("Review-post payload does not match its authorized digest");
  }
  const lease = await opts.store.reserve(identity, opts.repost);
  try {
    const current = reviewPostIdentitySchema.parse(await opts.reauthorize());
    if (reviewPostDigest(current) !== reviewPostDigest(identity)) {
      throw new Error("Review authorization or content changed while reserving the post");
    }
    await opts.store.markSending(lease, identity);
    // The daemon transition itself is an HTTP await. A human may withdraw
    // approval while its response is in flight; no local gate may precede
    // that wait and still be advertised as the final pre-POST authorization.
    const beforeSend = reviewPostIdentitySchema.parse(await opts.reauthorize());
    if (reviewPostDigest(beforeSend) !== reviewPostDigest(identity)) {
      throw new Error("Review authorization or content changed during the sending transition");
    }
  } catch (err) {
    let reservationReleased = false;
    try { await opts.store.failBeforeSending(lease); reservationReleased = true; } catch { /* preserve the reservation */ }
    throw new ReviewPostNotSentError(lease.operationId, err, reservationReleased);
  }

  let result: ReviewPostResult;
  try {
    // An opaque operation marker lets later read-only reconciliation identify
    // THIS attempt, not an older otherwise-identical review. It is not a token,
    // session ID, credential, or GitHub idempotency key.
    const wirePayload = { ...payload, body: payload.body + reviewPostMarker(lease.operationId) };
    result = validateReviewPostResult(identity, await opts.send(identity.target, wirePayload));
  } catch (err) {
    try { await opts.store.markUnknown(lease); } catch { /* durable sending still blocks retry */ }
    throw new ReviewPostUnknownError(lease.operationId, err);
  }

  try {
    await opts.store.succeed(lease, result);
    return { operationId: lease.operationId, result, receipt: "recorded" };
  } catch {
    // The validated remote receipt proves success, even if local persistence
    // failed. Return that truth with a warning; never encourage another POST.
    try { await opts.store.markUnknown(lease); } catch { /* sending remains unresolved */ }
    return { operationId: lease.operationId, result, receipt: "unconfirmed" };
  }
}

export function reviewPostMarker(operationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) {
    throw new Error("Invalid durable review operation ID");
  }
  return `\n\n<!-- deepPairing-review-operation:${operationId} -->`;
}
