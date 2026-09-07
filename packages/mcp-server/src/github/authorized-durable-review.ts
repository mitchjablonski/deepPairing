import { authorizeReviewPost, type AuthorizableSession } from "./review-authorization.js";
import { bindReviewPayloadToPreparedTarget, type PreparedPrReviewTarget } from "./post-review.js";
import { canonicalReviewTarget, reviewPostDigest, type ReviewPostIdentity } from "../store/review-post-journal.js";

/** Rebuild the payload and permission fingerprint from one fresh local snapshot.
 * No remote reads here: head preparation precedes every final local gate. */
export function authorizeDurableReview(
  state: AuthorizableSession,
  options: { event?: unknown; repost: boolean },
  prepared: PreparedPrReviewTarget,
) {
  const target = canonicalReviewTarget(prepared.target);
  if (!target) throw new Error("Prepared review destination is not a canonical GitHub PR");
  const auth = authorizeReviewPost(state, { event: options.event, repost: options.repost, pr: target });
  if (!auth.ok) throw new Error(auth.reason);
  const payload = bindReviewPayloadToPreparedTarget(auth.payload, auth.reviewedHeadSha, prepared);
  const identity: ReviewPostIdentity = {
    target, event: auth.event,
    ...(auth.reviewedHeadSha ? { reviewedHeadSha: auth.reviewedHeadSha } : {}),
    payloadDigest: reviewPostDigest(payload),
    // These are the gate's permission-bearing inputs. Deliberately conservative:
    // any artifact change during reservation requires fresh human-state review.
    authorizationDigest: reviewPostDigest({ sessionId: state.sessionId, artifacts: state.artifacts }),
  };
  return { payload, identity };
}
